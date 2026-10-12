import { buildDesignPrompt, buildRevalidationPrompt } from "./designPrompt";
import { buildPlanPrompt, buildComponentPrompt } from "./architectPrompt";
import { buildPatchPrompt } from "./patchPrompt";
import { validatePatch } from "./patch";
import { isMockEnabled, mockDesign, mockPatch, mockPlan, mockComponent } from "./mockProvider";
import {
  buildSemanticDesignPrompt,
  buildSemanticRevalidationPrompt,
} from "./semanticPrompt";
import { validateSemanticDesign } from "../layout/semanticValidator";
import { resolveSemanticDesign } from "../layout/layoutEngine";
import { validateDesign } from "../design/designValidator";

/**
 * AI service abstraction.
 *
 * generateDesign(userPrompt, { referenceAnalysis, referenceInfluence }) -> { design, semanticDesign, warnings, canvas }
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
 * Fetches model text from the AI Conductor endpoint, transparently falling
 * back to the same-origin proxy when a custom provider fails on CORS/network.
 */
async function fetchWithFallback(primaryUrl, token, model, prompt) {
  const configuredUrl = (import.meta.env.VITE_AICONDUCTOR_URL || "").trim().replace(/\/+$/, "");
  const isDefault = !configuredUrl || configuredUrl === DEFAULT_URL;
  try {
    return await fetchAiconductor(primaryUrl, token, model, prompt);
  } catch (error) {
    if (!isDefault && error.isNetworkError) {
      return await fetchAiconductor(PROXY_PATH, token, model, prompt);
    }
    throw error;
  }
}

/**
 * Semantic pipeline (reference-based). The model outputs a semantic DSL,
 * which is validated, laid out by the constraint engine, then validated a
 * second time as a pixel Design.
 */
async function generateSemantic(userPrompt, analysis, influence) {
  const configuredUrl = (import.meta.env.VITE_AICONDUCTOR_URL || "").trim().replace(/\/+$/, "");
  const token = import.meta.env.VITE_AICONDUCTOR_TOKEN;
  const model = import.meta.env.VITE_AICONDUCTOR_MODEL;
  const isDefault = !configuredUrl || configuredUrl === DEFAULT_URL;
  const primaryUrl = isDefault ? PROXY_PATH : configuredUrl;

  let previousSemantic = null;
  let errors = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1
        ? buildSemanticDesignPrompt(userPrompt, { analysis, influence })
        : buildSemanticRevalidationPrompt(userPrompt, previousSemantic, errors, { analysis, influence });

    const text = await fetchWithFallback(primaryUrl, token, model, requestPrompt);

    const parsed = regexRepairJson(text);
    if (parsed === null) {
      throw new Error(
        "AI response was not recoverable JSON. The model should return only a semantic Design JSON document.",
      );
    }

    const validated = validateSemanticDesign(parsed);
    if (!validated.ok) {
      previousSemantic = parsed;
      errors = validated.errors;
      continue;
    }
    previousSemantic = validated.semantic;

    let resolved;
    try {
      resolved = resolveSemanticDesign(validated.semantic, {
        defaultCanvas: { width: analysis.canvas.width, height: analysis.canvas.height },
      });
    } catch (error) {
      errors = [`Layout error: ${error.message}`];
      continue;
    }

    const design = { canvas: resolved.canvas, elements: resolved.elements };
    const check = validateDesign(design);
    if (check.ok) {
      return {
        design: check.design,
        semanticDesign: validated.semantic,
        warnings: resolved.warnings,
        canvas: resolved.canvas,
      };
    }
    errors = check.errors;
  }

  throw new Error(
    `AI returned an invalid semantic design after ${MAX_ATTEMPTS} attempts: ${errors.slice(0, 6).join("; ")}`,
  );
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
 * @param {{referenceAnalysis?: import("../reference/analysisTypes").ReferenceDesignAnalysis, referenceInfluence?: number, canvas?: {width:number, height:number}}} [options]
 * @returns {Promise<{ design: import("../design/designTypes").Design, semanticDesign: object|null, warnings: string[], canvas: {width:number, height:number, background:string} }>}
 */
