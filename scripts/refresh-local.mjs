// Run the hourly refresh on this machine, writing to .local/data instead of S3.
//   npm run refresh:mock   -> placeholder summaries, no Gemini calls
//   npm run refresh:local  -> real summaries; key from GEMINI_API_KEY or SSM (AWS_PROFILE/region)
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
process.env.LOCAL_DATA_DIR ??= join(root, '.local', 'data');
process.env.GEMINI_KEY_PARAM ??= '/hn-reader/gemini-api-key';
process.env.AWS_REGION ??= 'us-east-1';
if (process.argv.includes('--mock')) process.env.MOCK_AI = '1';

const { handler } = await import('../src/refresh.mjs');
const started = Date.now();
await handler();
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${process.env.LOCAL_DATA_DIR}`);
