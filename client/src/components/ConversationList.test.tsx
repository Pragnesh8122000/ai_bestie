// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

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

import ConversationList from './ConversationList';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';
import { conversationApi } from '../api/conversation';

const api = conversationApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Chat ${id}`,
    personaId: 'p1',
    avatarId: 'a',
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    titleIsCustom: false,
    messageCount: 2,
    lastMessagePreview: `preview for ${id}`,
    ...overrides,
  };
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
    isLoadingList: false,
    isSidebarOpen: false,
  });
  usePersonaStore.setState({
    personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a' } as any],
    activePersonaId: 'p1',
  });
  api.list.mockResolvedValue({ data: { data: { conversations: [], hasMore: false } } });
});

afterEach(cleanup);

describe('ConversationList', () => {
  it('fetches and renders conversations with previews', async () => {
    api.list.mockResolvedValue({
      data: { data: { conversations: [conversation('a'), conversation('b')], hasMore: false } },
    });

    render(<ConversationList />);

    expect(await screen.findByText('Chat a')).toBeInTheDocument();
    expect(screen.getByText('Chat b')).toBeInTheDocument();
    expect(screen.getByText('preview for a')).toBeInTheDocument();
  });

  it('shows the empty state when there are no conversations', async () => {
    render(<ConversationList />);
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });

  it('marks the active conversation with aria-current', async () => {
    api.list.mockResolvedValue({
      data: { data: { conversations: [conversation('a'), conversation('b')], hasMore: false } },
    });
    useChatStore.setState({ activeConversationId: 'b' });

    render(<ConversationList />);

    const active = await screen.findByRole('button', { current: 'page' });
    expect(active).toHaveTextContent('Chat b');
  });

  it('switches conversation on click and closes the drawer', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({
      data: { data: { conversations: [conversation('a'), conversation('b')], hasMore: false } },
    });
    api.get.mockResolvedValue({
      data: { data: { conversation: { ...conversation('b'), messages: [] } } },
    });
    useChatStore.setState({ activeConversationId: 'a', isSidebarOpen: true });

    render(<ConversationList />);
    await user.click(await screen.findByText('Chat b'));

    await waitFor(() => expect(useChatStore.getState().activeConversationId).toBe('b'));
    expect(useChatStore.getState().isSidebarOpen).toBe(false);
  });

  it('creates a new chat from the New Chat button', async () => {
    const user = userEvent.setup();
    api.create.mockResolvedValue({
      data: { data: { conversation: { ...conversation('new'), title: 'New Conversation', messages: [] } } },
    });

    render(<ConversationList />);
    await user.click(screen.getByRole('button', { name: /new chat/i }));

    await waitFor(() => expect(useChatStore.getState().activeConversationId).toBe('new'));
    expect(api.create).toHaveBeenCalledWith({ personaId: 'p1', avatarId: 'a' });
  });

  it('renames a conversation inline on Enter', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({ data: { data: { conversations: [conversation('a')], hasMore: false } } });
    api.rename.mockResolvedValue({ data: { data: { conversation: conversation('a', { title: 'Lisbon' }) } } });

    render(<ConversationList />);
    await user.click(await screen.findByRole('button', { name: /options for/i }));
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));

    const input = screen.getByRole('textbox', { name: /conversation title/i });
    await user.clear(input);
    await user.type(input, 'Lisbon{Enter}');

    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('a', 'Lisbon'));
    expect(useChatStore.getState().conversations[0].title).toBe('Lisbon');
  });

  it('discards a rename on Escape without calling the API', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({ data: { data: { conversations: [conversation('a')], hasMore: false } } });

    render(<ConversationList />);
    await user.click(await screen.findByRole('button', { name: /options for/i }));
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));

    const input = screen.getByRole('textbox', { name: /conversation title/i });
    await user.type(input, 'ignored{Escape}');

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(api.rename).not.toHaveBeenCalled();
    expect(screen.getByText('Chat a')).toBeInTheDocument();
  });

  it('requires confirmation before deleting', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({
      data: { data: { conversations: [conversation('a'), conversation('b')], hasMore: false } },
    });
    api.delete.mockResolvedValue({ data: { success: true } });

    render(<ConversationList />);
    const menus = await screen.findAllByRole('button', { name: /options for/i });
    await user.click(menus[0]);
    await user.click(screen.getByRole('menuitem', { name: /delete/i }));

    // Dialog appears; nothing deleted yet.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('a'));
  });

  it('cancelling the confirm dialog deletes nothing', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({ data: { data: { conversations: [conversation('a')], hasMore: false } } });

    render(<ConversationList />);
    await user.click(await screen.findByRole('button', { name: /options for/i }));
    await user.click(screen.getByRole('menuitem', { name: /delete/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('loads more when there is another page', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValueOnce({
      data: { data: { conversations: [conversation('a')], hasMore: true } },
    });
    api.list.mockResolvedValueOnce({
      data: { data: { conversations: [conversation('b')], hasMore: false } },
    });

    render(<ConversationList />);
    await user.click(await screen.findByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Chat b')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it('renders an untitled conversation as a placeholder', async () => {
    api.list.mockResolvedValue({
      data: {
        data: {
          conversations: [conversation('a', { title: 'New Conversation', lastMessagePreview: '' })],
          hasMore: false,
        },
      },
    });

    render(<ConversationList />);

    expect(await screen.findByText('New Conversation')).toHaveClass('italic');
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });
});
