import { create } from 'zustand';
import { authApi, AuthUser, RegisterInput, LoginInput } from '../api/auth';
import { resetChatSession } from './chatStore';

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  login: (data: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

let authRequestId = 0;

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  initialize: async () => {
    const requestId = ++authRequestId;
    try {
      set({ isLoading: true });
      const response = await authApi.getMe();
      if (requestId !== authRequestId) return;
      set({
        user: response.data.data.user,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      if (requestId !== authRequestId) return;
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  register: async (data: RegisterInput) => {
    const requestId = ++authRequestId;
    resetChatSession();
    try {
      set({ isLoading: true, error: null });
      const response = await authApi.register(data);
      if (requestId !== authRequestId) return;
      set({
        user: response.data.data.user,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error: any) {
      if (requestId !== authRequestId) return;
      const message = error.response?.data?.message || 'Registration failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  login: async (data: LoginInput) => {
    const requestId = ++authRequestId;
    resetChatSession();
    try {
      set({ isLoading: true, error: null });
      const response = await authApi.login(data);
      if (requestId !== authRequestId) return;
      set({
        user: response.data.data.user,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error: any) {
      if (requestId !== authRequestId) return;
      const message = error.response?.data?.message || 'Login failed';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    const requestId = ++authRequestId;
    resetChatSession();
    set({ user: null, isAuthenticated: false, isLoading: false });
    try {
      await authApi.logout();
    } catch {
      if (requestId === authRequestId)
        set({ error: 'Could not reach the server to sign out. Please retry when online.' });
    } finally {
      if (requestId === authRequestId)
        set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));

// Listen for 401 events from the axios interceptor
if (typeof window !== 'undefined') {
  window.addEventListener('auth:unauthorized', () => {
    ++authRequestId;
    resetChatSession();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });
}
