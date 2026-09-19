// @vitest-environment jsdom
/**
 * Regression coverage for the Brave/Safari voice-typing divergence.
 *
 * Brave exposes the same `webkitSpeechRecognition` constructor as Safari and
 * Chrome (it's Chromium), so `isSTTSupported()` is true and the mic button
 * renders there too — the difference only shows up once recognition starts,
 * as a `network` error, because Brave disables the Google backend behind the
 * API. These tests mock `../utils/speech` at the public boundary (not the
 * browser globals) so both paths — and the permission/device/cleanup edge
 * cases around them — are covered without a real recognizer.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const listenOnce = vi.fn();
const isSTTSupported = vi.fn(() => true);
const stopSpeaking = vi.fn();

vi.mock('../utils/speech', () => ({
  listenOnce: (...args: unknown[]) => listenOnce(...args),
  isSTTSupported: () => isSTTSupported(),
  stopSpeaking: () => stopSpeaking(),
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  setTtsStateListener: vi.fn(),
}));

import ChatInput from './ChatInput';
import { useChatStore } from '../stores/chatStore';
import { usePersonaStore } from '../stores/personaStore';

function activeConversation() {
  return {
    id: 'c1',
    title: 'T',
    personaId: 'p1',
    avatarId: 'a',
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    messages: [],
  };
}

/** A controllable fake session, mirroring speech.ts's ListenSession shape. */
function pendingSession() {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const stop = vi.fn();
  return { session: { promise, stop }, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSTTSupported.mockReturnValue(true);
  usePersonaStore.setState({
    personas: [{ id: 'p1', name: 'Sam', archetype: 'friend', avatarId: 'a' } as any],
    activePersonaId: 'p1',
  });
  useChatStore.setState({
    activeConversation: activeConversation() as any,
    activeConversationId: 'c1',
    isStreaming: false,
    isLoadingConversation: false,
    sendMessage: vi.fn(),
  });
});

afterEach(cleanup);

describe('ChatInput voice typing', () => {
  it('hides the mic and shows the fallback hint when the browser has no recognizer', () => {
    isSTTSupported.mockReturnValue(false);
    render(<ChatInput />);

    expect(screen.queryByRole('button', { name: /talk to/i })).not.toBeInTheDocument();
    expect(screen.getByText(/voice needs chrome or safari/i)).toBeInTheDocument();
  });

  it('inserts the transcript into the message field on the Safari-like working path', async () => {
    const user = userEvent.setup();
    const { session, resolve } = pendingSession();
    listenOnce.mockReturnValue(session);
    render(<ChatInput />);

    await user.click(screen.getByRole('button', { name: /talk to/i }));
    expect(stopSpeaking).toHaveBeenCalled();
    resolve('hello there');

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/or type to/i)).toHaveValue('hello there'),
    );
  });

  it('shows an actionable, non-generic error on the Brave-like network failure', async () => {
    const user = userEvent.setup();
    const { session, reject } = pendingSession();
    listenOnce.mockReturnValue(session);
    render(<ChatInput />);

    await user.click(screen.getByRole('button', { name: /talk to/i }));
    reject(new Error('network'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/blocks the speech service/i);
    expect(alert).toHaveTextContent(/chrome, edge, or safari/i);
  });

  it('tells the user to grant mic access when permission is denied', async () => {
    const user = userEvent.setup();
    const { session, reject } = pendingSession();
    listenOnce.mockReturnValue(session);
    render(<ChatInput />);

    await user.click(screen.getByRole('button', { name: /talk to/i }));
    reject(new Error('not-allowed'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/allow microphone access/i);
  });

  it('tells the user no microphone is available when the device is missing', async () => {
    const user = userEvent.setup();
    const { session, reject } = pendingSession();
    listenOnce.mockReturnValue(session);
    render(<ChatInput />);

    await user.click(screen.getByRole('button', { name: /talk to/i }));
    reject(new Error('audio-capture'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no microphone found/i);
  });

  it('stays silent about a deliberate abort (e.g. cleanup on unmount), not a failure', async () => {
    const user = userEvent.setup();
    const { session, reject } = pendingSession();
    listenOnce.mockReturnValue(session);
    render(<ChatInput />);

    await user.click(screen.getByRole('button', { name: /talk to/i }));
    reject(new Error('aborted'));

    await waitFor(() => expect(screen.getByRole('button', { name: /talk to/i })).not.toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stops the recognition session on unmount instead of leaving it running', async () => {
    const user = userEvent.setup();
    const { session } = pendingSession();
    listenOnce.mockReturnValue(session);
    const { unmount } = render(<ChatInput />);

    await user.click(screen.getByRole('button', { name: /talk to/i }));
    expect(session.stop).not.toHaveBeenCalled();

    unmount();

    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores a second mic click while a session is already in flight', async () => {
    const user = userEvent.setup();
    const { session } = pendingSession();
    listenOnce.mockReturnValue(session);
    render(<ChatInput />);

    const button = screen.getByRole('button', { name: /talk to/i });
    await user.click(button);
    // The button disables itself while recording, but drive the handler
    // path directly to confirm no second session is ever requested.
    await user.click(button);

    expect(listenOnce).toHaveBeenCalledTimes(1);
  });
});
