// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
  setTtsLevelListener: vi.fn(),
  listenOnce: vi.fn(),
  isSTTSupported: () => false,
}));

vi.mock('../utils/voiceCapture', () => ({
  startVoiceTurn: vi.fn(() => ({
    promise: new Promise(() => {}),
    stop: vi.fn(),
  })),
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
  },
}));

vi.mock('../api/persona', () => ({
  personaApi: { getArchetypes: vi.fn() },
}));

import ChatPage from './ChatPage';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { usePersonaStore } from '../stores/personaStore';
import { conversationApi } from '../api/conversation';
import { personaApi } from '../api/persona';
import { startVoiceTurn } from '../utils/voiceCapture';
import { stopSpeaking } from '../utils/speech';

const api = conversationApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const personaApiMock = personaApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

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
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      mediaListeners.delete(cb),
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
    isLoadingConversation: false,
    isStreaming: false,
  });
  useAuthStore.setState({ user: { id: 'u1', email: 'a@b.c', name: 'Tester' } as any });
  usePersonaStore.setState({
    personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a' } as any],
    activePersonaId: 'p1',
    archetypes: [],
  });
  api.list.mockResolvedValue({ data: { data: { conversations: [conversation], hasMore: false } } });
  personaApiMock.getArchetypes.mockResolvedValue({
    data: {
      data: {
        archetypes: [
          {
            type: 'friend',
            displayName: 'The Friend',
            corePurpose: '',
            defaultTraits: {},
            traitRanges: {},
          },
        ],
      },
    },
  });
  document.body.style.overflow = '';
});

afterEach(cleanup);

