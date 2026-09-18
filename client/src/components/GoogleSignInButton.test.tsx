// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('../api/auth', () => ({
  authApi: {
    getMe: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    googleLogin: vi.fn(),
    logout: vi.fn(),
  },
}));

import GoogleSignInButton from './GoogleSignInButton';
import { authApi } from '../api/auth';
import { useAuthStore } from '../stores/authStore';

const api = authApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  delete window.google;
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    isGuest: false,
  });
});

afterEach(cleanup);

describe('GoogleSignInButton', () => {
  it('is safely disabled and points to password auth when unconfigured', () => {
    render(<GoogleSignInButton clientId="" />);

    expect(screen.getByRole('button', { name: 'Google sign-in unavailable' })).toBeDisabled();
    expect(screen.getByText('Continue with email and password')).toBeInTheDocument();
  });

  it('renders GIS and exchanges its credential for the canonical session user', async () => {
    let callback: ((response: GoogleCredentialResponse) => void) | undefined;
    const initialize = vi.fn((options: {
      client_id: string;
      callback(response: GoogleCredentialResponse): void;
      ux_mode?: 'popup' | 'redirect';
    }) => {
      callback = options.callback;
    });
    const renderButton = vi.fn((parent: HTMLElement) => {
      const button = document.createElement('button');
      button.textContent = 'Continue with Google';
      parent.appendChild(button);
    });
    window.google = { accounts: { id: { initialize, renderButton } } };
    api.googleLogin.mockResolvedValue({
      data: {
        data: {
          user: {
            id: 'u1',
            email: 'person@gmail.com',
            name: 'Person',
            authProviders: ['google'],
          },
        },
      },
    });

    render(<GoogleSignInButton clientId="web-client-id" />);
    await waitFor(() => expect(renderButton).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      client_id: 'web-client-id',
      ux_mode: 'popup',
    }));

    await act(async () => {
      callback?.({ credential: 'signed-id-token', select_by: 'btn' });
    });
    await waitFor(() => expect(api.googleLogin).toHaveBeenCalledWith({
      credential: 'signed-id-token',
    }));

    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: { id: 'u1', authProviders: ['google'] },
    });
  });
});
