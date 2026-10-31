// Calendar Prep retrieval: what we already know about a meeting's people, from sources the owner has granted.
//   meeting history (primary calendar, 90 days) · email threads (Gmail, 30 days, read-only) · earlier briefs (ops.*)
// Rules (docs/closeout.md, "Calendar Prep retrieval"):
//   - Structured, with a source id on everything ('m1', 't1.2', 'b1', 'ev'), so the model cites ids instead of
//     inventing attribution, and code can check every citation.
//   - People are matched by email ADDRESS only, never display name.
//   - Each source degrades on its own: a failed source is recorded and skipped; retrieval never blocks a brief.
//   - Bounded: ≤8 people, ≤3 threads × ≤2 messages × ≤600 chars, ≤5 prior meetings, ≤3 prior briefs.
//   - Gmail is optional for Calendar Prep: without the scope, the email source is 'no_access', not an error.
import { pool } from './db.js';
import { dbosControlError } from './errors.js';
import type { CalendarEvent } from './connections/google.js';
import { listEvents } from './connections/google.js';
import { getMessage, recentMailWith, type MailMessage } from './connections/gmail.js';

export const LIMITS = { emailDays: 30, historyDays: 90, people: 8, threads: 3, messagesPerThread: 2, excerptChars: 600, meetings: 5, briefs: 3, mailScan: 12 };
const GMAIL_READ_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.readonly'];
const DAY = 86_400_000;

export type SourceStatus = 'ok' | 'failed' | 'no_access' | 'skipped';
export type MeetingRef = { id: string; date: string; title: string; shared: string[] };
export type EmailMsg = { id: string; date: string; author: string; authorIsOwner: boolean; excerpt: string };
export type EmailThread = { id: string; subject: string; lastDate: string; shared: string[]; ownerInvolved: boolean; awaitingOwner: boolean; messages: EmailMsg[] };
export type PriorBrief = { id: string; date: string; title: string; why: string; prep: string[]; feedback: string | null };
export type RetrievedContext = {
  people: string[];
  metBeforeCount: number;
  meetingHistory: MeetingRef[];
  emailThreads: EmailThread[];
  priorBriefs: PriorBrief[];
  status: { calendar: SourceStatus; email: SourceStatus; briefs: SourceStatus };
};
/** What the nightly ranking sees: counts and recency, plus each thread's subject and a short excerpt of its last message. */
export type ContextSignals = {
  metBefore: number; lastMetDaysAgo: number | null; lastMetTitle: string | null;
  threads: { subject: string; daysAgo: number; lastFrom: string; lastFromOwner: boolean; awaitingOwner: boolean; lastExcerpt: string }[];
};

