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
 * Every request goes through one same-origin server route:
 *
 *   POST /api/groq   { messages, schema, maxTokens, effort }
 *   ->               { text, provider }
 *
 * The provider order (Groq gpt-oss-120b -> Gemini Gemma 4 -> OpenRouter
 * Nemotron -> on-device Ollama) lives server-side in api/_aiChain.js, so the
 * API keys never reach the browser and no call ever leaves this pipeline.
 * Swapping providers only means editing that chain - the renderer and
 * validator are untouched.
 */

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
 * Network errors are also fallback-eligible (retryable): a dead gateway
 * is exactly when the local model should take over.
 */
function networkError(message) {
  const error = new Error(message);
  error.isNetworkError = true;
  error.retryable = true;
  return error;
}

/**
 * Split our single-string "[System]...[User]..." prompts into real chat
 * roles for OpenAI-compatible endpoints. Falls back to user-only.
 */
function splitPrompt(full) {
  const lines = String(full || "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "[User]");
  if (at === -1) return { system: "", user: String(full || "") };
  const sys = lines.slice(0, at).filter((l) => l.trim() !== "[System]");
  return { system: sys.join("\n").trim(), user: lines.slice(at + 1).join("\n").trim() };
}

/** All validator-tolerated styling fields. Groq strict mode demands every
 * property key appear in `required`, so optionals are nullable unions —
 * and normalizeElement strips nulls back out before validation. */
const OPT_COMMON = {
  role: { type: ["string", "null"] },
  stroke: { type: ["string", "null"] },
  strokeWidth: { type: ["number", "null"] },
  angle: { type: ["number", "null"] },
  opacity: { type: ["number", "null"] },
  visible: { type: ["boolean", "null"] },
  locked: { type: ["boolean", "null"] },
};
function closedVariant(extraProps) {
  const properties = { id: { type: "string" }, ...OPT_COMMON, ...extraProps };
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
// Gradient overlay, strict-compatible: nullable object, all keys required
// (unused coords arrive null and are defaulted by the validator).
const GRADIENT_PROP = {
  type: ["object", "null"],
  properties: {
    type: { type: "string", enum: ["linear", "radial"] },
    x1: { type: ["number", "null"] }, y1: { type: ["number", "null"] },
    x2: { type: ["number", "null"] }, y2: { type: ["number", "null"] },
    cx: { type: ["number", "null"] }, cy: { type: ["number", "null"] },
    r: { type: ["number", "null"] },
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: { offset: { type: "number" }, color: { type: "string" } },
        required: ["offset", "color"],
        additionalProperties: false,
      },
    },
  },
  required: ["type", "x1", "y1", "x2", "y2", "cx", "cy", "r", "stops"],
  additionalProperties: false,
};
const TEXT_VAR = closedVariant(
  {
    type: { type: "string", enum: ["text"] },
    content: { type: "string" },
    x: { type: "number" }, y: { type: "number" }, width: { type: "number" },
    fontSize: { type: "number" }, fontWeight: { type: "number" }, fill: { type: "string" },
    textAlign: { type: ["string", "null"] }, lineHeight: { type: ["number", "null"] },
    fontFamily: { type: ["string", "null"] }, charSpacing: { type: ["number", "null"] },
    gradient: GRADIENT_PROP,
  },
);
const RECT_VAR = closedVariant(
  {
    type: { type: "string", enum: ["rectangle"] },
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number" }, height: { type: "number" }, fill: { type: "string" },
    cornerRadius: { type: ["number", "null"] },
    gradient: GRADIENT_PROP,
  },
);
const CIRCLE_VAR = closedVariant(
  {
    type: { type: "string", enum: ["circle"] },
    x: { type: "number" }, y: { type: "number" },
    radius: { type: "number" }, fill: { type: "string" },
    gradient: GRADIENT_PROP,
  },
);
const LINE_VAR = closedVariant(
  {
    type: { type: "string", enum: ["line"] },
    x: { type: "number" }, y: { type: "number" },
    x2: { type: "number" }, y2: { type: "number" },
  },
);
const IMAGE_VAR = closedVariant(
  {
    type: { type: "string", enum: ["image"] },
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number" }, height: { type: "number" }, src: { type: "string" },
  },
);
// Groups nest one level (flat children; deeper nesting falls back to
// json_object mode via the automatic downgrade below).
const GROUP_VAR = closedVariant(
  {
    type: { type: "string", enum: ["group"] },
    x: { type: "number" }, y: { type: "number" },
    children: { type: "array", items: { anyOf: [TEXT_VAR, RECT_VAR, CIRCLE_VAR, LINE_VAR, IMAGE_VAR] } },
  },
);
const COMPONENTS_SCHEMA = {
  type: "object",
  properties: {
    elements: { type: "array", items: { anyOf: [TEXT_VAR, RECT_VAR, CIRCLE_VAR, LINE_VAR, IMAGE_VAR, GROUP_VAR] } },
  },
  required: ["elements"],
  additionalProperties: false,
};
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    palette: {
      type: "object",
      properties: {
        background: { type: "string" }, ink: { type: "string" }, accent: { type: "string" },
      },
      required: ["background", "ink", "accent"],
      additionalProperties: false,
    },
    style: { type: "string" },
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["dsl", "image"] },
          role: {
            type: "string",
            enum: ["header", "headline", "hero", "tagline", "details", "sections", "audience", "footer", "decoration"],
          },
          describe: { type: "string" },
          asset: { type: "string", enum: ["icon", "logo", "illustration", "photo", "none"] },
          box: {
            type: "object",
            properties: {
              x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
        },
        required: ["id", "kind", "role", "describe", "asset", "box"],
        additionalProperties: false,
      },
    },
  },
  required: ["palette", "style", "components"],
  additionalProperties: false,
};

