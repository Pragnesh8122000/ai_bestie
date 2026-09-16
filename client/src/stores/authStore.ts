import { create } from 'zustand';
import { authApi, AuthUser, RegisterInput, LoginInput } from '../api/auth';

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  // Guest mode is a purely client-side, in-memory flag (Option A: no guest
  // token or session is ever issued). It grants no API access by itself —
  // every write endpoint still requires a real `requireAuth` cookie, so a
  // tampered or forged client can never turn this flag into a real session.
  isGuest: boolean;

  initialize: () => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  login: (data: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  enterGuest: () => void;
  exitGuest: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  isGuest: false,

  initialize: async () => {
    try {
      set({ isLoading: true });
      const response = await authApi.getMe();
      set({
        user: response.data.data.user,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  register: async (data: RegisterInput) => {
    try {
      set({ isLoading: true, error: null });
      const response = await authApi.register(data);
      set({
        user: response.data.data.user,
        isAuthenticated: true,
        isGuest: false,
        isLoading: false,
      });
    } catch (error: any) {
      const message = error.response?.data?.message || 'Registration failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  login: async (data: LoginInput) => {
    try {
      set({ isLoading: true, error: null });
      const response = await authApi.login(data);
      set({
        user: response.data.data.user,
        isAuthenticated: true,
        isGuest: false,
        isLoading: false,
      });
    } catch (error: any) {
      const message = error.response?.data?.message || 'Login failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      set({ user: null, isAuthenticated: false, isGuest: false, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),

  enterGuest: () => set({ isGuest: true, isAuthenticated: false, user: null }),
  exitGuest: () => set({ isGuest: false }),
}));

// Listen for 401 events from the axios interceptor
if (typeof window !== 'undefined') {
  window.addEventListener('auth:unauthorized', () => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });
}