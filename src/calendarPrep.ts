// Calendar Prep V1 (handler 'calendar_prep'): at 8 PM local, brief the next local day.
//   list events → structured features → hard filters (garbage only) → Claude ranks → brief row (canonical)
//   → all-day mirror event on Agent Ops (same deterministic ID per day, so re-runs update it) → hold proposals.
// Same replay rules as workflows.ts: anything that touches the outside world is a step; the code between
// steps only computes from checkpointed values, so it decides the same way on every replay.
import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { pool } from './db.js';
import { agentModel } from './model.js';
import { classify, OpsError } from './errors.js';
import {
  deleteEvent, ensureAgentOpsCalendar, getEvent, insertEventOnce, listEvents, upsertEvent, type CalendarEvent,
} from './connections/google.js';
import { addDays, clock, localDate, zonedMidnight } from './localDay.js';
import { insertAction, recordRunEnd, recordRunStart, type AgentRow, type Trigger } from './workflows.js';

// Google event IDs allow [a-v0-9], 5–1024 chars; hex is a subset. Same input → same event.
export const googleEventId = (seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, 32);

// ---------- features + hard filters ----------

const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com']);
const MEETING_LINK = /zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com/;

export type EventFeatures = {
  eventId: string;
  title: string;
  start: string;           // ISO instant, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  durationMinutes: number | null;
  localStart: string | null;
  recurring: boolean;
  organizer: 'self' | string;
  attendeeCount: number;
  externalAttendees: number;
  externalDomains: string[];
  hasAgenda: boolean;
  description: string;     // trimmed excerpt for the ranker
  docLinks: string[];
  location: string | null;
};

