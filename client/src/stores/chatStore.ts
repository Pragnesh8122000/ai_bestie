import { create } from 'zustand';
import { conversationApi, Conversation, Message } from '../api/conversation';
import { speakChunk, beginSpeech, stopSpeaking, setTtsStateListener } from '../utils/speech';
import { isSpeechActive } from '../utils/tts';
import { deriveTitle, toPreview, DEFAULT_TITLE } from '../utils/conversation';
import { SpeechChunker } from '../utils/speechChunker';
import { createVoiceTurnLatencyTrace, type VoiceTurnLatencyTrace } from '../utils/voiceLatency';
import { finishActiveVoiceTrace, setActiveVoiceTrace } from '../utils/voiceTrace';
import type { VoiceTurnTiming } from '../utils/voiceCapture';
import { usePersonaStore } from './personaStore';

type AvatarState = 'idle' | 'thinking' | 'speaking' | 'listening';

type ActiveConversation = Conversation & { messages: Message[] };

interface ChatState {
  conversations: Conversation[];
  activeConversation: ActiveConversation | null;
  activeConversationId: string | null;
  avatarState: AvatarState;
  isStreaming: boolean;
  isLoadingConversation: boolean;
  isLoadingList: boolean;
  hasMoreConversations: boolean;
  isSidebarOpen: boolean;
  streamingContent: string;
  error: string | null;
  ttsEnabled: boolean;

  fetchConversations: (opts?: { append?: boolean }) => Promise<void>;
  openDefaultConversation: () => Promise<void>;
  switchConversation: (id: string) => Promise<void>;
  createConversation: (personaId: string, avatarId: string, title?: string) => Promise<string>;
  openPersonaConversation: (personaId: string) => Promise<string | null>;
  startNewConversation: () => Promise<string | null>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  sendMessage: (
    content: string,
    opts?: { voiceMode?: boolean; voiceTiming?: VoiceTurnTiming },
  ) => Promise<void>;
  /** The persona opens an empty active conversation itself (once). */
  greet: (opts?: { voiceMode?: boolean }) => Promise<void>;
  abortStream: () => void;
  clearError: () => void;
  toggleTts: () => void;
  setTtsEnabled: (enabled: boolean) => void;
}

// Per-stream controller + watchdog. Held at module scope so the store actions
// (and ChatPage cleanup) can abort the in-flight request.
let currentController: AbortController | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
// Monotonic id so a stale stream's late callbacks can't clobber a newer one.
let streamId = 0;
// Monotonic id for conversation loads, so a slow GET for conversation A can't
// overwrite a faster GET for B when the user switches rapidly.
let loadId = 0;
let currentVoiceTrace: VoiceTurnLatencyTrace | null = null;
// Conversations whose greeting was already requested this page load.
const greetingRequested = new Set<string>();

const WATCHDOG_MS = 60_000; // abort if no chunk arrives for 60s

function clearWatchdog(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.message || error?.message || fallback;
}

/** Newest activity first — the order the sidebar renders. */
function sortByRecency(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  );
}

/**
 * Stream one assistant reply into the active conversation. `content: null`
 * is the persona's greeting: it opens an empty conversation itself, with no
 * user message, and fails silently (the user can simply speak first).
 */