/**
 * Same-origin /api/groq proxy, now a server-side provider CHAIN
 * (groq → gemini → openrouter, order via AI_CHAIN). The browser sends one
 * normalized request; the proxy returns whichever provider answered, so a
 * rate-limited provider never drops a component. Keys stay server-side.
 *
 * Strict json_schema first; a 400 (schema unsupported by every provider)
 * downgrades once to plain json_object, where our repair loop takes over.
 */
async function fetchGroqChat(prompt, opts = {}) {
  const tStart = Date.now();
  const ms = () => Date.now() - tStart;
  const model = import.meta.env.VITE_GROQ_MODEL || "openai/gpt-oss-120b";
  const { system, user } = splitPrompt(prompt);
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const post = async (schema) => {
    let res;
    try {
      res = await fetch("/api/groq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, model, schema, name: opts.name, maxTokens: opts.maxTokens, effort: opts.effort }),
        signal: AbortSignal.timeout(180000),
      });
    } catch (error) {
      throw networkError(`ai request failed (network): ${error.message}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // keep data null
    }
    if (!res.ok) {
      const error = new Error(`ai request failed: ${data?.error || res.status}`);
      if (data?.retryable) error.retryable = true;
      error.status = res.status;
      throw error;
    }
    if (typeof data?.text !== "string" || !data.text.trim()) {
      throw new Error("ai returned an empty response");
    }
    // provider = which rung of the chain answered (groq/gemini/openrouter/ollama).
    return { text: data.text, provider: data.provider || "groq" };
  };
  console.log(`[ai] chain POST /api/groq model=${model} promptChars=${prompt.length} strict=${opts.schema ? "schema" : "json_object"}`);
  try {
    const out = await post(opts.schema);
    console.log(`[ai] chain ok via ${out.provider} ${ms()}ms respChars=${out.text.length}`);
    return out.text;
  } catch (error) {
    if (error && error.status === 400 && opts.schema && typeof opts.schema === "object") {
      console.warn(`[ai] chain strict rejected (400), downgrading to json_object: ${error.message}`);
      const out = await post("json_object");
      console.log(`[ai] chain ok-downgraded via ${out.provider} ${ms()}ms respChars=${out.text.length}`);
      return out.text;
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
  let previousSemantic = null;
  let errors = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1
        ? buildSemanticDesignPrompt(userPrompt, { analysis, influence })
        : buildSemanticRevalidationPrompt(userPrompt, previousSemantic, errors, { analysis, influence });

    const text = await fetchGroqChat(requestPrompt);

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

  const prompt = buildDesignPrompt(userPrompt, canvas);

  let previousOutput = "";
  let errors = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1 ? prompt : buildRevalidationPrompt(userPrompt, previousOutput, errors, canvas);

    const text = await fetchGroqChat(requestPrompt);
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

  const text = await fetchGroqChat(buildPatchPrompt(message, design, selectedIds));
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

const PLAN_ROLES = [
  "header",
  "headline",
  "hero",
  "tagline",
  "details",
  "sections",
  "audience",
  "footer",
  "decoration",
];

function sanitizePlan(raw, canvas) {
  const warnings = [];
  const palette = {
    background: "#FFFFFF",
    ink: "#111111",
    accent: "#4F46E5",
    ...((raw && raw.palette) || {}),
  };
  const style = String((raw && raw.style) || "").slice(0, 200);
  const seen = new Set();
  const components = [];
  // Roles drive size floors, hero checks and hierarchy warnings downstream,
  // but models often omit them — infer from the id so the contract holds.
  const inferRole = (id, kind) => {
    if (/hero|focal|art|illustration|mascot/.test(id)) return "hero";
    if (/headline|title/.test(id)) return "headline";
    if (/header|brand|kicker|nav/.test(id)) return "header";
    if (/tagline|subhead|subtitle|slogan/.test(id)) return "tagline";
    if (/detail|info|date|time|venue|when|where/.test(id)) return "details";
    if (/audience|who|attend/.test(id)) return "audience";
    if (/foot|register|sponsor|partner|organiz/.test(id)) return "footer";
    if (/decor|confetti|sparkle|background|texture|pattern|shape/.test(id)) return "decoration";
    if (/section|activit|benefit|lineup|card|feature|expect/.test(id)) return "sections";
    return kind === "image" ? "hero" : "sections";
  };
  for (const c of (raw?.components || []).slice(0, 12)) {
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
      role: PLAN_ROLES.includes(c.role) ? c.role : inferRole(id, kind),
      describe: String(c.describe || id).slice(0, 300),
      asset: ["icon", "logo", "illustration", "photo", "none"].includes(c.asset) ? c.asset : "illustration",
      ...(box ? { box } : {}),
    });
  }
  // Planned boxes that already overlap (decoration may bleed, anything
  // else collides by construction) — surfaced now, fixed by replan.
  let boxClash = null;
  for (let i = 0; i < components.length && !boxClash; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i];
      const b = components[j];
      if (!a.box || !b.box || a.role === "decoration" || b.role === "decoration") continue;
      const A = a.box;
      const B = b.box;
      if (
        Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x) > 0 &&
        Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y) > 0
      ) {
        boxClash = `"${a.id}" and "${b.id}"`;
        break;
      }
    }
  }
  if (boxClash) warnings.push(`plan: ${boxClash} boxes overlap — sections will collide`);
  return { palette, style, components, warnings };
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
  const tStart = Date.now();
  console.log(`[ai] plan start canvas=${canvas.width}x${canvas.height} promptChars=${userPrompt.length}`);
  let errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1
        ? buildPlanPrompt(userPrompt, canvas)
        : `${buildPlanPrompt(userPrompt, canvas)}\n\n[Correction]\nYour previous response was not usable JSON (${errors.join("; ")}). Return ONLY the JSON plan.`;
    // Corrections only fix malformed model output — a dead network never
    // recovers by re-asking, so fetch failures throw immediately instead
    // of burning (attempts × timeout) on a hung provider.
    let text;
    try {
      text = await fetchGroqChat(requestPrompt, { schema: PLAN_SCHEMA, name: "oovi_plan", maxTokens: 4000, effort: "medium" });
    } catch (error) {
      throw new Error(`Could not plan the design: ${error.message}`);
    }
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
    console.log(
      `[ai] plan ok ${Date.now() - tStart}ms attempts=${attempt} ` +
        `components=${clean.components.map((c) => `${c.id}(${c.kind}/${c.role})`).join(",")}`,
    );
    return { ...clean, source: "ai" };
  }
  throw new Error(`Could not plan the design: ${errors.slice(0, 3).join("; ")}`);
}

/**
 * Architect pass 2: one DSL component → validated elements.
 * @returns {Promise<{elements: Array, source: "mock"|"ai"}>}
 */
export async function componentDesign(component, canvas, plan) {
  const palette = plan.palette;
  if (isMockEnabled()) {
    const elements = mockComponent(component, canvas);
    const check = validateDesign({ canvas, elements });
    if (!check.ok) throw new Error(`Mock component invalid: ${check.errors.slice(0, 2).join("; ")}`);
    return { elements: check.design.elements, source: "mock" };
  }
  const tStart = Date.now();
  console.log(`[ai] component start ${component.id} (${component.kind}/${component.role || "?"})`);
  let errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestPrompt =
      attempt === 1
        ? buildComponentPrompt(component, canvas, plan)
        : `${buildComponentPrompt(component, canvas, plan)}\n\n[Correction]\nYour previous response failed (${errors.join("; ")}). Return ONLY {"elements":[...]}.`;
    // Same fail-fast rule as planning: corrections fix bad JSON, not networks.
    let text;
    try {
      text = await fetchGroqChat(requestPrompt, { schema: COMPONENTS_SCHEMA, name: "oovi_component", maxTokens: 1200, effort: "low" });
    } catch (error) {
      throw new Error(`Component "${component.id}" failed: ${error.message}`);
    }
    const parsed = regexRepairJson(text);
    if (parsed === null || !Array.isArray(parsed.elements)) {
      console.warn(`[ai] component retry ${component.id} attempt=${attempt} errors=unrecoverable JSON`);
      errors = ["unrecoverable JSON"];
      continue;
    }
    const check = validateDesign({ canvas, elements: parsed.elements });
    if (check.ok) {
      console.log(
        `[ai] component ok ${component.id} ${Date.now() - tStart}ms attempts=${attempt} elements=${check.design.elements.length}`,
      );
      return { elements: check.design.elements, source: "ai" };
    }
    console.warn(
      `[ai] component retry ${component.id} attempt=${attempt} errors=${check.errors.slice(0, 2).join("; ")}`,
    );
    errors = check.errors;
  }
  throw new Error(`Component "${component.id}" failed: ${errors.slice(0, 3).join("; ")}`);
}