/**
 * POST /api/ai | server-side AI gateway (Vercel function + local server).
 *
 * Routes every generation to the on-device provider (Ollama serving the
 * local Gemma model) through api/_aiChain.js. The browser only ever calls
 * this one same-origin route; there is no client-side provider switch and
 * no API key anywhere near the browser.
 *
 * Body: { messages, schema?, name?, maxTokens?, effort?, stream? }.
 *   - schema object  → strict json_schema (constrained decoding) where the
 *                      provider supports it
 *   - schema "json_object" → plain JSON mode
 *   - stream: true   → NDJSON stream instead of one JSON body (see below)
 * Responds { text, provider, model, usage, attempts } or
 * { error, retryable?, attempts? }.
 *
 * On-device generation takes minutes, and a single silent HTTP response is
 * what idle timeouts at any hop (browser, dev proxy, Node) are built to kill.
 * The streaming form keeps bytes flowing for the whole run, so long calls
 * cannot be cut off and the UI can show live progress.
 */

import { runChain } from "./_aiChain.js";

/**
 * Streaming variant. Writes one JSON object per line so the response is
 * never idle, and the client can render progress while it waits.
 *
 *   {"t":"start"}
 *   {"t":"delta","text":"…"}                   … raw tokens (opt-in: delta)
 *   {"t":"progress","chunks":N,"secs":S}      … repeated
 *   {"t":"done","text":"…","provider":"…","usage":{…}}
 *   {"t":"error","error":"…","retryable":bool}
 */
async function streamChain(res, base) {
  const write = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // client already gone; the run will end on its own budget
    }
  };

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);
  write({ t: "start" });

  // Throttle progress to ~1/s: enough to defeat idle timeouts without
  // spamming the socket on a fast reply.
  let lastEmit = 0;
  const onProgress = (chunks, secs) => {
    const now = Date.now();
    if (now - lastEmit >= 1000) {
      lastEmit = now;
      write({ t: "progress", chunks, secs });
    }
  };

  const onDelta = base.delta ? (piece) => write({ t: "delta", text: piece }) : null;

  const run = (schema) => runChain({ ...base, schema }, { onProgress, onDelta });

  try {
    let out;
    try {
      out = await run(base.schema);
    } catch (error) {
      // Mirror the non-streaming downgrade: strict schema unsupported → plain
      // JSON mode. Safe here because a 400 arrives before any token.
      if (error && error.status === 400 && base.schema && typeof base.schema === "object") {
        console.warn(`[ai] strict rejected (400), downgrading to json_object: ${error.message}`);
        out = await run("json_object");
      } else {
        throw error;
      }
    }
    write({
      t: "done",
      text: out.text,
      provider: out.provider,
      model: out.model || null,
      usage: out.usage || null,
      attempts: out.attempts || [],
    });
  } catch (error) {
    const status = error?.status >= 400 && error?.status < 600 ? error.status : 502;
    console.warn(`[ai] stream failed (${status}): ${error?.message || error}`);
    write({
      t: "error",
      error: String(error?.message || error),
      retryable: !!error?.retryable,
      attempts: error?.attempts || [],
    });
  } finally {
    try {
      res.end();
    } catch {
      // already closed
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { messages, model, schema, name, maxTokens, effort, stream, delta } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages required" });
    return;
  }
  console.log(
    `[ai] request name=${name || "-"} maxTokens=${maxTokens ?? "-"} messages=${messages.length}${stream ? " stream" : ""}`,
  );

  if (stream) {
    await streamChain(res, { messages, model, schema, name, maxTokens, effort, delta: !!delta });
    return;
  }

  try {
    const out = await runChain({ messages, model, schema, name, maxTokens, effort });
    res.status(200).json({
      text: out.text,
      provider: out.provider,
      model: out.model || null,
      usage: out.usage || null,
      attempts: out.attempts || [],
    });
  } catch (error) {
    const status = error?.status >= 400 && error?.status < 600 ? error.status : 502;
    res.status(status >= 500 ? 502 : status).json({
      error: String(error?.message || error),
      retryable: !!error?.retryable,
      attempts: error?.attempts || [],
    });
  }
}
