// Deterministic prep-hold placement. Claude says whether prep helps and how much time it wants; this
// module decides WHEN, from the real availability of the day. Boring on purpose:
//   - search the gaps before the meeting, never overlapping anything that blocks time
//   - stay inside the working day, leave a buffer before the meeting
//   - prefer the ideal duration, nearest the preferred lead; fall back to the minimum useful duration
//   - no legitimate gap → no hold (never wedge one somewhere stupid)
// Pure: no I/O, no clock. Times are epoch ms.
import type { CalendarEvent } from './connections/google.js';
import { zonedTime } from './localDay.js';

export type Interval = { start: number; end: number };
export type HoldRequest = { idealMinutes: number; minimumMinutes: number; preferredLeadMinutes: number };
export type SlotSettings = { dayStart: string; dayEnd: string; bufferMinutes: number };
export const SLOT_DEFAULTS: SlotSettings = { dayStart: '08:00', dayEnd: '19:00', bufferMinutes: 10 };

const MIN = 60_000;
const FIVE = 5 * MIN;

// Clamp what the model asked for into sane bounds.
export function normalizeRequest(r: HoldRequest): HoldRequest {
  const ideal = Math.min(Math.max(Math.round(r.idealMinutes), 10), 120);
  const minimum = Math.min(Math.max(Math.round(r.minimumMinutes), 10), ideal);
  const lead = Math.min(Math.max(Math.round(r.preferredLeadMinutes), 0), 8 * 60);
  return { idealMinutes: ideal, minimumMinutes: minimum, preferredLeadMinutes: lead };
}

// Everything that blocks time: timed, not cancelled, not shown-as-free, not declined by me.
// Filtered-out events (focus blocks, standups) are included: irrelevant to ranking, not to availability.
export function busyIntervals(events: CalendarEvent[], excludeIds: Set<string> = new Set()): Interval[] {
  return events
    .filter((e) => e.start.dateTime && e.end.dateTime && e.status !== 'cancelled' && e.transparency !== 'transparent'
      && !excludeIds.has(e.id) && !e.attendees?.some((a) => a.self && a.responseStatus === 'declined'))
    .map((e) => ({ start: Date.parse(e.start.dateTime!), end: Date.parse(e.end.dateTime!) }));
}

export const overlapsAny = (slot: Interval, busy: Interval[]) => busy.some((b) => slot.start < b.end && b.start < slot.end);

export function findSlot(
  meetingStart: number, req: HoldRequest, busy: Interval[], date: string, tz: string, settings: SlotSettings = SLOT_DEFAULTS,
): Interval | null {
  const r = normalizeRequest(req);
  const dayStart = zonedTime(date, settings.dayStart, tz).getTime();
  const dayEnd = zonedTime(date, settings.dayEnd, tz).getTime();
  const latestEnd = Math.min(meetingStart - settings.bufferMinutes * MIN, dayEnd);
  if (latestEnd - dayStart < r.minimumMinutes * MIN) return null;

  // Free gaps inside [dayStart, latestEnd].
  const blocks = busy.filter((b) => b.end > dayStart && b.start < latestEnd).sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let cursor = dayStart;
  for (const b of blocks) {
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, latestEnd) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < latestEnd) gaps.push({ start: cursor, end: latestEnd });

  const target = meetingStart - Math.max(settings.bufferMinutes, r.preferredLeadMinutes) * MIN;
  let best: { slot: Interval; ideal: boolean; distance: number } | null = null;
  for (const g of gaps) {
    const len = g.end - g.start;
    if (len < r.minimumMinutes * MIN) continue;
    const duration = Math.min(r.idealMinutes * MIN, len);
    // End as close to the target as the gap allows, then snap the start to 5 minutes when it still fits.
    let end = Math.min(Math.max(target, g.start + duration), g.end);
    let start = end - duration;
    const snapped = Math.floor(start / FIVE) * FIVE;
    if (snapped >= g.start) { end -= start - snapped; start = snapped; }
    const cand = { slot: { start, end }, ideal: duration === r.idealMinutes * MIN, distance: Math.abs(end - target) };
    if (!best || (cand.ideal && !best.ideal) || (cand.ideal === best.ideal && (cand.distance < best.distance
      || (cand.distance === best.distance && cand.slot.end > best.slot.end)))) best = cand;
  }
  return best?.slot ?? null;
}