export function eventFeatures(e: CalendarEvent, selfEmail: string, tz: string): EventFeatures {
  const self = selfEmail.toLowerCase();
  const selfDomain = self.split('@')[1] ?? '';
  const others = (e.attendees ?? []).filter((a) => !a.self && !a.resource && a.email.toLowerCase() !== self && !a.email.endsWith('calendar.google.com'));
  // A personal (consumer-domain) account has no "colleagues": everyone else counts as external.
  const external = others.filter((a) => CONSUMER_DOMAINS.has(selfDomain) || a.email.toLowerCase().split('@')[1] !== selfDomain);
  const description = (e.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const links = [
    ...((e.description ?? '').match(/https?:\/\/[^\s"'<>)]+/g) ?? []).filter((u) => !MEETING_LINK.test(u)),
    ...(e.attachments ?? []).map((a) => a.fileUrl).filter((u): u is string => Boolean(u)),
  ];
  const allDay = Boolean(e.start.date && !e.start.dateTime);
  const start = e.start.dateTime ?? e.start.date!;
  const end = e.end.dateTime ?? e.end.date!;
  return {
    eventId: e.id,
    title: (e.summary ?? '(no title)').slice(0, 200),
    start, end, allDay,
    durationMinutes: allDay ? null : Math.round((Date.parse(end) - Date.parse(start)) / 60_000),
    localStart: allDay ? null : clock(start, tz),
    recurring: Boolean(e.recurringEventId),
    organizer: e.organizer?.self || !e.organizer?.email ? 'self' : e.organizer.email,
    attendeeCount: others.length + 1,
    externalAttendees: external.length,
    externalDomains: [...new Set(external.map((a) => a.email.toLowerCase().split('@')[1]))].slice(0, 5),
    hasAgenda: description.length >= 20,
    description: description.slice(0, 600),
    docLinks: [...new Set(links)].slice(0, 5),
    location: e.location ?? null,
  };
}

// Removes only garbage. Everything else is the ranker's call.
export function hardFilter(e: CalendarEvent): string | null {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return 'declined';
  if (e.eventType === 'focusTime' || /^\s*(focus(\s+(time|block))?|deep\s+work|heads?[\s-]down)\b/i.test(e.summary ?? '')) return 'focus block';
  if (e.eventType === 'birthday' || (e.start.date && /birthday/i.test(e.summary ?? ''))) return 'birthday';
  if (e.eventType === 'outOfOffice' || e.eventType === 'workingLocation') return 'not a meeting';
  return null;
}

// ---------- ranking (Claude judgment over structured features) ----------

// No length/range constraints in the schema itself (not every provider's structured-output mode accepts
// them); they're enforced after parsing instead.
const RankingSchema = z.object({
  headline: z.string(),
  items: z.array(z.object({
    ref: z.string(),
    why: z.string(),
    prep: z.array(z.string()),
    hold: z.object({ durationMinutes: z.number(), minutesBefore: z.number() }).nullable(),
  })),
});

export type BriefItem = {
  eventId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  localStart: string | null;
  why: string;
  prep: string[];
  hold: { start: string; end: string } | null;
  features: EventFeatures;
};

function rankingPrompt(date: string, tz: string, candidates: EventFeatures[], notUseful: string[]): string {
  const refs = candidates.map((f, i) => ({ ref: `e${i + 1}`, ...f, eventId: undefined }));
  return [
    `Tomorrow is ${date} (${tz}). These are tomorrow's events after removing cancelled, declined, focus blocks and birthdays.`,
    'Return only the events worth preparing for, by ref. For each: why (one sentence), prep (at most 3 concrete points),',
    'and hold = {durationMinutes, minutesBefore} only if real preparation time should be blocked beforehand, otherwise null.',
    'headline = one short line summarising tomorrow. If nothing is worth preparing, return an empty items list.',
    notUseful.length ? `The person recently marked these as NOT useful to prep for; weigh similar events down: ${JSON.stringify(notUseful)}` : '',
    `<events>${JSON.stringify(refs)}</events>`,
  ].filter(Boolean).join('\n');
}

function toBriefItems(ranking: z.infer<typeof RankingSchema>, candidates: EventFeatures[]): BriefItem[] {
  const byRef = new Map(candidates.map((f, i) => [`e${i + 1}`, f]));
  const seen = new Set<string>();
  const items: BriefItem[] = [];
  for (const r of ranking.items) {
    const f = byRef.get(r.ref);
    if (!f || seen.has(r.ref)) continue; // the model can only pick from what it was shown
    seen.add(r.ref);
    let hold: BriefItem['hold'] = null;
    if (r.hold && !f.allDay) {
      const duration = Math.min(Math.max(Math.round(r.hold.durationMinutes), 10), 120);
      const before = Math.min(Math.max(Math.round(r.hold.minutesBefore), 0), 12 * 60);
      const end = Date.parse(f.start) - before * 60_000;
      hold = { start: new Date(end - duration * 60_000).toISOString(), end: new Date(end).toISOString() };
    }
    items.push({
      eventId: f.eventId, title: f.title, start: f.start, end: f.end, allDay: f.allDay, localStart: f.localStart,
      why: r.why.slice(0, 300), prep: r.prep.slice(0, 3).map((p) => p.slice(0, 300)), hold, features: f,
    });
  }
  return items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

// ---------- steps ----------

type PrepContext = { date: string; timeMin: string; timeMax: string; connectionId: string; selfEmail: string; notUseful: string[] };

async function prepContext(agent: AgentRow, trigger: Trigger): Promise<PrepContext> {
  const { rows } = await pool.query(
    `select c.id, c.account_label from ops.agent_connections ac join ops.connections c on c.id = ac.connection_id
      where ac.agent_id = $1 and c.provider = 'google' order by c.id limit 1`,
    [agent.id],
  );
  if (!rows[0]) throw new OpsError('validation', `agent ${agent.id} has no Google connection`);
  // A schedule tick briefs the day after the tick's own local date; Run Now briefs tomorrow (or a given day).
  const base = trigger.type === 'schedule' ? new Date(trigger.sourceEvent) : new Date();
  const date = trigger.forDate ?? addDays(localDate(base, agent.timezone), 1);
  const fb = await pool.query(
    `select distinct f.title from ops.brief_feedback f join ops.briefs b on b.id = f.brief_id
      where b.agent_id = $1 and f.verdict in ('not_useful', 'dismissed') and f.created_at > now() - interval '30 days' and f.title is not null
      limit 20`,
    [agent.id],
  );
  return {
    date,
    timeMin: zonedMidnight(date, agent.timezone).toISOString(),
    timeMax: zonedMidnight(addDays(date, 1), agent.timezone).toISOString(),
    connectionId: rows[0].id,
    selfEmail: rows[0].account_label ?? '',
    notUseful: fb.rows.map((r) => r.title),
  };
}

type SavedBrief = { briefId: string; previousMirror: { eventId: string | null; calendarId: string | null; status: string | null } };

async function saveBrief(agent: AgentRow, ctx: PrepContext, workflowId: string, b: { headline: string; items: BriefItem[]; considered: number; filtered: unknown[] }): Promise<SavedBrief> {
  const prev = await pool.query(`select mirror_event_id, mirror_calendar_id, mirror_status from ops.briefs where agent_id = $1 and brief_date = $2`, [agent.id, ctx.date]);
  const { rows } = await pool.query(
    `insert into ops.briefs (agent_id, brief_date, timezone, time_min, time_max, connection_id, source_workflow_id, headline, items, considered, filtered)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (agent_id, brief_date) do update set
       timezone = excluded.timezone, time_min = excluded.time_min, time_max = excluded.time_max, connection_id = excluded.connection_id,
       source_workflow_id = excluded.source_workflow_id, headline = excluded.headline, items = excluded.items,
       considered = excluded.considered, filtered = excluded.filtered, seen_at = null, updated_at = now()
     returning id`,
    [agent.id, ctx.date, agent.timezone, ctx.timeMin, ctx.timeMax, ctx.connectionId, workflowId, b.headline,
      JSON.stringify(b.items), b.considered, JSON.stringify(b.filtered)],
  );
  const p = prev.rows[0];
  return { briefId: rows[0].id, previousMirror: { eventId: p?.mirror_event_id ?? null, calendarId: p?.mirror_calendar_id ?? null, status: p?.mirror_status ?? null } };
}

const appUrl = () => (process.env.APP_URL ?? (process.env.GOOGLE_REDIRECT_URI ? new URL(process.env.GOOGLE_REDIRECT_URI).origin : '')).replace(/\/$/, '');

export function mirrorBody(date: string, items: BriefItem[], headline: string) {
  const n = items.length;
  const lines = items.map((i) => `${i.localStart ?? 'All day'}  ${i.title}`);
  return {
    summary: `Prep brief · ${n} item${n === 1 ? '' : 's'}`,
    description: [headline, '', ...lines, '', `Open full brief → ${appUrl()}/app/#/brief/${date}`].join('\n'),
    start: { date },
    end: { date: addDays(date, 1) },
    transparency: 'transparent', // shows as free: a mirror must never block the real schedule
  };
}

type MirrorResult = { status: 'written' | 'removed' | 'skipped' | 'failed'; eventId: string | null; calendarId: string | null; error?: string };

async function writeMirror(agent: AgentRow, ctx: PrepContext, saved: SavedBrief, items: BriefItem[], headline: string): Promise<MirrorResult> {
  const eventId = googleEventId(`brief:${agent.id}:${ctx.date}`);
  if (!items.length) {
    // Nothing to prep: no all-day noise. Remove a mirror an earlier run of this day wrote.
    if (saved.previousMirror.status === 'written' && saved.previousMirror.calendarId) {
      await deleteEvent(ctx.connectionId, saved.previousMirror.calendarId, eventId);
      return { status: 'removed', eventId, calendarId: saved.previousMirror.calendarId };
    }
    return { status: 'skipped', eventId: null, calendarId: null };
  }
  const { calendarId } = await ensureAgentOpsCalendar(ctx.connectionId);
  await upsertEvent(ctx.connectionId, calendarId, eventId, mirrorBody(ctx.date, items, headline) as never);
  return { status: 'written', eventId, calendarId };
}

// ---------- the workflow body (called from agentRunBody for handler = 'calendar_prep') ----------

export async function calendarPrepRun(agent: AgentRow, trigger: Trigger, workflowId: string): Promise<{ text: string; proposed: number }> {
  const ctx = await DBOS.runStep(() => prepContext(agent, trigger), { name: 'prepContext' });
  const events = await DBOS.runStep(() => listEvents(ctx.connectionId, 'primary', ctx.timeMin, ctx.timeMax, agent.timezone), {
    name: 'listEvents', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2, backoffRate: 2,
  });

  const filtered: { eventId: string; title: string; reason: string }[] = [];
  const candidates: EventFeatures[] = [];
  for (const e of events) {
    const reason = hardFilter(e);
    if (reason) filtered.push({ eventId: e.id, title: e.summary ?? '', reason });
    else candidates.push(eventFeatures(e, ctx.selfEmail, agent.timezone));
  }

  let headline = 'Nothing on the calendar tomorrow.';
  let items: BriefItem[] = [];
  if (candidates.length) {
    // The model call is a durable step (durableCalls): after a crash it replays from Postgres, unpaid.
    const result = await generateText({
      model: agentModel(agent.model),
      system: agent.instructions,
      prompt: rankingPrompt(ctx.date, agent.timezone, candidates, ctx.notUseful),
      output: Output.object({ schema: RankingSchema, name: 'calendar_prep_ranking' }),
    });
    items = toBriefItems(result.output, candidates);
    headline = result.output.headline.slice(0, 200) || `${items.length} to prepare for`;
  }

  const saved = await DBOS.runStep(() => saveBrief(agent, ctx, workflowId, { headline, items, considered: candidates.length, filtered }), { name: 'saveBrief' });

  // The brief row is canonical; the mirror is best-effort. A failed mirror is recorded and surfaces in the
  // Attention Queue, it never fails the run or loses the brief.
  let mirror: MirrorResult;
  try {
    mirror = await DBOS.runStep(() => writeMirror(agent, ctx, saved, items, headline), {
      name: 'writeMirror', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2, backoffRate: 2,
    });
  } catch (e) {
    const { errorClass, message } = classify(e);
    mirror = { status: 'failed', eventId: null, calendarId: null, error: `${errorClass}: ${message}` };
  }
  await DBOS.runStep(async () => {
    await pool.query(
      `update ops.briefs set mirror_status = $2, mirror_error = $3,
              mirror_event_id = coalesce($4, mirror_event_id), mirror_calendar_id = coalesce($5, mirror_calendar_id)
        where id = $1`,
      [saved.briefId, mirror.status, mirror.error ?? null, mirror.eventId, mirror.calendarId],
    );
  }, { name: 'saveMirrorStatus' });

  // One hold proposal per (event, day): re-running the brief never proposes the same hold twice.
  const proposed = await DBOS.runStep(async () => {
    let n = 0;
    for (const i of items.filter((x) => x.hold)) {
      await insertAction(agent, workflowId, {
        action: 'agentops.hold',
        target: i.eventId,
        payload: { connectionId: ctx.connectionId, title: `Prep: ${i.title}`, start: i.hold!.start, end: i.hold!.end, briefDate: ctx.date, sourceTitle: i.title, prep: i.prep },
        idempotencyKey: `${agent.id}:agentops.hold:${i.eventId}:${ctx.date}`,
      });
      n++;
    }
    return n;
  }, { name: 'proposeHolds' });

  return { text: `${ctx.date}: ${items.length} item(s), mirror ${mirror.status}; ${headline}`, proposed };
}

// ---------- executor side: an approved agentops.hold becomes an Agent Ops event ----------

export async function createAgentOpsHold(action: { idempotency_key: string; target: string; payload: Record<string, unknown> }) {
  const p = action.payload as { connectionId: string; title: string; start: string; end: string; prep?: string[]; sourceTitle?: string };
  const { calendarId } = await ensureAgentOpsCalendar(p.connectionId);
  const eventId = googleEventId(`hold:${action.idempotency_key}`);
  const ev = await insertEventOnce(p.connectionId, calendarId, eventId, {
    summary: p.title,
    description: [`Prep for: ${p.sourceTitle ?? ''}`, ...(p.prep ?? []).map((x) => `• ${x}`)].join('\n'),
    start: { dateTime: p.start },
    end: { dateTime: p.end },
  });
  return { calendarId, eventId: ev.id, created: ev.created, htmlLink: ev.htmlLink ?? null };
}

// ---------- "Request deeper prep": a focused second pass on one brief item ----------

async function deeperPrepBody(briefId: string, eventId: string) {
  const workflowId = DBOS.workflowID!;
  const ctx = await DBOS.runStep(async () => {
    const { rows } = await pool.query(
      `select b.agent_id, b.connection_id, b.brief_date::text as brief_date, b.timezone, a.model, a.instructions,
              (select value from jsonb_array_elements(b.items) where value->>'eventId' = $2) as item
         from ops.briefs b join ops.agents a on a.id = b.agent_id where b.id = $1`,
      [briefId, eventId],
    );
    if (!rows[0]?.item) throw new OpsError('validation', `brief ${briefId} has no item ${eventId}`);
    return rows[0] as { agent_id: string; connection_id: string; brief_date: string; timezone: string; model: string; instructions: string; item: BriefItem };
  }, { name: 'loadBriefItem' });
  await DBOS.runStep(() => recordRunStart({ workflowId, kind: 'agent_run', agentId: ctx.agent_id, trigger: 'deeper_prep', sourceEvent: `${briefId}/${eventId}` }), { name: 'recordRunStart' });

  try {
    const ev = await DBOS.runStep(() => getEvent(ctx.connection_id, 'primary', eventId), { name: 'getEvent', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 });
    const attendees = (ev.attendees ?? []).filter((a) => !a.resource).map((a) => `${a.email}${a.self ? ' (me)' : ''}${a.responseStatus ? ` [${a.responseStatus}]` : ''}`);
    const result = await generateText({
      model: agentModel(ctx.model),
      system: ctx.instructions,
      prompt: [
        '<deeper>Prepare me properly for this one meeting. Use only what is given; say what is unknown rather than guessing.',
        'Format: short markdown with sections Context, What I want out of it, Questions to ask, Decisions/risks. Under 250 words.',
        `Event: ${ev.summary ?? '(no title)'} at ${ctx.item.localStart ?? 'all day'} on ${ctx.brief_date} (${ctx.timezone}).`,
        `Attendees: ${attendees.join(', ') || 'none listed'}.`,
        `Organizer: ${ev.organizer?.email ?? 'unknown'}. Location: ${ev.location ?? 'none'}.`,
        `Description: ${(ev.description ?? '').slice(0, 4000) || 'none'}`,
        `First-pass brief said: ${ctx.item.why} Prep: ${ctx.item.prep.join(' | ')}</deeper>`,
      ].join('\n'),
    });
    await DBOS.runStep(async () => {
      await pool.query(
        `insert into ops.brief_deeper (brief_id, event_id, workflow_id, content) values ($1, $2, $3, $4)
         on conflict (brief_id, event_id) do update set content = excluded.content, workflow_id = excluded.workflow_id, created_at = now()`,
        [briefId, eventId, workflowId, result.text.slice(0, 8000)],
      );
    }, { name: 'saveDeeper' });
    await DBOS.runStep(() => recordRunEnd(workflowId, 'succeeded', {}), { name: 'recordRunEnd' });
    return { ok: true };
  } catch (err) {
    const { errorClass, message } = classify(err);
    await DBOS.runStep(() => recordRunEnd(workflowId, 'failed', { errorClass, errorMessage: message }), { name: 'recordRunFailed' });
    throw err;
  }
}

export const deeperPrep = DBOS.registerWorkflow(deeperPrepBody, { name: 'deeperPrep' });
