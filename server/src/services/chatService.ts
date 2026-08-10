import { Response } from 'express';
import { config } from '../config/index';
import { Conversation } from '../models/Conversation';
import { Persona } from '../models/Persona';
import { assembleSystemPrompt, ensureDefaultPersona } from './personaService';
import { streamChat } from './llmService';

const CONVERSATION_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const STREAM_TIMEOUT_MS = 30_000; // abort upstream if no completion by 30s
const HEARTBEAT_MS = 15_000; // SSE keepalive to survive idle proxy/CDN drops

/**
 * Normalize a (lean) conversation doc into the shape the client expects:
 * `id` as a string (Mongoose lean returns `_id` as an ObjectId, which the
 * client cannot use for stream URLs).
 */
function serializeConversation(conv: any) {
  if (!conv) return conv;
  return {
    ...conv,
    id: conv._id?.toString?.() ?? conv.id,
    personaId: conv.personaId?.toString?.() ?? conv.personaId,
    userId: conv.userId?.toString?.() ?? conv.userId,
  };
}

/**
 * Orchestrate a chat response: retrieve context → assemble prompt → stream tokens → persist.
 *
 * Persistence uses atomic `$push`/`$set` updates rather than read-modify-write
 * so two concurrent streams on the same conversation can't clobber each other's
 * messages. The upstream LLM fetch is bound to an AbortController that fires
 * on client disconnect or a 30s deadline, so closing the tab mid-stream stops
 * burning the free-tier LLM quota into a dead socket.
 */
export async function handleChatStream(
  userId: string,
  conversationId: string,
  userMessage: string,
  res: Response,
): Promise<void> {
  // 1. Load conversation
  const conversation = await Conversation.findOne({
    _id: conversationId,
    userId,
  });

  if (!conversation) {
    res.status(404).json({ success: false, message: 'Conversation not found' });
    return;
  }

  // 2. Load persona and assemble system prompt
  const persona = await Persona.findById(conversation.personaId);
  if (!persona) {
    res.status(404).json({ success: false, message: 'Persona not found' });
    return;
  }

  const systemPrompt = assembleSystemPrompt(persona);

  // 3. Append the user message atomically (avoids read-modify-write races).
  const userNow = new Date();
  await Conversation.updateOne(
    { _id: conversation._id, userId },
    {
      $push: {
        messages: { role: 'user', content: userMessage, timestamp: userNow, tokenCount: 0 },
      },
      $set: {
        lastMessageAt: userNow,
        expiresAt: new Date(userNow.getTime() + CONVERSATION_TTL_MS),
      },
    },
  );

  // 4. Re-read recent messages for the context window.
  const refreshed = await Conversation.findOne({ _id: conversation._id, userId });
  const recentMessages = (refreshed?.getRecentMessages(20) || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // 5. Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Write helper that no-ops once the response is closed/ended, so disconnects
  // and double-end paths don't throw "Cannot set headers after they are sent".
  const write = (chunk: string): void => {
    if (res.destroyed || res.writableEnded) return;
    res.write(chunk);
  };

  write(`data: ${JSON.stringify({ type: 'state', state: 'thinking' })}\n\n`);

  // 6. Abort/timeout/cleanup wiring
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), STREAM_TIMEOUT_MS);
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    ac.abort();
  });
  // Heartbeat keeps proxies/CDNs from dropping the idle stream during the
  // LLM backoff window. Comment frames (leading ":") are ignored by clients.
  const heartbeat = setInterval(() => write(': keepalive\n\n'), HEARTBEAT_MS);

  let fullResponse = '';
  let firstToken = true;

  try {
    await streamChat({
      systemPrompt,
      messages: recentMessages,
      signal: ac.signal,
      onToken: (token) => {
        if (firstToken) {
          write(`data: ${JSON.stringify({ type: 'state', state: 'speaking' })}\n\n`);
          firstToken = false;
        }
        write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
      },
      onEnd: (text) => {
        fullResponse = text;
      },
    });

    clearTimeout(timeout);

    // 7. Persist assistant message atomically
    if (fullResponse) {
      const endNow = new Date();
      await Conversation.updateOne(
        { _id: conversation._id, userId },
        {
          $push: {
            messages: { role: 'assistant', content: fullResponse, timestamp: endNow, tokenCount: 0 },
          },
          $set: {
            lastMessageAt: endNow,
            expiresAt: new Date(endNow.getTime() + CONVERSATION_TTL_MS),
          },
        },
      );
    }

    // 8. Send done event
    write(`data: ${JSON.stringify({ type: 'state', state: 'idle' })}\n\n`);
    write(`data: ${JSON.stringify({ type: 'done', messageId: `msg_${Date.now()}` })}\n\n`);
  } catch (error) {
    clearTimeout(timeout);
    const aborted = ac.signal.aborted;
    if (clientClosed) {
      // Client is gone — nothing to send; the user message is already persisted.
    } else if (aborted) {
      // Timed out (client still connected) — surface a friendly error.
      write(
        `data: ${JSON.stringify({ type: 'error', message: 'Reply timed out. Please try again.' })}\n\n`,
      );
    } else {
      const raw = error instanceof Error ? error.message : 'Failed to generate response';
      console.error('Stream error:', raw);
      // Never leak upstream provider details in production.
      const message = config.nodeEnv === 'production' ? 'Failed to generate response' : raw;
      write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Already closed
      }
    }
  }
}

/**
 * Create a new conversation for a persona.
 */
export async function createConversation(
  userId: string,
  personaId: string,
  avatarId: string,
  title?: string,
) {
  const conversation = await Conversation.create({
    userId,
    personaId,
    avatarId,
    title: title || 'New Conversation',
    messages: [],
    lastMessageAt: new Date(),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  });

  return conversation;
}

/**
 * List conversations for a user.
 */
export async function listConversations(userId: string) {
  const convs = await Conversation.find({ userId })
    .select('title lastMessageAt createdAt avatarId personaId')
    .sort({ lastMessageAt: -1 })
    .lean();
  return convs.map((c: any) => ({
    ...c,
    id: c._id.toString(),
    personaId: c.personaId?.toString?.(),
  }));
}

/**
 * Ensure the single hard-coded Friend persona exists for the user and that a
 * conversation exists for it. Returns the conversation (lean, with messages).
 * This is the entry point the client auto-opens on load.
 */
export async function ensureDefaultConversation(userId: string) {
  const persona = await ensureDefaultPersona(userId);

  let conversation = await Conversation.findOne({ userId, personaId: persona._id }).lean();
  if (!conversation) {
    const created = await createConversation(
      userId,
      persona._id.toHexString(),
      persona.avatarId,
      persona.name,
    );
    conversation = await Conversation.findById(created._id).lean();
  }

  return { conversation: serializeConversation(conversation), persona };
}