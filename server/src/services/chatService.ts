import { Response } from 'express';
import { config } from '../config/index';
import { Conversation, toPreview } from '../models/Conversation';
import { Persona } from '../models/Persona';
import { assembleSystemPrompt, ensureDefaultPersona } from './personaService';
import { streamChat } from './llmService';

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

export interface ConversationSummary {
  id: string;
  title: string;
  titleIsCustom: boolean;
  personaId: string;
  avatarId: string;
  messageCount: number;
  lastMessagePreview: string;
  lastMessageAt: Date;
  createdAt: Date;
}

const TITLE_MAX_LENGTH = 50;
const DEFAULT_TITLE = 'New Conversation';

/**
 * Derive a conversation title from its first user message.
 *
 * Collapses whitespace, strips a wrapping quote pair, and clips to 50 chars on
 * a word boundary where one is available so titles don't end mid-word.
 */
export function deriveTitle(firstUserMessage: string): string {
  let text = (firstUserMessage || '').replace(/\s+/g, ' ').trim();

  // Strip one wrapping quote pair ("hi there" -> hi there).
  const quoted = /^(["'\u201c\u2018])(.*)(["'\u201d\u2019])$/.exec(text);
  if (quoted) text = quoted[2].trim();

  if (!text) return DEFAULT_TITLE;
  if (text.length <= TITLE_MAX_LENGTH) return text;

  const clipped = text.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only back off to a word boundary if it doesn't gut the title.
  const base = lastSpace > TITLE_MAX_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}\u2026`;
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
    isArchived: false,
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

  // 3. Auto-title from the first user message. Guarded on `messageCount: 0`
  // so it can only ever match before the push below, and on `titleIsCustom`
  // so a manual rename is never overwritten. A no-match is the normal
  // outcome for every message after the first.
  await Conversation.updateOne(
    { _id: conversation._id, userId, titleIsCustom: false, messageCount: 0 },
    { $set: { title: deriveTitle(userMessage) } },
  );

  // 4. Append the user message atomically (avoids read-modify-write races).
  const userNow = new Date();
  await Conversation.updateOne(
    { _id: conversation._id, userId },
    {
      $push: {
        messages: { role: 'user', content: userMessage, timestamp: userNow, tokenCount: 0 },
      },
      $inc: { messageCount: 1 },
      $set: {
        lastMessageAt: userNow,
        lastMessagePreview: toPreview(userMessage),
      },
    },
  );

  // 5. Re-read recent messages for the context window.
  const refreshed = await Conversation.findOne({ _id: conversation._id, userId });
  const recentMessages = (refreshed?.getRecentMessages(20) || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // 6. Set up SSE headers
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

  // 7. Abort/timeout/cleanup wiring
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

    // Persist assistant message atomically
    if (fullResponse) {
      const endNow = new Date();
      await Conversation.updateOne(
        { _id: conversation._id, userId },
        {
          $push: {
            messages: { role: 'assistant', content: fullResponse, timestamp: endNow, tokenCount: 0 },
          },
          $inc: { messageCount: 1 },
          $set: {
            lastMessageAt: endNow,
            lastMessagePreview: toPreview(fullResponse),
          },
        },
      );
    }

    // Send done event
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
 *
 * The title stays at the schema default until the first user message arrives,
 * at which point `handleChatStream` auto-titles it (see `deriveTitle`).
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
    ...(title ? { title, titleIsCustom: true } : {}),
    messages: [],
    messageCount: 0,
    lastMessagePreview: '',
    lastMessageAt: new Date(),
  });

  return conversation;
}

const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 50;

/**
 * List a user's non-archived conversations, newest activity first.
 *
 * Paginated by a `before` cursor on `lastMessageAt` rather than skip/limit, so
 * a conversation that gets bumped mid-scroll can't shift the page window.
 */
export async function listConversations(
  userId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<{ conversations: ConversationSummary[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);

  const filter: Record<string, unknown> = { userId, isArchived: false };
  if (opts.before) filter.lastMessageAt = { $lt: opts.before };

  // Over-fetch by one to detect a further page without a second count query.
  const docs = await Conversation.find(filter)
    .select('title titleIsCustom lastMessageAt createdAt avatarId personaId messageCount lastMessagePreview')
    .sort({ lastMessageAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;

  return {
    conversations: page.map((c: any) => ({
      id: c._id.toString(),
      title: c.title,
      titleIsCustom: Boolean(c.titleIsCustom),
      personaId: c.personaId?.toString?.() ?? '',
      avatarId: c.avatarId,
      messageCount: c.messageCount ?? 0,
      lastMessagePreview: c.lastMessagePreview ?? '',
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
    })),
    hasMore,
  };
}

/**
 * Rename a conversation and pin the title against future auto-titling.
 * Returns `null` when the conversation isn't the user's or is archived.
 */
export async function renameConversation(userId: string, conversationId: string, title: string) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, userId, isArchived: false },
    { $set: { title, titleIsCustom: true } },
    { new: true },
  ).lean();
}

/**
 * Soft-delete a conversation. Returns false when there was nothing to archive
 * (wrong owner, unknown id, or already archived), which the route maps to 404.
 *
 * Soft rather than hard so an in-flight stream holding this document can
 * finish writing without hitting a vanished record.
 */
export async function archiveConversation(userId: string, conversationId: string): Promise<boolean> {
  const result = await Conversation.updateOne(
    { _id: conversationId, userId, isArchived: false },
    { $set: { isArchived: true, deletedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

/**
 * Ensure the single hard-coded Friend persona exists for the user and that a
 * conversation exists for it. Resumes the most recently active one.
 * This is the entry point the client auto-opens on load.
 */
export async function ensureDefaultConversation(userId: string) {
  const persona = await ensureDefaultPersona(userId);

  let conversation = await Conversation.findOne({ userId, isArchived: false })
    .sort({ lastMessageAt: -1 })
    .lean();

  if (!conversation) {
    const created = await createConversation(userId, persona._id.toHexString(), persona.avatarId);
    conversation = await Conversation.findById(created._id).lean();
  }

  return { conversation: serializeConversation(conversation), persona };
}
