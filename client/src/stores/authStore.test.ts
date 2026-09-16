// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/auth', () => ({
  authApi: { getMe: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
}));
vi.mock('../api/persona', () => ({ personaApi: { list: vi.fn() } }));
vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
}));
import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';
import { usePersonaStore } from './personaStore';
import { authApi } from '../api/auth';
import { personaApi } from '../api/persona';

const user = { id: 'user', name: 'Tester', email: 'test@example.invalid' };
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user, isAuthenticated: true, isLoading: false, error: null });
  useChatStore.setState({
    activeConversation: { id: 'private' } as any,
    activeConversationId: 'private',
    conversations: [{ id: 'private' } as any],
  });
  usePersonaStore.setState({
    personas: [{ id: 'private-persona' } as any],
    activePersonaId: 'private-persona',
  });
});

describe('auth isolation', () => {
  it('ignores a persona response from the previous session after logout', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(personaApi.list).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = usePersonaStore.getState().fetchPersonas();
    vi.mocked(authApi.logout).mockResolvedValue({} as any);
    await useAuthStore.getState().logout();
    resolve({ data: { data: { personas: [{ id: 'old-private-persona' }] } } });
    await pending;
    expect(usePersonaStore.getState().personas).toEqual([]);
  });

  it('clears private data immediately when signing out even on a failed network', async () => {
    vi.mocked(authApi.logout).mockRejectedValue(new TypeError('offline'));
    const logout = useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useChatStore.getState().activeConversation).toBeNull();
    expect(usePersonaStore.getState().personas).toEqual([]);
    await logout;
    expect(useAuthStore.getState().error).toMatch(/retry/i);
  });

  it('does not let an old session check log the user back in after logout', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(authApi.getMe).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const initialize = useAuthStore.getState().initialize();
    vi.mocked(authApi.logout).mockResolvedValue({} as any);
    await useAuthStore.getState().logout();
    resolve({ data: { data: { user } } });
    await initialize;
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('clears private state when a fetch or axios request reports an expired session', () => {
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useChatStore.getState().conversations).toEqual([]);
  });
});
