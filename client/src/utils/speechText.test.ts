import { describe, it, expect } from 'vitest';
import { stripForSpeech, takeSpeech } from './speechText';

describe('stripForSpeech', () => {
  it('returns plain prose unchanged', () => {
    expect(stripForSpeech('hey, how did the interview go?')).toBe(
      'hey, how did the interview go?',
    );
  });

  it('handles empty input', () => {
    expect(stripForSpeech('')).toBe('');
  });

  it('speaks the words inside bold and italics, not the markers', () => {
    expect(stripForSpeech('that is **really** _very_ important')).toBe(
      'that is really very important',
    );
  });

  it('handles bold-italic and underscore bold', () => {
    expect(stripForSpeech('***wow*** and __big__')).toBe('wow and big');
  });

  it('drops strikethrough markers', () => {
    expect(stripForSpeech('~~nope~~ yes')).toBe('nope yes');
  });

  it('leaves snake_case identifiers alone', () => {
    // A lone underscore pair inside a word is not emphasis.
    expect(stripForSpeech('call some_helper_fn now')).toBe('call some_helper_fn now');
  });

  it('leaves arithmetic asterisks alone', () => {
    expect(stripForSpeech('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('speaks heading text without the hashes', () => {
    expect(stripForSpeech('## The short version')).toBe('The short version');
  });

  it('speaks list items without the bullets', () => {
    expect(stripForSpeech('- walk\n- call a friend')).toBe('walk call a friend');
  });

  it('drops the numbers from an ordered list', () => {
    // "one dot walk it off" is not how a friend talks.
    expect(stripForSpeech('1. walk it off\n2. call someone')).toBe(
      'walk it off call someone',
    );
  });

  it('drops nested list indentation and markers', () => {
    expect(stripForSpeech('- phone away\n  - especially at night')).toBe(
      'phone away especially at night',
    );
  });

  it('drops task-list checkboxes', () => {
    expect(stripForSpeech('- [x] done\n- [ ] todo')).toBe('done todo');
  });

  it('replaces a fenced code block with a short placeholder', () => {
    const out = stripForSpeech('try this:\n\n```ts\nconst a = 1;\n```\n\nmake sense?');
    expect(out).toBe('try this: code block make sense?');
    expect(out).not.toContain('const');
  });

  it('replaces an unterminated fence too', () => {
    // A stream cut short must not dump raw source into the voice queue.
    const out = stripForSpeech('here:\n```js\nconst a = 1;');
    expect(out).toBe('here: code block');
  });

  it('never leaves a backtick behind', () => {
    expect(stripForSpeech('run `npm test` now')).toBe('run npm test now');
  });

  it('speaks a link label, not its url', () => {
    const out = stripForSpeech('see [the docs](https://example.com/a_b_c) ok');
    expect(out).toBe('see the docs ok');
    expect(out).not.toContain('http');
  });

  it('drops a bare autolink url', () => {
    expect(stripForSpeech('go <https://example.com> now')).toBe('go now');
  });

  it('speaks an image alt text', () => {
    expect(stripForSpeech('![a cat](cat.png) cute')).toBe('a cat cute');
  });

  it('drops blockquote markers', () => {
    expect(stripForSpeech('> the one that matters')).toBe('the one that matters');
  });

  it('drops horizontal rules', () => {
    expect(stripForSpeech('before\n\n---\n\nafter')).toBe('before after');
  });

  it('reads a table as comma-separated values, not pipes', () => {
    const out = stripForSpeech('| Thing | Effort |\n| --- | --- |\n| Walk | Low |');
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
    expect(out).toContain('Thing, Effort');
    expect(out).toContain('Walk, Low');
  });

  it('drops escaped-character backslashes', () => {
    expect(stripForSpeech('a \\* b')).toBe('a * b');
  });

  it('strips html tags the renderer would have escaped', () => {
    expect(stripForSpeech('hi <b>there</b>')).toBe('hi there');
  });

  it('collapses the whitespace left behind', () => {
    expect(stripForSpeech('a\n\n\nb   c')).toBe('a b c');
  });

  it('leaves no markdown delimiter in a full realistic reply', () => {
    const reply = `Hey, here's what I'd try.

## The short version

You're **not** stuck. Three things:

1. **Walk it off** — twenty minutes
2. *Write it down* — get it out

> The one that matters is the one you'll do.

- Drink water
- ~~Doomscroll~~ Read on paper

Run \`npm run journal\`:

\`\`\`ts
const tonight = { walk: true };
\`\`\`

| Thing | Effort |
| --- | --- |
| Walk | Low |

More at [the docs](https://example.com).`;

    const out = stripForSpeech(reply);
    for (const bad of ['**', '```', '##', '~~', '|', '](', 'http', '`', '>']) {
      expect(out, `leaked ${bad}`).not.toContain(bad);
    }
    expect(out).toContain('The short version');
    expect(out).toContain('Walk it off');
    expect(out).toContain('code block');
    expect(out).toContain('the docs');
  });
});

describe('takeSpeech', () => {
  it('waits until two sentences are available', () => {
    const r = takeSpeech('One thing. ');
    expect(r.speech).toBe('');
    expect(r.rest).toBe('One thing. ');
  });

  it('emits once two sentences are complete', () => {
    const r = takeSpeech('One thing. Two things. And more');
    expect(r.speech).toBe('One thing. Two things.');
    // The remainder keeps its original spacing; only the emitted text is
    // normalized, since that is what reaches the voice.
    expect(r.rest.trim()).toBe('And more');
  });

  it('strips markdown from what it emits', () => {
    const r = takeSpeech('That is **really** good. So is _this_. more');
    expect(r.speech).toBe('That is really good. So is this.');
  });

  it('does not split on a decimal point', () => {
    const r = takeSpeech('It costs 3.50 today. And 4.25 tomorrow. rest');
    expect(r.speech).toBe('It costs 3.50 today. And 4.25 tomorrow.');
  });

  it('does not treat an ordered-list number as a sentence end', () => {
    // "1." must not flush a chunk containing only "1".
    const r = takeSpeech('1. Walk it off\n2. Call a friend\n');
    expect(r.speech).not.toMatch(/^\s*$/);
    expect(r.speech).toContain('Walk it off');
  });

  it('keeps a fenced block whole', () => {
    const r = takeSpeech('Try:\n```ts\nconst a = 1;\nconst b = 2;\n```\nDone. Ok. x');
    expect(r.speech).toContain('code block');
    expect(r.speech).not.toContain('const');
  });

  it('waits for an unterminated fence rather than speaking source', () => {
    const r = takeSpeech('Try:\n```ts\nconst a = 1;');
    expect(r.speech).toBe('');
    expect(r.rest).toBe('Try:\n```ts\nconst a = 1;');
  });

  it('speaks an unterminated fence as a placeholder on flush', () => {
    const r = takeSpeech('Try:\n```ts\nconst a = 1;', true);
    expect(r.speech).toBe('Try: code block');
    expect(r.rest).toBe('');
  });

  it('flushes whatever remains at end of stream', () => {
    const r = takeSpeech('Just one thought.', true);
    expect(r.speech).toBe('Just one thought.');
    expect(r.rest).toBe('');
  });

  it('flushes an incomplete sentence at end of stream', () => {
    const r = takeSpeech('trailing words with no period', true);
    expect(r.speech).toBe('trailing words with no period');
  });

  it('emits early when a run-on clause gets long', () => {
    const long = 'word '.repeat(80); // 400 chars, no sentence end
    const r = takeSpeech(long);
    expect(r.speech.length).toBeGreaterThan(0);
    expect(r.rest.length).toBeGreaterThan(0);
  });

  it('returns empty for empty input', () => {
    expect(takeSpeech('')).toEqual({ speech: '', rest: '' });
  });

  it('never emits a markdown delimiter while draining a stream', () => {
    // Replay a reply token by token the way the SSE loop does.
    const reply =
      "Here's the plan. You're **not** stuck.\n\n" +
      '1. **Walk it off** — twenty minutes\n' +
      '2. Call `sam` about it\n\n' +
      'Try:\n```ts\nconst a = 1;\n```\n\n' +
      'More at [the docs](https://example.com). Talk soon.';

    let buffer = '';
    const spoken: string[] = [];
    for (const ch of reply) {
      buffer += ch;
      const { speech, rest } = takeSpeech(buffer);
      if (speech) {
        spoken.push(speech);
        buffer = rest;
      }
    }
    const { speech: last } = takeSpeech(buffer, true);
    if (last) spoken.push(last);

    const all = spoken.join(' ');
    for (const bad of ['**', '```', '](', 'http', '`', '##']) {
      expect(all, `leaked ${bad}`).not.toContain(bad);
    }
    // And the actual words still made it through, in order.
    expect(all).toContain('Walk it off');
    expect(all).toContain('code block');
    expect(all).toContain('the docs');
    expect(all).toContain('Talk soon');
  });

  it('loses no words while draining a stream', () => {
    const reply = 'First thought here. Second one follows. Third and last one.';
    let buffer = '';
    const spoken: string[] = [];
    for (const ch of reply) {
      buffer += ch;
      const { speech, rest } = takeSpeech(buffer);
      if (speech) {
        spoken.push(speech);
        buffer = rest;
      }
    }
    const { speech: last } = takeSpeech(buffer, true);
    if (last) spoken.push(last);

    expect(spoken.join(' ').replace(/\s+/g, ' ')).toBe(reply);
  });
});
