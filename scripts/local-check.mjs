/**
 * On-device provider probe (Ollama, OpenAI-compatible endpoint).
 * Checks the daemon, lists installed models, then measures reliability,
 * JSON discipline, and behaviour under context pressure.
 *
 *   node scripts/local-check.mjs
 *   OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_MODEL=gpt-oss:20b node scripts/local-check.mjs
 */
const BASE = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:20b';

console.log(`--- health ${BASE} ---`);
try {
  const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(4000) });
  const data = await res.json();
  const names = (data?.models || []).map((m) => m.name);
  console.log(`reachable=${res.ok} models=[${names.join(', ')}]`);
  if (!names.some((n) => n === MODEL || n.startsWith(MODEL.split(':')[0]))) {
    console.warn(`WARN: model "${MODEL}" not installed — run: ollama pull ${MODEL}`);
  }
} catch (error) {
  console.error(`UNREACHABLE (${error.message}) — is Ollama running? https://ollama.com`);
  console.log('LOCAL CHECK DONE');
  process.exit(0);
}

async function chat(messages, { maxTokens = 200, temperature = 0 } = {}) {
  const t = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  const ms = Date.now() - t;
  if (!res.ok) return { ok: false, ms, error: `http ${res.status}` };
  const data = await res.json();
  const choice = data?.choices?.[0];
  const completion = data?.usage?.completion_tokens;
  return {
    ok: true,
    ms,
    text: (choice?.message?.content || '').trim(),
    promptTokens: data?.usage?.prompt_tokens,
    completionTokens: completion,
    tps: completion ? completion / (ms / 1000) : undefined,
    truncated: choice?.finish_reason,
  };
}

const SYS = 'You reply with JSON only, no prose.';

// 1-3. Reliability: same trivial probe x3, temp 0.
console.log(`--- reliability x3 (${MODEL}, trivial JSON, temp 0) ---`);
for (let i = 1; i <= 3; i++) {
  const r = await chat(
    [{ role: 'system', content: SYS }, { role: 'user', content: 'Return {"ok": true, "word": "pineapple"}.' }],
    { maxTokens: 60 },
  );
  let parsed = 'unparseable';
  try { parsed = JSON.stringify(JSON.parse(r.text)); } catch { /* keep */ }
  console.log(`try ${i}: ok=${r.ok} ms=${r.ms} tps=${r.tps?.toFixed?.(1)} finish=${r.truncated} -> ${String(parsed).slice(0, 80)}`);
}

// 4. Quality: realistic component-shape task (small but true DSL shape).
console.log('--- quality: component-shape DSL ---');
const r4 = await chat(
  [
    { role: 'system', content: `${SYS} You emit poster component JSON: {"elements":[...]}. Each element: text needs id,type,content,x,y,width,fontSize,fontWeight,fill. Canvas is 1200x630.` },
    { role: 'user', content: 'A headline "Hacktoberfest 2026" at x=64 y=60 width=520 fontSize=64 weight=800 fill=#FFFFFF, plus a #FFC400 rectangle bar x=48 y=280 width=500 height=80. JSON only.' },
  ],
  { maxTokens: 400 },
);
console.log(`ms=${r4.ms} tps=${r4.tps?.toFixed?.(1)} promptTok=${r4.promptTokens} finish=${r4.truncated}`);
console.log('raw: ' + String(r4.text).slice(0, 600));
try {
  const d = JSON.parse(r4.text);
  const els = d.elements || [];
  const fields = ['id', 'type', 'x', 'y'];
  const bad = els.filter((e) => !fields.every((f) => e[f] !== undefined) || (e.type === 'text' && !e.content));
  console.log(`parsed: ${els.length} elements, ${bad.length} malformed`);
} catch {
  console.log('parsed: FAILED — not JSON');
}

// 5. Context pressure: a prompt near the default context window with a big
// system block. Our real plan prompt is ~3.8k tokens, so a small n_ctx
// (Ollama defaults to 2048) truncates it — raise OLLAMA_CONTEXT_LENGTH.
console.log('--- context: oversized prompt ---');
const bigSys = SYS + ' ' + 'Poster design theory placeholder. '.repeat(120);
const r5 = await chat(
  [{ role: 'system', content: bigSys }, { role: 'user', content: 'Return {"ok": true}.' }],
  { maxTokens: 60 },
);
console.log(`promptTok=${r5.promptTokens} finish=${r5.truncated} -> ${String(r5.text).slice(0, 100)}`);
console.log('LOCAL CHECK DONE');
