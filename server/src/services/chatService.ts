import { randomUUID } from 'node:crypto';
import { Response } from 'express';
import { config } from '../config/index';
import { Conversation, toPreview } from '../models/Conversation';
import { Persona } from '../models/Persona';
import { assembleSystemPrompt, ensureDefaultPersona } from './personaService';
import { LlmProviderError, streamChat, type ProviderInfo } from './llmService';
import { logMetric } from '../utils/metricsLog';
import { formatIst } from '../utils/time';
import { deriveTitle } from '../utils/conversationTitle';

export { deriveTitle };

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

/**
 * Orchestrate a chat response: retrieve context → assemble prompt → stream tokens → persist.
 *
 * Persistence uses atomic `$push`/`$set` updates rather than read-modify-write
 * so two concurrent streams on the same conversation can't clobber each other's
 * messages. The upstream LLM fetch is bound to an AbortController that fires
 * on client disconnect or a 30s deadline, so closing the tab mid-stream stops
 * burning the free-tier LLM quota into a dead socket.
 */
// Voice replies are heard, not read: a text-chat-length paragraph is a wall
// of sound and most of it is thrown away as filler by the time it's spoken.
// This caps generation length specifically for voice mode; text chat is
// unaffected (see assembleSystemPrompt's own voiceMode branch for the prompt
// side of this).
const VOICE_MODE_MAX_TOKENS = 220;

/**
 * Sent to the LLM (never stored or shown) when the persona opens a brand-new
 * conversation itself. Providers need at least one user turn, and the
 * persona's system prompt still sets the voice.
 */
export const GREETING_CUE =
  "[The user just opened a new conversation with you and hasn't said anything yet. " +
  'Start it yourself, in character: greet them warmly and ask how they are doing or ' +
  "what's on their mind. One or two short sentences. Never mention this note.]";

/**
 * `userMessage: null` is the greeting: the persona speaks first in an empty
 * conversation. Nothing from the user is stored, and the reply is only
 * persisted while the conversation is still empty (idempotent across tabs
 * and double-fired effects).
 */
