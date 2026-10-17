import 'dotenv/config';
import { runChain } from '../api/_aiChain.js';

// Demand-tolerant: proves the CHAIN advances correctly even while a rung is
// struggling, without requiring every provider to be healthy right now.
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
const req = { messages, schema, name: 'probe', maxTokens: 200, effort: 'low' };

let failures = 0;

// 1. Broken Groq must fall through to OpenRouter-free, not drop the call.
const goodKey = process.env.GROQ_API_KEY;
process.env.GROQ_API_KEY = 'invalid-key-for-fallthrough-test';
process.env.AI_CHAIN = 'groq,openrouter';
try {
  const out = await runChain(req);
  if (out.provider === 'openrouter' && out.text.includes('pineapple')) {
    console.log('ok: groq broken -> openrouter-free answered with valid JSON');
  } else {
    console.log(`FAIL: fallthrough landed on ${out.provider}: ${out.text.slice(0, 80)}`);
    failures++;
  }
} catch (error) {
  console.log(`FAIL: fallthrough -> ${error.message}`);
  failures++;
} finally {
  process.env.GROQ_API_KEY = goodKey;
}

// 2. Gemini rung is wired correctly: either it answers, or it fails
// RETRYABLE (demand 503) so the chain advances past it. A non-retryable
// failure here would mean misconfiguration, not demand.
process.env.AI_CHAIN = 'gemini';
try {
  const out = await runChain(req);
  console.log(`ok: gemini answered directly (${out.text.length} chars)`);
} catch (error) {
  if (error.retryable) {
    console.log(`ok: gemini demand-spiked but retryable (${error.message.slice(0, 100)}) -> chain advances`);
  } else {
    console.log(`FAIL: gemini non-retryable -> ${error.message}`);
    failures++;
  }
}

console.log(failures === 0 ? 'FALLBACK CHECK DONE' : `FALLBACK CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
