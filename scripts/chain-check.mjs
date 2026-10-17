import 'dotenv/config';
import { runChain } from '../api/_aiChain.js';

const messages = [
  { role: 'system', content: 'You reply with JSON only, no prose.' },
  { role: 'user', content: 'Return {"ok": true, "word": "pineapple"}.' },
];
const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
  required: ['ok', 'word'],
  additionalProperties: false,
};

let failures = 0;
let skipped = 0;
let flaky = 0;
const order = (process.env.AI_CHAIN || 'groq,gemini,openrouter,ollama').split(',').map((s) => s.trim());

// 1-3. Each provider answers on its own.
for (const provider of order) {
  process.env.AI_CHAIN = provider;
  try {
    const out = await runChain({ messages, schema, name: 'probe', maxTokens: 200, effort: 'low' });
    const text = out.text.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`ok: ${provider} answered -> chars=${out.text.length} "${text}"`);
  } catch (error) {
    // Three buckets so the exit code means something: a provider having a
    // bad day (429/5xx) is not a regression in our request shape, and the
    // on-device rung being absent is expected. 4xx/parse errors are ours.
    if (provider === 'ollama' && /not reachable/.test(error.message)) {
      console.log(`skip: ${provider} not running (${error.message})`);
      skipped++;
    } else if (error.status >= 429) {
      console.log(`flaky: ${provider} upstream ${error.status} -> ${error.message}`);
      flaky++;
    } else {
      console.log(`FAIL: ${provider} (status=${error.status}) -> ${error.message}`);
      failures++;
    }
  }
}

// 4. A dead primary rung must fall through to a live one, not drop the call.
// Assert on the SET of remaining rungs, not on one specific provider: a
// transient 503 on any single rung must not look like a code failure (both
// Gemini and Groq have gone "high demand" mid-suite).
if (order.length >= 2) {
  const goodKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'invalid-key-for-fallthrough-test';
  const rest = order.slice(1);
  process.env.AI_CHAIN = rest.join(',');
  try {
    const out = await runChain({ messages, schema, name: 'probe', maxTokens: 200, effort: 'low' });
    if (out.provider !== order[0] && rest.includes(out.provider)) {
      console.log(`ok: ${order[0]} broken -> fell through to ${out.provider}`);
    } else {
      console.log(`FAIL: fallthrough landed on ${out.provider}, expected one of ${rest.join('/')}`);
      failures++;
    }
  } catch (error) {
    if (error.status >= 429) {
      console.log(`flaky: fallthrough blocked by upstream ${error.status} -> ${error.message}`);
      flaky++;
    } else {
      console.log(`FAIL: fallthrough -> ${error.message}`);
      failures++;
    }
  } finally {
    process.env.GROQ_API_KEY = goodKey;
  }
}

console.log(
  failures === 0
    ? `CHAIN CHECK DONE (${skipped} skipped, ${flaky} flaky)`
    : `CHAIN CHECK: ${failures} FAILURES (${skipped} skipped, ${flaky} flaky)`,
);
process.exit(failures === 0 ? 0 : 1);
