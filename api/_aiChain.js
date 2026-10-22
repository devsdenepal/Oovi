/**
 * Server-side AI provider (server-only).
 *
 * One call | `runChain({ messages, schema, name, maxTokens, effort })` |
 * runs the configured on-device provider and returns its reply. The
 * provider is Ollama serving the local Gemma model: no API key, no outbound
 * network, nothing bundled into the browser.
 *
 * We call Ollama's NATIVE endpoint (/api/chat), not its OpenAI shim, for two
 * reasons that matter on CPU:
 *   - `think: false` | Gemma 4 is a thinking model (default: on); letting it
 *     reason first burns minutes of tokens before any JSON appears.
 *   - real per-token streaming (the OpenAI shim buffers), so we get liveness
 *     and can log progress.
 * The reply is read as an NDJSON stream over Node's core HTTP client, which
 * (unlike undici, i.e. global fetch) imposes no 300s headers/body timeout.
 * That matters here: with a single Ollama slot a queued request receives no
 * bytes until the generation ahead of it finishes, and undici would abort it
 * at 300s with "fetch failed" long before our own budget elapses.
 *
 * A provider failure (network fault, 5xx, timeout, empty reply) surfaces as
 * an error; only cheap transient faults (network blips, fast 5xx) get one
 * bounded same-provider retry first.
 *
 * Config lives ONLY in server env (never VITE_-prefixed, never bundled):
 *   OLLAMA_URL     (default http://127.0.0.1:11434)
 *   OLLAMA_MODEL   (default gemma4:e2b)
 *   OLLAMA_NUM_CTX (default 8192)
 *   AI_CHAIN       (provider order, default "ollama")
 *
 * Requests are normalised to OpenAI-style `messages` in and plain `text`
 * out, so the browser keeps calling one route (/api/ai) and never learns
 * which model answered.
 */

import http from "node:http";
import https from "node:https";

const PROVIDER_TIMEOUT = 75_000;
// On-device CPU generation is slow (~1-3 tok/s on a 4-core box), so the chain
// gets a long wall clock | far more than a hosted provider would ever need.
const CHAIN_DEADLINE = 1_800_000;
const MAX_ATTEMPTS = 2;

const OLLAMA_URL_DEFAULT = "http://127.0.0.1:11434";
const OLLAMA_NUM_CTX_DEFAULT = 8192;
// 2 physical cores (this box is a 2c/4t i5-2520M, AVX only). Measured: 2
// threads beat 3 on both prefill (10.1 vs 9.6 tok/s) and generation
// (2.73 vs 2.62 tok/s).
const OLLAMA_NUM_THREAD_DEFAULT = 2;
const OLLAMA_MODEL_DEFAULT = "gemma4:e2b";
// Per-layer model override (all blank = today's behaviour: one model everywhere).
// The browser names every call (`oovi_*`), so the route is keyed by that name:
// the narrow layers may run a tiny model while the heavy ones keep the big one.
// Measured on this box (i5-2520M, CPU-only): gemma3:270m prefill 103 tok/s,
// generation 27.8 tok/s; gemma3:1b 19.9 / 9.6; gemma4:e2b 10.9 / 3.3. A model
// swap also costs ~19-22s reload AND drops the prompt cache, so only split the
// layers when the narrow call's prompt is small enough to win that back.
const LAYER_MODEL_ENV = {
  oovi_goal: "OLLAMA_MODEL_FALLBACK", // L1 free-form goal refinement
  oovi_palette: "OLLAMA_MODEL_FALLBACK", // L2 free-form palette
  oovi_template: "OLLAMA_MODEL_TUNE", // L3a template choice
  oovi_tuning: "OLLAMA_MODEL_TUNE", // L3b tuning patch
  oovi_copydeck: "OLLAMA_MODEL_COPY_DECK", // L3c whole-design copy deck
  oovi_component: "OLLAMA_MODEL_COPY", // L4 slot copy (template-anchored)
  oovi_component_free: "OLLAMA_MODEL_FALLBACK", // L4 copy on a free-form skeleton
  oovi_plan: "OLLAMA_MODEL_FALLBACK", // free-form L3 (plan pass)
  oovi_skeleton: "OLLAMA_MODEL_FALLBACK", // free-form L3 (skeleton pass)
};

