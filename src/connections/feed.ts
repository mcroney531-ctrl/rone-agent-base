// Feed (RSS 2.0 / RSS 1.0 / Atom) as a source: the second connection type, with no OAuth and no secret.
// This adapter is deliberately DUMB: fetch safely, parse, normalize, hash. It has no judgment and no state;
// the Research Watch producer (src/feedWatch.ts) owns checkpoints and relevance. Same split that kept Gmail
// push clean: the source says "here is what's there now", the producer decides what it means.
//
// Fetch safety (the URL is owner-supplied and fetched from our server):
//   - https only; the resolved address of EVERY hop must be public (no loopback, private, link-local, CGNAT,
//     multicast, reserved, IPv4-mapped private). The check runs inside the socket's DNS lookup, so the
//     address we check is the address we connect to (no DNS-rebinding gap).
//   - at most 3 redirects, each re-checked; 10 s overall timeout; the 2 MB cap applies to the DECOMPRESSED
//     body (a 20 KB gzip bomb is refused, not inflated).
// Parse safety: any DOCTYPE/ENTITY declaration is refused before parsing (no external entities, no billion laughs).
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const FEED_LIMITS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3, maxItems: 200, textChars: 4000 };

export class FeedError extends Error {
  constructor(public readonly kind: 'blocked' | 'http' | 'too_large' | 'timeout' | 'network' | 'invalid', message: string, public readonly httpStatus?: number) {
    super(message);
  }
  /** Does this failure say the source itself is gone or isn't a feed (vs. a transient problem)? */
  get permanent(): boolean {
    return this.kind === 'invalid' || this.kind === 'blocked' || this.kind === 'too_large' || this.httpStatus === 404 || this.httpStatus === 410;
  }
}

// ---------- address policy ----------

const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  BLOCKED.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]] as const) {
  BLOCKED.addSubnet(a, p, 'ipv6');
}

/** True when an address must never be fetched from (private, loopback, link-local, reserved...). */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return BLOCKED.check(mapped, 'ipv4');
  const family = net.isIP(address);
  if (!family) return true;
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Tests only: FEED_ALLOW_INSECURE=1 permits http; FEED_ALLOW_HOSTS lists the exact private addresses a test
// server listens on (e.g. 127.0.0.1). Every other private address stays blocked, so redirect/SSRF tests are real.
const insecureAllowed = () => process.env.FEED_ALLOW_INSECURE === '1';
const allowedPrivate = (address: string) => (process.env.FEED_ALLOW_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean).includes(address);
const blocked = (address: string) => isBlockedAddress(address) && !allowedPrivate(address);

/** Reject a URL before any connection: scheme, credentials, literal private IPs. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FeedError('invalid', 'not a valid URL'); }
  if (u.protocol !== 'https:' && !(insecureAllowed() && u.protocol === 'http:')) throw new FeedError('blocked', 'only https URLs are allowed');
  if (u.username || u.password) throw new FeedError('blocked', 'URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && blocked(host)) throw new FeedError('blocked', 'that address is not public');
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
// Runs as the socket's resolver, so the checked address IS the connected address.
function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => blocked(a.address))) {
      const e = new Error(`${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
      e.code = 'EBLOCKED';
      return cb(e, '');
    }
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

// ---------- fetch ----------

export type FetchResult =
  | { status: 'ok'; body: string; etag: string | null; lastModified: string | null; finalUrl: string }
  | { status: 'not_modified' };

function once(u: URL, headers: Record<string, string>, deadline: number): Promise<{ res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', headers, lookup: safeLookup as never, timeout: Math.max(1, deadline - Date.now()) }, (res) => resolve({ res }));
    req.on('timeout', () => req.destroy(new FeedError('timeout', 'timed out')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e instanceof FeedError ? e : e.code === 'EBLOCKED' ? new FeedError('blocked', e.message) : new FeedError('network', e.message)));
    req.end();
  });
}

function readBody(res: http.IncomingMessage, maxBytes: number, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
    // The cap counts DECOMPRESSED bytes: the decoder's output is what we measure.
    const stream: NodeJS.ReadableStream = enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip())
      : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
    const chunks: Buffer[] = [];
    let n = 0;
    const timer = setTimeout(() => { res.destroy(); reject(new FeedError('timeout', 'timed out')); }, Math.max(1, deadline - Date.now()));
    stream.on('data', (c: Buffer) => {
      n += c.length;
      if (n > maxBytes) {
        clearTimeout(timer);
        res.destroy();
        (stream as unknown as { destroy?: () => void }).destroy?.();
        reject(new FeedError('too_large', `larger than ${Math.round(maxBytes / 1024)} KB`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    stream.on('error', (e: Error) => { clearTimeout(timer); reject(e instanceof FeedError ? e : new FeedError('invalid', `bad body: ${e.message}`)); });
  });
}

/** Conditional GET of a feed URL under the safety rules above. 304 → not_modified (no work). */
export async function fetchFeed(url: string, cond: { etag?: string | null; lastModified?: string | null } = {}, limits = FEED_LIMITS): Promise<FetchResult> {
  const deadline = Date.now() + limits.timeoutMs;
  let u = checkUrl(url);
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = {
      'user-agent': 'AgentOps-FeedWatch/1.0', 'accept-encoding': 'gzip, deflate, br',
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
    };
    if (cond.etag) headers['if-none-match'] = cond.etag;
    if (cond.lastModified) headers['if-modified-since'] = cond.lastModified;
    const { res } = await once(u, headers, deadline);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && status !== 304) {
      res.resume();
      const loc = res.headers.location;
      if (!loc) throw new FeedError('http', `redirect ${status} without a location`, status);
      if (hop >= limits.maxRedirects) throw new FeedError('http', 'too many redirects', status);
      u = checkUrl(new URL(loc, u).toString()); // every hop is re-checked
      continue;
    }
    if (status === 304) { res.resume(); return { status: 'not_modified' }; }
    if (status < 200 || status >= 300) { res.resume(); throw new FeedError('http', `HTTP ${status}`, status); }
    const body = await readBody(res, limits.maxBytes, deadline);
    const h = (k: string) => (typeof res.headers[k] === 'string' ? (res.headers[k] as string) : null);
    return { status: 'ok', body, etag: h('etag'), lastModified: h('last-modified'), finalUrl: u.toString() };
  }
}

