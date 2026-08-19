// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
  listenOnce: vi.fn(),
  isSTTSupported: () => false,
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

import ChatPage from './ChatPage';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { usePersonaStore } from '../stores/personaStore';
import { conversationApi } from '../api/conversation';

const api = conversationApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

// jsdom implements neither of these; ChatWindow autoscrolls on mount.
Element.prototype.scrollIntoView = vi.fn();

// jsdom has no matchMedia — provide one whose listeners we can fire by hand.
const mediaListeners = new Set<(e: MediaQueryListEvent) => void>();
beforeEach(() => {
  mediaListeners.clear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => mediaListeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => mediaListeners.delete(cb),
  })) as any;

  vi.clearAllMocks();
  const conversation = {
    id: 'a',
    title: 'Lisbon trip',
    personaId: 'p1',
    avatarId: 'a',
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    messages: [],
  };
  useChatStore.setState({
    conversations: [conversation as any],
    activeConversation: conversation as any,
    activeConversationId: 'a',
    error: null,
    isSidebarOpen: false,
    isLoadingList: false,
    isStreaming: false,
  });
  useAuthStore.setState({ user: { id: 'u1', email: 'a@b.c', name: 'Tester' } as any });
  usePersonaStore.setState({
    personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a' } as any],
    activePersonaId: 'p1',
  });
  api.list.mockResolvedValue({ data: { data: { conversations: [conversation], hasMore: false } } });
  document.body.style.overflow = '';
});

afterEach(cleanup);

describe('ChatPage drawer', () => {
  it('shows the active conversation title in the header', async () => {
    render(<ChatPage />);
    expect(await screen.findByRole('heading', { name: 'Lisbon trip' })).toBeInTheDocument();
  });

  it('opens the drawer and locks body scroll, restoring it on close', async () => {
    const user = userEvent.setup();
    render(<ChatPage />);

    await user.click(screen.getByRole('button', { name: /open conversations/i }));

    expect(await screen.findByRole('dialog', { name: /conversations/i })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: /close conversations/i }));

    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });

  it('closes the drawer on Escape', async () => {
    const user = userEvent.setup();
    render(<ChatPage />);

    await user.click(screen.getByRole('button', { name: /open conversations/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(useChatStore.getState().isSidebarOpen).toBe(false));
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });

  it('releases the scroll lock when the viewport grows to desktop', async () => {
    const user = userEvent.setup();
    render(<ChatPage />);

    await user.click(screen.getByRole('button', { name: /open conversations/i }));
    expect(document.body.style.overflow).toBe('hidden');

    // Simulate crossing the sm breakpoint while the drawer is open.
    act(() => {
      mediaListeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent));
    });

    await waitFor(() => expect(useChatStore.getState().isSidebarOpen).toBe(false));
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });
});

describe('ChatPage error toast', () => {
  it('renders a store error and dismisses it on click', async () => {
    const user = userEvent.setup();
    render(<ChatPage />);

    act(() => {
      useChatStore.setState({ error: 'Failed to rename conversation' });
    });

    const toast = await screen.findByText(/Failed to rename conversation/);
    await user.click(toast);

    await waitFor(() => expect(useChatStore.getState().error).toBeNull());
  });

  it('auto-dismisses the error after 5 seconds', async () => {
    vi.useFakeTimers();
    try {
      render(<ChatPage />);
      act(() => {
        useChatStore.setState({ error: 'Connection stalled. Please try again.' });
      });
      expect(screen.getByText(/Connection stalled/)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(useChatStore.getState().error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
