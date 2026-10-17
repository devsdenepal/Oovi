/**
 * POST /api/groq — server-side AI gateway (Vercel function).
 *
 * Despite the historical name, this is now a multi-provider chain:
 * Groq → Gemini → OpenRouter (order in AI_CHAIN). A rate-limited or
 * failing provider advances to the next, so one outage never drops a
 * component. All keys stay in server env and never reach the browser.
 *
 * Body: { messages, model, schema?, name?, maxTokens?, effort? }.
 *   - schema object  → strict json_schema (constrained decoding) where the
 *                      provider supports it; Gemini uses JSON mime instead
 *   - schema "json_object" → plain JSON mode
 * Responds { text, provider, model, usage, attempts } or
 * { error, retryable?, attempts? }.
 */

import { runChain } from "./_aiChain.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  try {
    const { messages, model, schema, name, maxTokens, effort } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages required" });
      return;
    }
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
