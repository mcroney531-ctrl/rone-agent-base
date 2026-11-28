// Edit before approve (D), end to end against fake Gmail + the scripted model:
//   edit → approve → Gmail gets exactly the edited text · the edit persists (server-side, survives reload) ·
//   a stale screen (changed elsewhere) can neither save nor approve over the newer version · an agent refresh never
//   overwrites the owner's edit · crash after Gmail accepted the edited draft → one draft · the AI original stays in
//   the audit/drill-in · reject still rejects · only declared fields are editable, and only while pending.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-action-edit.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AttentionItemSchema } from '../src/compat.js';
import { EXTERNALS, LOG_DIR, all, freshDb, killAllWorkers, one, startWorker, waitFor, type Worker } from './lib.js';

const PORT = 7897;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const post = (p: string, body?: unknown) => fetch(`${EXTERNALS}${p}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const gmail = async () => (await fetch(`${EXTERNALS}/google/admin/gmail/state`)).json();

const { url, db } = await freshDb('spike_action_edit');
const crashMarker = path.join(LOG_DIR, 'edit-crash.marker');
fs.rmSync(crashMarker, { force: true });
const env = {
  API_TOKEN: 'api-secret', CONNECTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`,
  GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`, GOOGLE_TOKEN_URL: `${EXTERNALS}/google/token`,
  GOOGLE_USERINFO_URL: `${EXTERNALS}/google/userinfo`, GOOGLE_CALENDAR_BASE: `${EXTERNALS}/google/calendar/v3`,
  GMAIL_BASE: `${EXTERNALS}/google/gmail/v1/users/me`, APP_URL: 'https://ops.example',
};
await post('/google/admin/reset');
let w: Worker = await startWorker({ id: 'edit-1', port: PORT, dbUrl: url, env });
let wid = 1;
async function restart(extra: Record<string, string> = {}) {
  if (w.proc.exitCode === null && w.proc.signalCode === null) await w.kill();
  w = await startWorker({ id: `edit-${++wid}`, port: PORT, dbUrl: url, env: { ...env, ...extra } });
}
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer api-secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let seq = 0;
async function triage() {
  const r = await call('POST', '/agents/inbox-triage/run', { requestId: `t${++seq}` });
  await waitFor('triage', async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [r.body.workflowID]))?.outcome), 30_000);
}
type Item = { type: string; ref: string; title: string; summary: string; edit?: { actionId: string; version: number; edited: boolean; fields: { name: string; value: string }[] } };
const draftCard = async (subject: string) => ((await call('GET', '/attention')).body as Item[]).find((i) => i.type === 'approval_needed' && i.summary.includes(subject));
const action = (id: string) => one(db, `select status, version, payload, proposed_payload, edited_by from ops.actions where id = $1`, [id]);
const draftsFor = async (subject: string) => (await gmail()).drafts.filter((d: { subject: string }) => d.subject === `Re: ${subject}`);

try {
  const start = await call('POST', '/connections/google', { id: 'google:primary' });
  await fetch((await fetch(start.body.authUrl, { redirect: 'manual' })).headers.get('location')!);
  await post('/google/admin/gmail/messages', [
    { id: 'e1', from: 'Dana Lee <dana@northwind.example>', subject: 'Lunch Thursday?', body: 'Are you free for lunch Thursday?' },
    { id: 'e2', from: 'Sam Ortiz <sam@acme.example>', subject: 'Quick favor?', body: 'Could you review my deck?' },
    { id: 'e3', from: 'Ana Ruiz <ana@acme.example>', subject: 'Coffee next week?', body: 'Coffee next week?' },
  ]);
  await triage();

  // ---- the card offers an edit of exactly the draft field ----
  let card = await draftCard('Lunch Thursday?');
  const aiDraft = card?.edit?.fields.find((f) => f.name === 'draft')?.value ?? '';
  check('a draft approval carries an edit descriptor: one field (the reply), version 1, the AI text', Boolean(card?.edit) && card!.edit!.version === 1
    && card!.edit!.fields.length === 1 && aiDraft.length > 0 && !card!.edit!.edited, card);
  check('…and still parses through the app contract (additive)', AttentionItemSchema.safeParse(card).success);
  const id = card!.edit!.actionId;

  // ---- edit → persists server-side ----
  const mine = 'Thursday works. How about 12:30 at the usual place?';
  const e1 = await call('PATCH', `/actions/${id}`, { version: 1, fields: { draft: mine } });
  check('saving an edit bumps the version and stores the owner text as the payload', e1.status === 200 && e1.body.version === 2 && e1.body.payload.draft === mine, e1);
  card = await draftCard('Lunch Thursday?');
  check('reload (a fresh GET): the edit persists; the card says it is the owner\'s edit', card?.edit?.version === 2 && card.edit.edited
    && card.edit.fields[0].value === mine && /Your edit: “Thursday works/.test(card.summary), card);
  const a1 = await action(id);
  check('the AI original is kept once (proposed_payload), the audit has the edit', a1.proposed_payload.draft === aiDraft && a1.payload.draft === mine
    && (await all(db, `select version, before, after from ops.action_edits where action_id = $1`, [id])).length === 1, a1);
  const facts = Object.fromEntries(((await call('GET', `/attention/approval_needed/${id}`)).body.facts ?? []).map((f: { label: string; value: string }) => [f.label, f.value]));
  check('the drill-in shows the edit, the AI original and who edited', facts['Draft (your edit)'] === mine && facts['Original draft (AI)'] === aiDraft && Boolean(facts.Edited), facts);

  // ---- stale screens can't overwrite or approve ----
  const staleSave = await call('PATCH', `/actions/${id}`, { version: 1, fields: { draft: 'from an old screen' } });
  check('a save from a stale screen (old version) is refused: 409 stale, nothing changes', staleSave.status === 409 && staleSave.body.reason === 'stale' && (await action(id)).payload.draft === mine, staleSave);
  const staleApprove = await call('POST', `/attention/approval_needed/${id}/approve`, { requestId: 'stale-1', version: 1 });
  check('an approve from a stale screen is refused and the action stays pending', staleApprove.status === 409 && /changed since/.test(staleApprove.body.message) && (await action(id)).status === 'pending_approval', staleApprove);
  const bad = await call('PATCH', `/actions/${id}`, { version: 2, fields: { to: 'attacker@evil.example' } });
  const empty = await call('PATCH', `/actions/${id}`, { version: 2, fields: { draft: '   ' } });
  check('only declared fields can be edited (the recipient is not), and the reply can\'t be emptied', bad.status === 400 && empty.status === 400 && (await action(id)).version === 2, { bad, empty });

  // ---- an agent refresh never overwrites the owner's edit ----
  // The real re-proposal path (insertAction with refreshPending, as Calendar Prep uses for holds).
  process.env.DATABASE_URL = url;
  const { insertAction } = await import('../src/workflows.js');
  const row = await one(db, `select agent_id, logical_action, target, payload, idempotency_key from ops.actions where id = $1`, [id]);
  await insertAction({ id: row.agent_id, approval_policy: { mode: 'manual' } } as never, 'refresh-sim',
    { action: row.logical_action, target: row.target, payload: { ...row.payload, draft: 'AI rewrite' }, idempotencyKey: row.idempotency_key, refreshPending: true });
  check('INVARIANT: an agent refresh/rerun after the owner edited never replaces the edit (payload and version unchanged)', (await action(id)).payload.draft === mine && (await action(id)).version === 2, await action(id));

  // ---- approve exactly the edited version → Gmail gets exactly that text, once, even across a crash ----
  await restart({ CRASH_AFTER_PROVIDER_CALL: crashMarker, CRASH_AFTER_PROVIDER_CALL_ACTION: 'gmail.draft' });
  const ok = await call('POST', `/attention/approval_needed/${id}/approve`, { requestId: 'ok-1', version: 2 });
  check('approving with the current version is accepted', ok.status === 200, ok);
  await waitFor('worker died right after Gmail accepted the draft', () => fs.existsSync(crashMarker) && (w.proc.exitCode !== null || w.proc.signalCode !== null), 30_000);
  await restart();
  await waitFor('executor recovered', async () => (await action(id)).status === 'executed', 60_000);
  const drafts = await draftsFor('Lunch Thursday?');
  check('crash after Gmail accepted it, then recovery: exactly ONE draft, containing exactly the owner\'s text', drafts.length === 1 && drafts[0].body === mine, drafts);
  check('…and the AI text was never sent to Gmail', !(await gmail()).drafts.some((d: { body: string }) => d.body === aiDraft));
  const after = await call('PATCH', `/actions/${id}`, { version: 2, fields: { draft: 'too late' } });
  check('once approved, the payload is frozen (edit → 409 decided)', after.status === 409 && after.body.reason === 'decided' && (await action(id)).payload.draft === mine, after);

  // ---- an unedited approve still works, and still carries a version check ----
  const c2 = (await draftCard('Quick favor?'))!;
  await call('POST', `/attention/approval_needed/${c2.edit!.actionId}/approve`, { requestId: 'ok-2', version: c2.edit!.version });
  await waitFor('unedited executed', async () => (await action(c2.edit!.actionId)).status === 'executed', 30_000);
  check('approving without editing sends the AI draft as before; no proposed_payload recorded', (await draftsFor('Quick favor?'))[0]?.body === c2.edit!.fields[0].value
    && (await action(c2.edit!.actionId)).proposed_payload === null);

  // ---- reject still rejects, even after an edit ----
  const c3 = (await draftCard('Coffee next week?'))!;
  await call('PATCH', `/actions/${c3.edit!.actionId}`, { version: 1, fields: { draft: 'Sure, Tuesday?' } });
  const rj = await call('POST', `/attention/approval_needed/${c3.edit!.actionId}/reject`, { requestId: 'rj-1' });
  check('reject after an edit rejects the whole action: nothing reaches Gmail', rj.status === 200 && (await action(c3.edit!.actionId)).status === 'rejected'
    && (await draftsFor('Coffee next week?')).length === 0, rj);

  check('nothing was ever sent, deleted or trashed', (await gmail()).forbidden.length === 0, (await gmail()).forbidden);
} finally {
  await killAllWorkers();
  await db.end();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall action edit checks passed');
process.exit(failures.length ? 1 : 0);