/** The model for this call: its layer's override when set, else OLLAMA_MODEL. */
function modelForRequest(name) {
  const override = LAYER_MODEL_ENV[name] ? process.env[LAYER_MODEL_ENV[name]] : "";
  return (override && override.trim()) || process.env.OLLAMA_MODEL || OLLAMA_MODEL_DEFAULT;
}
// Truncation guard ONLY | caps are measured never to bind (a ~30-token answer
// cost 425 generated tokens while e2b was thinking silently; with think:false
// it costs 9). One constant, so the options object below is byte-identical on
// every call.
const OLLAMA_NUM_PREDICT_DEFAULT = 1100;
// Per-request cap: a real component can take minutes to generate on CPU.
// Core http has no default timeout, so this is the only per-request bound.
const OLLAMA_TIMEOUT = 1_200_000;
// How often to log streaming progress (ms) so a long call is visible.
const PROGRESS_EVERY = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nsToMs = (ns) => (Number.isFinite(Number(ns)) ? Math.round(Number(ns) / 1e6) : null);

function positiveInt(value, dflt) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * The ONE options object sent on every single call.
 *
 * A differing load-time option (num_ctx, num_thread, ...) makes Ollama tear
 * the model down and reload it | measured ~19-22s here | which also throws
 * away the prompt cache the shared static prefix depends on. So nothing
 * per-layer lives in here: `num_predict` is fixed too, because the caps never
 * bind and a truncation guard needs no per-layer value.
 *
 * `draft_num_predict: 0` disables speculative drafting. Measured on this box
 * with an identical 1144-token prompt (gemma4:e2b, -t 2, CPU only):
 *
 *   draft on   cold: prefill 160.5s, eval 388 tok @ 136.7s = 2.84 tok/s
 *   draft off  cold: prefill 124.3s, eval 337 tok @  94.4s = 3.57 tok/s
 *   draft off  warm: prefill cached, eval 335 tok @  92.3s = 3.63 tok/s
 *
 * Drafting loses on both ends: the draft model costs ~36s of extra prefill and
 * a third of the generation rate, and it changed the answer length (388 vs 337
 * tokens for the same prompt). It is a load-time option, so setting it here
 * reloads the model once and then holds for every call.
 */
function buildOptions() {
  return {
    num_ctx: positiveInt(process.env.OLLAMA_NUM_CTX, OLLAMA_NUM_CTX_DEFAULT),
    num_thread: positiveInt(process.env.OLLAMA_NUM_THREAD, OLLAMA_NUM_THREAD_DEFAULT),
    num_predict: positiveInt(process.env.OLLAMA_NUM_PREDICT, OLLAMA_NUM_PREDICT_DEFAULT),
    temperature: 0.2,
    draft_num_predict: 0,
  };
}

/**
 * `format` turns on Ollama's constrained decoding. A JSON schema pins the
 * SYNTAX (never malformed/truncated JSON) and the SHAPE (required keys,
 * enums), which removes the repair retries that each cost a full
 * minute-scale call. The browser downgrades a rejected schema once to
 * "json_object" (which maps to Ollama's plain `format: "json"` here), and
 * OLLAMA_FORMAT=0 disables it entirely if a schema will not compile.
 */
function resolveFormat(schema) {
  if (String(process.env.OLLAMA_FORMAT || "").trim() === "0") return null;
  if (!schema) return null;
  if (typeof schema === "object") return schema;
  if (schema === "json_object" || schema === "json") return "json";
  return null;
}

/**
 * Renders Ollama's own timing fields, the only trustworthy answer to "where
 * did the minute go". `load_duration` is pure reload overhead (killed by
 * keep_alive); `prompt_eval_duration` is prefix processing (shrunk by a
 * stable system prefix); `eval_duration` is real token generation. Comparing
 * `eval_count` against the visible token count exposes any hidden reasoning
 * tokens that never appear in the reply.
 */
