// Pure: is `now` inside the owner's quiet hours? (Overnight windows wrap midnight; equal start/end = off.)
import { localDate, zonedTime } from './localDay.js';

export type NotifySettings = { quietStart: string; quietEnd: string; timezone: string };
export function inQuietHours(now: Date, s: NotifySettings): boolean {
  if (s.quietStart === s.quietEnd) return false; // disabled
  const today = localDate(now, s.timezone);
  const start = zonedTime(today, s.quietStart, s.timezone).getTime();
  const end = zonedTime(today, s.quietEnd, s.timezone).getTime();
  const t = now.getTime();
  return start < end ? t >= start && t < end : t >= start || t < end; // overnight window wraps midnight
}
