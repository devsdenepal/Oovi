import 'dotenv/config';

const KEY = process.env.GEMINI_API_KEY;

async function call(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const t = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    const ms = Date.now() - t;
    if (!res.ok) return `FAIL ${res.status} ${ms}ms: ${(data?.error?.message || '').slice(0, 140)}`;
    const txt = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    return `ok ${ms}ms -> "${txt.replace(/\s+/g, ' ').slice(0, 120)}"`;
  } catch (error) {
    return `FAIL ${Date.now() - t}ms: ${error.message}`;
  }
}

const hardSystem =
  'You are a JSON API. Output ONLY one minified JSON object. No markdown, no code fences, no bullet points, no explanation, no commentary. Start with { and end with }.';
const body31 = {
  systemInstruction: { parts: [{ text: hardSystem }] },
  contents: [{ role: 'user', parts: [{ text: 'Return {"ok": true, "word": "pineapple"}.' }] }],
  generationConfig: { maxOutputTokens: 200, temperature: 0.2, responseMimeType: 'application/json' },
};

console.log('--- gemma-4-31b-it x3 ---');
for (let i = 1; i <= 3; i++) console.log(`try ${i}: ${await call('gemma-4-31b-it', body31)}`);

console.log('--- gemma-4-26b-a4b-it (hard system) ---');
for (let i = 1; i <= 2; i++) console.log(`try ${i}: ${await call('gemma-4-26b-a4b-it', body31)}`);
