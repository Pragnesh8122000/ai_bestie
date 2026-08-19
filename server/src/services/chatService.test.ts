import { describe, it, expect } from 'vitest';
import { deriveTitle } from './chatService';
import { toPreview, PREVIEW_MAX_LENGTH } from '../models/Conversation';

describe('deriveTitle', () => {
  it('keeps a short message verbatim', () => {
    expect(deriveTitle('Hi')).toBe('Hi');
  });

  it('collapses whitespace and newlines', () => {
    expect(deriveTitle('  hello   there\n\nfriend  ')).toBe('hello there friend');
  });

  it('strips a wrapping quote pair', () => {
    expect(deriveTitle('"what should I do tonight"')).toBe('what should I do tonight');
    expect(deriveTitle('“smart quotes too”')).toBe('smart quotes too');
  });

  it('leaves an unbalanced quote alone', () => {
    expect(deriveTitle('"unclosed')).toBe('"unclosed');
  });

  it('clips a long message on a word boundary', () => {
    const title = deriveTitle(
      'I need help planning a trip to Lisbon next month with my whole family',
    );
    expect(title.length).toBeLessThanOrEqual(51); // 50 + ellipsis
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/); // no dangling space before the ellipsis
    expect(title).toBe('I need help planning a trip to Lisbon next month…');
  });

  it('hard-clips when there is no usable word boundary', () => {
    const title = deriveTitle('x'.repeat(80));
    expect(title).toBe(`${'x'.repeat(50)}…`);
  });

  it('does not gut a title when the only space is very early', () => {
    const title = deriveTitle(`a ${'b'.repeat(80)}`);
    expect(title.length).toBe(51);
  });

  it('falls back to the default for empty or whitespace input', () => {
    expect(deriveTitle('')).toBe('New Conversation');
    expect(deriveTitle('   ')).toBe('New Conversation');
    expect(deriveTitle('""')).toBe('New Conversation');
  });

  it('handles emoji-only messages', () => {
    expect(deriveTitle('\u{1F44B}')).toBe('\u{1F44B}');
  });
});

describe('toPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(toPreview('  a\n\n b  ')).toBe('a b');
  });

  it('clips to the preview maximum', () => {
    expect(toPreview('y'.repeat(300))).toHaveLength(PREVIEW_MAX_LENGTH);
  });

  it('returns an empty string for empty input', () => {
    expect(toPreview('')).toBe('');
  });
});
