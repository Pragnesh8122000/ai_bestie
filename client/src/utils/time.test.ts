import { describe, expect, it } from 'vitest';
import { clock, istYear } from './time';

describe('IST display', () => {
  it('shows clock time in Asia/Kolkata regardless of the device zone', () => {
    expect(clock('2026-10-02T00:00:00.000Z')).toBe('05:30');
    expect(clock('2026-10-01T18:30:00.000Z')).toBe('00:00'); // midnight, never 24:00
    expect(clock(undefined)).toBe('');
    expect(clock('nope')).toBe('');
  });

  it('decides the calendar year in IST', () => {
    expect(istYear(new Date('2025-12-31T18:30:00Z'))).toBe('2026');
    expect(istYear(new Date('2025-12-31T18:29:00Z'))).toBe('2025');
  });
});
