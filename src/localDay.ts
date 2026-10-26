// Local-day arithmetic in IANA zones, DST-correct. Pure: no I/O, safe to import anywhere.

function partsIn(instant: Date, tz: string): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]));
}
export function localDate(instant: Date, tz: string): string {
  const o = partsIn(instant, tz);
  return `${o.year}-${o.month}-${o.day}`;
}
function offsetMs(instant: Date, tz: string): number {
  const o = partsIn(instant, tz);
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(instant.getTime() / 1000) * 1000;
}
// The instant local midnight starts `date` in `tz`. Two passes settle the offset on DST-change days.
export function zonedMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const clock = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
