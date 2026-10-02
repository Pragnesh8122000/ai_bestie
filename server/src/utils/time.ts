/**
 * The app's one time zone: India Standard Time. It has no DST (fixed UTC+05:30),
 * and everything here goes through Intl with an explicit zone, so output never
 * depends on the host's TZ (Render runs in UTC).
 *
 * Stored and API-wire instants stay UTC (Date objects / ISO strings): they are
 * unambiguous and sort correctly. Human-facing text — log lines, log file
 * names, reports — uses this format: `yyyy-mm-dd hh-mm-ss`.
 */
export const APP_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** `yyyy-mm-dd hh-mm-ss` in Asia/Kolkata. */
export function formatIst(input: Date | number = new Date()): string {
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(input)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}-${p.second}`;
}

/** `yyyy-mm-dd` of the Asia/Kolkata calendar day (log file rotation key). */
export function istDay(input: Date | number = new Date()): string {
  return formatIst(input).slice(0, 10);
}

const IST_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/;

/** Inverse of `formatIst`, to epoch ms; NaN if `text` is not in that format. */
export function parseIst(text: string): number {
  const m = IST_PATTERN.exec(text);
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MS;
}
