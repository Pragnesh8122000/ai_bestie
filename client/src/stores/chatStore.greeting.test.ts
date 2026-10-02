import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
}));

vi.mock('../api/conversation', () => ({
  conversationApi: {
    list: vi.fn(),
    get: vi.fn(),
    getDefault: vi.fn(),
    openPersona: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    streamMessage: vi.fn(),
    streamGreeting: vi.fn(),
  },
}));

import { useChatStore } from './chatStore';
import { conversationApi } from '../api/conversation';
import { speakChunk } from '../utils/speech';

const api = conversationApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** A fetch-like Response streaming the given SSE events; `gate` holds it open. */
function sseResponse(events: unknown[], gate?: Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      await gate;
      controller.close();
    },
  });
  return { ok: true, body: stream };
}

const GREETING = [
  { type: 'state', state: 'thinking' },
  { type: 'token', content: 'Hey! How are you doing today?' },
  { type: 'state', state: 'idle' },
  { type: 'done', messageId: 'msg_1' },
];

let nextId = 0;
function openEmptyConversation() {
  const id = `g${++nextId}`;
  const conversation = {
    id,
    title: 'New Conversation',
    personaId: 'p1',
    avatarId: 'a',
    lastMessageAt: '2026-10-02T10:00:00.000Z',
    createdAt: '2026-10-02T10:00:00.000Z',
    titleIsCustom: false,
    messageCount: 0,
    lastMessagePreview: '',
  };
  useChatStore.setState({
    conversations: [conversation],
    activeConversation: { ...conversation, messages: [] },
    activeConversationId: id,
  });
  return id;
}

const initialState = useChatStore.getState();

beforeEach(() => {
  useChatStore.getState().abortStream();
  vi.clearAllMocks();
  useChatStore.setState({ ...initialState, error: null, ttsEnabled: false });
});

describe('greet', () => {
  it('opens an empty conversation with an assistant message and no user turn', async () => {
    const id = openEmptyConversation();
    api.streamGreeting.mockResolvedValue(sseResponse(GREETING));

    await useChatStore.getState().greet();

    expect(api.streamGreeting).toHaveBeenCalledWith(id, expect.any(AbortSignal), undefined);
    expect(api.streamMessage).not.toHaveBeenCalled();
    const state = useChatStore.getState();
    expect(state.activeConversation?.messages).toMatchObject([
      { role: 'assistant', content: 'Hey! How are you doing today?' },
    ]);
    expect(state.activeConversation?.title).toBe('New Conversation');
    expect(state.conversations[0].messageCount).toBe(1);
    expect(state.isStreaming).toBe(false);
  });

  it('greets each conversation at most once, and never one that has messages', async () => {
    openEmptyConversation();
    api.streamGreeting.mockResolvedValue(sseResponse(GREETING));
    await useChatStore.getState().greet();
    await useChatStore.getState().greet();
    expect(api.streamGreeting).toHaveBeenCalledTimes(1);

    openEmptyConversation();
    const active = useChatStore.getState().activeConversation!;
    useChatStore.setState({
      activeConversation: {
        ...active,
        messages: [{ _id: 'm', role: 'user', content: 'hi', timestamp: '' }],
      },
    });
    await useChatStore.getState().greet();
    expect(api.streamGreeting).toHaveBeenCalledTimes(1);
  });

  it('speaks a voice-mode greeting when voice replies are on', async () => {
    const id = openEmptyConversation();
    useChatStore.setState({ ttsEnabled: true });
    api.streamGreeting.mockResolvedValue(sseResponse(GREETING));

    await useChatStore.getState().greet({ voiceMode: true });

    expect(api.streamGreeting).toHaveBeenCalledWith(id, expect.any(AbortSignal), true);
    expect(
      vi
        .mocked(speakChunk)
        .mock.calls.map(([text]) => text)
        .join(' '),
    ).toContain('How are you doing today?');
  });

  it('does not speak the tail of a greeting when voice turns on mid-stream', async () => {
    openEmptyConversation();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.streamGreeting.mockResolvedValue(
      sseResponse(
        [
          { type: 'token', content: 'Hey there. ' },
          { type: 'token', content: 'How are you doing?' },
        ],
        gate,
      ),
    );

    const pending = useChatStore.getState().greet();
    await vi.waitFor(() => expect(useChatStore.getState().streamingContent).toContain('How'));
    useChatStore.setState({ ttsEnabled: true });
    release();
    await pending;

    expect(speakChunk).not.toHaveBeenCalled();
  });

  it('fails quietly so the user can simply talk first', async () => {
    openEmptyConversation();
    api.streamGreeting.mockResolvedValue(sseResponse([{ type: 'error', message: 'LLM busy' }]));
    await useChatStore.getState().greet();
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().avatarState).toBe('idle');

    openEmptyConversation();
    api.streamGreeting.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Conversation already started' }),
    });
    await useChatStore.getState().greet();
    const state = useChatStore.getState();
    expect(state.error).toBeNull();
    expect(state.isStreaming).toBe(false);
    expect(state.activeConversation?.messages).toEqual([]);
  });
});
