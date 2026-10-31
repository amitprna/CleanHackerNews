import { pageToText, truncate } from './text.mjs';

const MAX_HTML = 2_000_000;

/** Best-effort article text. Returns null for paywalls, PDFs, timeouts, etc. */
export async function fetchArticleText(url, maxChars = 5000) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; hn-reader/1.0; personal summariser)',
        accept: 'text/html,text/plain;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/html|text\/plain/.test(type)) return null;
    const raw = (await res.text()).slice(0, MAX_HTML);
    const text = type.includes('html') ? pageToText(raw) : raw;
    return text.length > 200 ? truncate(text, maxChars) : null;
  } catch {
    return null;
  }
}
