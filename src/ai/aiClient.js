import { buildDesignPrompt } from "./designPrompt";
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

/**
 * Extract a JSON document hidden inside model output that might be wrapped in
 * prose or code fences. Tolerates common LLM mistakes so valid responses still
 * come through; anything unparseable becomes a validation error downstream.
 */
function extractJson(text) {
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // fall through
    }
  }

  return null;
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
 * Returns the validated, normalized design. Throws an Error with a
 * human-readable message when the AI call or validation fails.
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

  let text;
  try {
    text = await fetchAiconductor(primaryUrl, token, model, prompt);
  } catch (error) {
    if (!isDefault && error.isNetworkError) {
      text = await fetchAiconductor(PROXY_PATH, token, model, prompt);
    } else {
      throw error;
    }
  }

  const parsed = extractJson(text);
  if (parsed === null) {
    throw new Error(
      "AI response was not valid JSON. The model should return only a Design JSON document.",
    );
  }

  const result = validateDesign(parsed);
  if (!result.ok) {
    throw new Error(
      `AI returned an invalid design: ${result.errors.slice(0, 5).join("; ")}`,
    );
  }

  return result.design;
}