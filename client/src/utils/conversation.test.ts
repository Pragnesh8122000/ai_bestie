import { describe, it, expect } from 'vitest';
import { deriveTitle, toPreview, formatRelative } from './conversation';

describe('deriveTitle (client mirror of the server rule)', () => {
  it('matches the server for the documented cases', () => {
    expect(deriveTitle('Hi')).toBe('Hi');
    expect(deriveTitle('  hello   there\n\nfriend  ')).toBe('hello there friend');
    expect(deriveTitle('"what should I do tonight"')).toBe('what should I do tonight');
    expect(deriveTitle('')).toBe('New Conversation');
    expect(deriveTitle('x'.repeat(80))).toBe(`${'x'.repeat(50)}…`);
    expect(
      deriveTitle('I need help planning a trip to Lisbon next month with my whole family'),
    ).toBe('I need help planning a trip to Lisbon next month…');
  });
});

describe('toPreview', () => {
  it('collapses and clips', () => {
    expect(toPreview(' a \n b ')).toBe('a b');
    expect(toPreview('z'.repeat(200))).toHaveLength(120);
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');

  it('renders sub-minute as "now"', () => {
    expect(formatRelative('2026-08-18T11:59:30.000Z', now)).toBe('now');
  });

  it('renders minutes and hours', () => {
    expect(formatRelative('2026-08-18T11:45:00.000Z', now)).toBe('15m');
    expect(formatRelative('2026-08-18T09:00:00.000Z', now)).toBe('3h');
  });

  it('renders a weekday within the last week', () => {
    expect(formatRelative('2026-08-15T12:00:00.000Z', now)).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('renders a day and month beyond a week', () => {
    expect(formatRelative('2026-03-12T12:00:00.000Z', now)).toMatch(/Mar/);
  });

  it('includes the year for older dates', () => {
    expect(formatRelative('2025-03-12T12:00:00.000Z', now)).toMatch(/2025/);
  });

  it('returns empty for missing or unparseable input', () => {
    expect(formatRelative(undefined, now)).toBe('');
    expect(formatRelative('not-a-date', now)).toBe('');
  });
});