export async function generateDesign(userPrompt, options = {}) {
  const { referenceAnalysis, referenceInfluence = 1, canvas } = options;

  if (isMockEnabled()) {
    const raw = mockDesign(userPrompt, canvas);
    const check = validateDesign(raw);
    if (!check.ok) throw new Error(`Mock produced invalid design: ${check.errors.slice(0, 3).join("; ")}`);
    return { design: check.design, semanticDesign: null, warnings: [], canvas: check.design.canvas, source: "mock" };
  }

  if (referenceAnalysis && referenceInfluence > 0) {
    return generateSemantic(userPrompt, referenceAnalysis, referenceInfluence);
  }

  const configuredUrl = (import.meta.env.VITE_AICONDUCTOR_URL || "").trim().replace(/\/+$/, "");
  const token = import.meta.env.VITE_AICONDUCTOR_TOKEN;
  const model = import.meta.env.VITE_AICONDUCTOR_MODEL;

  const prompt = buildDesignPrompt(userPrompt, canvas);

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
      attempt === 1 ? prompt : buildRevalidationPrompt(userPrompt, previousOutput, errors, canvas);

    const text = await fetchWithFallback(primaryUrl, token, model, requestPrompt);
    previousOutput = text;

    const parsed = regexRepairJson(text);
    if (parsed === null) {
      throw new Error(
        "AI response was not recoverable JSON. The model should return only a Design JSON document.",
      );
    }

    const result = validateDesign(parsed);
    if (result.ok) {
      return {
        design: result.design,
        semanticDesign: null,
        warnings: [],
        canvas: result.design.canvas,
      };
    }
    errors = result.errors;
  }

  throw new Error(
    `AI returned an invalid design after ${MAX_ATTEMPTS} attempts: ${errors.slice(0, 6).join("; ")}`,
  );
}

/**
 * Assistant edit path (Goal 4): natural-language request → validated
 * PATCH against the live design (changed props only, never a redesign).
 *
 * @param {string} message
 * @param {{design: import("../design/designTypes").Design, selectedIds?: string[]}} context
 * @returns {Promise<{ops: Array, errors: string[], note: string, source: "mock"|"ai"}>}
 */
export async function generatePatch(message, context) {
  const { design, selectedIds = [] } = context;
  if (!message || !message.trim()) throw new Error("Describe the change first.");
  if (!design) throw new Error("Generate or open a design first.");

  if (isMockEnabled()) {
    const { ops, note } = mockPatch(message, design, selectedIds);
    const { ops: valid, errors } = validatePatch({ ops }, design);
    return { ops: valid, errors, note, source: "mock" };
  }

  const configuredUrl = (import.meta.env.VITE_AICONDUCTOR_URL || "").trim().replace(/\/+$/, "");
  const token = import.meta.env.VITE_AICONDUCTOR_TOKEN;
  const model = import.meta.env.VITE_AICONDUCTOR_MODEL;
  const isDefault = !configuredUrl || configuredUrl === DEFAULT_URL;
  const primaryUrl = isDefault ? PROXY_PATH : configuredUrl;

  const text = await fetchWithFallback(primaryUrl, token, model, buildPatchPrompt(message, design, selectedIds));
  const parsed = regexRepairJson(text);
  if (parsed === null) {
    throw new Error("AI response was not recoverable JSON. Ask again, more specifically.");
  }
  const { ops, errors } = validatePatch(parsed, design);
  return { ops, errors, note: "", source: "ai" };
}

function sanitizeBox(box, canvas, warnings, id) {
  if (!box || typeof box !== "object") return null;
  const num = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  const width = Math.min(1024, Math.max(32, Math.round(num(box.width, 256))));
  const height = Math.min(1024, Math.max(32, Math.round(num(box.height, 256))));
  const x = Math.min(Math.max(0, Math.round(num(box.x, 0))), Math.max(0, canvas.width - 32));
  const y = Math.min(Math.max(0, Math.round(num(box.y, 0))), Math.max(0, canvas.height - 32));
  return { x, y, width, height };
}

