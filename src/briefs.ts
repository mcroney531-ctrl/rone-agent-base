// The phone's brief view: one card per meeting worth preparing for, built from the brief row (content,
// refreshable) joined with the owner's state, which keeps its own identity across reruns:
// hold ACTIONs (ops.actions), feedback (ops.brief_feedback), deeper prep (ops.brief_deeper).
import { pool } from './db.js';
import { localDate } from './localDay.js';
import type { BriefItem } from './calendarPrep.js';

export type Source = { url: string; label: string; provenance: 'event' | 'consulted' };
export type CardHold = {
  actionId: string;
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'failed';
  start: string;
  end: string;
  note?: string;
};
export type Card = {
  eventId: string; title: string; start: string; end: string; allDay: boolean; localStart: string | null;
  why: string; prep: string[]; sources: Source[];
  hold: CardHold | null; holdNote?: string;
  deeper: { status: 'none' | 'preparing' | 'ready' | 'failed'; content?: string };
  feedback: string | null;
};

// A readable label from the URL itself (or the attachment title Google gave us). Never from model text.
export function sourceLabel(url: string, title?: string): string {
  if (title) return title.slice(0, 60);
  try {
    const u = new URL(url);
    if (u.hostname === 'docs.google.com') {
      const kind = u.pathname.split('/')[1];
      return { document: 'Google Doc', presentation: 'Google Slides', spreadsheets: 'Google Sheet', forms: 'Google Form' }[kind] ?? 'Google Docs';
    }
    if (u.hostname === 'drive.google.com') return 'Drive file';
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return `${u.hostname.replace(/^www\./, '')}${seg ? ` › ${decodeURIComponent(seg).slice(0, 24)}` : ''}`;
  } catch {
    return 'Link';
  }
}

// Provenance rule: "event" = links on the calendar event (the owner or organizer attached them);
// "consulted" = URLs the system itself fetched while preparing (item.consultedSources, written only by
// retrieval code). Links the model mentions in its prose are never promoted to sources.
function sourcesFor(item: BriefItem & { consultedSources?: { url: string; title?: string }[] }): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const url of item.features?.docLinks ?? []) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label: sourceLabel(url), provenance: 'event' });
  }
  for (const s of item.consultedSources ?? []) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ url: s.url, label: sourceLabel(s.url, s.title), provenance: 'consulted' });
  }
  return out;
}

const HOLD_STATUS: Record<string, CardHold['status'] | undefined> = {
  pending_approval: 'pending', approved: 'approving', executed: 'approved', rejected: 'rejected', failed: 'failed',
};

export async function briefView(key: string, agentId: string) {
  const byDate = /^\d{4}-\d{2}-\d{2}$/.test(key);
  const { rows: [b] } = await pool.query(
    `select b.*, b.brief_date::text as brief_date from ops.briefs b
      where ${byDate ? `b.brief_date = $1::date and b.agent_id = $2` : `b.id = $1::uuid`}`,
    byDate ? [key, agentId] : [key],
  );
  if (!b) return null;

  const [holds, feedback, deeper] = await Promise.all([
    pool.query(
      `select distinct on (target) id, target, status, error, payload
         from ops.actions where agent_id = $1 and logical_action = 'agentops.hold' and payload->>'briefDate' = $2 and status <> 'superseded'
        order by target, created_at desc`,
      [b.agent_id, b.brief_date],
    ),
    pool.query(`select event_id, verdict from ops.brief_feedback where brief_id = $1`, [b.id]),
    pool.query(
      `select e.event_id, d.content, v.run_state
         from (select value->>'eventId' as event_id from jsonb_array_elements($2::jsonb)) e
         left join ops.brief_deeper d on d.brief_id = $1::uuid and d.event_id = e.event_id
         left join lateral (select run_state from ops.v_runs
                             where workflow_id like 'deeper-' || $1::text || '-' || e.event_id || '%'
                             order by created_at desc limit 1) v on true`,
      [b.id, JSON.stringify(b.items)],
    ),
  ]);
  const holdBy = new Map(holds.rows.map((r) => [r.target, r]));
  const fbBy = new Map(feedback.rows.map((r) => [r.event_id, r.verdict as string]));
  const deepBy = new Map(deeper.rows.map((r) => [r.event_id, r]));

  const cards: Card[] = (b.items as BriefItem[]).map((i) => {
    const a = holdBy.get(i.eventId);
    const status = a ? HOLD_STATUS[a.status] : undefined;
    const hold: CardHold | null = a && status ? {
      actionId: a.id, status, start: a.payload.start, end: a.payload.end,
      note: status === 'failed' ? (a.error ?? 'No longer fits')
        : a.payload.movedFrom && status === 'pending' ? 'Moved — earlier slot was taken' : undefined,
    } : null;
    const d = deepBy.get(i.eventId);
    const deep: Card['deeper'] = d?.content ? { status: 'ready', content: d.content }
      : d?.run_state === 'queued' || d?.run_state === 'running' ? { status: 'preparing' }
      : d?.run_state === 'failed' ? { status: 'failed' } : { status: 'none' };
    return {
      eventId: i.eventId, title: i.title, start: i.start, end: i.end, allDay: i.allDay, localStart: i.localStart,
      why: i.why, prep: i.prep, sources: sourcesFor(i), hold, holdNote: hold ? undefined : i.holdNote,
      deeper: deep, feedback: fbBy.get(i.eventId) ?? null,
    };
  });

  const dismissed = (v: string | null) => v === 'not_useful' || v === 'dismissed';
  return {
    ...b,
    // Undo is offered only while the day hasn't passed.
    editable: b.brief_date >= localDate(new Date(), b.timezone),
    cards: cards.filter((c) => !dismissed(c.feedback)),
    dismissedCards: cards.filter((c) => dismissed(c.feedback)).map((c) => ({ eventId: c.eventId, title: c.title, localStart: c.localStart })),
    // Kept for API compatibility (tests, scripts).
    deeper: Object.fromEntries(deeper.rows.filter((r) => r.content).map((r) => [r.event_id, { content: r.content }])),
    feedback: Object.fromEntries(fbBy),
  };
}

// "Not useful" collapses the card, stops hold proposals for it (an undecided one is withdrawn), and becomes
// ranking feedback. "clear" is Undo. Brief history itself is never deleted.
export async function setFeedback(briefId: string, eventId: string, verdict: 'useful' | 'not_useful' | 'dismissed' | 'clear', title: string) {
  if (verdict === 'clear') {
    await pool.query(`delete from ops.brief_feedback where brief_id = $1 and event_id = $2`, [briefId, eventId]);
    return;
  }
  await pool.query(
    `insert into ops.brief_feedback (brief_id, event_id, verdict, title) values ($1, $2, $3, $4)
     on conflict (brief_id, event_id) do update set verdict = excluded.verdict, created_at = now()`,
    [briefId, eventId, verdict, title],
  );
  if (verdict !== 'useful') {
    await pool.query(
      `update ops.actions a set status = 'superseded', error = 'meeting marked not useful', updated_at = now()
         from ops.briefs b
        where b.id = $1 and a.agent_id = b.agent_id and a.logical_action = 'agentops.hold' and a.status = 'pending_approval'
          and a.target = $2 and a.payload->>'briefDate' = b.brief_date::text`,
      [briefId, eventId],
    );
  }
}
