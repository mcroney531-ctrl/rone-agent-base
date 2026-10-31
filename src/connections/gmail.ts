// Gmail as a capability boundary: this module is the ONLY Gmail code, and it exposes only what Inbox Triage
// may do. Read inbox mail; add labels under "Agent Ops/"; find or create a draft reply. There is deliberately
// no send, delete, trash, archive, read/unread, spam or arbitrary-label method, and no raw client is
// exported, so "never send" is absent from the system's capabilities rather than a promise not to call it.
// (gmail.modify would let Google accept a send; nothing here can make one.)
import { createHash } from 'node:crypto';
import { OpsError } from '../errors.js';
import { googleAccessToken } from './google.js';

export const AGENT_OPS_LABEL_PREFIX = 'Agent Ops/';
const base = () => process.env.GMAIL_BASE ?? 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailApiError extends OpsError {
  constructor(errorClass: OpsError['errorClass'], public readonly status: number, message: string) {
    super(errorClass, message);
  }
}

// Private on purpose: only the named functions below may reach Gmail.
async function gmail<T>(connectionId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const call = async (token: string) => fetch(`${base()}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  let res = await call(await googleAccessToken(connectionId));
  if (res.status === 401) res = await call(await googleAccessToken(connectionId, { forceRefresh: true }));
  if (!res.ok) {
    const cls = res.status === 401 || res.status === 403 ? 'provider_auth' : res.status === 429 || res.status >= 500 ? 'provider_unavailable' : 'validation';
    throw new GmailApiError(cls, res.status, `Gmail API ${method} ${path.split('?')[0]} → ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---------- intake ----------

/** Current mailbox history ID: the cursor to resume from after a bootstrap read. */
export async function mailboxHistoryId(connectionId: string): Promise<string> {
  return (await gmail<{ historyId: string }>(connectionId, 'GET', '/profile')).historyId;
}

/** Bootstrap: inbox message IDs received in the last `hours` hours (newest first, capped). */
export async function recentInboxIds(connectionId: string, hours: number, cap = 200): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ q: `in:inbox newer_than:${Math.max(1, Math.ceil(hours / 24))}d`, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
    const r = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(connectionId, 'GET', `/messages?${q}`);
    ids.push(...(r.messages ?? []).map((m) => m.id));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < cap);
  return ids.slice(0, cap);
}

/**
 * Incremental intake: IDs of messages added to the inbox since `startHistoryId`, and the new cursor.
 * Returns null when Gmail no longer has history that old (404): the caller re-bootstraps.
 */
export async function inboxAddedSince(connectionId: string, startHistoryId: string): Promise<{ ids: string[]; historyId: string } | null> {
  const ids = new Set<string>();
  let historyId = startHistoryId;
  let pageToken: string | undefined;
  try {
    do {
      const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', ...(pageToken ? { pageToken } : {}) });
      const r = await gmail<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string; nextPageToken?: string }>(
        connectionId, 'GET', `/history?${q}`);
      for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) if (!a.message.labelIds || a.message.labelIds.includes('INBOX')) ids.add(a.message.id);
      historyId = r.historyId ?? historyId;
      pageToken = r.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof GmailApiError && e.status === 404) return null;
    throw e;
  }
  return { ids: [...ids], historyId };
}

/**
 * Read-only retrieval (Calendar Prep): IDs of recent mail exchanged with any of these addresses, newest first.
 * Matching is by email ADDRESS only (from/to/cc), never by display name, so a namesake can't pull in the wrong thread.
 */
export async function recentMailWith(connectionId: string, addresses: string[], days: number, cap = 12): Promise<{ id: string; threadId: string }[]> {
  const addrs = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => /^[^\s@{}()"]+@[^\s@{}()"]+$/.test(a)))];
  if (!addrs.length) return [];
  const any = addrs.flatMap((a) => [`from:${a}`, `to:${a}`, `cc:${a}`]).join(' ');
  const q = new URLSearchParams({ q: `newer_than:${days}d {${any}} -in:spam -in:trash -in:drafts`, maxResults: String(Math.min(cap, 50)) });
  const r = await gmail<{ messages?: { id: string; threadId: string }[] }>(connectionId, 'GET', `/messages?${q}`);
  return (r.messages ?? []).slice(0, cap);
}

export type MailMessage = {
  id: string; threadId: string; labelIds: string[]; receivedAt: string;
  from: string; fromName: string | null; fromAddr: string; replyTo: string | null; to: string; cc: string; subject: string;
  messageIdHeader: string | null; references: string | null;
  listUnsubscribe: boolean; precedence: string | null; autoSubmitted: string | null;
  snippet: string; body: string;
};

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function plainText(p: Part | undefined): string {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return b64url(p.body.data);
  for (const c of p.parts ?? []) { const t = plainText(c); if (t) return t; }
  return '';
}
function parseFrom(v: string): { name: string | null; addr: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1].trim() || null, addr: m[2].trim().toLowerCase() } : { name: null, addr: v.trim().toLowerCase() };
}

type RawMessage = { id: string; threadId: string; labelIds?: string[]; internalDate: string; snippet?: string; payload?: Part };