function formatTiming(usage, wallMs) {
  if (!usage) return "";
  const s = (ms) => (ms == null ? "?" : `${(ms / 1000).toFixed(1)}s`);
  const rate = (tokens, ms) => (tokens && ms ? `${(tokens / (ms / 1000)).toFixed(1)}tok/s` : "?");
  const prompt = usage.prompt_tokens ?? "?";
  const cached = usage.cached_tokens ?? "?";
  return (
    `load=${s(usage.load_duration_ms)} ` +
    `prefill=${prompt}tok(cached ${cached})/${s(usage.prompt_eval_duration_ms)}(${rate(usage.prompt_tokens, usage.prompt_eval_duration_ms)}) ` +
    `eval=${usage.completion_tokens ?? "?"}tok/${s(usage.eval_duration_ms)}(${rate(usage.completion_tokens, usage.eval_duration_ms)}) ` +
    `total=${s(usage.total_duration_ms)} wall=${(wallMs / 1000).toFixed(1)}s`
  );
}

function providerError(provider, message, opts = {}) {
  const error = new Error(`${provider} ${message}`);
  error.provider = provider;
  error.retryable = !!opts.retryable;
  error.status = opts.status || 502;
  return error;
}

function budget(deadline, cap = PROVIDER_TIMEOUT) {
  return Math.max(5000, Math.min(cap, deadline - Date.now()));
}

/**
 * Reads Ollama's NDJSON chat stream: one JSON object per line. Accumulates
 * `message.content`, fires `onProgress(chunks)` per content chunk (liveness)
 * and `onDelta(piece)` per token (so callers can forward the raw text), and
 * captures end-of-stream token counts as `usage`.
 */
