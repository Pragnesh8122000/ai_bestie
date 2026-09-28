import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBargeInDetector } from './bargeIn';

afterEach(() => {
  vi.useRealTimers();
});

describe('barge-in detector', () => {
  it('ignores likely speaker echo and accepts distinct speech', () => {
    const onAccept = vi.fn();
    const detector = createBargeInDetector(() => 'I can help you plan that trip today.', onAccept);
    expect(detector.hear('I can help')).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(detector.hear('wait actually')).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('matches echo on whole words, so a user word inside a longer assistant word still interrupts', () => {
    const onAccept = vi.fn();
    const detector = createBargeInDetector(() => 'I stopped by and it was helpful.', onAccept);
    expect(detector.hear('stop', true)).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);

    const help = createBargeInDetector(() => 'That was helpful.', vi.fn());
    expect(help.hear('help', true)).toBe(true);
  });

  it('treats a short word ending the reply as echo, but not a short word elsewhere', () => {
    const onAccept = vi.fn();
    const detector = createBargeInDetector(() => 'No worries. How about you?', onAccept);
    expect(detector.hear('you')).toBe(false);
    expect(detector.hasPendingSpeech()).toBe(false);
    expect(detector.hear('you', true)).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();

    expect(detector.hear('no', true)).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('requires one interim word to persist but accepts it when final', () => {
    let now = 100;
    const detector = createBargeInDetector(
      () => '',
      vi.fn(),
      () => now,
    );
    expect(detector.hear('stop')).toBe(false);
    now += 299;
    expect(detector.hear('stop')).toBe(false);
    now += 1;
    expect(detector.hear('stop')).toBe(true);
    detector.cancel();

    const final = createBargeInDetector(() => '', vi.fn());
    expect(final.hear('stop', true)).toBe(true);
  });

  it('accepts a stable single word after 300ms even when no further result arrives', async () => {
    vi.useFakeTimers();
    const onAccept = vi.fn();
    const detector = createBargeInDetector(
      () => '',
      onAccept,
      () => Date.now(),
    );

    expect(detector.hear('stop')).toBe(false);
    expect(detector.hasPendingSpeech()).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(onAccept).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(detector.hasPendingSpeech()).toBe(false);
  });

  it('does not accept a word that was replaced by echo or cancelled before 300ms', async () => {
    vi.useFakeTimers();
    const onAccept = vi.fn();
    const detector = createBargeInDetector(
      () => 'Sure, here is the plan.',
      onAccept,
      () => Date.now(),
    );

    detector.hear('wait');
    await vi.advanceTimersByTimeAsync(100);
    detector.hear('here is the plan');
    expect(detector.hasPendingSpeech()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(onAccept).not.toHaveBeenCalled();

    detector.hear('wait');
    detector.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(onAccept).not.toHaveBeenCalled();
  });
});