export async function handleChatStream(
  userId: string,
  conversationId: string,
  userMessage: string | null,
  res: Response,
  voiceMode = false,
  turnId?: string,
): Promise<void> {
  const startedAtMs = Date.now();
  const reqId = randomUUID();

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

  const isGreeting = userMessage === null;
  if (isGreeting && (conversation.messageCount ?? 0) > 0) {
    res.status(409).json({
      success: false,
      code: 'CONVERSATION_STARTED',
      message: 'Conversation already started',
    });
    return;
  }

  const systemPrompt = assembleSystemPrompt(persona, voiceMode);

  let recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  if (isGreeting) {
    recentMessages = [{ role: 'user', content: GREETING_CUE }];
  } else {
    // 3. Auto-title from the first user message. Guarded on "no user message
    // yet" (a persona greeting may already be there) so it can only match
    // before the push below, and on `titleIsCustom` so a manual rename is
    // never overwritten. A no-match is the normal outcome after the first.
    await Conversation.updateOne(
      { _id: conversation._id, userId, titleIsCustom: false, 'messages.role': { $ne: 'user' } },
      { $set: { title: deriveTitle(userMessage) } },
    );

    // 4. Append the user message atomically and return the updated document.
    // Reusing the write result removes a separate database round trip from
    // the transcript-to-first-token path while preserving concurrent-stream
    // safety.
    const userNow = new Date();
    const refreshed = await Conversation.findOneAndUpdate(
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
      { new: true },
    );

    // 5. Build the context window from that updated document.
    recentMessages = (refreshed?.getRecentMessages(20) || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
  }

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

  // Metrics for the `chat.turn` log line (see utils/metricsLog.ts). Lengths and
  // timings only — never the message or reply text.
  const llmStartMs = Date.now();
  let llmOpenMs = null as number | null;
  let firstTokenMs = null as number | null;
  let tokenChunks = 0;
  let replyChars = 0;
  let provider = null as ProviderInfo | null;
  let outcome: 'ok' | 'client_closed' | 'timeout' | 'error' = 'ok';
  let errorCode: string | undefined;
  let failureSummary: string | undefined;

  try {
    await streamChat({
      systemPrompt,
      messages: recentMessages,
      ...(voiceMode ? { maxTokens: VOICE_MODE_MAX_TOKENS } : {}),
      // Greetings are short and should feel instant, so they always take the
      // fast, hedged model path too.
      ...(voiceMode || isGreeting ? { latencyMode: true } : {}),
      signal: ac.signal,
      onProvider: (info) => {
        provider = info;
        llmOpenMs = Date.now();
      },
      onToken: (token) => {
        tokenChunks++;
        replyChars += token.length;
        if (firstToken) {
          firstTokenMs = Date.now();
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

    // Persist assistant message atomically. A greeting only lands in a
    // still-empty conversation (the user may have spoken in another tab).
    if (fullResponse) {
      const endNow = new Date();
      await Conversation.updateOne(
        { _id: conversation._id, userId, ...(isGreeting ? { messageCount: 0 } : {}) },
        {
          $push: {
            messages: {
              role: 'assistant',
              content: fullResponse,
              timestamp: endNow,
              tokenCount: 0,
            },
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
      outcome = 'client_closed';
    } else if (aborted) {
      // Timed out (client still connected) — surface a friendly error.
      outcome = 'timeout';
      write(
        `data: ${JSON.stringify({ type: 'error', message: 'Reply timed out. Please try again.' })}\n\n`,
      );
    } else {
      const providerError = error instanceof LlmProviderError ? error : null;
      outcome = 'error';
      errorCode = providerError?.code ?? 'UNEXPECTED';
      failureSummary = providerError?.internalSummary;
      const raw = error instanceof Error ? error.message : 'Failed to generate response';
      console.error(
        'Chat generation failed:',
        providerError?.internalSummary ??
          (config.nodeEnv === 'production' ? 'unexpected error' : raw),
      );
      // Provider bodies can include enormous nested payloads and internal
      // diagnostics. LlmProviderError exposes a deliberately short, actionable
      // client message in every environment.
      const message = providerError
        ? providerError.message
        : config.nodeEnv === 'production'
          ? 'Failed to generate response. Please try again.'
          : raw;
      write(
        `data: ${JSON.stringify({ type: 'error', message, ...(providerError ? { code: providerError.code } : {}) })}\n\n`,
      );
    }
  } finally {
    const endMs = Date.now();
    logMetric('chat.turn', {
      reqId,
      ...(turnId ? { turnId } : {}),
      userId,
      conversationId,
      voiceMode,
      ...(isGreeting ? { kind: 'greeting' } : {}),
      startedAt: formatIst(startedAtMs),
      outcome,
      ...(errorCode ? { errorCode } : {}),
      // Time before the LLM call: DB loads, prompt assembly, persisting the user message.
      prepMs: llmStartMs - startedAtMs,
      // LLM request sent -> upstream stream open (includes failover/retry waits).
      llmConnectMs: llmOpenMs === null ? null : llmOpenMs - llmStartMs,
      // Request received -> first token written: what the server adds to the
      // speech-end -> first-audio path of a voice turn.
      ttfbMs: firstTokenMs === null ? null : firstTokenMs - startedAtMs,
      llmTtftMs: firstTokenMs === null ? null : firstTokenMs - llmStartMs,
      streamMs: firstTokenMs === null ? null : endMs - firstTokenMs,
      totalMs: endMs - startedAtMs,
      provider: provider?.provider ?? null,
      model: provider?.model ?? null,
      failedAttempts: provider?.failedAttempts ?? null,
      // Upstream requests started (voice hedging can race more than one).
      ...(provider?.attempts !== undefined ? { llmAttempts: provider.attempts } : {}),
      ...(failureSummary ? { failureSummary } : {}),
      maxTokens: voiceMode ? VOICE_MODE_MAX_TOKENS : null,
      inputChars: userMessage?.length ?? 0,
      contextMessages: recentMessages.length,
      replyChars,
      tokenChunks,
    });
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

/**
 * Open the most recently active conversation for one of the user's existing
 * personas, creating that persona's first conversation when necessary.
 *
 * Keeping this as one server operation makes the selector idempotent from the
 * client's point of view: one click produces one intended chat and never
 * creates a second persona (or a duplicate chat because of a follow-up GET).
 */
export async function openPersonaConversation(userId: string, personaId: string) {
  const persona = await Persona.findOne({ _id: personaId, userId }).lean();
  if (!persona) return null;

  let conversation = await Conversation.findOne({
    userId,
    personaId: persona._id,
    isArchived: false,
  })
    .sort({ lastMessageAt: -1 })
    .lean();

  if (!conversation) {
    const created = await createConversation(userId, personaId, persona.avatarId);
    conversation = await Conversation.findById(created._id).lean();
  }

  return { conversation: serializeConversation(conversation), persona };
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
    .select(
      'title titleIsCustom lastMessageAt createdAt avatarId personaId messageCount lastMessagePreview',
    )
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
export async function archiveConversation(
  userId: string,
  conversationId: string,
): Promise<boolean> {
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
  const defaultPersona = await ensureDefaultPersona(userId);

  let conversation = await Conversation.findOne({ userId, isArchived: false })
    .sort({ lastMessageAt: -1 })
    .lean();

  let persona = defaultPersona;

  if (!conversation) {
    const created = await createConversation(
      userId,
      defaultPersona._id.toHexString(),
      defaultPersona.avatarId,
    );
    conversation = await Conversation.findById(created._id).lean();
  } else if (conversation.personaId?.toString() !== defaultPersona._id.toString()) {
    const actualPersona = await Persona.findById(conversation.personaId);
    if (actualPersona) persona = actualPersona;
  }

  return { conversation: serializeConversation(conversation), persona };
}
