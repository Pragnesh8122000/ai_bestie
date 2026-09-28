import { describe, expect, it } from 'vitest';
import { createBargeInDetector } from './bargeIn';

describe('barge-in detector', () => {
  it('ignores likely speaker echo and accepts distinct speech', () => {
    const accept = createBargeInDetector(() => 'I can help you plan that trip today.');
    expect(accept('I can help')).toBe(false);
    expect(accept('wait actually')).toBe(true);
  });

  it('requires one interim word to persist but accepts it when final', () => {
    let now = 100;
    const accept = createBargeInDetector(
      () => '',
      () => now,
    );
    expect(accept('stop')).toBe(false);
    now += 299;
    expect(accept('stop')).toBe(false);
    now += 1;
    expect(accept('stop')).toBe(true);

    const final = createBargeInDetector(() => '');
    expect(final('stop', true)).toBe(true);
  });
});