const norm = (a: string) => a.trim().toLowerCase();
const addrsIn = (header: string) => (header.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map(norm);

/** The meeting's other people, by address: not me, not rooms, not calendar group addresses. External first. */
export function people(e: CalendarEvent, selfEmail: string): string[] {
  const self = norm(selfEmail);
  const selfDomain = self.split('@')[1] ?? '';
  const others = (e.attendees ?? []).filter((a) => !a.self && !a.resource && a.email && norm(a.email) !== self && !a.email.endsWith('calendar.google.com')).map((a) => norm(a.email));
  return [...new Set(others)].sort((a, b) => Number(a.endsWith(`@${selfDomain}`)) - Number(b.endsWith(`@${selfDomain}`))).slice(0, LIMITS.people);
}

/** Past meetings sharing at least one address with `who` (all counted; the latest few kept). */
export function meetingHistory(past: CalendarEvent[], who: string[], selfEmail: string, excludeEventId?: string): { count: number; refs: MeetingRef[] } {
  const want = new Set(who);
  const self = norm(selfEmail);
  const hits = past.filter((e) => e.id !== excludeEventId && e.status !== 'cancelled'
    && !(e.attendees ?? []).some((a) => (a.self || norm(a.email) === self) && a.responseStatus === 'declined'))
    .map((e) => ({ e, shared: [...new Set((e.attendees ?? []).map((a) => norm(a.email)).filter((a) => want.has(a)))] }))
    .filter((x) => x.shared.length)
    .sort((a, b) => Date.parse(b.e.start.dateTime ?? b.e.start.date!) - Date.parse(a.e.start.dateTime ?? a.e.start.date!));
  return {
    count: hits.length,
    refs: hits.slice(0, LIMITS.meetings).map((x, i) => ({ id: `m${i + 1}`, date: (x.e.start.dateTime ?? x.e.start.date!).slice(0, 10), title: (x.e.summary ?? '(no title)').slice(0, 120), shared: x.shared })),
  };
}

/**
 * Group fetched mail into threads and keep the most relevant few. Deterministic ordering:
 * shared participants (×3) + recency (0–3) + owner took part (+2) + the last word is someone asking the owner (+2).
 */
export function rankThreads(msgs: MailMessage[], who: string[], selfEmail: string, now: number): EmailThread[] {
  const self = norm(selfEmail);
  const want = new Set(who);
  const byThread = new Map<string, MailMessage[]>();
  for (const m of msgs) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  const scored = [...byThread.values()].map((ms) => {
    ms.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const everyone = new Set(ms.flatMap((m) => [m.fromAddr, ...addrsIn(m.to), ...addrsIn(m.cc)]).map(norm));
    const shared = [...everyone].filter((a) => want.has(a));
    const ownerInvolved = ms.some((m) => norm(m.fromAddr) === self) || ms.some((m) => addrsIn(m.to).includes(self));
    const last = ms[0];
    const awaitingOwner = norm(last.fromAddr) !== self && /\?/.test(last.body || last.snippet);
    const days = (now - Date.parse(last.receivedAt)) / DAY;
    const score = shared.length * 3 + Math.max(0, 3 - days / 10) + (ownerInvolved ? 2 : 0) + (awaitingOwner ? 2 : 0);
    return { ms, shared, ownerInvolved, awaitingOwner, score };
  }).filter((t) => t.shared.length).sort((a, b) => b.score - a.score || Date.parse(b.ms[0].receivedAt) - Date.parse(a.ms[0].receivedAt));
  return scored.slice(0, LIMITS.threads).map((t, i) => ({
    id: `t${i + 1}`,
    subject: t.ms[0].subject.slice(0, 160),
    lastDate: t.ms[0].receivedAt.slice(0, 10),
    shared: t.shared, ownerInvolved: t.ownerInvolved, awaitingOwner: t.awaitingOwner,
    messages: t.ms.slice(0, LIMITS.messagesPerThread).map((m, j) => ({
      id: `t${i + 1}.${j + 1}`, date: m.receivedAt.slice(0, 10),
      author: m.fromName ? `${m.fromName} <${norm(m.fromAddr)}>` : norm(m.fromAddr),
      authorIsOwner: norm(m.fromAddr) === self,
      excerpt: stripQuoted(m.body || m.snippet).slice(0, Math.floor(LIMITS.excerptChars / LIMITS.messagesPerThread)),
    })),
  }));
}

/** The new part of an email: drop quoted history ("On … wrote:", "> …") and collapse whitespace. */
function stripQuoted(body: string): string {
  const cut = body.split(/\n\s*On .{5,200}wrote:\s*\n|\n-----Original Message-----/)[0];
  return cut.split('\n').filter((l) => !l.trim().startsWith('>')).join(' ').replace(/\s+/g, ' ').trim();
}

export function rankingSignals(c: RetrievedContext, now: number): ContextSignals {
  const daysAgo = (d: string) => Math.max(0, Math.round((now - Date.parse(d)) / DAY));
  return {
    metBefore: c.metBeforeCount, lastMetDaysAgo: c.meetingHistory[0] ? daysAgo(c.meetingHistory[0].date) : null, lastMetTitle: c.meetingHistory[0]?.title ?? null,
    threads: c.emailThreads.map((t) => ({
      subject: t.subject, daysAgo: daysAgo(t.lastDate), lastFrom: t.messages[0]?.author ?? '', lastFromOwner: Boolean(t.messages[0]?.authorIsOwner),
      awaitingOwner: t.awaitingOwner, lastExcerpt: (t.messages[0]?.excerpt ?? '').slice(0, 160),
    })),
  };
}

async function gmailReadable(connectionId: string): Promise<boolean> {
  const { rows } = await pool.query(`select scopes from ops.connections where id = $1 and status = 'active'`, [connectionId]);
  return Boolean(rows[0]?.scopes?.some((s: string) => GMAIL_READ_SCOPES.includes(s)));
}

/** One source at a time, each allowed to fail without taking the others (or the brief) with it. */
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const control = dbosControlError(e);
    if (control) throw control;
    console.warn(`[retrieval] ${label} failed: ${(e as Error).message}`);
    return { ok: false };
  }
}

