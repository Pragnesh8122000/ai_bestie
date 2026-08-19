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
import { usePersonaStore } from './personaStore';
import { conversationApi } from '../api/conversation';
import { stopSpeaking } from '../utils/speech';

const api = conversationApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Chat ${id}`,
    personaId: 'p1',
    avatarId: 'friend-male-01',
    lastMessageAt: '2026-08-18T10:00:00.000Z',
    createdAt: '2026-08-18T09:00:00.000Z',
    titleIsCustom: false,
    messageCount: 2,
    lastMessagePreview: 'hello',
    ...overrides,
  };
}

function detail(id: string, overrides: Record<string, unknown> = {}) {
  return { data: { data: { conversation: { ...conversation(id), messages: [], ...overrides } } } };
}

const initialState = useChatStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    ...initialState,
    conversations: [],
    activeConversation: null,
    activeConversationId: null,
    error: null,
    isStreaming: false,
    isLoadingList: false,
    isLoadingConversation: false,
    hasMoreConversations: false,
    isSidebarOpen: false,
  });
  usePersonaStore.setState({ personas: [], activePersonaId: null });
});

describe('fetchConversations', () => {
  it('loads the first page and records hasMore', async () => {
    api.list.mockResolvedValue({ data: { data: { conversations: [conversation('a')], hasMore: true } } });

    await useChatStore.getState().fetchConversations();

    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useChatStore.getState().hasMoreConversations).toBe(true);
    expect(api.list).toHaveBeenCalledWith(undefined);
  });

  it('appends with a cursor and de-dupes overlapping ids', async () => {
    useChatStore.setState({
      conversations: [conversation('a'), conversation('b', { lastMessageAt: '2026-08-18T08:00:00.000Z' })],
    });
    api.list.mockResolvedValue({
      data: { data: { conversations: [conversation('b'), conversation('c')], hasMore: false } },
    });

    await useChatStore.getState().fetchConversations({ append: true });

    expect(api.list).toHaveBeenCalledWith({ before: '2026-08-18T08:00:00.000Z' });
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('surfaces an error message on failure', async () => {
    api.list.mockRejectedValue({ response: { data: { message: 'boom' } } });

    await useChatStore.getState().fetchConversations();

    expect(useChatStore.getState().error).toBe('boom');
    expect(useChatStore.getState().isLoadingList).toBe(false);
  });
});

describe('switchConversation', () => {
  it('loads the target and marks it active', async () => {
    api.get.mockResolvedValue(detail('b'));

    await useChatStore.getState().switchConversation('b');

    const state = useChatStore.getState();
    expect(state.activeConversationId).toBe('b');
    expect(state.activeConversation?.id).toBe('b');
    expect(state.isLoadingConversation).toBe(false);
  });

  it('stops in-flight speech when switching mid-stream', async () => {
    useChatStore.setState({ isStreaming: true, streamingContent: 'partial', avatarState: 'speaking' });
    api.get.mockResolvedValue(detail('b'));

    await useChatStore.getState().switchConversation('b');

    expect(stopSpeaking).toHaveBeenCalled();
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().streamingContent).toBe('');
    expect(useChatStore.getState().avatarState).toBe('idle');
  });

  it('discards a stale response when switched again mid-load', async () => {
    let resolveA: (value: unknown) => void = () => {};
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    api.get.mockImplementationOnce(() => Promise.resolve(detail('b')));

    const first = useChatStore.getState().switchConversation('a');
    const second = useChatStore.getState().switchConversation('b');
    await second;

    // A's response lands late — it must not overwrite B.
    resolveA(detail('a'));
    await first;

    expect(useChatStore.getState().activeConversationId).toBe('b');
    expect(useChatStore.getState().activeConversation?.id).toBe('b');
  });

  it('recovers to the default conversation when the target is gone', async () => {
    useChatStore.setState({ conversations: [conversation('gone')] });
    api.get.mockRejectedValue({ response: { status: 404 } });
    api.getDefault.mockResolvedValue({
      data: { data: { conversation: { ...conversation('fresh'), messages: [] }, persona: { id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a', traits: {} } } },
    });

    await useChatStore.getState().switchConversation('gone');

    const state = useChatStore.getState();
    expect(state.conversations.find((c) => c.id === 'gone')).toBeUndefined();
    expect(state.activeConversationId).toBe('fresh');
    expect(state.error).toBe('That conversation is no longer available.');
  });

  it('is a no-op when the target is already active and loaded', async () => {
    useChatStore.setState({
      activeConversationId: 'a',
      activeConversation: { ...conversation('a'), messages: [] },
    });

    await useChatStore.getState().switchConversation('a');

    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('startNewConversation', () => {
  it('creates an empty conversation, opens it, and closes the drawer', async () => {
    usePersonaStore.setState({
      personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'friend-male-01' } as any],
      activePersonaId: 'p1',
    });
    api.create.mockResolvedValue({
      data: { data: { conversation: { ...conversation('new'), title: 'New Conversation', messages: [] } } },
    });
    useChatStore.setState({ isSidebarOpen: true });

    const id = await useChatStore.getState().startNewConversation();

    const state = useChatStore.getState();
    expect(id).toBe('new');
    expect(state.activeConversationId).toBe('new');
    expect(state.activeConversation?.messages).toEqual([]);
    expect(state.conversations[0].id).toBe('new');
    expect(state.isSidebarOpen).toBe(false);
    expect(api.get).not.toHaveBeenCalled(); // a fresh conversation needs no fetch
  });

  it('returns null and reports the error when creation fails', async () => {
    usePersonaStore.setState({
      personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a' } as any],
      activePersonaId: 'p1',
    });
    api.create.mockRejectedValue({ response: { data: { message: 'nope' } } });

    const id = await useChatStore.getState().startNewConversation();

    expect(id).toBeNull();
    expect(useChatStore.getState().error).toBe('nope');
    expect(useChatStore.getState().conversations).toHaveLength(0);
  });
});

describe('renameConversation', () => {
  it('applies the new title immediately', async () => {
    useChatStore.setState({
      conversations: [conversation('a')],
      activeConversation: { ...conversation('a'), messages: [] },
      activeConversationId: 'a',
    });
    api.rename.mockResolvedValue({ data: { data: { conversation: conversation('a', { title: 'Lisbon' }) } } });

    await useChatStore.getState().renameConversation('a', 'Lisbon');

    expect(useChatStore.getState().conversations[0].title).toBe('Lisbon');
    expect(useChatStore.getState().activeConversation?.title).toBe('Lisbon');
    expect(useChatStore.getState().conversations[0].titleIsCustom).toBe(true);
  });

  it('reverts the title when the server rejects the rename', async () => {
    useChatStore.setState({ conversations: [conversation('a')] });
    api.rename.mockRejectedValue({ response: { data: { message: 'too long' } } });

    await useChatStore.getState().renameConversation('a', 'Lisbon');

    expect(useChatStore.getState().conversations[0].title).toBe('Chat a');
    expect(useChatStore.getState().error).toBe('too long');
  });

  it('skips the request for an empty or unchanged title', async () => {
    useChatStore.setState({ conversations: [conversation('a')] });

    await useChatStore.getState().renameConversation('a', '   ');
    await useChatStore.getState().renameConversation('a', 'Chat a');

    expect(api.rename).not.toHaveBeenCalled();
  });
});

describe('deleteConversation', () => {
  it('removes a non-active conversation and leaves the active one alone', async () => {
    useChatStore.setState({
      conversations: [conversation('a'), conversation('b')],
      activeConversationId: 'a',
      activeConversation: { ...conversation('a'), messages: [] },
    });
    api.delete.mockResolvedValue({ data: { success: true } });

    await useChatStore.getState().deleteConversation('b');

    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['a']);
    expect(useChatStore.getState().activeConversationId).toBe('a');
  });

  it('falls back to the next conversation when deleting the active one', async () => {
    useChatStore.setState({
      conversations: [conversation('a'), conversation('b')],
      activeConversationId: 'a',
      activeConversation: { ...conversation('a'), messages: [] },
    });
    api.delete.mockResolvedValue({ data: { success: true } });
    api.get.mockResolvedValue(detail('b'));

    await useChatStore.getState().deleteConversation('a');

    expect(useChatStore.getState().activeConversationId).toBe('b');
  });

  it('seeds a fresh conversation when the last one is deleted', async () => {
    useChatStore.setState({
      conversations: [conversation('a')],
      activeConversationId: 'a',
      activeConversation: { ...conversation('a'), messages: [] },
    });
    api.delete.mockResolvedValue({ data: { success: true } });
    api.getDefault.mockResolvedValue({
      data: { data: { conversation: { ...conversation('fresh'), messages: [] }, persona: { id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a', traits: {} } } },
    });

    await useChatStore.getState().deleteConversation('a');

    expect(api.getDefault).toHaveBeenCalled();
    expect(useChatStore.getState().activeConversationId).toBe('fresh');
  });

  it('treats a 404 as already-deleted', async () => {
    useChatStore.setState({ conversations: [conversation('a'), conversation('b')], activeConversationId: 'b' });
    api.delete.mockRejectedValue({ response: { status: 404 } });

    await useChatStore.getState().deleteConversation('a');

    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['b']);
    expect(useChatStore.getState().error).toBeNull();
  });

  it('keeps the conversation on a non-404 failure', async () => {
    useChatStore.setState({ conversations: [conversation('a')], activeConversationId: 'a' });
    api.delete.mockRejectedValue({ response: { status: 500, data: { message: 'server down' } } });

    await useChatStore.getState().deleteConversation('a');

    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useChatStore.getState().error).toBe('server down');
  });
});
