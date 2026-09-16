/**
 * Turning Markdown into speakable text.
 *
 * The TTS queue used to receive the raw stream, so the neural voice literally
 * pronounced the syntax — asterisks, backticks, hashes, table pipes, and whole
 * code blocks read symbol by symbol. Now that replies are rendered as Markdown
 * the model emits more of it, so the voice path needs its own view of the text.
 *
 * Two jobs live here:
 *   stripForSpeech(md)      — Markdown source -> words a person would say
 *   takeSpeech(raw, flush)  — pull the part of a partial stream that is safe
 *                             to speak yet, without cutting mid-construct
 *
 * Kept separate from `speech.ts` on purpose: that module owns the audio queue
 * and has hard-won invariants (one locked voice per session, session IDs that
 * invalidate in-flight fetches). This is pure text, and is unit-testable
 * without touching any of that.
 */

/** A fenced code block, spoken as a short placeholder rather than read out. */
const CODE_BLOCK_SPOKEN = 'code block';

/**
 * Convert Markdown source into plain speakable text.
 *
 * Order matters: block constructs are handled before inline ones so a heading's
 * `#` or a list's `-` can't survive as a stray character, and links are resolved
 * before emphasis so a URL's underscores are never treated as italics.
 */
export function stripForSpeech(md: string): string {
  if (!md) return '';
  let out = md;

  // Fenced code: never read source aloud. A closing fence may be missing when
  // the stream is cut short, so the trailing-open case is handled too.
  out = out.replace(/```[^\n]*\n[\s\S]*?```/g, ` ${CODE_BLOCK_SPOKEN} `);
  out = out.replace(/```[^\n]*\n[\s\S]*$/g, ` ${CODE_BLOCK_SPOKEN} `);
  out = out.replace(/```/g, ' ');

  // Indented (4-space) code blocks read no better than fenced ones.
  out = out.replace(/^(?: {4}|\t)[^\n]*$/gm, ` ${CODE_BLOCK_SPOKEN} `);

  // HTML tags — the renderer escapes these, so they are visible text, but
  // "less than p greater than" is not worth speaking.
  out = out.replace(/<[^>\n]{1,200}>/g, ' ');

  // Images and links: keep the human-readable label, drop the URL.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Reference-style and bare autolinks.
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, ' ');

  // Tables: drop the |---|:---| separator rows, then turn cell pipes into
  // pauses so a row reads as a list instead of "pipe walk pipe low pipe".
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '');
  out = out.replace(/^[ \t]*\|/gm, '');
  out = out.replace(/\|[ \t]*$/gm, '');
  out = out.replace(/[ \t]*\|[ \t]*/g, ', ');

  // Horizontal rules, before list markers so `---` isn't seen as a bullet.
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');

  // Headings: the words are worth speaking, the hashes are not.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  // Setext underlines (=== / ---) carry no spoken content.
  out = out.replace(/^[ \t]*[=]{2,}[ \t]*$/gm, '');

  // Blockquote markers.
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');

  // Task-list checkboxes, before the bullet that precedes them.
  out = out.replace(/^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]*/gm, '$1');

  // List markers. The number in an ordered list is dropped along with the dot:
  // a friend says "walk it off", not "one dot walk it off", and keeping the
  // period would also read as a sentence break.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d{1,9}[.)][ \t]+/gm, '');

  // Inline code.
  out = out.replace(/`+([^`]*)`+/g, '$1');

  // Emphasis. Paired markers only, so a lone `*` or a snake_case identifier is
  // left alone rather than having characters silently deleted.
  out = out.replace(/(\*\*\*|___)(\S[\s\S]*?\S|\S)\1/g, '$2');
  out = out.replace(/(\*\*|__)(\S[\s\S]*?\S|\S)\1/g, '$2');
  out = out.replace(/(~~)(\S[\s\S]*?\S|\S)\1/g, '$2');
  out = out.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1');
  out = out.replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, '$1');

  // Backslash escapes: `\*` was always meant to be a literal asterisk.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, '$1');

  // Collapse the whitespace the substitutions left behind. Newlines become
  // spaces because the caller has already chosen where one chunk ends.
  out = out.replace(/[ \t]*\n[ \t]*/g, ' ');
  out = out.replace(/[ \t]{2,}/g, ' ');
  // ", ," from an empty table cell, and a leading comma from a stripped pipe.
  out = out.replace(/(,\s*){2,}/g, ', ');
  out = out.replace(/^\s*,\s*/, '');

  return out.trim();
}

/** Hold at least this many completed sentences before speaking (prosody). */
const SENTENCES_PER_CHUNK = 2;
/** Speak sooner than a sentence boundary once the buffer gets this long. */
const MAX_CHUNK_CHARS = 280;

const SENTENCE_END = /[.!?…]/;

/**
 * Pull the leading part of a partially-streamed reply that is safe to speak.
 *
 * Returns the spoken text and the unconsumed remainder. When nothing can be
 * spoken yet, `speech` is empty and `rest` is the input unchanged, so the
 * caller can simply keep buffering and call again on the next token.
 *
 * Text is consumed in whole units (a sentence, or a line, or an entire fenced
 * code block) so a chunk never ends mid-construct — cutting inside a fence or
 * a link would hand the stripper a fragment it cannot interpret.
 *
 * @param flush end of stream: emit whatever is left, including a partial unit.
 */
export function takeSpeech(raw: string, flush = false): { speech: string; rest: string } {
  if (!raw) return { speech: '', rest: '' };

  let rest = raw;
  const units: string[] = [];
  let speech = '';

  const speechOf = (parts: string[]) => stripForSpeech(parts.join(''));

  while (rest) {
    const unit = nextUnit(rest, flush);
    if (!unit) break;

    units.push(unit.text);
    rest = rest.slice(unit.text.length);

    speech = speechOf(units);

    // A forced cut means there was no natural boundary and the buffer already
    // exceeded the chunk budget. Waiting longer only delays audio, so speak.
    if (unit.forced) return { speech, rest };

    // Count utterances, not just sentences. A list item ("- walk") is a
    // natural place to breathe but carries no terminator, so counting only
    // `.!?` would leave a list-only reply silent until the stream ended.
    const terminators = (speech.match(/[.!?…](?=\s|$)/g) || []).length;
    const lineUnits = units.filter((u) => u.endsWith('\n') && u.trim()).length;
    const utterances = Math.max(terminators, lineUnits);

    if (utterances >= SENTENCES_PER_CHUNK || speech.length >= MAX_CHUNK_CHARS) {
      return { speech, rest };
    }
  }

  // Not enough for a natural chunk yet. At end of stream say it anyway;
  // otherwise wait for more tokens rather than clipping the prosody short.
  if (flush) {
    const all = stripForSpeech(raw);
    return { speech: all, rest: '' };
  }
  return { speech: '', rest: raw };
}

/**
 * Take one complete unit off the front of `raw`, or null when the text so far
 * has no complete unit (the caller should wait for more tokens).
 *
 * `forced` marks a unit that was cut at the size budget rather than at a
 * natural boundary, which tells the caller to stop accumulating and speak.
 */
function nextUnit(raw: string, flush: boolean): { text: string; forced: boolean } | null {
  const natural = (text: string) => ({ text, forced: false });

  // An entire fenced block is one unit: its interior has no meaningful
  // sentence or line breaks once it will be spoken as "code block".
  const fenceStart = /^[ \t]*```/.exec(raw);
  if (fenceStart) {
    const close = raw.indexOf('\n```', fenceStart[0].length);
    if (close !== -1) {
      const after = raw.indexOf('\n', close + 1);
      return natural(after === -1 ? raw : raw.slice(0, after + 1));
    }
    // Fence still open: only safe at end of stream.
    return flush ? natural(raw) : null;
  }

  // A blank line ends a block; keep it as a unit boundary.
  const lineEnd = raw.indexOf('\n');

  // First sentence end that is a real one. A period inside "3.5", "e.g." or a
  // list marker ("1. Walk") must not split the text there.
  const sentenceEnd = findSentenceEnd(raw, lineEnd === -1 ? raw.length : lineEnd);

  if (sentenceEnd !== -1) return natural(raw.slice(0, sentenceEnd + 1));
  if (lineEnd !== -1) return natural(raw.slice(0, lineEnd + 1));

  // No boundary at all. Once the fragment is long enough, cut at the last
  // space *within* the chunk budget so audio still starts promptly on a
  // run-on clause. Cutting at the final space of the whole buffer would
  // swallow it entirely and defeat the chunking.
  if (!flush && raw.length > MAX_CHUNK_CHARS) {
    const space = raw.lastIndexOf(' ', MAX_CHUNK_CHARS);
    if (space > 0) return { text: raw.slice(0, space + 1), forced: true };
  }
  return flush ? natural(raw) : null;
}