/**
 * Retrieve context for several events at once (one calendar history read shared by all). Runs inside a single
 * checkpointed step, so a replay reuses what was read instead of reading again.
 */
export async function retrieveForEvents(
  agentId: string, connectionId: string, selfEmail: string, events: CalendarEvent[], now: number,
  opts: { email: boolean; briefs: boolean } = { email: true, briefs: true },
): Promise<Record<string, RetrievedContext>> {
  const past = await attempt('calendar history', () =>
    listEvents(connectionId, 'primary', new Date(now - LIMITS.historyDays * DAY).toISOString(), new Date(now).toISOString()));
  const canMail = opts.email ? await attempt('gmail scope check', () => gmailReadable(connectionId)) : { ok: true as const, value: false };
  const out: Record<string, RetrievedContext> = {};
  for (const e of events) {
    const who = people(e, selfEmail);
    const ctx: RetrievedContext = {
      people: who, metBeforeCount: 0, meetingHistory: [], emailThreads: [], priorBriefs: [],
      status: { calendar: 'skipped', email: 'skipped', briefs: 'skipped' },
    };
    if (who.length) {
      if (past.ok) {
        const h = meetingHistory(past.value, who, selfEmail, e.id);
        ctx.metBeforeCount = h.count; ctx.meetingHistory = h.refs; ctx.status.calendar = 'ok';
      } else ctx.status.calendar = 'failed';

      if (!opts.email) ctx.status.email = 'skipped';
      else if (!canMail.ok) ctx.status.email = 'failed';
      else if (!canMail.value) ctx.status.email = 'no_access';
      else {
        const mail = await attempt(`gmail for ${e.id}`, async () => {
          const ids = await recentMailWith(connectionId, who, LIMITS.emailDays, LIMITS.mailScan);
          const msgs: MailMessage[] = [];
          for (const { id } of ids) { const m = await getMessage(connectionId, id, 2000); if (m) msgs.push(m); }
          return rankThreads(msgs, who, selfEmail, now);
        });
        ctx.status.email = mail.ok ? 'ok' : 'failed';
        if (mail.ok) ctx.emailThreads = mail.value;
      }
    }
    if (opts.briefs) {
      const b = await attempt(`prior briefs for ${e.id}`, () => priorBriefs(agentId, e, now));
      ctx.status.briefs = b.ok ? 'ok' : 'failed';
      if (b.ok) ctx.priorBriefs = b.value;
    }
    out[e.id] = ctx;
  }
  return out;
}

/** Earlier briefs for the same event or the same title (a recurring series keeps its title), with feedback. */
async function priorBriefs(agentId: string, e: CalendarEvent, now: number): Promise<PriorBrief[]> {
  const series = e.recurringEventId ?? e.id;
  const { rows } = await pool.query(
    `select b.id as brief_id, b.brief_date::text as date, i.value as item, f.verdict
       from ops.briefs b cross join lateral jsonb_array_elements(b.items) i
       left join ops.brief_feedback f on f.brief_id = b.id and f.event_id = i.value->>'eventId'
      where b.agent_id = $1 and b.brief_date < $4::date and b.brief_date > $4::date - 60
        and (i.value->>'eventId' like $2 || '%' or i.value->>'title' = $3)
      order by b.brief_date desc limit $5`,
    [agentId, series.split('_')[0], e.summary ?? '', new Date(now).toISOString().slice(0, 10), LIMITS.briefs],
  );
  return rows.map((r, i) => ({
    id: `b${i + 1}`, date: r.date, title: String(r.item.title ?? '').slice(0, 120), why: String(r.item.why ?? '').slice(0, 200),
    prep: (r.item.prep ?? []).slice(0, 3).map((p: string) => String(p).slice(0, 120)), feedback: r.verdict ?? null,
  }));
}