/** One message: the headers triage needs, plus up to `maxBody` chars of plain text. Null if it's gone. */
export async function getMessage(connectionId: string, id: string, maxBody = 4000): Promise<MailMessage | null> {
  let m: RawMessage;
  try {
    m = await gmail(connectionId, 'GET', `/messages/${encodeURIComponent(id)}?format=full`);
  } catch (e) {
    if (e instanceof GmailApiError && e.status === 404) return null;
    throw e;
  }
  return parseMessage(m, maxBody);
}

/** Read-only (Follow-up Tracker): IDs of mail the owner sent in the last `days` days, newest first. */
export async function recentSentIds(connectionId: string, days: number, cap = 50): Promise<string[]> {
  const q = new URLSearchParams({ q: `in:sent newer_than:${days}d -in:drafts`, maxResults: String(Math.min(cap, 100)) });
  const r = await gmail<{ messages?: { id: string }[] }>(connectionId, 'GET', `/messages?${q}`);
  return (r.messages ?? []).map((m) => m.id).slice(0, cap);
}

/** Read-only (Follow-up Tracker): every message in a thread, oldest first. Null if the thread is gone. */
export async function threadMessages(connectionId: string, threadId: string, maxBody = 1000): Promise<MailMessage[] | null> {
  try {
    const t = await gmail<{ messages?: RawMessage[] }>(connectionId, 'GET', `/threads/${encodeURIComponent(threadId)}?format=full`);
    return (t.messages ?? []).map((m) => parseMessage(m, maxBody)).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  } catch (e) {
    if (e instanceof GmailApiError && e.status === 404) return null;
    throw e;
  }
}

function parseMessage(m: RawMessage, maxBody: number): MailMessage {
  const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  const from = h('From') ?? '';
  const f = parseFrom(from);
  return {
    id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [], receivedAt: new Date(Number(m.internalDate)).toISOString(),
    from, fromName: f.name, fromAddr: f.addr, replyTo: h('Reply-To'), to: h('To') ?? '', cc: h('Cc') ?? '', subject: h('Subject') ?? '(no subject)',
    messageIdHeader: h('Message-ID') ?? h('Message-Id'), references: h('References'),
    listUnsubscribe: Boolean(h('List-Unsubscribe')), precedence: h('Precedence'), autoSubmitted: h('Auto-Submitted'),
    snippet: m.snippet ?? '', body: plainText(m.payload).slice(0, maxBody),
  };
}

// ---------- actions (the executor's only Gmail writes) ----------

function assertAgentOpsLabel(name: string) {
  if (!name.startsWith(AGENT_OPS_LABEL_PREFIX) || name.length > 100) throw new OpsError('validation', `label "${name}" is outside ${AGENT_OPS_LABEL_PREFIX}*`);
}

/** Adds an "Agent Ops/*" label to a message, creating the label once. Idempotent. */
export async function addAgentOpsLabel(connectionId: string, messageId: string, labelName: string): Promise<{ labelId: string }> {
  assertAgentOpsLabel(labelName);
  const { labels = [] } = await gmail<{ labels?: { id: string; name: string }[] }>(connectionId, 'GET', '/labels');
  let label = labels.find((l) => l.name === labelName);
  if (!label) {
    try {
      label = await gmail<{ id: string; name: string }>(connectionId, 'POST', '/labels', { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    } catch (e) {
      if (!(e instanceof GmailApiError && e.status === 409)) throw e; // created concurrently: look it up again
      label = (await gmail<{ labels?: { id: string; name: string }[] }>(connectionId, 'GET', '/labels')).labels?.find((l) => l.name === labelName);
      if (!label) throw e;
    }
  }
  await gmail(connectionId, 'POST', `/messages/${encodeURIComponent(messageId)}/modify`, { addLabelIds: [label.id] });
  return { labelId: label.id };
}

/** A stable RFC 5322 Message-ID for a draft, from the action's idempotency key. */
export const draftMessageId = (idempotencyKey: string) =>
  `<agentops-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}@agent-ops.local>`;

export type DraftReply = {
  threadId: string; to: string; subject: string; body: string;
  inReplyTo: string | null; references: string | null; idempotencyKey: string;
};

/**
 * Creates a draft reply in the thread exactly once per idempotency key. Gmail has no idempotency key, so the
 * draft carries a deterministic Message-ID and we look for it first: a replay after a crash finds the draft
 * it already made instead of making a second one. Drafts are created, never sent.
 */
export async function createDraftReplyOnce(connectionId: string, d: DraftReply): Promise<{ draftId: string | null; messageId: string; existed: boolean }> {
  const mid = draftMessageId(d.idempotencyKey);
  const found = await gmail<{ messages?: { id: string }[] }>(connectionId, 'GET', `/messages?${new URLSearchParams({ q: `in:drafts rfc822msgid:${mid}` })}`);
  if (found.messages?.length) return { draftId: null, messageId: found.messages[0].id, existed: true };
  const subject = /^re:/i.test(d.subject) ? d.subject : `Re: ${d.subject}`;
  const headers = [
    `To: ${d.to}`, `Subject: ${subject}`, `Message-ID: ${mid}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`, `References: ${[d.references, d.inReplyTo].filter(Boolean).join(' ')}`] : []),
    'Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0',
  ];
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${d.body}`).toString('base64url');
  const r = await gmail<{ id: string; message: { id: string } }>(connectionId, 'POST', '/drafts', { message: { threadId: d.threadId, raw } });
  return { draftId: r.id, messageId: r.message.id, existed: false };
}
