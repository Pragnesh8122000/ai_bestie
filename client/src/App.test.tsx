// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

vi.mock('./api/auth', () => ({
  authApi: { getMe: vi.fn() },
}));
vi.mock('./pages/LoginPage', () => ({ default: () => <div>Sign-in surface</div> }));
vi.mock('./pages/RegisterPage', () => ({ default: () => <div>Register surface</div> }));
vi.mock('./pages/ChatPage', () => ({ default: () => <div>Chat surface</div> }));
vi.mock('./pages/GuestChatPage', () => ({ default: () => <div>Guest surface</div> }));
vi.mock('./pages/SwitchPersonaPage', () => ({ default: () => <div>Persona selector</div> }));

import App from './App';
import { authApi } from './api/auth';
import { useAuthStore } from './stores/authStore';

const getMe = authApi.getMe as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isGuest: false,
    isLoading: true,
    error: null,
  });
});

afterEach(cleanup);

describe('protected-route auth bootstrap', () => {
  it('waits for session restoration before rendering a direct chat route', async () => {
    let resolveSession: (value: unknown) => void = () => {};
    getMe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('connecting')).toBeInTheDocument();
    expect(screen.queryByText('Chat surface')).not.toBeInTheDocument();
    expect(screen.queryByText('Guest surface')).not.toBeInTheDocument();

    resolveSession({
      data: { data: { user: { id: 'u1', name: 'Tester', email: 't@example.com' } } },
    });
    expect(await screen.findByText('Chat surface')).toBeInTheDocument();
  });

  it('waits for session restoration before rendering a direct persona-selector route', async () => {
    let resolveSession: (value: unknown) => void = () => {};
    getMe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );

    render(
      <MemoryRouter initialEntries={['/switch-persona']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('connecting')).toBeInTheDocument();
    expect(screen.queryByText('Persona selector')).not.toBeInTheDocument();
    expect(screen.queryByText('Sign-in surface')).not.toBeInTheDocument();

    resolveSession({
      data: { data: { user: { id: 'u1', name: 'Tester', email: 't@example.com' } } },
    });
    expect(await screen.findByText('Persona selector')).toBeInTheDocument();
  });

  it('settles a signed-out direct route on sign-in without a not-found surface', async () => {
    getMe.mockRejectedValue({ response: { status: 401 } });

    render(
      <MemoryRouter initialEntries={['/switch-persona']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Sign-in surface')).toBeInTheDocument();
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });
});
