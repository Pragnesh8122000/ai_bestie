// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../api/avatar', () => ({
  avatarApi: { list: vi.fn() },
}));

vi.mock('../api/persona', () => ({
  personaApi: { getArchetypes: vi.fn(), list: vi.fn() },
}));

import CreatePersonaPage from './CreatePersonaPage';
import { avatarApi } from '../api/avatar';
import { personaApi } from '../api/persona';
import { usePersonaStore } from '../stores/personaStore';
import { useChatStore } from '../stores/chatStore';

const api = avatarApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const personaApiMock = personaApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

const avatars = [
  { id: 'mentor-male-01', name: 'Marcus', src: '/avatars/mentor-male-01.svg', category: 'mentor' },
  { id: 'friend-male-01', name: 'Jake', src: '/avatars/friend-male-01.svg', category: 'friend' },
];

const archetypes = [
  { type: 'mentor', displayName: 'The Mentor', corePurpose: '', defaultTraits: {}, traitRanges: {} },
  { type: 'friend', displayName: 'The Friend', corePurpose: '', defaultTraits: {}, traitRanges: {} },
  { type: 'therapist', displayName: 'The Therapist', corePurpose: '', defaultTraits: {}, traitRanges: {} },
  { type: 'coach', displayName: 'The Coach', corePurpose: '', defaultTraits: {}, traitRanges: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockClear();
  api.list.mockResolvedValue({ data: { data: { avatars } } });
  personaApiMock.getArchetypes.mockResolvedValue({ data: { data: { archetypes } } });
  personaApiMock.list.mockResolvedValue({ data: { data: { personas: [] } } });
  usePersonaStore.setState({ personas: [], activePersonaId: null, error: null, archetypes: [] });
});

afterEach(cleanup);

describe('CreatePersonaPage', () => {
  it('renders the avatar gallery with visible names', async () => {
    render(<CreatePersonaPage />);
    expect(await screen.findByRole('radio', { name: 'Marcus' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Jake' })).toBeInTheDocument();
  });

  it('groups avatars under their archetype display name', async () => {
    render(<CreatePersonaPage />);

    expect(await screen.findByRole('heading', { name: 'The Mentor' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The Friend' })).toBeInTheDocument();
  });

  it('falls back to the archetype display name when metadata has not loaded yet', async () => {
    personaApiMock.getArchetypes.mockReturnValue(new Promise(() => {}));
    render(<CreatePersonaPage />);

    expect(await screen.findByRole('heading', { name: 'The Mentor' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The Friend' })).toBeInTheDocument();
  });

  it('shows the selected avatar archetype on the creating confirmation panel', async () => {
    const user = userEvent.setup();
    render(<CreatePersonaPage />);

    await user.click(await screen.findByRole('radio', { name: 'Jake' }));

    expect(screen.getByText('Creating')).toBeInTheDocument();
    expect(screen.getAllByText('The Friend').length).toBeGreaterThan(1);
  });

  it('selecting an avatar reveals a collapsed rename drawer defaulting to the manifest name', async () => {
    const user = userEvent.setup();
    render(<CreatePersonaPage />);

    await user.click(await screen.findByRole('radio', { name: 'Marcus' }));

    expect(screen.getAllByText('Marcus').length).toBeGreaterThan(1);
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Marcus');
  });

  it('creates a persona with the avatar-derived archetype and navigates to chat', async () => {
    const createPersona = vi.fn().mockResolvedValue({ id: 'p1' });
    usePersonaStore.setState({ createPersona: createPersona as any });
    const user = userEvent.setup();
    render(<CreatePersonaPage />);

    await user.click(await screen.findByRole('radio', { name: 'Jake' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createPersona).toHaveBeenCalledWith({
        name: 'Jake',
        archetype: 'friend',
        avatarId: 'friend-male-01',
      }),
    );
    expect(navigateMock).toHaveBeenCalledWith('/');
  });

  it('sends the renamed name instead of the manifest default', async () => {
    const createPersona = vi.fn().mockResolvedValue({ id: 'p1' });
    usePersonaStore.setState({ createPersona: createPersona as any });
    const user = userEvent.setup();
    render(<CreatePersonaPage />);

    await user.click(await screen.findByRole('radio', { name: 'Marcus' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Big M');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createPersona).toHaveBeenCalledWith({
        name: 'Big M',
        archetype: 'mentor',
        avatarId: 'mentor-male-01',
      }),
    );
  });

  it('selecting an avatar already tied to a persona starts a chat directly, without creating anything', async () => {
    const createPersona = vi.fn().mockResolvedValue({ id: 'new' });
    const startNewConversation = vi.fn().mockResolvedValue('conv1');
    const existingPersona = {
      id: 'p-existing',
      name: 'Jake',
      archetype: 'friend' as const,
      avatarId: 'friend-male-01',
      traits: { directness: 0, warmth: 0, proactivity: 0, depth: 0, accountability: 0 },
    };
    personaApiMock.list.mockResolvedValue({ data: { data: { personas: [existingPersona] } } });
    usePersonaStore.setState({ createPersona: createPersona as any });
    useChatStore.setState({ startNewConversation: startNewConversation as any });

    const user = userEvent.setup();
    render(<CreatePersonaPage />);

    await screen.findByRole('radio', { name: 'Jake' });
    await waitFor(() => expect(usePersonaStore.getState().personas).toHaveLength(1));

    await user.click(screen.getByRole('radio', { name: 'Jake' }));

    await waitFor(() => expect(startNewConversation).toHaveBeenCalled());
    expect(createPersona).not.toHaveBeenCalled();
    expect(screen.queryByText('Creating')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
    expect(navigateMock).toHaveBeenCalledWith('/');
  });
});
