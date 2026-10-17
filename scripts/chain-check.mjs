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
const order = (process.env.AI_CHAIN || 'groq,gemini,openrouter').split(',').map((s) => s.trim());

// 1-3. Each provider answers on its own.
for (const provider of order) {
  process.env.AI_CHAIN = provider;
  try {
    const out = await runChain({ messages, schema, name: 'probe', maxTokens: 200, effort: 'low' });
    const text = out.text.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`ok: ${provider} answered -> chars=${out.text.length} "${text}"`);
  } catch (error) {
    console.log(`FAIL: ${provider} -> ${error.message}`);
    failures++;
  }
}

// 4. A dead primary rung must fall through to a live one, not drop the call.
if (order.length >= 2) {
  const goodKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'invalid-key-for-fallthrough-test';
  process.env.AI_CHAIN = `${order[0]},${order[1]}`;
  try {
    const out = await runChain({ messages, schema, name: 'probe', maxTokens: 200, effort: 'low' });
    if (out.provider === order[1]) {
      console.log(`ok: ${order[0]} broken -> fell through to ${order[1]}`);
    } else {
      console.log(`FAIL: fallthrough landed on ${out.provider}, expected ${order[1]}`);
      failures++;
    }
  } catch (error) {
    console.log(`FAIL: fallthrough -> ${error.message}`);
    failures++;
  } finally {
    process.env.GROQ_API_KEY = goodKey;
  }
}

console.log(failures === 0 ? 'CHAIN CHECK DONE' : `CHAIN CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