async function streamReply(
  content: string | null,
  opts?: { voiceMode?: boolean; voiceTiming?: VoiceTurnTiming },
): Promise<void> {
  const set = useChatStore.setState;
  const getState = useChatStore.getState;
  const { activeConversation, isStreaming } = getState();
  const isGreeting = content === null;
  // A greeting is spoken only if TTS was already on when it started: voice
  // mode opened mid-greeting replays it whole instead of speaking a tail.
  const greetingSpoken = isGreeting && getState().ttsEnabled;
  const shouldSpeak = () => (isGreeting ? greetingSpoken : getState().ttsEnabled);
  // Single-flight at the state boundary, not just the disabled button. Two
  // same-tick UI events must never emit duplicate generation requests.
  if (!activeConversation || isStreaming || (!isGreeting && !content.trim())) return;

  // Pin the conversation this stream belongs to — the user may switch away
  // mid-reply, and none of the callbacks below may touch the new one.
  const convId = activeConversation.id;
  const wasEmpty = (activeConversation.messages?.length ?? 0) === 0;
  const originalTitle = activeConversation.title;

  const myStreamId = ++streamId;
  const controller = new AbortController();
  currentController = controller;

  // Add user message optimistically (a greeting has none: the persona speaks first)
  const userMessage: Message | null = isGreeting
    ? null
    : {
        _id: `client_${myStreamId}_${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

  set((state) => ({
    activeConversation:
      state.activeConversation && userMessage
        ? {
            ...state.activeConversation,
            messages: [...state.activeConversation.messages, userMessage],
          }
        : state.activeConversation,
    avatarState: 'thinking',
    isStreaming: true,
    streamingContent: '',
    error: null,
  }));

  // First message of a conversation names it — mirror the server's title
  // derivation locally so the sidebar row updates without a refetch.
  if (wasEmpty && !isGreeting) {
    const conversation = getState().conversations.find((c) => c.id === convId);
    if (conversation && !conversation.titleIsCustom) {
      const title = deriveTitle(content);
      set((state) => ({
        conversations: state.conversations.map((c) => (c.id === convId ? { ...c, title } : c)),
        activeConversation:
          state.activeConversation?.id === convId
            ? { ...state.activeConversation, title }
            : state.activeConversation,
      }));
    }
  }

  // Reset TTS for the new reply. The chunker turns this stream's raw
  // (still-Markdown) tokens into speakable chunks, sized so each can be
  // synthesized while the previous one plays.
  const chunker = new SpeechChunker();
  currentVoiceTrace?.cancel();
  const voiceTrace = opts?.voiceTiming ? createVoiceTurnLatencyTrace(opts.voiceTiming) : null;
  currentVoiceTrace = voiceTrace;
  const stageTrace = opts?.voiceTiming?.trace ?? null;
  stageTrace?.mark('chat.send');
  beginSpeech(
    voiceTrace
      ? () => {
          voiceTrace.markFirstTtsAudio();
          if (currentVoiceTrace === voiceTrace) currentVoiceTrace = null;
        }
      : undefined,
  );
  // After beginSpeech: it closes the previous reply's trace as 'aborted'.
  setActiveVoiceTrace(stageTrace);

  const resetWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      // Connection stalled — abort and surface a friendly error.
      if (myStreamId !== streamId) return;
      controller.abort();
      set({
        error: 'Connection stalled. Please try again.',
        avatarState: 'idle',
        isStreaming: false,
        streamingContent: '',
      });
    }, WATCHDOG_MS);
  };
  resetWatchdog();

  try {
    const response = isGreeting
      ? await conversationApi.streamGreeting(convId, controller.signal, opts?.voiceMode)
      : await conversationApi.streamMessage(
          convId,
          content,
          controller.signal,
          opts?.voiceMode,
          stageTrace?.id,
        );
    stageTrace?.mark('chat.headers');

    if (!response.ok) {
      let message = `Message request failed (${response.status})`;
      try {
        const body = await response.json();
        if (typeof body?.message === 'string') message = body.message;
      } catch {
        // Non-JSON proxy errors still retain the status-aware fallback.
      }
      const rejected = new Error(message) as Error & { requestRejected: boolean };
      rejected.requestRejected = true;
      throw rejected;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No readable stream');

    const decoder = new TextDecoder();
    let assistantContent = '';
    let buffer = '';

    while (true) {
      if (myStreamId !== streamId) break; // a newer stream superseded this one
      const { done, value } = await reader.read();
      if (done) break;
      if (myStreamId !== streamId) break;

      resetWatchdog();

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (myStreamId !== streamId) return;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data.startsWith(':')) continue;
        stageTrace?.mark('chat.first_event');

        try {
          const event = JSON.parse(data);

          switch (event.type) {
            case 'state':
              // When TTS is on, the orb's speaking state is driven by actual
              // audio start/stop (see setTtsStateListener below), not the
              // server's advisory state event.
              if (event.state === 'speaking' && shouldSpeak()) break;
              set({ avatarState: event.state });
              break;

            case 'token':
              voiceTrace?.markFirstLlmToken();
              stageTrace?.mark('chat.first_token');
              assistantContent += event.content;
              set({ streamingContent: assistantContent });
              if (shouldSpeak()) {
                // The chunker keeps constructs like fenced blocks whole,
                // strips the Markdown so the voice speaks words rather than
                // asterisks, and sizes each chunk so it is synthesized
                // before the previous one finishes playing.
                for (const speech of chunker.push(event.content)) speakChunk(speech);
              }
              break;

            case 'done': {
              stageTrace?.mark('chat.done');
              // Flush any remaining buffered text, including a trailing
              // fragment with no sentence end.
              if (shouldSpeak()) {
                for (const speech of chunker.flush()) speakChunk(speech);
              }
              const assistantMessage: Message = {
                _id: event.messageId,
                role: 'assistant',
                content: assistantContent,
                timestamp: new Date().toISOString(),
              };
              const now = new Date().toISOString();

              set((state) => ({
                // Only append if the user is still looking at this conversation.
                activeConversation:
                  state.activeConversation?.id === convId
                    ? {
                        ...state.activeConversation,
                        messages: [...state.activeConversation.messages, assistantMessage],
                        lastMessageAt: now,
                      }
                    : state.activeConversation,
                // The list entry updates regardless — the reply landed in the
                // database whether or not it's on screen.
                conversations: sortByRecency(
                  state.conversations.map((c) =>
                    c.id === convId
                      ? {
                          ...c,
                          lastMessageAt: now,
                          lastMessagePreview: toPreview(assistantContent),
                          messageCount: (c.messageCount ?? 0) + (isGreeting ? 1 : 2),
                        }
                      : c,
                  ),
                ),
                isStreaming: false,
                streamingContent: '',
              }));

              // If TTS is off (or no audio ever started), go idle now. When TTS
              // is playing, the audio state listener resets to idle on drain.
              const st = getState();
              if (!shouldSpeak() || st.avatarState === 'thinking') {
                set({ avatarState: 'idle' });
              }
              // Nothing left to say (or no audio ever started): the turn is over.
              if (stageTrace && !isSpeechActive()) finishActiveVoiceTrace('ok');
              break;
            }

            case 'error':
              if (stageTrace) finishActiveVoiceTrace('error');
              voiceTrace?.cancel();
              if (currentVoiceTrace === voiceTrace) currentVoiceTrace = null;
              set({
                // A failed greeting stays quiet: the user can just talk first.
                error: isGreeting ? null : event.message || 'Stream error',
                avatarState: 'idle',
                isStreaming: false,
                streamingContent: '',
              });
              break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } catch (error: any) {
    // Stale stream — a newer stream superseded this one; don't touch state.
    if (myStreamId !== streamId) return;
    voiceTrace?.cancel();
    if (currentVoiceTrace === voiceTrace) currentVoiceTrace = null;
    if (stageTrace) finishActiveVoiceTrace(error?.name === 'AbortError' ? 'aborted' : 'error');
    const wasAborted = error?.name === 'AbortError';
    const requestRejected = error?.requestRejected === true;
    if (requestRejected && userMessage) {
      // The server rejected the request before chatService persisted it
      // (notably a 429). Remove only this optimistic turn and restore an
      // auto-title derived from a message that never landed.
      set((state) => ({
        activeConversation:
          state.activeConversation?.id === convId
            ? {
                ...state.activeConversation,
                title: wasEmpty ? originalTitle : state.activeConversation.title,
                messages: state.activeConversation.messages.filter(
                  (message) => message._id !== userMessage._id,
                ),
              }
            : state.activeConversation,
        conversations: state.conversations.map((conversation) =>
          conversation.id === convId && wasEmpty
            ? { ...conversation, title: originalTitle }
            : conversation,
        ),
      }));
    }
    if (wasAborted) {
      // Aborted by us (stalled / navigated / switched / new message). The
      // watchdog path already set a specific error; otherwise reset quietly.
      if (!getState().error) {
        set({ avatarState: 'idle', isStreaming: false, streamingContent: '' });
      }
    } else {
      set({
        error: isGreeting ? null : errorMessage(error, 'Failed to send message'),
        avatarState: 'idle',
        isStreaming: false,
        streamingContent: '',
      });
    }
  } finally {
    if (myStreamId === streamId) {
      clearWatchdog();
      if (currentController === controller) currentController = null;
    }
  }
}

export const useChatStore = create<ChatState>((set, getState) => ({
  conversations: [],
  activeConversation: null,
  activeConversationId: null,
  avatarState: 'idle',
  isStreaming: false,
  isLoadingConversation: false,
  isLoadingList: false,
  hasMoreConversations: false,
  isSidebarOpen: false,
  streamingContent: '',
  error: null,
  ttsEnabled: false,

  fetchConversations: async ({ append = false } = {}) => {
    const { conversations, isLoadingList } = getState();
    if (isLoadingList) return; // guard double-fire (StrictMode, rapid clicks)

    // Cursor-paginate from the oldest row we already hold.
    const before = append ? conversations[conversations.length - 1]?.lastMessageAt : undefined;
    if (append && !before) return;

    set({ isLoadingList: true });
    try {
      const response = await conversationApi.list(before ? { before } : undefined);
      const { conversations: page, hasMore } = response.data.data;

      set((state) => {
        if (!append)
          return { conversations: page, hasMoreConversations: hasMore, isLoadingList: false };
        // De-dupe on id: a conversation bumped between pages can appear twice.
        const seen = new Set(state.conversations.map((c) => c.id));
        const merged = [...state.conversations, ...page.filter((c) => !seen.has(c.id))];
        return { conversations: merged, hasMoreConversations: hasMore, isLoadingList: false };
      });
    } catch (error: any) {
      set({ error: errorMessage(error, 'Failed to load conversations'), isLoadingList: false });
    }
  },

  openDefaultConversation: async () => {
    const myLoadId = ++loadId;
    set({ isLoadingConversation: true });
    try {
      const response = await conversationApi.getDefault();
      if (myLoadId !== loadId) return;
      const { conversation, persona } = response.data.data;
      usePersonaStore.getState().upsertPersona(persona);
      set((state) => ({
        activeConversation: conversation,
        activeConversationId: conversation.id,
        isLoadingConversation: false,
        conversations: state.conversations.some((c) => c.id === conversation.id)
          ? state.conversations
          : sortByRecency([conversation, ...state.conversations]),
      }));
    } catch (error: any) {
      if (myLoadId !== loadId) return;
      set({
        error: errorMessage(error, 'Failed to start conversation'),
        isLoadingConversation: false,
      });
    }
  },

  /**
   * Switch the active conversation, tearing down anything the previous one had
   * running. Safe to call mid-stream and safe to call rapidly — a stale
   * response is discarded rather than rendered under the wrong title.
   */
  switchConversation: async (id: string) => {
    const state = getState();
    if (id === state.activeConversationId && state.activeConversation) return;

    // Kill the in-flight reply and any queued speech before swapping context.
    state.abortStream();

    const myLoadId = ++loadId;
    set({
      activeConversationId: id,
      activeConversation: null,
      isLoadingConversation: true,
      isStreaming: false,
      streamingContent: '',
      avatarState: 'idle',
      error: null,
    });

    try {
      const response = await conversationApi.get(id);
      if (myLoadId !== loadId) return; // superseded by a newer switch
      const { conversation, persona } = response.data.data;
      usePersonaStore.getState().upsertPersona(persona);
      set({
        activeConversation: conversation,
        isLoadingConversation: false,
      });
    } catch (error: any) {
      if (myLoadId !== loadId) return;

      // Gone (deleted in another tab, or a stale link) — drop it and recover.
      if (error?.response?.status === 404) {
        set((s) => ({
          conversations: s.conversations.filter((c) => c.id !== id),
          activeConversation: null,
          activeConversationId: null,
          isLoadingConversation: false,
          error: 'That conversation is no longer available.',
        }));
        await getState().openDefaultConversation();
        return;
      }

      set({
        error: errorMessage(error, 'Failed to load conversation'),
        isLoadingConversation: false,
      });
    }
  },

  createConversation: async (personaId: string, avatarId: string, title?: string) => {
    try {
      const response = await conversationApi.create({ personaId, avatarId, title });
      const conversation = response.data.data.conversation;
      set((state) => ({
        conversations: [conversation, ...state.conversations],
      }));
      return conversation.id;
    } catch (error: any) {
      set({ error: errorMessage(error, 'Failed to create conversation') });
      throw error;
    }
  },

  openPersonaConversation: async (personaId: string) => {
    getState().abortStream();
    const myLoadId = ++loadId;
    set({ isLoadingConversation: true, error: null });

    try {
      const response = await conversationApi.openPersona(personaId);
      if (myLoadId !== loadId) return null;
      const { conversation, persona } = response.data.data;
      usePersonaStore.getState().upsertPersona(persona);
      usePersonaStore.getState().setActivePersona(persona.id);
      set((state) => ({
        activeConversation: conversation,
        activeConversationId: conversation.id,
        isLoadingConversation: false,
        isSidebarOpen: false,
        conversations: sortByRecency([
          conversation,
          ...state.conversations.filter((item) => item.id !== conversation.id),
        ]),
      }));
      return conversation.id;
    } catch (error: any) {
      if (myLoadId !== loadId) return null;
      set({
        error: errorMessage(error, 'Could not switch persona. Please try again.'),
        isLoadingConversation: false,
      });
      return null;
    }
  },

  /**
   * Create an empty conversation with the current persona and open it.
   * No GET round-trip — a freshly created conversation is known to be empty.
   */
  startNewConversation: async () => {
    let persona =
      usePersonaStore
        .getState()
        .personas.find((p) => p.id === usePersonaStore.getState().activePersonaId) ??
      usePersonaStore.getState().personas[0];

    // Cold load (hard refresh straight onto a "new chat" click) — seed a persona.
    if (!persona) {
      await getState().openDefaultConversation();
      persona = usePersonaStore.getState().personas[0];
      if (!persona) {
        set({ error: 'Could not start a new chat. Please reload.' });
        return null;
      }
    }

    getState().abortStream();

    try {
      const response = await conversationApi.create({
        personaId: persona.id,
        avatarId: persona.avatarId,
      });
      const conversation = response.data.data.conversation;
      const active: ActiveConversation = { ...conversation, messages: conversation.messages ?? [] };

      ++loadId; // invalidate any conversation GET still in flight
      set((state) => ({
        conversations: [conversation, ...state.conversations],
        activeConversation: active,
        activeConversationId: conversation.id,
        isLoadingConversation: false,
        isStreaming: false,
        streamingContent: '',
        avatarState: 'idle',
        isSidebarOpen: false,
        error: null,
      }));

      return conversation.id;
    } catch (error: any) {
      set({ error: errorMessage(error, 'Failed to start a new chat') });
      return null;
    }
  },

  /** Optimistic rename — reverts the title if the server rejects it. */
  renameConversation: async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;

    const previous = getState().conversations.find((c) => c.id === id)?.title;
    if (previous === trimmed) return;

    const apply = (value: string, isCustom: boolean) =>
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, title: value, titleIsCustom: isCustom } : c,
        ),
        activeConversation:
          state.activeConversation?.id === id
            ? { ...state.activeConversation, title: value, titleIsCustom: isCustom }
            : state.activeConversation,
      }));

    apply(trimmed, true);

    try {
      await conversationApi.rename(id, trimmed);
    } catch (error: any) {
      if (previous !== undefined) apply(previous, false);
      set({ error: errorMessage(error, 'Failed to rename conversation') });
    }
  },

  deleteConversation: async (id: string) => {
    const { activeConversationId } = getState();
    const wasActive = activeConversationId === id;

    if (wasActive) getState().abortStream();

    try {
      await conversationApi.delete(id);
    } catch (error: any) {
      // 404 means it's already gone — the desired end state either way.
      if (error?.response?.status !== 404) {
        set({ error: errorMessage(error, 'Failed to delete conversation') });
        return;
      }
    }

    const remaining = getState().conversations.filter((c) => c.id !== id);
    set({ conversations: remaining });

    if (!wasActive) return;

    // Move to the next most recent conversation, or seed a fresh one.
    const next = remaining[0];
    set({ activeConversation: null, activeConversationId: null });
    if (next) {
      await getState().switchConversation(next.id);
    } else {
      await getState().openDefaultConversation();
    }
  },

  setSidebarOpen: (open: boolean) => set({ isSidebarOpen: open }),

  abortStream: () => {
    // Invalidate callbacks even when a custom/slow fetch implementation
    // ignores AbortSignal. This is the authoritative stale-stream guard.
    ++streamId;
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    clearWatchdog();
    currentVoiceTrace?.cancel();
    currentVoiceTrace = null;
    stopSpeaking();
    set({
      avatarState: 'idle',
      isStreaming: false,
      streamingContent: '',
    });
  },

  sendMessage: (content: string, opts?: { voiceMode?: boolean; voiceTiming?: VoiceTurnTiming }) =>
    streamReply(content, opts),

  greet: (opts?: { voiceMode?: boolean }) => {
    const { activeConversation, isStreaming } = getState();
    if (!activeConversation || isStreaming || activeConversation.messages.length > 0) {
      return Promise.resolve();
    }
    // Once per conversation per page load: a refused or failed greeting must
    // not retry in a loop, and StrictMode/remounts must not double-greet.
    if (greetingRequested.has(activeConversation.id)) return Promise.resolve();
    greetingRequested.add(activeConversation.id);
    return streamReply(null, opts);
  },

  clearError: () => set({ error: null }),

  toggleTts: () => {
    set((state) => {
      const next = !state.ttsEnabled;
      if (!next) stopSpeaking();
      return { ttsEnabled: next };
    });
  },

  setTtsEnabled: (enabled: boolean) => {
    if (!enabled) stopSpeaking();
    set({ ttsEnabled: enabled });
  },
}));

export { DEFAULT_TITLE };

// Drive the orb's speaking state from actual audio start/stop when TTS is on.
// Fires true when the first utterance begins, false when the queue drains.
setTtsStateListener((speaking) => {
  const state = useChatStore.getState();
  if (speaking) {
    useChatStore.setState({ avatarState: 'speaking' });
  } else if (!state.isStreaming) {
    // Audio drained after the reply finished streaming: the voice turn is over.
    finishActiveVoiceTrace('ok');
    useChatStore.setState({ avatarState: 'idle' });
  }
});
