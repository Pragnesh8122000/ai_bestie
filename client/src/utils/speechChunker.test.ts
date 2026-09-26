import { describe, expect, it } from 'vitest';
import { SpeechChunker, splitChunks } from './speechChunker';

/** Stream `reply` through a chunker `size` characters at a time. */
function stream(reply: string, size = 3, chunker = new SpeechChunker()) {
  const chunks: string[] = [];
  const readyAt: number[] = [];
  for (let i = 0; i < reply.length; i += size) {
    for (const c of chunker.push(reply.slice(i, i + size))) {
      chunks.push(c);
      readyAt.push(i + size);
    }
  }
  for (const c of chunker.flush()) {
    chunks.push(c);
    readyAt.push(reply.length);
  }
  return { chunks, readyAt };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('SpeechChunker', () => {
  it('merges a one-word opener with the next sentence', () => {
    const { chunks } = stream('Yes! That sounds really good to me. Want to talk about it?');
    expect(chunks[0]).toBe('Yes! That sounds really good to me.');
  });

  it('lets a two-word opener go first so audio starts at once', () => {
    // Benchmarked: holding "Oh no!" for more words delayed first audio ~1s
    // on short replies; the chunk after it is sized to be ready in time.
    const { chunks } = stream('Oh no! That sounds really frustrating. Want to talk about it?');
    expect(chunks[0]).toBe('Oh no!');
    expect(chunks[1].length).toBeLessThanOrEqual(60);
  });

  it('speaks a normal first sentence on its own, before the reply finishes', () => {
    const reply = 'I am so glad you told me that. It really does sound like a lot to carry.';
    const { chunks, readyAt } = stream(reply);
    expect(chunks[0]).toBe('I am so glad you told me that.');
    expect(readyAt[0]).toBeLessThan(reply.length);
  });

  it('cuts a long opening sentence at a clause so audio starts early', () => {
    const reply =
      "Honestly, when you're feeling this stretched, the best first step is picking one small thing you can finish today, even if it's tiny.";
    const { chunks, readyAt } = stream(reply);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(80);
    expect(chunks[0]).toMatch(/,$/);
    expect(readyAt[0]).toBeLessThan(reply.length); // before the sentence finished streaming
  });

  it('never joins sentences past the growth budget; only a lone sentence may exceed it', () => {
    const reply =
      'Hey, I hear you. Starting a new job is a lot, even when it is something you wanted. ' +
      'It is totally normal to feel wobbly for the first couple of weeks, and it usually passes. ' +
      'What has been the hardest part so far, the people, the pace, or just not knowing where anything is yet?';
    const { chunks } = stream(reply);
    for (let i = 1; i < chunks.length; i++) {
      // growth 1.6 over the previous chunk, with a 60-character floor.
      const budget = Math.max(60, Math.round(chunks[i - 1].length * 1.6));
      if (chunks[i].length > budget) {
        // Over budget only when one sentence had no clause to cut at in time.
        expect(chunks[i].slice(0, -1)).not.toMatch(/[.!?]\s/);
      }
    }
    expect(chunks.join(' ')).toBe(reply);
  });

  it('keeps short later sentences together instead of one request each', () => {
    const { chunks } = stream(
      'I am really proud of you for this. Yes. You did it. It shows. Truly. Well done.',
    );
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it('loses no words and keeps their order', () => {
    const reply =
      'First thought here, with a clause. Second one follows. A third, longer sentence that keeps going for a while, with commas, and more words. Last.';
    for (const size of [1, 2, 5, 17]) {
      const { chunks } = stream(reply, size);
      expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(reply);
    }
  });

  it('never emits Markdown syntax, URLs or emoji', () => {
    const reply =
      "Here's the plan 😊. You're **not** stuck, honestly, not even a little bit, whatever it feels like tonight.\n\n" +
      '1. **Walk it off** — twenty minutes\n' +
      '2. Call `sam` about it\n\n' +
      'Try:\n```ts\nconst a = 1;\n```\n\n' +
      'More at [the docs](https://example.com) or https://example.org/x. Talk soon.';
    for (const size of [1, 4, 9]) {
      const all = stream(reply, size).chunks.join(' ');
      for (const bad of ['**', '```', '](', 'http', '`', '😊']) {
        expect(all, `leaked ${bad}`).not.toContain(bad);
      }
      expect(all).toContain('Walk it off');
      expect(all).toContain('code block');
      expect(all).toContain('example.org');
    }
  });

  it('speaks a one-word reply and ignores an empty one', () => {
    expect(stream('Yes.').chunks).toEqual(['Yes.']);
    expect(stream('').chunks).toEqual([]);
    expect(stream('😊😊').chunks).toEqual([]);
  });

  it('respects the hard maximum even for a run-on without punctuation', () => {
    const reply = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const { chunks } = stream(reply);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(280);
    expect(chunks.join(' ')).toBe(reply);
  });

  it('keeps list items as speakable units', () => {
    const { chunks } = stream('Three ideas for tonight:\n\n- walk\n- stretch\n- sleep early\n');
    expect(chunks.join(' ')).toBe('Three ideas for tonight: walk stretch sleep early');
    expect(words(chunks[0])).toBeGreaterThanOrEqual(3);
  });
});

describe('splitChunks', () => {
  it('caps pieces at the given size on sentence boundaries', () => {
    const text = 'One two three four. Five six seven eight. Nine ten.';
    expect(splitChunks(text, 25)).toEqual([
      'One two three four.',
      'Five six seven eight.',
      'Nine ten.',
    ]);
  });
});