describe('ChatPage drawer', () => {
  it('shows the active conversation title in the header', async () => {
    render(<ChatPage />, { wrapper: MemoryRouter });
    expect(await screen.findByRole('heading', { name: 'Lisbon trip' })).toBeInTheDocument();
  });

  it('enters orb-first voice mode and returns to the exact active text chat', async () => {
    const user = userEvent.setup();
    const active = useChatStore.getState().activeConversation!;
    useChatStore.setState({
      ttsEnabled: false,
      activeConversation: {
        ...active,
        messages: [
          {
            _id: 'kept-message',
            role: 'assistant',
            content: 'This must remain.',
            timestamp: '2026-09-17T17:00:00.000Z',
          },
        ],
      },
    });
    render(<ChatPage />, { wrapper: MemoryRouter });

    expect(screen.getAllByRole('button', { name: 'Start voice chat' })).toHaveLength(2);
    expect(screen.getByText('This must remain.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Start voice chat' })[1]);

    expect(await screen.findByRole('region', { name: 'Voice chat with Sam' })).toBeInTheDocument();
    expect(screen.queryByText('This must remain.')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Voice chat transcript' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End voice chat' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to text chat' }));

    expect(await screen.findByText('This must remain.')).toBeInTheDocument();
    expect(useChatStore.getState().activeConversationId).toBe('a');
    expect(useChatStore.getState().activeConversation?.messages[0]._id).toBe('kept-message');
  });

  it('pauses for an explicit retry after a microphone failure', async () => {
    vi.useFakeTimers();
    try {
      let rejectCapture: (error: Error) => void = () => {};
      vi.mocked(startVoiceTurn).mockReturnValueOnce({
        promise: new Promise((_, reject) => {
          rejectCapture = reject;
        }),
        stop: vi.fn(),
      });
      render(<ChatPage />, { wrapper: MemoryRouter });

      fireEvent.click(screen.getAllByRole('button', { name: 'Start voice chat' })[1]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      await act(async () => {
        rejectCapture(new Error('Mic access is blocked. Allow it and try again.'));
        await Promise.resolve();
      });

      expect(screen.getByRole('status')).toHaveTextContent('Mic access is blocked');
      expect(screen.getByRole('button', { name: 'Unmute microphone' })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the user barge in: speech heard while the persona is talking stops it instead of waiting', async () => {
    let capturedOnInterim: ((text: string) => void) | undefined;
    vi.mocked(startVoiceTurn).mockImplementation((_onLevel, _maxMs, onInterim) => {
      capturedOnInterim = onInterim;
      return { promise: new Promise(() => {}), stop: vi.fn() };
    });
    render(<ChatPage />, { wrapper: MemoryRouter });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Start voice chat' })[1]);
    });

    // The persona is still mid-reply, audio actively playing.
    act(() => {
      useChatStore.setState({
        avatarState: 'speaking',
        isStreaming: true,
        streamingContent: 'I can help you plan that trip today.',
      });
    });

    // A barge-in probe starts immediately (no idle debounce) while it's
    // speaking, and stays silent — the orb still shows "speaking" — until
    // real speech is detected.
    await waitFor(() => expect(startVoiceTurn).toHaveBeenCalled());
    expect(capturedOnInterim).toBeTypeOf('function');
    expect(screen.getByText(/is speaking/i)).toBeInTheDocument();

    act(() => capturedOnInterim?.('I can help'));
    expect(stopSpeaking).not.toHaveBeenCalled();
    act(() => capturedOnInterim?.('wait'));
    expect(stopSpeaking).not.toHaveBeenCalled();
    act(() => capturedOnInterim?.('wait, actually'));

    expect(stopSpeaking).toHaveBeenCalled();
    expect(useChatStore.getState().avatarState).toBe('idle');
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(await screen.findByText(/is listening/i)).toBeInTheDocument();
  });

  it('sends the barged-in/normal voice transcript with voiceMode so replies stay short', async () => {
    vi.mocked(startVoiceTurn).mockReturnValueOnce({
      promise: Promise.resolve({ transcript: 'how do I fix this', usedServerFallback: false }),
      stop: vi.fn(),
    });
    api.streamMessage.mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: 'done', messageId: 'm1' })}\n\n`,
            ),
          );
          controller.close();
        },
      }),
    });
    render(<ChatPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getAllByRole('button', { name: 'Start voice chat' })[1]);

    await waitFor(() =>
      expect(api.streamMessage).toHaveBeenCalledWith(
        'a',
        'how do I fix this',
        expect.anything(),
        true,
      ),
    );
  });

  it('shows the persona archetype on saved and streaming assistant message rows', async () => {
    const activeConversation = useChatStore.getState().activeConversation!;
    useChatStore.setState({
      activeConversation: {
        ...activeConversation,
        messages: [
          {
            _id: 'm1',
            role: 'assistant',
            content: 'I am here.',
            timestamp: '2026-09-17T17:00:00.000Z',
          },
        ],
      },
      isStreaming: true,
      streamingContent: 'Still listening.',
    });

    render(<ChatPage />, { wrapper: MemoryRouter });

    expect(await screen.findAllByText('sam · the friend')).toHaveLength(2);
  });

  it('hydrates a saved conversation persona after a cold load', async () => {
    const user = userEvent.setup();
    const current = useChatStore.getState().activeConversation!;
    const saved = {
      ...current,
      id: 'b',
      title: 'Coach check-in',
      personaId: 'p2',
      messages: [],
    };
    usePersonaStore.setState({ personas: [], activePersonaId: null });
    useChatStore.setState({ conversations: [current, saved] });
    api.list.mockResolvedValue({
      data: { data: { conversations: [current, saved], hasMore: false } },
    });
    api.get.mockResolvedValue({
      data: {
        data: {
          conversation: saved,
          persona: {
            id: 'p2',
            name: 'Riley',
            archetype: 'coach',
            avatarId: 'coach-female-01',
            traits: {},
          },
        },
      },
    });

    render(<ChatPage />, { wrapper: MemoryRouter });
    await user.click(await screen.findByTitle('Coach check-in'));

    expect(await screen.findByText('Riley')).toBeInTheDocument();
    expect(screen.getByText('The Coach')).toBeInTheDocument();
  });

  it('does not bootstrap the default while a saved conversation is loading', async () => {
    const user = userEvent.setup();
    let resolveSaved: (value: unknown) => void = () => {};
    const current = useChatStore.getState().activeConversation!;
    const saved = {
      ...current,
      id: 'b',
      title: 'Coach check-in',
      personaId: 'p2',
      messages: [],
    };
    useChatStore.setState({ conversations: [current, saved] });
    api.list.mockResolvedValue({
      data: { data: { conversations: [current, saved], hasMore: false } },
    });
    api.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSaved = resolve;
        }),
    );
    api.getDefault.mockResolvedValue({
      data: {
        data: {
          conversation: { ...current, id: 'default', messages: [] },
          persona: {
            id: 'p1',
            name: 'Sam',
            archetype: 'friend',
            avatarId: 'friend-male-01',
            traits: {},
          },
        },
      },
    });

    render(<ChatPage />, { wrapper: MemoryRouter });
    await user.click(await screen.findByTitle('Coach check-in'));

    expect(api.getDefault).not.toHaveBeenCalled();

    act(() => {
      resolveSaved({
        data: {
          data: {
            conversation: saved,
            persona: {
              id: 'p2',
              name: 'Riley',
              archetype: 'coach',
              avatarId: 'coach-female-01',
              traits: {},
            },
          },
        },
      });
    });

    expect(await screen.findByText('Riley')).toBeInTheDocument();
    expect(useChatStore.getState().activeConversationId).toBe('b');
  });

  it('attempts default bootstrap once when the request fails', async () => {
    useChatStore.setState({
      activeConversation: null,
      activeConversationId: null,
      isLoadingConversation: false,
    });
    api.getDefault.mockRejectedValue({ response: { data: { message: 'offline' } } });

    render(<ChatPage />, { wrapper: MemoryRouter });

    expect(await screen.findByText('offline')).toBeInTheDocument();
    await waitFor(() => expect(api.getDefault).toHaveBeenCalledTimes(1));
  });

  it('keeps the persona type visible when archetype metadata fails', async () => {
    const activeConversation = useChatStore.getState().activeConversation!;
    usePersonaStore.setState({
      personas: [{ id: 'p1', name: 'Morgan', archetype: 'therapist', avatarId: 'a' } as any],
      archetypes: [],
    });
    useChatStore.setState({
      activeConversation: {
        ...activeConversation,
        messages: [
          {
            _id: 'm1',
            role: 'assistant',
            content: 'Take your time.',
            timestamp: '2026-09-17T17:00:00.000Z',
          },
        ],
      },
    });
    personaApiMock.getArchetypes.mockRejectedValue(new Error('offline'));

    render(<ChatPage />, { wrapper: MemoryRouter });

    expect(await screen.findByText('The Therapist')).toBeInTheDocument();
    expect(screen.getByText('morgan · the therapist')).toBeInTheDocument();
  });

  it('opens the drawer and locks body scroll, restoring it on close', async () => {
    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /open conversations/i }));

    expect(await screen.findByRole('dialog', { name: /conversations/i })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: /close conversations/i }));

    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });

  it('closes the drawer on Escape', async () => {
    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: /open conversations/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(useChatStore.getState().isSidebarOpen).toBe(false));
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });

  it('releases the scroll lock when the viewport grows to desktop', async () => {
    const user = userEvent.setup();
    render(<ChatPage />, { wrapper: MemoryRouter });

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
    render(<ChatPage />, { wrapper: MemoryRouter });

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
      render(<ChatPage />, { wrapper: MemoryRouter });
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
