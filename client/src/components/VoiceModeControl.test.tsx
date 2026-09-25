// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import VoiceModeControl from './VoiceModeControl';

afterEach(cleanup);

describe('VoiceModeControl', () => {
  it('labels and opens immersive voice chat', async () => {
    const onStart = vi.fn();
    const user = userEvent.setup();
    render(<VoiceModeControl onStart={onStart} />);

    const button = screen.getByRole('button', { name: 'Start voice chat' });
    expect(button).toHaveTextContent('Voice chat');
    expect(screen.getByText('Open immersive conversation')).toBeInTheDocument();
    await user.click(button);

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('uses the same accessible action in compact mode', () => {
    render(<VoiceModeControl compact onStart={() => {}} />);

    expect(screen.getByRole('button', { name: 'Start voice chat' })).toHaveTextContent(
      'Voice chat',
    );
  });
});
