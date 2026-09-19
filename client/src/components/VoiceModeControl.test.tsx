// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('../utils/speech', () => ({
  speakChunk: vi.fn(),
  beginSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsStateListener: vi.fn(),
}));

import VoiceModeControl from './VoiceModeControl';
import { useChatStore } from '../stores/chatStore';
import { stopSpeaking } from '../utils/speech';

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ ttsEnabled: false });
});

afterEach(cleanup);

describe('VoiceModeControl', () => {
  it('makes the default off state unmistakably inactive', () => {
    render(<VoiceModeControl />);

    const control = screen.getByRole('switch', { name: 'Voice replies off' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveAttribute('data-state', 'off');
    expect(screen.getByText('Off · Replies are silent')).toBeInTheDocument();
    expect(screen.getByTestId('voice-switch-thumb')).toHaveTextContent('×');
    expect(screen.getByTestId('voice-switch-thumb')).toHaveClass('translate-x-0.5');
  });

  it('communicates on through text, icon treatment, and switch position', async () => {
    const user = userEvent.setup();
    render(<VoiceModeControl />);

    await user.click(screen.getByRole('switch', { name: 'Voice replies off' }));

    const control = screen.getByRole('switch', { name: 'Voice replies on' });
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveAttribute('data-state', 'on');
    expect(screen.getByText('On · Replies play aloud')).toBeInTheDocument();
    expect(screen.getByTestId('voice-switch-thumb')).toHaveTextContent('✓');
    expect(screen.getByTestId('voice-switch-thumb')).toHaveClass('translate-x-6');

    await user.click(control);
    expect(stopSpeaking).toHaveBeenCalled();
  });

  it('uses the same explicit contract in compact mode', () => {
    render(<VoiceModeControl compact />);

    const control = screen.getByRole('switch', { name: 'Voice replies off' });
    expect(control).toHaveTextContent('Voice · Off');
    expect(control).toHaveAttribute('aria-checked', 'false');
  });
});
