// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../api/persona', () => ({
  personaApi: { list: vi.fn(), getArchetypes: vi.fn() },
}));

vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
}));

import SwitchPersonaPage from './SwitchPersonaPage';
import { personaApi } from '../api/persona';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';

const api = personaApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const personas = [
  {
    id: 'p1',
    name: 'Sam',
    archetype: 'friend' as const,
    avatarId: 'friend-male-01',
    traits: {},
  },
  {
    id: 'p2',
    name: 'Riley',
    archetype: 'coach' as const,
    avatarId: 'coach-female-01',
    traits: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockClear();
  api.list.mockResolvedValue({ data: { data: { personas } } });
  api.getArchetypes.mockResolvedValue({ data: { data: { archetypes: [] } } });
  usePersonaStore.setState({
    personas: [],
    activePersonaId: null,
    archetypes: [],
    isLoading: false,
    error: null,
  });
});

afterEach(cleanup);

describe('SwitchPersonaPage', () => {
  it('lists only existing personas and exposes no creation action', async () => {
    render(<SwitchPersonaPage />);

    expect(await screen.findByRole('button', { name: 'Switch to Sam' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Riley' })).toBeInTheDocument();
    expect(screen.queryByText(/create/i)).not.toBeInTheDocument();
  });

  it('opens the selected persona exactly once and returns to the chat', async () => {
    const openPersonaConversation = vi.fn().mockResolvedValue('coach-chat');
    useChatStore.setState({ openPersonaConversation: openPersonaConversation as any });
    const user = userEvent.setup();
    render(<SwitchPersonaPage />);

    await user.click(await screen.findByRole('button', { name: 'Switch to Riley' }));

    await waitFor(() => expect(openPersonaConversation).toHaveBeenCalledTimes(1));
    expect(openPersonaConversation).toHaveBeenCalledWith('p2');
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows an actionable error and stays on the selector when opening fails', async () => {
    const openPersonaConversation = vi.fn().mockResolvedValue(null);
    useChatStore.setState({ openPersonaConversation: openPersonaConversation as any });
    const user = userEvent.setup();
    render(<SwitchPersonaPage />);

    await user.click(await screen.findByRole('button', { name: 'Switch to Sam' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch persona');
    expect(navigateMock).not.toHaveBeenCalledWith('/', expect.anything());
  });
});
