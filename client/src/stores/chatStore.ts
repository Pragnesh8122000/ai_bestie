import { create } from 'zustand';
import { conversationApi, Conversation, Message } from '../api/conversation';
import {
  speakChunk,
  beginSpeech,
  stopSpeaking,
  setTtsStateListener,
} from '../utils/speech';
import { usePersonaStore } from './personaStore';

type AvatarState = 'idle' | 'thinking' | 'speaking' | 'listening';

interface ChatState {
  conversations: Conversation[];
  activeConversation: (Conversation & { messages: Message[] }) | null;
  avatarState: AvatarState;
  isStreaming: boolean;
  streamingContent: string;
  error: string | null;
  ttsEnabled: boolean;

  fetchConversations: () => Promise<void>;
  openDefaultConversation: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  createConversation: (personaId: string, avatarId: string, title?: string) => Promise<string>;
  deleteConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  abortStream: () => void;
  clearError: () => void;
  toggleTts: () => void;
}

// Per-stream controller + watchdog. Held at module scope so the store actions
// (and ChatPage cleanup) can abort the in-flight request.
let currentController: AbortController | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
// Monotonic id so a stale stream's late callbacks can't clobber a newer one.
let streamId = 0;
// TTS sentence accumulator for the current stream (transient, not reactive).
let ttsSentenceBuffer = '';

const WATCHDOG_MS = 60_000; // abort if no chunk arrives for 60s