/** Index of the first genuine sentence terminator in `raw` before `limit`. */
function findSentenceEnd(raw: string, limit: number): number {
  for (let i = 0; i < limit; i++) {
    const ch = raw[i];
    if (!SENTENCE_END.test(ch)) continue;

    const next = raw[i + 1];
    // A terminator must be followed by a break; "3.5" and "sam@x.com" are not
    // sentence ends. At the very end of the buffer more text may still arrive,
    // so only treat it as final when a following character proves it.
    if (next !== undefined && !/[\s"')\]]/.test(next)) continue;
    if (next === undefined) return -1;

    // "1." / "2)" at the start of a line is a list marker, not a sentence.
    if (ch === '.' && isListMarker(raw, i)) continue;

    // Consume a run of terminators ("...", "?!") as one.
    let end = i;
    while (end + 1 < limit && SENTENCE_END.test(raw[end + 1])) end++;
    return end;
  }
  return -1;
}

/** True when the period at `dot` closes an ordered-list number at line start. */
function isListMarker(raw: string, dot: number): boolean {
  let i = dot - 1;
  let digits = 0;
  while (i >= 0 && raw[i] >= '0' && raw[i] <= '9') {
    digits++;
    i--;
  }
  if (digits === 0) return false;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  return i < 0 || raw[i] === '\n';
}