async function readChatStream(stream, onProgress, onDelta) {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let chunks = 0;
  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // ignore a malformed line, keep the stream alive
    }
    const piece = obj?.message?.content;
    if (typeof piece === "string" && piece) {
      text += piece;
      onDelta?.(piece);
      onProgress?.(++chunks);
    }
    if (obj?.done) {
      const prompt = obj.prompt_eval_count ?? null;
      const completion = obj.eval_count ?? null;
      usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt != null && completion != null ? prompt + completion : null,
        // 0.40.6 exposes the prefix-cache hit count | the number that tells us
        // whether the shared static prompt prefix is actually being reused.
        cached_tokens: obj.prompt_eval_cached_count ?? null,
        load_duration_ms: nsToMs(obj.load_duration),
        prompt_eval_duration_ms: nsToMs(obj.prompt_eval_duration),
        eval_duration_ms: nsToMs(obj.eval_duration),
        total_duration_ms: nsToMs(obj.total_duration),
      };
    }
  };
  for await (const value of stream) {
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      consume(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  consume(buffer);
  return { text: text.trim(), usage, visible: chunks };
}

// --- Provider: Ollama (on-device, Gemma) ---------------------------------

/**
 * Opens Ollama's /api/chat endpoint over Node's CORE http(s) client.
 *
 * We deliberately avoid global fetch here. Node's fetch is undici, whose
 * default `headersTimeout`/`bodyTimeout` is 300s. With OLLAMA_NUM_PARALLEL=1 a
 * queued request receives no bytes until the generation ahead of it completes,
 * so undici aborts it at 300s with "fetch failed" | far short of our own
 * budget. Core http has no such default, so a queued request simply waits,
 * bounded only by the AbortSignal we hand it.
 */
function openChatStream(url, body, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Drains a response body to a string (error path only). */
async function drain(stream) {
  let out = "";
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

/**
 * On-device provider: Ollama's native /api/chat. Ollama may not be running |
 * a 1.5s health probe fails fast instead of waiting out the request timeout.
 * `think: false` skips the model's reasoning phase; `num_ctx` pins the
 * context window so a large plan prompt is never silently truncated.
 */
async function callOllama(req, deadline, onProgress, onDelta) {
  const base = (process.env.OLLAMA_URL || OLLAMA_URL_DEFAULT).replace(/\/+$/, "");
  // Per-layer model override: which env var serves this call. Every override
  // is optional and blank falls back to OLLAMA_MODEL, so the default stays a
  // single model for the whole chain.
  const model = modelForRequest(req.name);
  try {
    const health = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (error) {
    throw providerError("ollama", `not reachable at ${base} (${error.message})`, { retryable: true });
  }
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE || "30m";
  const format = resolveFormat(req.schema);
  const options = buildOptions();
  const body = {
    model,
    messages: req.messages,
    stream: true,
    // Verified against Ollama 0.40.6 with a direct curl: `think:false` is the
    // right field name, and it is what stops e2b from burning ~2 minutes of
    // silent reasoning on every call.
    think: false,
    // Keeps the model resident; a reload costs ~19-22s AND drops the prompt
    // cache (server default is 5 minutes).
    keep_alive: keepAlive,
    // Constrained decoding, when the caller supplied a schema.
    ...(format ? { format } : {}),
    options,
  };
  const started = Date.now();
  let res;
  try {
    res = await openChatStream(
      `${base}/api/chat`,
      body,
      AbortSignal.timeout(budget(deadline, OLLAMA_TIMEOUT)),
    );
  } catch (error) {
    throw providerError("ollama", `request failed (${error.message})`, { retryable: true });
  }
  if (res.statusCode !== 200) {
    const raw = await drain(res).catch(() => "");
    let detail = `${res.statusCode}`;
    try {
      const data = JSON.parse(raw);
      detail = data?.error?.message || data?.error || detail;
    } catch {
      // non-JSON error body
    }
    throw providerError("ollama", String(detail), {
      status: res.statusCode,
      retryable: res.statusCode >= 500 || res.statusCode === 429,
    });
  }
  let lastLog = started;
  let streamed;
  try {
    streamed = await readChatStream(res, (chunks) => {
      const now = Date.now();
      if (now - lastLog >= PROGRESS_EVERY) {
        lastLog = now;
        const secs = ((now - started) / 1000).toFixed(0);
        console.log(`[ai-chain] ollama generating… ${chunks} chunks ${secs}s`);
      }
      onProgress?.(chunks, Math.round((now - started) / 1000));
    }, onDelta);
  } catch (error) {
    throw providerError("ollama", `stream interrupted (${error.message})`, { retryable: true });
  }
  const { text, usage, visible } = streamed;
  if (!text) throw providerError("ollama", "empty response", { retryable: true });
  console.log(`[ai-chain] ${req.name || "ollama"} timing ${formatTiming(usage, Date.now() - started)} visible=${visible}`);
  if (usage?.completion_tokens != null && visible && usage.completion_tokens > visible * 1.5) {
    console.warn(
      `[ai-chain] hidden reasoning? eval_count=${usage.completion_tokens} but only ${visible} chunks reached the reply`,
    );
  }
  return { text, model, usage };
}

const CALLERS = { ollama: callOllama };

/**
 * Runs the configured provider; returns { text, provider, model, usage, attempts }.
 * Throws the provider error when it fails, so a genuine request/schema
 * problem still surfaces instead of a downstream mask.
 */
export async function runChain(req, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const onDelta = typeof opts.onDelta === "function" ? opts.onDelta : null;
  const order = (process.env.AI_CHAIN || "ollama")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => CALLERS[s]);
  if (!order.length) order.push("ollama");

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
        const out = await call(req, deadline, onProgress, onDelta);
        const ms = Date.now() - started;
        console.log(`[ai-chain] ${name} ok ${ms}ms`);
        return { ...out, provider: name, attempts: attempts.concat([{ provider: name, ok: true, ms }]) };
      } catch (error) {
        lastError = error;
        // 429 means this provider is spent for now | stop immediately. Only
        // cheap transient faults (network blips, fast 5xx) get a same-provider
        // retry; slow verdicts are not worth doubling the burn.
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
    console.warn(`[ai-chain] ${lastError.message}`);
  }

  const error = firstError || providerError("chain", "no AI provider configured", { status: 500 });
  error.attempts = attempts;
  throw error;
}
