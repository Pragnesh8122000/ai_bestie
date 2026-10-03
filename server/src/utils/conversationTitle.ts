const TITLE_MAX_LENGTH = 50;
const DEFAULT_TITLE = 'New Conversation';

/**
 * Derive a conversation title from its first user message.
 *
 * Collapses whitespace, strips a wrapping quote pair, and clips to 50 chars on
 * a word boundary where one is available so titles don't end mid-word.
 */
export function deriveTitle(firstUserMessage: string): string {
  let text = (firstUserMessage || '').replace(/\s+/g, ' ').trim();

  // Strip one wrapping quote pair ("hi there" -> hi there).
  const quoted = /^(["'\u201c\u2018])(.*)(["'\u201d\u2019])$/.exec(text);
  if (quoted) text = quoted[2].trim();

  if (!text) return DEFAULT_TITLE;
  if (text.length <= TITLE_MAX_LENGTH) return text;

  const clipped = text.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only back off to a word boundary if it doesn't gut the title.
  const base = lastSpace > TITLE_MAX_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}\u2026`;
}