function clearWatchdog(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

export const useChatStore = create<ChatState>((set, getState) => ({
  conversations: [],
  activeConversation: null,
  avatarState: 'idle',
  isStreaming: false,
  streamingContent: '',
  error: null,
  ttsEnabled: false,

  fetchConversations: async () => {
    try {
      const response = await conversationApi.list();
      set({ conversations: response.data.data.conversations });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to load conversations' });
    }
  },

  openDefaultConversation: async () => {
    try {
      const response = await conversationApi.getDefault();
      const { conversation, persona } = response.data.data;
      usePersonaStore.getState().upsertPersona(persona);
      set((state) => ({
        activeConversation: conversation,
        conversations: state.conversations.some((c) => c.id === conversation.id)
          ? state.conversations
          : [conversation, ...state.conversations],
      }));
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to start conversation' });
    }
  },

  openConversation: async (id: string) => {
    try {
      const response = await conversationApi.get(id);
      set({ activeConversation: response.data.data.conversation });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to load conversation' });
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
      set({ error: error.response?.data?.message || 'Failed to create conversation' });
      throw error;
    }
  },

  deleteConversation: async (id: string) => {
    try {
      await conversationApi.delete(id);
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
        activeConversation: state.activeConversation?.id === id ? null : state.activeConversation,
      }));
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to delete conversation' });
    }
  },

  abortStream: () => {
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    clearWatchdog();
    stopSpeaking();
  },

  sendMessage: async (content: string) => {
    const { activeConversation, isStreaming } = getState();
    if (!activeConversation || !content.trim()) return;

    // Abort any in-flight stream before starting a new one (concurrency guard).
    if (isStreaming) getState().abortStream();

    const myStreamId = ++streamId;
    const controller = new AbortController();
    currentController = controller;

    // Add user message optimistically
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };

    set((state) => ({
      activeConversation: state.activeConversation
        ? {
            ...state.activeConversation,
            messages: [...state.activeConversation.messages, userMessage],
          }
        : null,
      avatarState: 'thinking',
      isStreaming: true,
      streamingContent: '',
      error: null,
    }));

    // Reset TTS for the new reply.
    ttsSentenceBuffer = '';
    beginSpeech();

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
      const response = await conversationApi.streamMessage(
        activeConversation.id,
        content,
        controller.signal,
      );

      if (!response.ok) {
        throw new Error('Stream request failed');
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

        resetWatchdog();

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data.startsWith(':')) continue;

          try {
            const event = JSON.parse(data);

            switch (event.type) {
              case 'state':
                // When TTS is on, the orb's speaking state is driven by actual
                // audio start/stop (see setTtsStateListener below), not the
                // server's advisory state event.
                if (event.state === 'speaking' && getState().ttsEnabled) break;
                set({ avatarState: event.state });
                break;

              case 'token':
                assistantContent += event.content;
                set({ streamingContent: assistantContent });
                if (getState().ttsEnabled) {
                  ttsSentenceBuffer += event.content;
                  // Hold for 2 completed sentences before flushing (not 1) so
                  // the TTS model synthesizes them together and carries
                  // intonation across the boundary — flushing one sentence
                  // per request made the neural voice sound choppy, since
                  // Kokoro resets prosody at the start of every request. Cap
                  // at ~280 chars so first-audio latency stays low even when
                  // sentences run long, and don't wait past that even with
                  // only 1 complete sentence so far.
                  const sentences = ttsSentenceBuffer.match(/[^.!?…\n]*[.!?…\n]+\s*/g) || [];
                  if (sentences.length >= 2 || ttsSentenceBuffer.length > 280) {
                    const take = sentences.length >= 2 ? 2 : sentences.length;
                    const flushEnd = sentences.slice(0, take).reduce((n, s) => n + s.length, 0);
                    if (flushEnd > 0) {
                      speakChunk(ttsSentenceBuffer.slice(0, flushEnd));
                      ttsSentenceBuffer = ttsSentenceBuffer.slice(flushEnd);
                    } else if (ttsSentenceBuffer.length > 280) {
                      // No sentence boundary yet but the buffer is already
                      // long (e.g. a run-on clause) — flush it as-is so audio
                      // still starts promptly.
                      speakChunk(ttsSentenceBuffer);
                      ttsSentenceBuffer = '';
                    }
                  }
                }
                break;

              case 'done': {
                // Flush any remaining buffered text.
                if (ttsSentenceBuffer.trim()) {
                  speakChunk(ttsSentenceBuffer);
                  ttsSentenceBuffer = '';
                }
                const assistantMessage: Message = {
                  _id: event.messageId,
                  role: 'assistant',
                  content: assistantContent,
                  timestamp: new Date().toISOString(),
                };
                set((state) => ({
                  activeConversation: state.activeConversation
                    ? {
                        ...state.activeConversation,
                        messages: [...state.activeConversation.messages, assistantMessage],
                      }
                    : null,
                  isStreaming: false,
                  streamingContent: '',
                }));
                // If TTS is off (or no audio ever started), go idle now. When TTS
                // is playing, the audio state listener resets to idle on drain.
                const st = getState();
                if (!st.ttsEnabled || st.avatarState === 'thinking') {
                  set({ avatarState: 'idle' });
                }
                break;
              }

              case 'error':
                set({
                  error: event.message || 'Stream error',
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
      const wasAborted = error?.name === 'AbortError';
      if (wasAborted) {
        // Aborted by us (stalled / navigated / new message). The watchdog path
        // already set a specific error; otherwise just reset quietly.
        if (!getState().error) {
          set({ avatarState: 'idle', isStreaming: false, streamingContent: '' });
        }
      } else {
        set({
          error: error.message || 'Failed to send message',
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
  },

  clearError: () => set({ error: null }),

  toggleTts: () => {
    set((state) => {
      const next = !state.ttsEnabled;
      if (!next) stopSpeaking();
      return { ttsEnabled: next };
    });
  },
}));

// Drive the orb's speaking state from actual audio start/stop when TTS is on.
// Fires true when the first utterance begins, false when the queue drains.
setTtsStateListener((speaking) => {
  const state = useChatStore.getState();
  if (speaking) {
    useChatStore.setState({ avatarState: 'speaking' });
  } else if (!state.isStreaming) {
    useChatStore.setState({ avatarState: 'idle' });
  }
});