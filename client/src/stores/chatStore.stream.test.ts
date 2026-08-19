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
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    streamMessage: vi.fn(),
  },
}));

import { useChatStore } from './chatStore';
import { conversationApi } from '../api/conversation';

const api = conversationApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** Build a fetch-like Response whose body streams the given SSE events. */
function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return { ok: true, body: stream };
}

function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: 'New Conversation',
    personaId: 'p1',
    avatarId: 'a',
    lastMessageAt: '2026-08-18T10:00:00.000Z',
    createdAt: '2026-08-18T09:00:00.000Z',
    titleIsCustom: false,
    messageCount: 0,
    lastMessagePreview: '',
    ...overrides,
  };
}

const initialState = useChatStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ ...initialState, conversations: [], activeConversation: null, activeConversationId: null, error: null });
});

describe('sendMessage', () => {
  it('streams a reply and updates both the transcript and the list row', async () => {
    useChatStore.setState({
      conversations: [conversation('a')],
      activeConversation: { ...conversation('a'), messages: [] },
      activeConversationId: 'a',
    });
    api.streamMessage.mockResolvedValue(
      sseResponse([
        { type: 'state', state: 'thinking' },
        { type: 'token', content: 'Hey' },
        { type: 'token', content: ' there.' },
        { type: 'done', messageId: 'm1' },
      ]),
    );

    await useChatStore.getState().sendMessage('Hello Sam');

    const state = useChatStore.getState();
    expect(state.activeConversation?.messages.map((m) => m.content)).toEqual(['Hello Sam', 'Hey there.']);
    expect(state.isStreaming).toBe(false);
    expect(state.avatarState).toBe('idle');
    expect(state.conversations[0].lastMessagePreview).toBe('Hey there.');
    expect(state.conversations[0].messageCount).toBe(2);
  });

  it('auto-titles the conversation from the first user message', async () => {
    useChatStore.setState({
      conversations: [conversation('a')],
      activeConversation: { ...conversation('a'), messages: [] },
      activeConversationId: 'a',
    });
    api.streamMessage.mockResolvedValue(sseResponse([{ type: 'done', messageId: 'm1' }]));

    await useChatStore.getState().sendMessage('I need help planning a trip to Lisbon next month with family');

    expect(useChatStore.getState().conversations[0].title).toBe(
      'I need help planning a trip to Lisbon next month…',
    );
  });

  it('does not retitle a conversation that already has messages', async () => {
    const existing = { role: 'user' as const, content: 'earlier', timestamp: '2026-08-18T09:00:00.000Z' };
    useChatStore.setState({
      conversations: [conversation('a', { title: 'Existing title', messageCount: 2 })],
      activeConversation: { ...conversation('a', { title: 'Existing title' }), messages: [existing] },
      activeConversationId: 'a',
    });
    api.streamMessage.mockResolvedValue(sseResponse([{ type: 'done', messageId: 'm2' }]));

    await useChatStore.getState().sendMessage('second message');

    expect(useChatStore.getState().conversations[0].title).toBe('Existing title');
  });

  it('does not overwrite a manually renamed title', async () => {
    useChatStore.setState({
      conversations: [conversation('a', { title: 'Lisbon', titleIsCustom: true })],
      activeConversation: { ...conversation('a', { title: 'Lisbon', titleIsCustom: true }), messages: [] },
      activeConversationId: 'a',
    });
    api.streamMessage.mockResolvedValue(sseResponse([{ type: 'done', messageId: 'm1' }]));

    await useChatStore.getState().sendMessage('anything at all here');

    expect(useChatStore.getState().conversations[0].title).toBe('Lisbon');
  });

  it('does not append the reply to a conversation the user switched away from', async () => {
    useChatStore.setState({
      conversations: [conversation('a'), conversation('b')],
      activeConversation: { ...conversation('a'), messages: [] },
      activeConversationId: 'a',
    });
    api.streamMessage.mockResolvedValue(sseResponse([{ type: 'token', content: 'hi' }, { type: 'done', messageId: 'm1' }]));

    const pending = useChatStore.getState().sendMessage('question');
    // Simulate the user landing on B before the stream finishes.
    useChatStore.setState({
      activeConversationId: 'b',
      activeConversation: { ...conversation('b'), messages: [] },
    });
    await pending;

    const state = useChatStore.getState();
    expect(state.activeConversation?.id).toBe('b');
    expect(state.activeConversation?.messages).toHaveLength(0);
    // The list still records that A received a reply.
    expect(state.conversations.find((c) => c.id === 'a')?.messageCount).toBe(2);
  });

  it('surfaces a server error frame', async () => {
    useChatStore.setState({
      conversations: [conversation('a')],
      activeConversation: { ...conversation('a'), messages: [] },
      activeConversationId: 'a',
    });
    api.streamMessage.mockResolvedValue(sseResponse([{ type: 'error', message: 'Reply timed out. Please try again.' }]));

    await useChatStore.getState().sendMessage('hello');

    expect(useChatStore.getState().error).toBe('Reply timed out. Please try again.');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('ignores an empty message and one with no active conversation', async () => {
    await useChatStore.getState().sendMessage('   ');
    expect(api.streamMessage).not.toHaveBeenCalled();

    useChatStore.setState({ activeConversation: { ...conversation('a'), messages: [] } });
    await useChatStore.getState().sendMessage('');
    expect(api.streamMessage).not.toHaveBeenCalled();
  });
});
