const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-flash-latest';
export const FALLBACK_MODEL = 'gemini-flash-lite-latest';

/** Thrown when every model's quota is used up; retrying this run won't help. */
export class QuotaExhausted extends Error {}
class RateLimited extends Error {}

// model -> time its daily quota resets; survives across warm Lambda invocations.
const exhaustedUntil = new Map();
let resolvedAlias = null;

/** Read Google's RetryInfo / QuotaFailure details from a 429 body. */
function parseRateLimit(detail) {
  try {
    const details = JSON.parse(detail).error?.details ?? [];
    const delay = details.find((d) => d.retryDelay)?.retryDelay;
    const quotaIds = details.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? '');
    return {
      waitMs: delay ? Math.ceil(parseFloat(delay) * 1000) : null,
      daily: quotaIds.some((q) => /PerDay/i.test(q)),
      quotaIds,
    };
  } catch {
    return { waitMs: null, daily: false, quotaIds: [] };
  }
}

/**
 * If the "latest" alias ever disappears, pick the newest stable "gemini-X.Y-flash"
 * that supports generateContent from Google's own model list.
 */
async function newestFlash(apiKey) {
  if (resolvedAlias) return resolvedAlias;
  const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw new Error(`Gemini models.list -> HTTP ${res.status}`);
  const { models = [] } = await res.json();
  const version = (name) => name.match(/gemini-(\d+(?:\.\d+)?)-flash$/)?.[1];
  const best = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter(version)
    .sort((a, b) => Number(version(b)) - Number(version(a)))[0];
  if (!best) throw new Error('No Gemini Flash model available');
  resolvedAlias = best;
  return best;
}

async function callOnce({ apiKey, model, prompt, schema, thinking }) {
  const generationConfig = { responseMimeType: 'application/json', responseSchema: schema };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  return fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
    signal: AbortSignal.timeout(45_000),
  });
}

async function generateWith({ apiKey, model, prompt, schema, maxWaitMs }) {
  let thinking = true;
  let current = model === DEFAULT_MODEL && resolvedAlias ? resolvedAlias : model;

  for (let attempt = 1; ; attempt++) {
    const res = await callOnce({ apiKey, model: current, prompt, schema, thinking });

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason ?? 'unknown'})`);
      return { value: JSON.parse(text), usage: data.usageMetadata ?? {}, modelVersion: data.modelVersion ?? current };
    }

    const detail = await res.text();
    if (res.status === 400 && thinking && /thinking/i.test(detail)) {
      thinking = false; // model doesn't accept this thinking setting; use its default
      continue;
    }
    if (res.status === 404 && current === DEFAULT_MODEL) {
      current = await newestFlash(apiKey);
      continue;
    }
    if (res.status === 429) {
      const limit = parseRateLimit(detail);
      if (limit.daily) {
        exhaustedUntil.set(model, Date.now() + (limit.waitMs ?? 3_600_000));
        throw new QuotaExhausted(`${current}: daily quota used up`);
      }
      // Per-minute limits: wait briefly on the primary (the backup may be free), longer on the last resort.
      if (attempt < 4 && (limit.waitMs ?? 10_000) <= maxWaitMs) {
        await new Promise((r) => setTimeout(r, (limit.waitMs ?? 10_000) + 500));
        continue;
      }
      throw new RateLimited(`${current}: rate limited`);
    }
    if (res.status === 402) {
      // Billing: prepaid credits ran out. Applies to the whole key, so stop this run.
      exhaustedUntil.set(model, Date.now() + 3_600_000);
      throw new QuotaExhausted(`${current}: billing credits depleted`);
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Gemini ${current} -> HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/**
 * Structured-JSON generation. Tries the primary model, then the backup model when the
 * primary is out of quota, rate limited, or too slow. Returns { value, usage, modelVersion }.
 */
export async function generateJson({
  apiKey,
  model = DEFAULT_MODEL,
  fallbackModel = process.env.GEMINI_FALLBACK_MODEL || FALLBACK_MODEL,
  prompt,
  schema,
}) {
  const models = [...new Set([model, fallbackModel].filter(Boolean))];
  const available = models.filter((m) => !(exhaustedUntil.get(m) > Date.now()));
  if (!available.length) throw new QuotaExhausted(`All Gemini models out of quota: ${models.join(', ')}`);

  let lastError;
  for (const [i, m] of available.entries()) {
    const isLast = i === available.length - 1;
    try {
      return await generateWith({ apiKey, model: m, prompt, schema, maxWaitMs: isLast ? 65_000 : 20_000 });
    } catch (e) {
      lastError = e;
      const recoverable = e instanceof QuotaExhausted || e instanceof RateLimited || e.name === 'TimeoutError';
      if (!recoverable) throw e;
      console.warn(`${m} unavailable (${e.message}); trying backup model`);
    }
  }
  if (models.every((m) => exhaustedUntil.get(m) > Date.now())) {
    throw new QuotaExhausted(`All Gemini models out of quota: ${models.join(', ')}`);
  }
  throw lastError;
}
