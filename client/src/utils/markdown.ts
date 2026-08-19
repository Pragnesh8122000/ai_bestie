/**
 * Markdown helpers for the chat transcript.
 */

/**
 * Make a half-received Markdown string safe to render mid-stream.
 *
 * While a reply streams in token by token, the text is briefly invalid
 * Markdown: `**bo` has an opener with no closer, a fenced block has no closing
 * fence, a link is `[Lisbon](htt`. Rendering that raw makes the message flicker
 * between literal syntax and formatted output on nearly every token.
 *
 * The fix is to hide markers that have not yet been completed. They reappear as
 * real formatting the moment the closing marker arrives, so the text settles
 * instead of strobing.
 *
 * This is deliberately conservative: it only touches constructs whose delimiter
 * is unambiguous. Single `*`/`_` emphasis mid-word is left alone because those
 * characters appear inside ordinary identifiers (`snake_case`), and silently
 * deleting one would corrupt what the persona actually said.
 */
export function stabilizePartialMarkdown(text: string): string {
  if (!text) return text;

  const { openFence, safeFrom } = scanFences(text);

  // An unterminated fence: close it so the partial snippet renders as a code
  // block. Nothing inside a fence is emphasis, so no other fix applies.
  if (openFence) {
    return text.endsWith('\n') ? `${text}\`\`\`` : `${text}\n\`\`\``;
  }

  // Inline fixes apply only after the last *closed* fence. Text inside a
  // complete fenced block is code — balancing its backticks or asterisks would
  // corrupt the snippet, and stripping its closing ``` would unclose it.
  const head = text.slice(0, safeFrom);
  const tail = stabilizeInline(text.slice(safeFrom));
  return head + tail;
}

/**
 * Walk the lines once, tracking fence state.
 *
 * Returns whether a fence is still open at the end, and the offset just past
 * the last closing fence (0 when there are none) — everything before that is
 * off-limits to the inline fixes.
 */
function scanFences(text: string): { openFence: boolean; safeFrom: number } {
  const fence = /^[ \t]*```/;
  let inFence = false;
  let safeFrom = 0;
  let offset = 0;

  for (const line of text.split('\n')) {
    const next = offset + line.length + 1; // +1 for the newline
    if (fence.test(line)) {
      inFence = !inFence;
      if (!inFence) safeFrom = next; // just closed — safe zone starts here
    }
    offset = next;
  }

  return { openFence: inFence, safeFrom: Math.min(safeFrom, text.length) };
}

/** Hide incomplete inline constructs in a chunk of non-fenced text. */
function stabilizeInline(text: string): string {
  let out = text;

  // A link/image whose URL is still arriving: drop the whole construct rather
  // than show "[Lisbon](htt". Runs first so the brackets can't be mistaken for
  // anything else.
  out = out.replace(/!?\[[^\]\n]*\]\([^)\n]*$/, '');
  // ...and one whose label is still being typed.
  out = out.replace(/!?\[[^\]\n]*$/, '');

  // A marker run at the end of the text that opens rather than closes. An
  // opener follows whitespace ("the plan: **"); a closer is attached to the
  // word it ends ("really**"), so the whitespace test tells them apart without
  // eating valid completed emphasis.
  out = out.replace(/(^|\s)(?:\*+|_+|~+|`+)$/, '$1');

  // Balance the unambiguous paired markers; an odd count means one is dangling.
  out = balanceMarker(out, '`');
  out = balanceMarker(out, '**');
  out = balanceMarker(out, '~~');

  // A partially-arrived closer leaves a stray char behind ("**really" loses its
  // `**` above, then the next token makes it "really*"). Strip a trailing run
  // only when that character's total count is odd, i.e. it cannot be part of a
  // completed pair — so a finished `*italic*` or `` `code` `` is left intact.
  out = stripUnpairedTrailing(out);

  return out;
}

/** Drop a trailing run of `char` when it has no partner anywhere in the text. */
function stripUnpairedTrailing(text: string): string {
  let out = text;
  for (const char of ['*', '~', '`']) {
    const trailing = new RegExp(`\\${char}+$`);
    if (!trailing.test(out)) continue;
    const count = out.split(char).length - 1;
    if (count % 2 === 1) out = out.replace(trailing, '');
  }
  return out;
}

/**
 * Remove the final `marker` when there is an odd number of them, i.e. one is
 * dangling. Line-leading bullets are masked first so a `* item` list marker is
 * never mistaken for an emphasis delimiter and deleted (that would collapse the
 * list while it streams).
 */
function balanceMarker(text: string, marker: string): string {
  const BULLET_MASK = '\u0000';

  // Mask line-leading bullets, remembering each one so it can be put back.
  const bullets: string[] = [];
  const masked = text.replace(/^([ \t]*)([*+-])([ \t])/gm, (_m, indent, bullet, space) => {
    bullets.push(bullet);
    return `${indent}${BULLET_MASK}${space}`;
  });

  const occurrences = masked.split(marker).length - 1;
  if (occurrences % 2 === 0) return text;

  const idx = masked.lastIndexOf(marker);
  if (idx === -1) return text;
  const cut = masked.slice(0, idx) + masked.slice(idx + marker.length);

  // Unmask in order: the cut removed a marker, never a bullet, so the
  // placeholders still line up 1:1 with `bullets`.
  let i = 0;
  return cut.replace(new RegExp(BULLET_MASK, 'g'), () => bullets[i++] ?? '-');
}
