/**
 * Chunking speech for the voice: how much text goes into each synthesis
 * request. `SpeechChunker` sizes chunks for a streamed reply; `splitChunks`
 * is the backstop that caps any text handed to the audio queue directly.
 */
import { MAX_CHUNK_CHARS, nextUnit, stripForSpeech } from './speechText';

export interface SpeechChunkerOptions {
  /** Words the first chunk needs before it is spoken. */
  firstMinWords?: number;
  /** Character budget of the first chunk; a longer opening is cut at a clause. */
  firstMaxChars?: number;
  /** A later chunk may be at most this many times longer than the one before. */
  growth?: number;
  /** Floor for a later chunk's budget, so short sentences are merged. */
  minChars?: number;
  /** Hard ceiling for any chunk. */
  maxChars?: number;
}

/**
 * Chosen by sweeping these options over six representative replies: real
 * Kokoro audio durations on a streaming timeline, at inference speeds of
 * 0.4x and 0.62x real time, then confirmed with `npm run bench-tts -w server`
 * (0.65x): versus the old one-then-two-sentences rule, average time to first
 * audio 2.6s -> 1.7s (never later on any reply) and silence between chunks
 * 2.4s -> 0.4s per reply. Holding the first chunk for 5 words cut gaps a
 * little more but started short replies ~1s later; a 15-word minimum (a
 * common guideline) removed gaps but pushed first audio to 4.6s.
 */
export const SPEECH_CHUNKER_DEFAULTS: Required<SpeechChunkerOptions> = {
  firstMinWords: 2,
  firstMaxChars: 80,
  growth: 1.6,
  minChars: 60,
  maxChars: MAX_CHUNK_CHARS,
};

/**
 * Streaming chunker for the voice: feed it tokens, get speakable chunks.
 *
 * Why chunk sizes matter: the server synthesizes chunks one after another at
 * roughly 0.6x real time, so chunk N+1 is only ready in time if it is not much
 * longer than chunk N (N+1's synthesis must fit inside N's playback). The old
 * rule — one sentence, then two at a time — produced exactly the wrong shape
 * for short replies: "Oh no!" (0.7s of audio) followed by a 19-word pair that
 * takes ~3s to synthesize, i.e. a ~2.7s silence after the first words.
 *
 * So:
 *  - the first chunk waits for `firstMinWords` words (merging a one-word
 *    "Yes!" with the next sentence) but is capped at `firstMaxChars`, cutting
 *    a long opening sentence at a clause so audio still starts quickly;
 *  - each later chunk takes whole sentences up to a budget that grows by
 *    `growth` over the previous chunk, clause-splitting a sentence only when
 *    it alone exceeds the budget.
 */
export class SpeechChunker {
  private raw = '';
  /** Complete, already-speakable sentences not yet emitted. */
  private pending: string[] = [];
  private previousChars = 0;
  private readonly o: Required<SpeechChunkerOptions>;

  constructor(options: SpeechChunkerOptions = {}) {
    this.o = { ...SPEECH_CHUNKER_DEFAULTS, ...options };
  }

  /** Add streamed text; returns the chunks that are ready to speak now. */
  push(token: string): string[] {
    this.raw += token;
    this.collect(false);
    return this.drain(false);
  }

  /** End of stream: returns everything left, in order. */
  flush(): string[] {
    this.collect(true);
    this.raw = '';
    const out = this.drain(true);
    this.pending = [];
    return out;
  }

  /** Move every complete unit from `raw` into `pending` as speech text. */
  private collect(flush: boolean): void {
    for (;;) {
      const unit = nextUnit(this.raw, flush);
      if (!unit) return;
      this.raw = this.raw.slice(unit.text.length);
      const speech = stripForSpeech(unit.text);
      if (speech) this.pending.push(speech);
      if (!this.raw) return;
    }
  }

  private drain(flush: boolean): string[] {
    const out: string[] = [];
    for (let chunk = this.next(flush); chunk; chunk = this.next(flush)) {
      out.push(chunk);
      this.previousChars = chunk.length;
    }
    return out;
  }

