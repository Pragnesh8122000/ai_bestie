/**
 * The app's one time zone: India Standard Time, applied explicitly so the UI
 * reads the same whatever the viewer's device zone is. Instants stay UTC ISO
 * strings in state and on the wire; only display goes through here.
 */
export const APP_TIME_ZONE = 'Asia/Kolkata';

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
});

const yearFormat = new Intl.DateTimeFormat('en-US', { timeZone: APP_TIME_ZONE, year: 'numeric' });

/** `HH:MM` in IST, or '' for a missing/invalid instant. */
export function clock(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : clockFormat.format(d);
}

/** `toLocaleDateString` pinned to IST. */
export function istDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString(undefined, { ...options, timeZone: APP_TIME_ZONE });
}

/** Calendar year of an instant in IST (a New Year's boundary differs from UTC/local). */
export function istYear(date: Date): string {
  return yearFormat.format(date);
}
