// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import VoiceOrb from './VoiceOrb';

afterEach(cleanup);

describe('VoiceOrb amplitude', () => {
  it('exposes normalized microphone/playback energy to the visual core', () => {
    render(<VoiceOrb state="speaking" level={0.65} />);

    expect(screen.getByRole('img')).toHaveStyle('--orb-level: 0.65');
  });

  it('clamps out-of-range analyser values', () => {
    const { rerender } = render(<VoiceOrb state="listening" level={4} />);
    expect(screen.getByRole('img')).toHaveStyle('--orb-level: 1');

    rerender(<VoiceOrb state="listening" level={-1} />);
    expect(screen.getByRole('img')).toHaveStyle('--orb-level: 0');
  });
});