  private next(flush: boolean): string | null {
    const first = this.previousChars === 0;
    const budget = first
      ? this.o.firstMaxChars
      : Math.min(
          this.o.maxChars,
          Math.max(this.o.minChars, Math.round(this.previousChars * this.o.growth)),
        );
    const minWords = first ? this.o.firstMinWords : 1;

    if (!this.pending.length) return first && !flush ? this.splitStreamingOpening(budget) : null;

    // Whole sentences that fit the budget (always at least one).
    let text = this.pending[0];
    let taken = 1;
    while (taken < this.pending.length && (!first || wordCount(text) < minWords)) {
      const joined = `${text} ${this.pending[taken]}`;
      if (joined.length > budget) break;
      text = joined;
      taken++;
    }

    if (text.length > budget) {
      // One sentence alone overflows: cut it at a clause if there is one.
      const cut = clauseCut(text, budget, minWords);
      if (cut > 0) return this.take(taken, text.slice(0, cut).trim(), text.slice(cut).trim());
      if (text.length > this.o.maxChars) {
        const space = text.lastIndexOf(' ', this.o.maxChars);
        if (space > 0) return this.take(taken, text.slice(0, space), text.slice(space + 1));
      }
      return this.take(taken, text, '');
    }

    if (flush) return this.take(taken, text, '');
    if (first) {
      // Speak as soon as the opening has enough words to carry itself.
      if (wordCount(text) >= minWords) return this.take(taken, text, '');
      if (taken < this.pending.length) {
        // "Yes!" + a sentence too long to add whole: borrow its first
        // clause if it has one, otherwise let the short opening go alone.
        const joined = `${text} ${this.pending[taken]}`;
        const cut = clauseCut(joined, budget, minWords);
        return cut > 0
          ? this.take(taken + 1, joined.slice(0, cut).trim(), joined.slice(cut).trim())
          : this.take(taken, text, '');
      }
      // The next sentence is still streaming; if it is already too long to
      // join, don't hold the opening back for it.
      return text.length + 1 + stripForSpeech(this.raw).length > budget
        ? this.take(taken, text, '')
        : null;
    }
    // A later chunk is ready once the next sentence can't fit, or the
    // budget is mostly used; otherwise wait for more text.
    const nextWontFit =
      taken < this.pending.length || text.length + 1 + stripForSpeech(this.raw).length > budget;
    return nextWontFit || text.length >= budget * 0.8 ? this.take(taken, text, '') : null;
  }

  /** Emit `text`, replacing the first `taken` pending sentences with `rest`. */
  private take(taken: number, text: string, rest: string): string {
    this.pending.splice(0, taken, ...(rest ? [rest] : []));
    return text;
  }

  /**
   * The opening sentence is still streaming and already longer than the first
   * chunk's budget: speak its first clause now rather than waiting for the
   * full stop. Only cut where the Markdown prefix is balanced, so no half an
   * emphasis pair or link ever reaches the voice.
   */
  private splitStreamingOpening(budget: number): string | null {
    if (this.raw.length <= budget || /^[ \t]*```/.test(this.raw)) return null;
    const cut = clauseCut(this.raw, budget, this.o.firstMinWords);
    if (cut <= 0) return null;
    const speech = stripForSpeech(this.raw.slice(0, cut));
    if (!speech || /[*_`~[\]]/.test(speech)) return null;
    this.raw = this.raw.slice(cut).replace(/^[ \t]+/, '');
    return speech;
  }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Index just past the last clause boundary (`,` `;` `:` or a spaced dash) at
 * or before `limit` that leaves at least `minWords` words before it and two
 * after it, or -1.
 */
function clauseCut(text: string, limit: number, minWords: number): number {
  const boundary = /[,;:](?=\s)|\s[—–-](?=\s)/g;
  let best = -1;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const end = m.index + m[0].length;
    if (end > limit) break;
    if (wordCount(text.slice(0, end)) >= minWords && wordCount(text.slice(end)) >= 2) best = end;
  }
  return best;
}

/**
 * Split text at sentence/clause boundaries into pieces of at most `max`
 * characters. `chatStore.ts` already hands over sized chunks (SpeechChunker);
 * this is the backstop for direct callers and for the browser voice's
 * shorter limit.
 */
export function splitChunks(text: string, max = 320): string[] {
  const parts = text.match(/[^.!?…\n]+[.!?…\n]*\s*|.+/g) || [text];
  const chunks: string[] = [];
  let buf = '';
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if ((buf + ' ' + piece).trim().length > max) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = piece;
    } else {
      buf = (buf ? buf + ' ' : '') + piece;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}