function sanitizePlan(raw, canvas) {
  const warnings = [];
  const palette = {
    background: "#FFFFFF",
    ink: "#111111",
    accent: "#4F46E5",
    ...((raw && raw.palette) || {}),
  };
  const seen = new Set();
  const components = [];
  for (const c of (raw?.components || []).slice(0, 10)) {
    if (!c || typeof c !== "object") continue;
    const id = String(c.id || "").trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
    if (!id || seen.has(id)) {
      warnings.push("plan: dropped a duplicate or empty component id");
      continue;
    }
    seen.add(id);
    const kind = c.kind === "image" ? "image" : "dsl";
    let box = c.box && typeof c.box === "object" ? sanitizeBox(c.box, canvas, warnings, id) : null;
    if (!box && kind === "dsl") {
      box = { x: 0, y: 0, width: canvas.width, height: canvas.height };
      warnings.push(`plan: "${id}" got no box — full canvas assumed`);
    }
    if (!box) {
      warnings.push(`plan: image component "${id}" needs a box`);
      continue;
    }
    components.push({
      id,
      kind,
      describe: String(c.describe || id).slice(0, 300),
      asset: ["icon", "logo", "illustration", "photo"].includes(c.asset) ? c.asset : "illustration",
      ...(box ? { box } : {}),
    });
  }
  return { palette, components, warnings };
}

function gatewayEnv() {
  const configuredUrl = (import.meta.env.VITE_AICONDUCTOR_URL || "").trim().replace(/\/+$/, "");
  const token = import.meta.env.VITE_AICONDUCTOR_TOKEN;
  const model = import.meta.env.VITE_AICONDUCTOR_MODEL;
  const isDefault = !configuredUrl || configuredUrl === DEFAULT_URL;
  return { primaryUrl: isDefault ? PROXY_PATH : configuredUrl, token, model };
}

/**
 * Architect pass 1: natural-language request → build plan (palette +
 * ordered components, each routed dsl|image with a fixed box).
 */
export async function planDesign(userPrompt, canvas) {
  if (isMockEnabled()) {
    const clean = sanitizePlan(mockPlan(userPrompt, canvas), canvas);
    return { ...clean, source: "mock" };
  }
  const { primaryUrl, token, model } = gatewayEnv();
  let errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1
        ? buildPlanPrompt(userPrompt, canvas)
        : `${buildPlanPrompt(userPrompt, canvas)}\n\n[Correction]\nYour previous response was not usable JSON (${errors.join("; ")}). Return ONLY the JSON plan.`;
    const text = await fetchWithFallback(primaryUrl, token, model, requestPrompt);
    const parsed = regexRepairJson(text);
    if (parsed === null) {
      errors = ["unrecoverable JSON"];
      continue;
    }
    const clean = sanitizePlan(parsed, canvas);
    if (clean.components.length === 0) {
      errors = ["plan had no usable components"];
      continue;
    }
    return { ...clean, source: "ai" };
  }
  throw new Error(`Could not plan the design: ${errors.slice(0, 3).join("; ")}`);
}

/**
 * Architect pass 2: one DSL component → validated elements.
 * @returns {Promise<{elements: Array, source: "mock"|"ai"}>}
 */
export async function componentDesign(component, canvas, palette) {
  if (isMockEnabled()) {
    const elements = mockComponent(component, canvas);
    const check = validateDesign({ canvas, elements });
    if (!check.ok) throw new Error(`Mock component invalid: ${check.errors.slice(0, 2).join("; ")}`);
    return { elements: check.design.elements, source: "mock" };
  }
  const { primaryUrl, token, model } = gatewayEnv();
  let errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1
        ? buildComponentPrompt(component, canvas, palette)
        : `${buildComponentPrompt(component, canvas, palette)}\n\n[Correction]\nYour previous response failed (${errors.join("; ")}). Return ONLY {"elements":[...]}.`;
    const text = await fetchWithFallback(primaryUrl, token, model, requestPrompt);
    const parsed = regexRepairJson(text);
    if (parsed === null || !Array.isArray(parsed.elements)) {
      errors = ["unrecoverable JSON"];
      continue;
    }
    const check = validateDesign({ canvas, elements: parsed.elements });
    if (check.ok) return { elements: check.design.elements, source: "ai" };
    errors = check.errors;
  }
  throw new Error(`Component "${component.id}" failed: ${errors.slice(0, 3).join("; ")}`);
}