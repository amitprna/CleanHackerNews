import { createHash } from 'node:crypto';
import { createUsers } from './lib/archive.mjs';

const users = createUsers();

// Each passphrase is its own reader. Nothing here is secret: the passphrase only keeps
// one person's read list apart from another's, so a plain hash is enough as the key.
const MIN_PASS = 6;
// Archived ids are remembered for 9 days (stories leave the site after 7), so nothing read
// comes back. Titles and summaries for the Archive tab are kept for only 3 days.
const KEEP_DAYS = 9;
const SHOW_DAYS = 3;
const MAX_IDS = 3000;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

const keyOf = (pass) => createHash('sha256').update(`hnbrief:${pass}`).digest('hex');
const isId = (v) => typeof v === 'string' && /^\d{1,12}$/.test(v);

/** Valid ids only, newest kept, old entries dropped. */
function clean(archive) {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const entries = Object.entries(archive ?? {})
    .filter(([id, t]) => isId(id) && Number.isFinite(t) && t > cutoff && t <= Date.now() + 60_000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_IDS);
  return Object.fromEntries(entries);
}

function parseBody(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
    const body = JSON.parse(raw || '{}');
    return body && typeof body === 'object' ? body : {};
  } catch {
    return null;
  }
}

const idList = (v) => (Array.isArray(v) ? v.filter(isId).slice(0, 500) : []);

const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const num = (v) => (Number.isFinite(v) ? v : undefined);

/** What the Archive tab shows for a story: only these fields, only for the last 3 days. */
function cleanMeta(meta, archive) {
  const cutoff = Date.now() - SHOW_DAYS * 86_400_000;
  const out = {};
  for (const [id, m] of Object.entries(meta ?? {})) {
    if (!(id in archive) || archive[id] <= cutoff || !m || typeof m !== 'object') continue;
    out[id] = {
      title: str(m.title, 300) ?? '(untitled)', url: str(m.url, 2000), author: str(m.author, 60),
      points: num(m.points), comments: num(m.comments), createdAt: num(m.createdAt),
      summary: str(m.summary, 900),
      tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string').slice(0, 2).map((t) => t.slice(0, 30)) : [],
    };
  }
  return out;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '';
  const pass = event.headers?.['x-hn-passphrase'] ?? '';
  if (pass.length < MIN_PASS || pass.length > 200) return json(400, { error: `Passphrase must be ${MIN_PASS} to 200 characters` });
  const key = keyOf(pass);

  // GET /api/me: this reader's archive. POST /api/me: claim a new passphrase.
  if (path === '/api/me' && method === 'GET') {
    const user = await users.get(key);
    if (!user) return json(404, { error: 'Unknown passphrase' });
    const archive = clean(user.archive);
    return json(200, { archive, meta: cleanMeta(user.meta, archive) });
  }
  if (path === '/api/me' && method === 'POST') {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Invalid JSON' });
    const archive = clean(body.archive);
    const meta = cleanMeta(body.meta, archive);
    const created = await users.create(key, { archive, meta, createdAt: Date.now() });
    return created ? json(201, { archive, meta }) : json(409, { error: 'Passphrase taken' });
  }

  // POST /api/archive { add: [ids], remove: [ids], meta: { id: { title, url, ... } } }
  if (path === '/api/archive' && method === 'POST') {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Invalid JSON' });
    const user = await users.get(key);
    if (!user) return json(404, { error: 'Unknown passphrase' });
    const archive = { ...user.archive };
    const meta = { ...user.meta };
    const now = Date.now();
    for (const id of idList(body.add)) {
      archive[id] ??= now;
      if (body.meta?.[id]) meta[id] = body.meta[id];
    }
    for (const id of idList(body.remove)) {
      delete archive[id];
      delete meta[id];
    }
    user.archive = clean(archive);
    user.meta = cleanMeta(meta, user.archive);
    await users.save(key, user);
    return json(200, { archive: user.archive, meta: user.meta });
  }

  return json(404, { error: 'Not found' });
}
