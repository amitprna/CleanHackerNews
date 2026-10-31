const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip tags from a small HTML fragment (HN comments, Ask HN text). */
export function fragmentToText(html) {
  if (!html) return '';
  return collapse(decodeEntities(html.replace(/<p>/gi, '\n').replace(/<[^>]+>/g, ' ')));
}

/** Rough readable text from a full web page — good enough for an LLM to summarise. */
export function pageToText(html) {
  const meta = html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*>/i)?.[0];
  const description = meta?.match(/content=["']([^"']*)["']/i)?.[1] ?? '';

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = body.match(/<(article|main)\b[\s\S]*?<\/\1>/i)?.[0];
  if (main && main.length > 1500) body = main;

  const text = collapse(decodeEntities(body.replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n').replace(/<[^>]+>/g, ' ')));
  return collapse(`${decodeEntities(description)} ${text}`);
}

export function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Run fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
