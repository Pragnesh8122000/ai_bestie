import { describe, expect, it } from 'vitest';
import { formatIst, istDay, parseIst } from './time';

describe('Asia/Kolkata time', () => {
  it('formats UTC instants as yyyy-mm-dd hh-mm-ss in IST (+05:30)', () => {
    expect(formatIst(Date.UTC(2026, 9, 2, 0, 0, 0))).toBe('2026-10-02 05-30-00');
    expect(formatIst(new Date('2026-10-01T18:29:59.999Z'))).toBe('2026-10-01 23-59-59');
  });

  it('rolls the calendar day at IST midnight, not UTC midnight', () => {
    expect(istDay(new Date('2026-10-01T18:29:59Z'))).toBe('2026-10-01');
    expect(istDay(new Date('2026-10-01T18:30:00Z'))).toBe('2026-10-02');
  });

  it('never prints hour 24 at midnight', () => {
    expect(formatIst(Date.UTC(2026, 9, 1, 18, 30, 0))).toBe('2026-10-02 00-00-00');
  });

  it('round-trips through parseIst and rejects other formats', () => {
    const ms = Date.UTC(2026, 9, 2, 7, 15, 42);
    expect(parseIst(formatIst(ms))).toBe(ms);
    expect(parseIst('2026-10-02T07:15:42Z')).toBeNaN();
  });
});
