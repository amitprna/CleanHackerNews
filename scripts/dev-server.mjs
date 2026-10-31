// Local preview: serves site/, the refreshed data in .local/data, and the archive API.
//   npm run refresh:mock && npm run dev   -> http://localhost:5173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.env.LOCAL_ARCHIVE_FILE ??= join(root, '.local', 'archive.json');
const { handler } = await import('../src/api.mjs');

const PORT = Number(process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await handler({
        rawPath: url.pathname,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
        requestContext: { http: { method: req.method } },
        body: await readBody(req),
        isBase64Encoded: false,
      });
      res.writeHead(out.statusCode, out.headers).end(out.body);
      return;
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([\\/])+/, '');
    const base = rel.startsWith('data') ? join(root, '.local', 'data') : join(root, 'site');
    const file = join(base, rel);
    if (!file.startsWith(base)) throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500).end(e.code === 'ENOENT' ? 'Not found' : String(e));
  }
}).listen(PORT, () => console.log(`HN reader preview on http://localhost:${PORT}`));
