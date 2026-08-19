export const TITLE_MAX_LENGTH = 50;
export const PREVIEW_MAX_LENGTH = 120;
export const DEFAULT_TITLE = 'New Conversation';

/**
 * Client-side mirror of the server's `deriveTitle` (server/src/services/chatService.ts).
 *
 * Used only to update the sidebar title optimistically when the first message
 * of a conversation is sent, so the row doesn't read "New Conversation" until
 * the next list refetch. The server remains authoritative.
 */
export function deriveTitle(firstUserMessage: string): string {
  let text = (firstUserMessage || '').replace(/\s+/g, ' ').trim();

  const quoted = /^(["'“‘])(.*)(["'”’])$/.exec(text);
  if (quoted) text = quoted[2].trim();

  if (!text) return DEFAULT_TITLE;
  if (text.length <= TITLE_MAX_LENGTH) return text;

  const clipped = text.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace > TITLE_MAX_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}…`;
}

/** Mirror of the server's `toPreview` for optimistic list updates. */
export function toPreview(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_LENGTH);
}

/**
 * Compact relative timestamp for the conversation list: `now`, `12m`, `3h`,
 * `Tue`, `12 Mar`. Deliberately short — these sit in a narrow sidebar column.
 */
export function formatRelative(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return '';

  const diffSec = Math.floor((now.getTime() - ms) / 1000);
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 7 * 86_400) return then.toLocaleDateString(undefined, { weekday: 'short' });
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return then.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
