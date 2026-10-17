/**
 * Multi-provider AI chain (server-only).
 *
 * One call — `runChain({ messages, schema, name, maxTokens, effort, model })`
 * — walks the configured providers in order and returns the first success.
 * Any provider failure advances the chain: rate limits (429), 5xx, network
 * faults, timeouts and empty replies all just mean "try the next one".
 * Only cheap transient faults (network blips, fast 5xx under ~25s) get one
 * bounded same-provider retry first; slow verdicts advance immediately so
 * one struggling model can't burn the whole budget.
 *
 * OPEN-WEIGHT ONLY: every rung runs an open-weight model — Groq
 * gpt-oss-120b and Gemini's Gemma 4 are open weights; the local rung is
 * Ollama on your own machine (default gpt-oss:20b, sized for 16GB RAM).
 * No closed/proprietary model is ever called.
 *
 * Config lives ONLY in server env (never VITE_-prefixed, never bundled):
 *   GROQ_API_KEY / GROQ_MODEL
 *   GEMINI_API_KEY / GEMINI_MODEL
 *   OPENROUTER_API_KEY / OPENROUTER_MODEL
 *   OLLAMA_URL / OLLAMA_MODEL   (on-device, no key)
 *   AI_CHAIN (order, default "groq,gemini,openrouter,ollama")
 *
 * Every provider is normalised to OpenAI-style `messages` in and plain
 * `text` out, so the browser keeps calling one route (/api/groq) and never
 * learns which provider answered.
 */

const PROVIDER_TIMEOUT = 75_000;
const CHAIN_DEADLINE = 165_000;
const MAX_ATTEMPTS = 2;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OLLAMA_URL_DEFAULT = "http://127.0.0.1:11434";
// On-device generation is slow on CPU; allow more wall time than the cloud
// rungs (still bounded by the chain deadline).
const OLLAMA_TIMEOUT = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampTokens(value, dflt) {
  return Math.min(8000, Math.max(256, Math.round(Number(value) || dflt)));
}

function providerError(provider, message, opts = {}) {
  const error = new Error(`${provider} ${message}`);
  error.provider = provider;
  error.retryable = !!opts.retryable;
  error.status = opts.status || 502;
  return error;
}

/** OpenAI `messages` -> { system, turns } with Gemini's user/model roles. */
function splitMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") system.push(m.content);
    else turns.push({ role: m.role === "assistant" ? "model" : "user", text: m.content });
  }
  if (!turns.length) turns.push({ role: "user", text: "Return the requested JSON." });
  return { system: system.join("\n\n"), turns };
}

function openAiResponseFormat(schema, name) {
  if (schema && typeof schema === "object") {
    return { type: "json_schema", json_schema: { name: name || "oovi", strict: true, schema } };
  }
  if (schema === "json_object") return { type: "json_object" };
  return null;
}

async function postJson(url, headers, body, upstream) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(upstream),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (gateway HTML error page): keep data null.
  }
  return { res, data };
}

function budget(deadline, cap = PROVIDER_TIMEOUT) {
  return Math.max(5000, Math.min(cap, deadline - Date.now()));
}

function firstText(data) {
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text.trim() : "";
}

// --- Providers -----------------------------------------------------------

