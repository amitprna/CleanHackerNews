// One tiny Gemini call per model with the key stored in SSM, to check quota and billing.
// Prints only the HTTP status, the resolved model and any quota error; never the key.
//   node scripts/probe-gemini.mjs [model ...]
import { getSecret } from '../src/lib/secrets.mjs';
import { DEFAULT_MODEL, FALLBACK_MODEL } from '../src/lib/gemini.mjs';

process.env.AWS_REGION ??= 'us-east-1';
const models = process.argv.slice(2).length ? process.argv.slice(2) : [DEFAULT_MODEL, FALLBACK_MODEL];
const apiKey = await getSecret('/hn-reader/gemini-api-key', 'GEMINI_API_KEY');

for (const model of models) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`${model}: ${res.status} -> ${body.modelVersion} said "${body.candidates?.[0]?.content?.parts?.[0]?.text?.trim()}"`);
  } else {
    const quotas = (body.error?.details ?? []).flatMap((d) => d.violations ?? []).map((v) => v.quotaId);
    console.log(`${model}: ${res.status} ${body.error?.status ?? ''} ${body.error?.message?.slice(0, 200) ?? ''}`);
    if (quotas.length) console.log(`  quota: ${quotas.join(', ')}`);
  }
}