// ---------- parse + normalize ----------

export type FeedItem = {
  key: string;              // guid / atom id, else link, else hash of the title
  link: string | null;
  title: string;
  published: string | null; // ISO, when the feed gives a parseable date
  text: string;             // normalized plain text, bounded
  contentHash: string;      // see contentHash()
};
export type ParsedFeed = { kind: 'rss' | 'atom' | 'rdf'; title: string; link: string | null; items: FeedItem[] };

const decode = (s: string) => s
  .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
  .replace(/&amp;/gi, '&');

/** HTML/markup → plain text, whitespace collapsed. Markup-only and whitespace-only edits normalize away. */
export function normalizeText(v: unknown): string {
  const s = str(v);
  return decode(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The pinned definition of "the content changed" (CONTENT_HASH v1): sha256 over the normalized title and the
 * normalized body text ONLY. Excluded on purpose: link (tracking params change), dates (feeds bump them),
 * guid, the item's position in the feed, markup and whitespace. Changing this definition re-flags every item
 * as changed, so it carries a version prefix and must be bumped deliberately.
 */
export const CONTENT_HASH_VERSION = 'v1';
export function contentHash(title: string, text: string): string {
  return crypto.createHash('sha256').update(`${CONTENT_HASH_VERSION}\n${title}\n${text}`).digest('hex').slice(0, 32);
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === 'object') return str((v as Record<string, unknown>)['#text']);
  return '';
}
const iso = (v: unknown) => { const t = Date.parse(str(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function atomLink(v: unknown): string | null {
  const links = arr(v as Record<string, string>[]).map((l) => (typeof l === 'string' ? { '@_href': l } : l));
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return alt?.['@_href'] ?? null;
}

function item(raw: { key: unknown; link: string | null; title: unknown; text: unknown; published: unknown }): FeedItem {
  const title = normalizeText(raw.title) || '(untitled)';
  const text = normalizeText(raw.text);
  const key = (normalizeText(raw.key) || raw.link || `h:${contentHash(title, '')}`).slice(0, 500);
  return { key, link: raw.link, title: title.slice(0, 300), published: iso(raw.published), text: text.slice(0, FEED_LIMITS.textChars), contentHash: contentHash(title, text) };
}

export function parseFeed(xml: string): ParsedFeed {
  // No DTDs at all: rules out external entities and entity-expansion bombs before the parser sees anything.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FeedError('invalid', 'DOCTYPE/ENTITY declarations are not allowed');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new FeedError('invalid', `not well-formed XML: ${valid.err.msg.slice(0, 120)}`);
  let doc: Record<string, any>;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: true, htmlEntities: false, parseTagValue: false, trimValues: true }).parse(xml);
  } catch (e) {
    throw new FeedError('invalid', `not well-formed XML: ${(e as Error).message.slice(0, 120)}`);
  }
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    const items = arr(ch.item).slice(0, FEED_LIMITS.maxItems).map((i: Record<string, unknown>) => {
      const link = str(i.link) || null;
      return item({ key: i.guid, link, title: i.title, text: i['content:encoded'] ?? i.description, published: i.pubDate ?? i['dc:date'] });
    });
    return { kind: 'rss', title: normalizeText(ch.title) || 'Untitled feed', link: str(ch.link) || null, items };
  }
  if (doc.feed) {
    const f = doc.feed;
    const items = arr(f.entry).slice(0, FEED_LIMITS.maxItems).map((e: Record<string, unknown>) =>
      item({ key: e.id, link: atomLink(e.link), title: e.title, text: e.content ?? e.summary, published: e.published ?? e.updated }));
    return { kind: 'atom', title: normalizeText(f.title) || 'Untitled feed', link: atomLink(f.link), items };
  }
  if (doc['rdf:RDF']) {
    const r = doc['rdf:RDF'];
    const items = arr(r.item).slice(0, FEED_LIMITS.maxItems).map((i: Record<string, unknown>) => {
      const link = str(i.link) || null;
      return item({ key: i['@_rdf:about'], link, title: i.title, text: i.description, published: i['dc:date'] });
    });
    return { kind: 'rdf', title: normalizeText(r.channel?.title) || 'Untitled feed', link: str(r.channel?.link) || null, items };
  }
  throw new FeedError('invalid', 'not an RSS or Atom feed');
}