async function callGroq(req, deadline) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw providerError("groq", "GROQ_API_KEY not configured", { status: 500 });
  const model = process.env.GROQ_MODEL || req.model || "openai/gpt-oss-120b";
  const body = {
    model,
    messages: req.messages,
    max_completion_tokens: clampTokens(req.maxTokens, 2000),
  };
  if (["low", "medium", "high"].includes(req.effort)) body.reasoning_effort = req.effort;
  const rf = openAiResponseFormat(req.schema, req.name);
  if (rf) body.response_format = rf;
  const { res, data } = await postJson(
    GROQ_URL,
    { Authorization: `Bearer ${key}` },
    body,
    budget(deadline),
  );
  if (!res.ok) {
    const detail = data?.error?.message || `${res.status}`;
    throw providerError("groq", detail, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const text = firstText(data);
  if (!text) throw providerError("groq", "empty response", { retryable: true });
  return { text, model, usage: data?.usage || null };
}

async function callOpenRouter(req, deadline) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw providerError("openrouter", "OPENROUTER_API_KEY not configured", { status: 500 });
  const model = process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";
  const headers = {
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://oovi.studio",
    "X-Title": process.env.OPENROUTER_TITLE || "Oovi Studio",
  };
  const rf = openAiResponseFormat(req.schema, req.name);
  const send = (body) => postJson(OPENROUTER_URL, headers, body, budget(deadline));
  const build = (format) => {
    const body = { model, messages: req.messages, max_tokens: clampTokens(req.maxTokens, 2000) };
    if (format) body.response_format = format;
    return body;
  };
  let { res, data } = await send(build(rf));
  // A model that rejects strict json_schema gets one plain-JSON retry; our
  // lenient repair loop downstream handles the rest.
  if (res.status === 400 && rf && rf.type === "json_schema") {
    ({ res, data } = await send(build({ type: "json_object" })));
  }
  if (!res.ok) {
    const detail = data?.error?.message || `${res.status}`;
    throw providerError("openrouter", detail, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const text = firstText(data);
  if (!text) throw providerError("openrouter", "empty response", { retryable: true });
  return { text, model, usage: data?.usage || null };
}

async function callGemini(req, deadline) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw providerError("gemini", "GEMINI_API_KEY not configured", { status: 500 });
  const model = process.env.GEMINI_MODEL || "gemma-4-31b-it";
  const { system, turns } = splitMessages(req.messages);
  const generationConfig = {
    maxOutputTokens: clampTokens(req.maxTokens, 2000),
    temperature: 0.7,
  };
  // Gemini's responseSchema is an OpenAPI subset without anyOf/nullable
  // unions, so our schemas cannot round-trip. JSON mime + our lenient
  // parser is the reliable path; the prompt already dictates the shape.
  if (req.schema) generationConfig.responseMimeType = "application/json";
  const body = {
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const { res, data } = await postJson(url, { "x-goog-api-key": key }, body, budget(deadline));
  if (!res.ok) {
    const detail = data?.error?.message || `${res.status}`;
    throw providerError("gemini", detail, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("").trim() : "";
  if (!text) throw providerError("gemini", "empty response", { retryable: true });
  return { text, model, usage: data?.usageMetadata || null };
}

/**
 * On-device rung: Ollama's OpenAI-compatible endpoint, no key.
 * Ollama is optional and often not running — a 1.5s health probe keeps a
 * down daemon an instant fall-through instead of a dead 75s wait. Model
 * output is plain text + our lenient repair (Ollama's structured-output
 * support varies by version, so we don't depend on response_format).
 */
async function callOllama(req, deadline) {
  const base = (process.env.OLLAMA_URL || OLLAMA_URL_DEFAULT).replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "gpt-oss:20b";
  try {
    const health = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (error) {
    throw providerError("ollama", `not reachable at ${base} (${error.message})`, { retryable: true });
  }
  const body = {
    model,
    messages: req.messages,
    max_tokens: clampTokens(req.maxTokens, 2000),
    temperature: 0.2,
    stream: false,
  };
  let res;
  let data = null;
  try {
    ({ res, data } = await postJson(`${base}/v1/chat/completions`, {}, body, budget(deadline, OLLAMA_TIMEOUT)));
  } catch (error) {
    throw providerError("ollama", `request failed (${error.message})`, { retryable: true });
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.error || `${res.status}`;
    throw providerError("ollama", String(detail), {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const text = firstText(data);
  if (!text) throw providerError("ollama", "empty response", { retryable: true });
  return { text, model, usage: data?.usage || null };
}

const CALLERS = { groq: callGroq, gemini: callGemini, openrouter: callOpenRouter, ollama: callOllama };

/**
 * Tries providers in order; returns { text, provider, model, usage, attempts }.
 * Throws the FIRST provider error when every rung fails (so a genuine
 * request/schema problem still surfaces instead of a downstream mask).
 */
export async function runChain(req) {
  const order = (process.env.AI_CHAIN || "groq,gemini,openrouter,ollama")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => CALLERS[s]);
  if (!order.length) order.push("groq");

  const started = Date.now();
  const deadline = started + CHAIN_DEADLINE;
  const attempts = [];
  let firstError = null;

  for (const name of order) {
    if (Date.now() > deadline - 3000) break;
    const call = CALLERS[name];
    const rungStart = Date.now();
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const out = await call(req, deadline);
        const ms = Date.now() - started;
        console.log(`[ai-chain] ${name} ok ${ms}ms${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
        return { ...out, provider: name, attempts: attempts.concat([{ provider: name, ok: true, ms }]) };
      } catch (error) {
        lastError = error;
        // 429 means this provider is spent for now — advance immediately.
        // A slow failure already burned budget (31b's 503s land after
        // 20-40s) — retrying it would double the burn, so only cheap
        // transient faults (network blips, fast 5xx) get a same-provider
        // retry. Every other verdict advances to the next rung.
        const spent = Date.now() - rungStart;
        if (error.status === 429 || !error.retryable || attempt === MAX_ATTEMPTS || spent > 25000) break;
        await sleep(500 * attempt);
      }
    }
    firstError = firstError || lastError;
    attempts.push({
      provider: name,
      ok: false,
      status: lastError.status,
      error: String(lastError.message).slice(0, 160),
    });
    console.warn(`[ai-chain] ${lastError.message} → next provider`);
  }

  const error = firstError || providerError("chain", "no AI providers configured", { status: 500 });
  error.attempts = attempts;
  throw error;
}
