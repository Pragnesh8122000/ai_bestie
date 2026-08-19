import { describe, it, expect } from 'vitest';
import { stabilizePartialMarkdown } from './markdown';

/**
 * Property the whole module exists for: at no point during a stream should the
 * user see a raw Markdown delimiter *as literal text*. Feeding every prefix of a
 * reply through the stabilizer is the closest thing to replaying the real SSE
 * stream.
 *
 * Note the output is Markdown *source*, so a balanced `**bold**` legitimately
 * still contains asterisks — those become formatting, not visible characters.
 * `visibleText` therefore strips the constructs that will render, and asserts on
 * what is actually left on screen.
 */
function prefixes(text: string): string[] {
  return Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1));
}

/** Approximate what the renderer will show, so leaked delimiters stand out. */
function visibleText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')       // fenced code
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
    .replace(/~~([^~]+)~~/g, '$1')         // strikethrough
    .replace(/`([^`]+)`/g, '$1')           // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // links
}

describe('stabilizePartialMarkdown', () => {
  it('leaves complete markdown untouched', () => {
    const done = 'that is **really** good\n\n- one\n- two';
    expect(stabilizePartialMarkdown(done)).toBe(done);
  });

  it('leaves plain prose untouched', () => {
    expect(stabilizePartialMarkdown('hey how are you')).toBe('hey how are you');
  });

  it('handles empty input', () => {
    expect(stabilizePartialMarkdown('')).toBe('');
  });

  it('hides a dangling bold opener', () => {
    expect(stabilizePartialMarkdown('that is **rea')).toBe('that is rea');
  });

  it('restores the bold as soon as it closes', () => {
    expect(stabilizePartialMarkdown('that is **real**')).toBe('that is **real**');
  });

  it('hides a marker typed with no content yet', () => {
    expect(stabilizePartialMarkdown('here it is: **')).toBe('here it is: ');
  });

  it('hides a dangling inline-code backtick', () => {
    expect(stabilizePartialMarkdown('run `npm te')).toBe('run npm te');
  });

  it('hides a dangling strikethrough', () => {
    expect(stabilizePartialMarkdown('not ~~th')).toBe('not th');
  });

  it('closes an unterminated code fence so it renders as a block', () => {
    const out = stabilizePartialMarkdown('```ts\nconst a = 1;');
    expect(out).toBe('```ts\nconst a = 1;\n```');
  });

  it('leaves a closed code fence alone', () => {
    const done = '```ts\nconst a = 1;\n```';
    expect(stabilizePartialMarkdown(done)).toBe(done);
  });

  it('does not touch markers inside an open fence', () => {
    // `**` here is code, not emphasis; stripping it would corrupt the snippet.
    const out = stabilizePartialMarkdown('```\na ** b');
    expect(out).toContain('a ** b');
  });

  it('drops a half-typed link instead of showing the url', () => {
    expect(stabilizePartialMarkdown('see [the docs](https://exa')).toBe('see ');
  });

  it('drops a half-typed link label', () => {
    expect(stabilizePartialMarkdown('see [the do')).toBe('see ');
  });

  it('keeps a completed link', () => {
    const done = 'see [the docs](https://example.com)';
    expect(stabilizePartialMarkdown(done)).toBe(done);
  });

  it('never mistakes a list bullet for an emphasis marker', () => {
    // The `*` bullets must survive: deleting one collapses the list mid-stream.
    const out = stabilizePartialMarkdown('* walk\n* call a friend');
    expect(out).toBe('* walk\n* call a friend');
  });

  it('strips a dangling bold without eating the bullets around it', () => {
    const out = stabilizePartialMarkdown('* walk\n* call **so');
    expect(out).toBe('* walk\n* call so');
  });

  it('preserves the exact bullet character used', () => {
    const out = stabilizePartialMarkdown('+ one\n- two\n+ three **x');
    expect(out).toBe('+ one\n- two\n+ three x');
  });

  it('leaves snake_case identifiers alone', () => {
    // Single underscores are too ambiguous to touch.
    expect(stabilizePartialMarkdown('call some_helper_fn now')).toBe(
      'call some_helper_fn now',
    );
  });

  it('never exposes a bold delimiter at any point in the stream', () => {
    for (const p of prefixes('that is **really** important')) {
      expect(visibleText(stabilizePartialMarkdown(p))).not.toContain('*');
    }
  });

  it('never exposes a backtick at any point in the stream', () => {
    for (const p of prefixes('run `npm test` first')) {
      expect(visibleText(stabilizePartialMarkdown(p))).not.toContain('`');
    }
  });

  it('never exposes a fence delimiter at any point in the stream', () => {
    for (const p of prefixes('try:\n\n```ts\nconst a = 1;\n```\n\ndone')) {
      expect(visibleText(stabilizePartialMarkdown(p))).not.toContain('`');
    }
  });

  it('never exposes a bare url at any point in the stream', () => {
    for (const p of prefixes('see [the docs](https://example.com) ok')) {
      const out = stabilizePartialMarkdown(p);
      // Either the link is incomplete (hidden) or complete (valid markdown).
      if (out.includes('https://')) expect(out).toMatch(/\[[^\]]*\]\([^)]*\)/);
    }
  });

  it('converges on the original text once the stream completes', () => {
    const full = 'plan:\n\n1. **walk** it off\n2. call `sam`\n\n> then rest';
    expect(stabilizePartialMarkdown(full)).toBe(full);
  });

  it('keeps text that follows a completed fence stable', () => {
    const done = '```\ncode\n```\n\nthat **works**';
    expect(stabilizePartialMarkdown(done)).toBe(done);
  });

  it('still balances emphasis after a closed fence', () => {
    expect(stabilizePartialMarkdown('```\ncode\n```\n\nthat **wo')).toBe(
      '```\ncode\n```\n\nthat wo',
    );
  });

  it('does not corrupt asterisks inside a completed fence', () => {
    const done = '```\na ** b\n```';
    expect(stabilizePartialMarkdown(done)).toBe(done);
  });
});
