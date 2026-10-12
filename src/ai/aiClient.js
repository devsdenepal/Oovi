import { buildDesignPrompt, buildRevalidationPrompt } from "./designPrompt";
import { validateDesign } from "../design/designValidator";

/**
 * AI service abstraction.
 *
 * generateDesign(userPrompt) -> Design
 *
 * The AI provider is configurable via environment variables:
 *
 *   AICONDUCTOR_URL      base URL of the AI Conductor endpoint
 *                         (default https://aiconductor.vercel.app)
 *   AICONDUCTOR_TOKEN    bearer token for the endpoint
 *   AICONDUCTOR_MODEL    model name forwarded to the endpoint (optional)
 *
 * The default provider is the AI Conductor vercel deployment, which exposes
 *   POST /generate   { "prompt": "<flattened system + user prompt>" }
 *   ->               { "success": true, "text": "<model output>" }
 *
 * Swapping providers (OpenAI-compatible /generate, image generators, etc.)
 * only requires a new fetchDesign() here - the renderer and validator are
 * untouched.
 */

const DEFAULT_URL = "https://aiconductor.vercel.app";

// Same-origin path that the Vite dev/preview server proxies to
// DEFAULT_URL (see vite.config.js). The AI Conductor endpoint does not send
// CORS headers, so it is always reached through this proxy instead of a
// direct browser fetch.
const PROXY_PATH = "/aiconductor";

// How many times we ask the model to fix an invalid design before giving up.
const MAX_ATTEMPTS = 3;

/**
 * Pass 1 fallback: regex-based JSON recovery.
 *
 * Tries increasingly aggressive extractions/repairs on the raw model text
 * before giving up:
 *   1. strip code fences and parse
 *   2. isolate the first `{...}` block and parse
 *   3. same, then repair common LLM JSON mistakes (trailing commas, BOM,
 *      unquoted keys, single-quoted strings, raw newlines inside strings)
 */
function regexRepairJson(text) {
  if (!text) return null;

  const candidates = [];

  // 1. Content inside a code fence.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  // 2. The whole trimmed text when it already looks like JSON.
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);

  // 3. The outermost `{...}` block found anywhere in the text.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseJsonLenient(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to repair
  }

  const repaired = text
    .replace(/^\uFEFF/, "")
    .replace(/,\s*]/g, "]") // trailing comma in arrays
    .replace(/,\s*}/g, "}") // trailing comma in objects
    // unquoted keys: { foo: 1, "bar": 2 } -> { "foo": 1, "bar": 2 }
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    // single-quoted strings -> double-quoted
    .replace(/:\s*'((?:[^'\\]|\\.)*)'/g, ': "$1"')
    .replace(/\[\s*'((?:[^'\\]|\\.)*)'\s*\]/g, '["$1"]')
    // backtick-quoted strings -> double-quoted (LLMs like emphasis ticks)
    .replace(/:\s*`((?:[^`\\]|\\.)*)`/g, ': "$1"')
    .replace(/\[\s*`((?:[^`\\]|\\.)*)`\s*\]/g, '["$1"]');

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/**
 * Marks an error as a network/CORS failure so callers can retry through
 * the same-origin proxy. CORS blockages surface as a fetch TypeError
 * ("Failed to fetch"), indistinguishable from a plain network error.
 */
function networkError(message) {
  const error = new Error(message);
  error.isNetworkError = true;
  return error;
}

async function fetchAiconductor(url, token, model, prompt) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const payload = { prompt };
  if (model) {
    payload.model = model;
  }

  let response;
  try {
    response = await fetch(`${url}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw networkError(`AI request failed (network): ${error.message}`);
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body?.error || body?.message || detail;
    } catch {
      // keep status text
    }
    throw new Error(`AI request failed: ${detail}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("AI returned a non-JSON response");
  }

  if (data?.success === false) {
    throw new Error(data?.error || "AI returned an error");
  }

  const text = data?.text || data?.result || data?.output || data?.content;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("AI returned an empty response");
  }

  return text;
}

/**
 * Generates a {@link Design} for the given natural-language prompt.
 *
 * Failure handling is layered:
 *   1. regexRepairJson() recovers parseable JSON from loose model output
 *   2. validateDesign() checks the schema
 *   3. if validation fails, the model is re-prompted with the exact errors
 *      and the previous (invalid) design, up to MAX_ATTEMPTS times total
 *
 * Returns the validated, normalized design. Throws an Error with a
 * human-readable message when all attempts fail.
 *
 * @param {string} userPrompt
 * @returns {Promise<import("../design/designTypes").Design>}
 */
export async function generateDesign(userPrompt) {
  const configuredUrl = (import.meta.env.VITE_AICONDUCTOR_URL || "").trim().replace(/\/+$/, "");
  const token = import.meta.env.VITE_AICONDUCTOR_TOKEN;
  const model = import.meta.env.VITE_AICONDUCTOR_MODEL;

  const prompt = buildDesignPrompt(userPrompt);

  // The default AI Conductor endpoint has no CORS headers, so route it
  // straight through the same-origin proxy. Custom providers configured via
  // VITE_AICONDUCTOR_URL are tried directly; on a CORS/network failure they
  // fall back to the proxy too.
  const isDefault = !configuredUrl || configuredUrl === DEFAULT_URL;
  const primaryUrl = isDefault ? PROXY_PATH : configuredUrl;

  let previousOutput = "";
  let errors = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1 ? prompt : buildRevalidationPrompt(userPrompt, previousOutput, errors);

    let text;
    try {
      text = await fetchAiconductor(primaryUrl, token, model, requestPrompt);
    } catch (error) {
      if (!isDefault && error.isNetworkError) {
        text = await fetchAiconductor(PROXY_PATH, token, model, requestPrompt);
      } else {
        throw error;
      }
    }
    previousOutput = text;

    const parsed = regexRepairJson(text);
    if (parsed === null) {
      throw new Error(
        "AI response was not recoverable JSON. The model should return only a Design JSON document.",
      );
    }

    const result = validateDesign(parsed);
    if (result.ok) return result.design;
    errors = result.errors;
  }

  throw new Error(
    `AI returned an invalid design after ${MAX_ATTEMPTS} attempts: ${errors.slice(0, 6).join("; ")}`,
  );
}