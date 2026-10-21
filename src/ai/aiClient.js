import { buildDesignPrompt, buildRevalidationPrompt } from "./designPrompt";
import { buildPlanPrompt, buildComponentPrompt } from "./architectPrompt";
import { createElementScanner } from "./streamJson";
import {
  buildGoalPrompt,
  buildPalettePrompt,
  GOAL_SCHEMA,
  PALETTE_SCHEMA,
} from "./layerPrompt";
import {
  buildTemplateChoicePrompt,
  buildTuningPrompt,
  templateChoiceSchema,
  tuningSchema,
} from "./templatePrompt";
import {
  getTemplate,
  instantiateTemplate,
  sanitizeTuning,
  sizeClassOf,
  TEMPLATES,
} from "../layout/templates";
import { retrieveTemplates, RETRIEVAL_LIMIT, DEFAULT_COVERAGE_THRESHOLD } from "../layout/retrieve";
import { listSavedTemplates } from "../layout/templateStore";
import { lookupPalette, paletteIsUsable } from "../layout/palettes";
import { ensurePaletteRoles, applyRoleFills, textRoleFor, normRoleColor } from "../layout/paletteRoles";
import { buildPatchPrompt } from "./patchPrompt";
import { validatePatch } from "./patch";
import { contrastRatio } from "./quality";
import { fitRegion } from "../layout/regionFit";
import { sanitizeRegionCopy, copyProblem, normalizeCopyLines } from "./copySanitize";
import { buildCopyPrompt, buildCopyRepairPrompt, copyDeckSchema, copyLineLimit, isCopyRegion } from "./copyPrompt";
import { normalizeElementRoles } from "./elementRoles";
import {
  isMockEnabled,
  mockDesign,
  mockPatch,
  mockPlan,
  mockComponent,
  mockGoal,
  mockPalette,
} from "./mockProvider";
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
 *   POST /api/ai   { messages, schema, maxTokens, effort }
 *   ->             { text, provider }
 *
 * The provider (on-device Ollama serving the local Gemma model) lives
 * server-side in api/_aiChain.js, so nothing provider-specific reaches the
 * browser and no API key ever leaves the server. Swapping the model only
 * means editing that file — the renderer and validator are untouched.
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

/** All validator-tolerated styling fields. Strict json_schema mode demands
 * every property key appear in `required`, so optionals are nullable
 * unions — and normalizeElement strips nulls back out before validation. */
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
 * Same-origin /api/ai proxy. The browser sends one normalized request and
 * the server routes it to the on-device provider (Ollama serving the local
 * Gemma model). Strict json_schema first; a 400 (schema unsupported)
 * downgrades once to plain json_object, where our repair loop takes over.
 *
 * The response is a progress STREAM (NDJSON), not one buffered body: on-device
 * generation runs for minutes, and a silent response is what idle timeouts at
 * any hop are built to kill. Streaming also lets `opts.onProgress(chunks, secs)`
 * drive the UI while it waits.
 */
async function fetchAiChat(prompt, opts = {}) {
  const tStart = Date.now();
  const ms = () => Date.now() - tStart;
  const { system, user } = splitPrompt(prompt);
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const onPartial = typeof opts.onPartial === "function" ? opts.onPartial : null;
  const signal = AbortSignal.timeout(1800000);

  // Drains the NDJSON progress stream: accumulates the final text while
  // forwarding live token counts to the UI.
  const readStream = async (res) => {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("ai returned no response stream");
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let provider = "ollama";
    let failure = null;
    const consume = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return; // ignore a malformed line, keep the stream alive
      }
      if (obj.t === "progress") onProgress?.(obj.chunks, obj.secs);
      else if (obj.t === "delta") {
        // Raw token text: lets a caller parse elements out of the response
        // while it is still being written.
        text += obj.text || "";
        onPartial?.(text);
      } else if (obj.t === "done") {
        text = obj.text || "";
        provider = obj.provider || provider;
      } else if (obj.t === "error") failure = obj;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    consume(buffer);
    if (failure) {
      const error = new Error(`ai request failed: ${failure.error}`);
      if (failure.retryable) error.retryable = true;
      error.status = failure.status || 502;
      throw error;
    }
    return { text, provider };
  };

  const post = async (schema) => {
    let res;
    try {
      res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ai-stream": "1" },
        body: JSON.stringify({
          messages,
          schema,
          name: opts.name,
          maxTokens: opts.maxTokens,
          effort: opts.effort,
          stream: true,
          delta: !!onPartial,
        }),
        signal,
      });
    } catch (error) {
      throw networkError(`ai request failed (network): ${error.message}`);
    }
    if (!res.ok || !res.body) {
      // Pre-stream rejection (bad request, method, etc.) — read the JSON body.
      let data = null;
      try {
        data = await res.json();
      } catch {
        // keep data null
      }
      const error = new Error(`ai request failed: ${data?.error || res.status}`);
      if (data?.retryable) error.retryable = true;
      error.status = res.status;
      throw error;
    }
    const out = await readStream(res);
    if (!out.text.trim()) throw new Error("ai returned an empty response");
    return out;
  };

  console.log(`[ai] POST /api/ai promptChars=${prompt.length} strict=${opts.schema ? "schema" : "json_object"}`);
  try {
    const out = await post(opts.schema);
    console.log(`[ai] ok via ${out.provider} ${ms()}ms respChars=${out.text.length}`);
    return out.text;
  } catch (error) {
    if (error && error.status === 400 && opts.schema && typeof opts.schema === "object") {
      console.warn(`[ai] strict rejected (400), downgrading to json_object: ${error.message}`);
      const out = await post("json_object");
      console.log(`[ai] ok-downgraded via ${out.provider} ${ms()}ms respChars=${out.text.length}`);
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

    const text = await fetchAiChat(requestPrompt);

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

    const text = await fetchAiChat(requestPrompt);
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

  const text = await fetchAiChat(buildPatchPrompt(message, design, selectedIds));
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

// --- Layered pipeline (raw -> best) --------------------------------------
//
// These three passes replace the single monolithic plan call so a terse
// request still produces a complete, on-palette design. See layerPrompt.js
// for what each layer receives; the sanitizers below make any layer's output
// safe to consume even when the model answers partially.

const DEFAULT_PALETTE = { background: "#FFFFFF", ink: "#111111", accent: "#4F46E5" };

function asText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function hexOrNull(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex.toUpperCase()}`;
}

/** Tolerates a partial goal: always returns the full shape. */
/**
 * Controlled vocabularies for the L1 scope fields. The model is asked for a
 * free string; these maps snap it onto the words the rest of the pipeline
 * reasons about, so "product launch" and "product-launch" and "launch" all
 * become one value instead of three that no comparison catches.
 */
const DESIGN_TYPES = [
  "poster", "banner", "social-post", "story", "cover", "newsletter", "notice",
  "invitation", "certificate", "menu", "schedule", "listing", "product-launch",
  "gallery", "quote", "comparison", "team", "ticket", "map", "metrics", "statement",
];

/** Words that commonly appear in a model's designType answer, mapped to ours. */
const DESIGN_TYPE_ALIASES = {
  "social post": "social-post", social: "social-post", instagram: "social-post",
  "product launch": "product-launch", launch: "product-launch", product: "product-launch",
  "cover": "cover", "magazine": "cover", "editorial": "cover",
  "event": "poster", "flyer": "poster", "announcement": "poster",
  "invite": "invitation", "wedding": "invitation",
  "award": "certificate", "diploma": "certificate",
  "timetable": "schedule", "agenda": "schedule", "programme": "schedule", "program": "schedule",
  "price list": "menu", "restaurant": "menu",
  "team roster": "team", "roster": "team", "speakers": "team",
  "stats": "metrics", "results": "metrics", "report": "metrics",
  "gallery": "gallery", "photos": "gallery",
  "quote": "quote", "testimonial": "quote",
  "compare": "comparison", "versus": "comparison",
  "map": "map", "location": "map", "venue": "map",
  "certificate of": "certificate",
  "story": "story", "reel": "story",
};

/** Composition vocabulary; matches the template variants that exist. */
const COMPOSITIONS = ["hero-left", "hero-right", "centered", "split", "stacked", "grid", "banner", "type-only"];

const COMPOSITION_ALIASES = {
  "hero left": "hero-left", "artwork left": "hero-left", "image left": "hero-left",
  "hero right": "hero-right", "artwork right": "hero-right", "image right": "hero-right",
  center: "centered", centred: "centered", "center-stack": "centered", symmetric: "centered",
  "side-by-side": "split", "two-column": "split", "two column": "split", columns: "split",
  vertical: "stacked", "top-down": "stacked", "one-column": "stacked",
  cards: "grid", "multi-column": "grid", columns3: "grid",
  strip: "banner", wide: "banner",
  "text-only": "type-only", "no image": "type-only", typographic: "type-only",
};

function pickVocab(raw, vocab, aliases, fallback) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fallback;
  if (vocab.includes(v)) return v;
  if (aliases[v]) return aliases[v];
  // Containment, longest key first so "product launch" beats "product".
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const key of keys) if (v.includes(key)) return aliases[key];
  for (const candidate of vocab) if (v.includes(candidate)) return candidate;
  return fallback;
}

function sanitizeGoal(raw) {
  const list = (v, cap = 10) =>
    Array.isArray(v)
      ? v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, cap)
      : [];
  const summary = asText(raw?.summary, asText(raw?.subject, "Design"));
  return {
    summary,
    subject: asText(raw?.subject, asText(raw?.summary, "Design")),
    audience: asText(raw?.audience, "general audience"),
    purpose: asText(raw?.purpose, "present the subject clearly"),
    tone: asText(raw?.tone, "clean and confident"),
    // Scope fields (L1). A goal built by hand or by an older model answer has
    // none of these; infer the design type from the summary so retrieval and
    // the palette still get a usable signal instead of "general".
    designType: pickVocab(raw?.designType, DESIGN_TYPES, DESIGN_TYPE_ALIASES, inferDesignType(summary)),
    industry: asText(raw?.industry, "general"),
    keywords: list(raw?.keywords, 8),
    composition: pickVocab(raw?.composition, COMPOSITIONS, COMPOSITION_ALIASES, ""),
    mustInclude: list(raw?.mustInclude),
    avoid: list(raw?.avoid),
    style: asText(raw?.style, "clean modern"),
  };
}

/**
 * Last-resort design type from the summary. Only used when L1 answered without
 * a usable designType (an old prompt, a mock goal, a hand-written fixture).
 */
export function inferDesignType(text) {
  const s = String(text || "").toLowerCase();
  if (/certificate|award|diploma|recogni[sz]/.test(s)) return "certificate";
  if (/invitation|invite|wedding|save the date/.test(s)) return "invitation";
  if (/ticket|admission|pass\b/.test(s)) return "ticket";
  if (/menu|dishes|price list/.test(s)) return "menu";
  if (/schedule|timetable|agenda|programme|program\b/.test(s)) return "schedule";
  if (/listing|itinerary|expo|fair\b/.test(s)) return "listing";
  if (/newsletter|digest|bulletin/.test(s)) return "newsletter";
  if (/cover|magazine|issue\b|journal/.test(s)) return "cover";
  if (/gallery|photo|recap|album/.test(s)) return "gallery";
  if (/comparison|versus|compare/.test(s)) return "comparison";
  if (/team|roster|speakers|panel|lineup/.test(s)) return "team";
  if (/map|directions|venue|location|address/.test(s)) return "map";
  if (/metric|results|stats|impact|quarterly|milestone/.test(s)) return "metrics";
  if (/quote|testimonial|saying/.test(s)) return "quote";
  if (/statement|manifesto|mission|vision|pledge/.test(s)) return "statement";
  if (/banner|header|linkedin|timeline cover/.test(s)) return "banner";
  if (/story|reel|vertical/.test(s)) return "story";
  if (/social|instagram|feed|post\b/.test(s)) return "social-post";
  if (/launch|product|app\b|software|assistant/.test(s)) return "product-launch";
  if (/notice|memo|circular/.test(s)) return "notice";
  return "poster";
}

/** Requires usable hex; repairs a background/ink pair that would fade. */
function sanitizePalette(raw, styleFallback) {
  const background = hexOrNull(raw?.background) || DEFAULT_PALETTE.background;
  let ink = hexOrNull(raw?.ink) || DEFAULT_PALETTE.ink;
  const accent = hexOrNull(raw?.accent) || DEFAULT_PALETTE.accent;
  if ((contrastRatio(ink, background) ?? 0) < 3) {
    const dark = contrastRatio("#111111", background) ?? 0;
    const light = contrastRatio("#FFFFFF", background) ?? 0;
    ink = dark >= light ? "#111111" : "#FFFFFF";
  }
  // Semantic roles are DERIVED, not taken from the model: the model is asked
  // for three colours (a cheap, reliable answer), and a role set it invented
  // could contradict itself. Any roles it does supply are honoured by
  // ensurePaletteRoles() when they are valid hex.
  const base = { background, ink, accent, style: asText(raw?.style, styleFallback || "clean modern") };
  const roles = ensurePaletteRoles({ ...base, ...(raw && typeof raw.roles === "object" ? raw.roles : {}) });
  return { ...base, roles };
}

/**
 * L1 — Refine the raw request into an explicit goal. Soft-fails: if the
 * model cannot answer, the raw prompt itself becomes the brief, so the
 * cascade never dies at the cheap first step.
 */
export async function refineGoal(userPrompt, canvas, onProgress = null) {
  if (isMockEnabled()) return { ...mockGoal(userPrompt, canvas), source: "mock" };
  const tStart = Date.now();
  console.log(`[ai] goal start promptChars=${userPrompt.length}`);
  try {
    const text = await fetchAiChat(buildGoalPrompt(userPrompt, canvas), {
      schema: GOAL_SCHEMA,
      name: "oovi_goal",
      maxTokens: 600,
      effort: "low",
      onProgress,
    });
    const parsed = regexRepairJson(text);
    if (parsed) {
      const goal = sanitizeGoal(parsed);
      console.log(`[ai] goal ok ${Date.now() - tStart}ms mustInclude=${goal.mustInclude.length}`);
      return { ...goal, source: "ai" };
    }
    console.warn("[ai] goal unrecoverable JSON — raw prompt used as the brief");
  } catch (error) {
    console.warn(`[ai] goal failed (${error.message}) — raw prompt used as the brief`);
  }
  return { ...sanitizeGoal({ summary: userPrompt, subject: userPrompt }), source: "fallback" };
}

/** L2 — Choose ONE palette for the goal, guaranteed to not fade. */
export async function planPalette(goal, canvas, onProgress = null) {
  if (isMockEnabled()) {
    const p = mockPalette(goal, canvas);
    return { ...p, roles: ensurePaletteRoles(p), source: "mock" };
  }
  const tStart = Date.now();
  // Phase 2D: a brief the curated library recognises needs no model call at
  // all — this is ~88s of prefill saved on exact, pre-verified colours.
  const known = lookupPalette(goal);
  if (known && paletteIsUsable(known)) {
    const ratio = contrastRatio(known.ink, known.background);
    console.log(
      `[ai] palette ok ${Date.now() - tStart}ms (library:${known.id}) bg=${known.background} ` +
        `ink=${known.ink} accent=${known.accent} contrast=${ratio ? ratio.toFixed(1) : "?"}`,
    );
    return {
      background: known.background,
      ink: known.ink,
      accent: known.accent,
      roles: known.roles,
      style: known.style,
      paletteId: known.id,
      source: "library",
    };
  }
  console.log("[ai] palette start (no library match)");
  try {
    const text = await fetchAiChat(buildPalettePrompt(goal, canvas), {
      schema: PALETTE_SCHEMA,
      name: "oovi_palette",
      maxTokens: 300,
      effort: "low",
      onProgress,
    });
    const parsed = regexRepairJson(text);
    if (parsed) {
      const palette = sanitizePalette(parsed, goal?.style);
      const ratio = contrastRatio(palette.ink, palette.background);
      console.log(
        `[ai] palette ok ${Date.now() - tStart}ms bg=${palette.background} ink=${palette.ink} ` +
          `accent=${palette.accent} contrast=${ratio ? ratio.toFixed(1) : "?"}`,
      );
      return { ...palette, source: "ai" };
    }
    console.warn("[ai] palette unrecoverable JSON — default palette used");
  } catch (error) {
    console.warn(`[ai] palette failed (${error.message}) — default palette used`);
  }
  return { ...sanitizePalette({}, goal?.style), source: "fallback" };
}

/**
 * L3 is template-only. The free-form skeleton path has been removed: every
 * generation must choose a template, show its regions, and then fill those
 * regions one by one. `planTemplate` below is the single L3 implementation.
 */

/**
 * A template by id, whether it shipped with the app or the user saved it.
 * Saved layouts are stored as data and rehydrated on read, so they never live
 * in the TEMPLATES table but must be just as usable.
 */
function findAnyTemplate(id) {
  if (!id) return null;
  return getTemplate(id) || listSavedTemplates().find((t) => t.id === id) || null;
}

/**
 * A request that names a layout this system actually has should not be left to
 * a 270m chooser. These cues are deliberately narrow: "facts rail" is the
 * poster-rail blueprint, "sidebar rail" is sidebar-rail, and so on. Anything
 * less explicit still goes through retrieval.
 */
const LAYOUT_CUES = [
  [/\b(?:three[- ]up\s+)?facts?[-\s]?rail\b|\bposter[-\s]?rail\b/i, "poster-rail"],
  [/\bsidebar[-\s]?rail\b/i, "sidebar-rail"],
  [/\bhero[-\s]?split\b|\bartwork (?:on the )?(?:left|right)\b/i, "hero-split"],
  [/\bteam[-\s]?roster\b/i, "team-roster"],
];

function requestedTemplate(rawPrompt) {
  const text = String(rawPrompt || "");
  for (const [pattern, id] of LAYOUT_CUES) if (pattern.test(text)) return id;
  return "";
}

/**
 * L3a — choose ONE template. The pipeline is template-only, so this function
 * always returns a usable id: retrieval decides when it can, and a forced
 * canvas-sized fallback covers briefs the corpus has never seen.
 *
 * @returns {Promise<{id: string, candidates: string[], source: string, coverage: number}>}
 */
function fallbackTemplateFor(canvas) {
  const size = sizeClassOf(canvas);
  const fits = TEMPLATES.filter((t) => Array.isArray(t.sizes) && t.sizes.includes(size));
  return (fits[0] || TEMPLATES[0])?.id || "";
}

export async function chooseTemplate(goal, palette, canvas, onProgress = null, rawPrompt = "") {
  const requested = requestedTemplate(rawPrompt);
  if (requested) {
    const template = findAnyTemplate(requested);
    if (template) {
      console.log(`[ai] template ok 0ms (request) -> ${requested}`);
      return { id: requested, candidates: [requested], source: "request", coverage: 1 };
    }
    console.warn(`[ai] requested template ${requested} not in library — using retrieval`);
  }
  const found = retrieveTemplates(goal, canvas, { limit: RETRIEVAL_LIMIT, extra: listSavedTemplates() });
  const candidates = found.candidates;
  if (!candidates.length) {
    const forced = fallbackTemplateFor(canvas);
    console.log(
      `[ai] template forced -> ${forced} (best coverage ${(found.coverage || 0).toFixed(2)} < ${DEFAULT_COVERAGE_THRESHOLD}; template-only pipeline)`,
    );
    return { id: forced, candidates: [forced], source: "forced", coverage: found.coverage };
  }
  // Retrieval matches vocabulary, not intent: a workshop brief can share
  // "workshop"/"members" with a team roster even when there are no people,
  // portraits or speaker names in the request. Filling those portrait and
  // name slots then produces a grid of placeholders. Require an explicit
  // people/team signal before allowing a roster template.
  const brief = [goal?.summary, goal?.subject, goal?.purpose, goal?.audience, ...(goal?.keywords || []), ...(goal?.mustInclude || [])]
    .filter(Boolean)
    .join(" ");
  const wantsPeople =
    goal?.designType === "team" ||
    /\b(team|roster|speaker|panel|cast|staff|lineup|portrait)\b|meet the (people|team|makers)/i.test(brief);
  const shortlist = candidates.filter((id) => {
    const template = findAnyTemplate(id);
    if (template?.type === "roster" && !wantsPeople) {
      console.log(`[ai] template skip ${id} — roster layout but the brief has no people/team content`);
      return false;
    }
    return true;
  });
  if (!shortlist.length) {
    const forced = fallbackTemplateFor(canvas);
    console.log(`[ai] template forced -> ${forced} (every retrieved candidate is a poor content match)`);
    return { id: forced, candidates: [forced], source: "forced", coverage: found.coverage };
  }
  // `decisive` is retrieval's own judgement that the top hit is not a tie; the
  // selection policy lives in src/layout/retrieve.js so the benchmark and the
  // pipeline cannot drift apart.
  const decisive = found.decisive?.id && shortlist.includes(found.decisive.id) ? found.decisive.id : shortlist.length === 1 ? shortlist[0] : null;
  if (decisive) {
    const runner = found.scored.find((s) => s.id !== decisive);
    console.log(
      `[ai] template ok 0ms (retrieval) -> ${decisive} coverage=${found.coverage.toFixed(2)}` +
        `${runner ? ` next=${runner.id}@${runner.coverage.toFixed(2)}` : ""}`,
    );
    return { id: decisive, candidates: shortlist, source: "retrieval", coverage: found.coverage };
  }
  if (isMockEnabled()) return { id: shortlist[0], candidates: shortlist, source: "mock", coverage: found.coverage };
  const tStart = Date.now();
  console.log(
    `[ai] template start candidates=${shortlist.join(",")} ` +
      `coverage=${found.scored.map((s) => `${s.id}:${s.coverage.toFixed(2)}`).join(" ")}`,
  );
  try {
    const text = await fetchAiChat(buildTemplateChoicePrompt(goal, palette, canvas, found.scored), {
      schema: templateChoiceSchema(shortlist),
      name: "oovi_template",
      maxTokens: 220,
      effort: "low",
      onProgress,
    });
    const parsed = regexRepairJson(text);
    const id = typeof parsed?.template === "string" ? parsed.template : "";
    // The grammar already restricts the answer to the shortlist; keep the
    // check anyway so a malformed local response cannot escape it.
    if (id && shortlist.includes(id)) {
      console.log(`[ai] template ok ${Date.now() - tStart}ms -> ${id}`);
      return { id, candidates: shortlist, source: "ai", coverage: found.coverage };
    }
    console.warn(`[ai] template choice "${id}" outside shortlist — using ${shortlist[0]}`);
  } catch (error) {
    console.warn(`[ai] template choice failed (${error.message}) — using ${shortlist[0]}`);
  }
  return { id: shortlist[0], candidates: shortlist, source: "fallback", coverage: found.coverage };
}

/**
 * L3b — bounded tuning patch for a chosen template. Always returns a usable
 * tuning object: the default (untouched template) is a valid answer.
 */
export async function planTemplateTuning(template, goal, palette, canvas, onProgress = null, opts = {}) {
  const t = typeof template === "string" ? getTemplate(template) : template;
  const defaults = sanitizeTuning(null, t);
  if (!t || isMockEnabled()) return { ...defaults, source: "default" };
  const tStart = Date.now();
  const correction = typeof opts.correction === "string" ? opts.correction.trim() : "";
  console.log(`[ai] template-tuning start ${t.id}${correction ? " (refine)" : ""}`);
  try {
    const text = await fetchAiChat(buildTuningPrompt(t, goal, palette, canvas, correction), {
      schema: tuningSchema(t),
      name: "oovi_tuning",
      maxTokens: 320,
      effort: "low",
      onProgress,
    });
    const parsed = regexRepairJson(text);
    if (parsed) {
      const tuning = sanitizeTuning(parsed, t);
      console.log(
        `[ai] template-tuning ok ${t.id} ${Date.now() - tStart}ms variant=${tuning.variant} ` +
          `density=${tuning.density} hide=${tuning.hide.length} scale=${Object.keys(tuning.scale).length}`,
      );
      return { ...tuning, source: "ai" };
    }
    console.warn("[ai] template-tuning unrecoverable JSON — template left untouched");
  } catch (error) {
    console.warn(`[ai] template-tuning failed (${error.message}) — template left untouched`);
  }
  return { ...defaults, source: "fallback" };
}

/**
 * L3c — one copy deck for every text region of the chosen template.
 *
 * The per-region L4 call is deliberately good at geometry, colour and fit; it
 * is not a reliable copywriter at 270m. This pass writes all the words while
 * the template sample is already on screen, then L4 receives exact lines.
 * Validation is deterministic and shared with the final region guard; one
 * focused repair call handles rejected lines. If the call fails entirely the
 * pipeline continues (regions write their own copy) and the final sanitizer
 * still has the last word.
 */
export async function planCopyDeck(components, goal, canvas, rawPrompt = "", onProgress = null) {
  const regions = (components || []).filter(isCopyRegion);
  const emptyStats = { regions: regions.length, lines: 0, rejected: 0, unresolved: 0 };
  if (!regions.length) return { copies: {}, source: "none", stats: emptyStats, rejected: [] };
  if (isMockEnabled()) return { copies: {}, source: "mock", stats: emptyStats, rejected: [] };

  const tStart = Date.now();
  console.log(`[ai] copy-deck start regions=${regions.map((component) => component.id).join(",")}`);
  try {
    const text = await fetchAiChat(buildCopyPrompt(regions, goal, rawPrompt, canvas), {
      schema: copyDeckSchema(regions),
      name: "oovi_copydeck",
      maxTokens: 500,
      effort: "low",
      onProgress,
    });
    const parsed = regexRepairJson(text);
    if (!parsed) throw new Error("unrecoverable JSON");
    let copies = normalizeCopyDeck(parsed, regions);
    let rejected = validateCopyDeck(copies, regions, goal, rawPrompt);
    const initialRejected = rejected.length;
    let source = rejected.length ? "rewrite" : "ai";
    if (rejected.length) {
      console.warn(
        `[ai] copy-deck rejected ${rejected
          .map((entry) => `${entry.component.id}: ${entry.reason} — ${JSON.stringify(entry.lines)}`)
          .join("; ")}`,
      );
      try {
        const repairText = await fetchAiChat(
          buildCopyRepairPrompt(
            rejected.map((entry) => entry.component),
            goal,
            rawPrompt,
            rejected,
            canvas,
          ),
          {
            schema: copyDeckSchema(rejected.map((entry) => entry.component)),
            name: "oovi_copydeck",
            maxTokens: 420,
            effort: "low",
            onProgress,
          },
        );
        const repairParsed = regexRepairJson(repairText);
        if (repairParsed) {
          const repaired = normalizeCopyDeck(repairParsed, rejected.map((entry) => entry.component));
          console.log(`[ai] copy-deck repair ${JSON.stringify(repaired)}`);
          for (const entry of rejected) {
            if (repaired[entry.component.id]?.length) copies[entry.component.id] = repaired[entry.component.id];
          }
        }
      } catch (error) {
        console.warn(`[ai] copy-deck repair failed (${error.message})`);
      }
      rejected = validateCopyDeck(copies, regions, goal, rawPrompt);
      if (rejected.length) {
        console.warn(
          `[ai] copy-deck unresolved ${rejected
            .map((entry) => `${entry.component.id}: ${entry.reason} — ${JSON.stringify(entry.lines)}`)
            .join("; ")}`,
        );
      }
      source = rejected.length ? "mixed" : "rewrite";
    }
    // Never pass a rejected line to L4 as "approved copy"; the final region
    // guard would only have to replace it again.
    for (const entry of rejected) delete copies[entry.component.id];
    const stats = {
      regions: regions.length,
      lines: Object.values(copies).reduce((sum, lines) => sum + lines.length, 0),
      rejected: initialRejected,
      unresolved: rejected.length,
    };
    console.log(
      `[ai] copy-deck ok ${Date.now() - tStart}ms source=${source} regions=${stats.regions} ` +
        `lines=${stats.lines} unresolved=${stats.unresolved}`,
    );
    return { copies, source, stats, rejected };
  } catch (error) {
    console.warn(`[ai] copy-deck failed (${error.message}) — regions will write their own copy`);
    return { copies: {}, source: "fallback", stats: emptyStats, rejected: [] };
  }
}

function normalizeCopyDeck(parsed, components) {
  const source = parsed?.copies && typeof parsed.copies === "object" ? parsed.copies : parsed;
  const copies = {};
  for (const component of components) {
    const value = source && typeof source === "object" ? source[component.id] : null;
    const lines = normalizeCopyLines(value).slice(0, copyLineLimit(component));
    if (lines.length) copies[component.id] = lines;
  }
  return copies;
}

function validateCopyDeck(copies, components, goal, rawPrompt) {
  const rejected = [];
  const seen = new Map();
  for (const component of components) {
    const lines = copies[component.id] || [];
    let reason = copyProblem(lines, component, goal, rawPrompt);
    if (!reason && lines.length) {
      const normalized = normalizeCopyLines(lines).map((line) => line.toLowerCase());
      const duplicate = normalized.find((line) => seen.has(line));
      if (duplicate) {
        reason = `duplicates copy used by ${seen.get(duplicate)}`;
      } else {
        normalized.forEach((line) => seen.set(line, component.id));
      }
    }
    if (reason) rejected.push({ component, lines, reason });
  }
  return rejected;
}

/**
 * The palette a PLAN carries. Roles are attached here, once, so every
 * downstream consumer (L4 prompt, L5 correction, the quality gate) reads the
 * same role set instead of each re-deriving it — and so a plan is
 * self-contained: it can be logged, replayed or saved without the L2 result.
 */
function planPaletteObject(palette) {
  return {
    background: palette.background,
    ink: palette.ink,
    accent: palette.accent,
    roles: ensurePaletteRoles(palette),
    paletteId: palette.paletteId,
    style: palette.style,
  };
}

/**
 * L3 via templates: choose -> tune -> instantiate. Template-only by design:
 * there is no free-form fallback. If the first candidate cannot instantiate
 * (e.g. its coverage check fails on an extreme aspect ratio), the next
 * canvas-sized template is tried until one builds.
 */
export async function planTemplate(goal, palette, canvas, onProgress = null, opts = {}) {
  const tStart = Date.now();
  const rawPrompt = typeof opts.rawPrompt === "string" ? opts.rawPrompt : "";
  const exclude = typeof opts.exclude === "string" ? opts.exclude : "";
  const forcedTemplate = typeof opts.template === "string" ? opts.template : "";
  const correction = typeof opts.correction === "string" ? opts.correction : "";
  const choice = forcedTemplate
    ? { id: forcedTemplate, candidates: [forcedTemplate], source: "refine" }
    : await chooseTemplate(goal, palette, canvas, onProgress, rawPrompt);
  const ordered = [...new Set([choice.id, ...(choice.candidates || [])].filter(Boolean))];
  const size = sizeClassOf(canvas);
  const sizeFits = TEMPLATES.filter((t) => Array.isArray(t.sizes) && t.sizes.includes(size)).map((t) => t.id);
  let pool = forcedTemplate
    ? [forcedTemplate]
    : [...new Set([...ordered, ...sizeFits, ...TEMPLATES.map((t) => t.id)])];
  if (exclude && !forcedTemplate) {
    const without = pool.filter((id) => id !== exclude);
    if (without.length) pool = without;
  }
  for (const id of pool) {
    const template = findAnyTemplate(id);
    if (!template) continue;
    const tuning = await planTemplateTuning(template, goal, palette, canvas, onProgress, { correction });
    const built = instantiateTemplate(template, tuning, canvas);
    if (!built.ok) {
      console.warn(`[ai] template ${template.id} unusable (${built.reason}) — trying next template`);
      continue;
    }
    // Each image region gets a prompt-grounded Unsplash query: the tuning
    // model may supply one, otherwise the brief's subject anchors it. Tiny
    // models sometimes echo the prompt's placeholder ("2-5 word Unsplash
    // subject"), so only accept something that looks like a real query.
    const usableImageQuery = (value) => {
      const q = String(value || "").replace(/\s+/g, " ").trim();
      if (q.length < 3 || q.length > 64) return "";
      if (/\bunsplash\b|\bsearch terms?\b|\bword\b|<|>/i.test(q)) return "";
      const words = q.split(" ").filter(Boolean);
      if (!words.length || words.length > 8) return "";
      return q;
    };
    const subject = asText(goal?.subject);
    const extraKeyword = (Array.isArray(goal?.keywords) ? goal.keywords : []).find(
      (keyword) => keyword && !subject.toLowerCase().includes(String(keyword).toLowerCase()),
    );
    const briefSubject = [subject, extraKeyword].filter(Boolean).join(" ").trim();
    const components = built.components.map((c) => {
      if (c.kind !== "image") return c;
      const query = usableImageQuery(built.tuning.images?.[c.id]) || briefSubject || c.describe;
      console.log(`[ai] template image ${template.id}/${c.id} query="${query}"`);
      return { ...c, imageQuery: query };
    });
    console.log(
      `[ai] template plan ok ${Date.now() - tStart}ms template=${template.id} variant=${built.tuning.variant} ` +
        `regions=${components.map((c) => c.id).join(",")}`,
    );
    return {
      palette: planPaletteObject(palette),
      style: palette.style || template.label,
      template: template.id,
      templateRef: template,
      tuning: built.tuning,
      components,
      warnings: [],
      source: "template",
    };
  }
  throw new Error("No template could be instantiated for this canvas.");
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
      text = await fetchAiChat(requestPrompt, { schema: PLAN_SCHEMA, name: "oovi_plan", maxTokens: 1500, effort: "medium" });
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
/**
 * The planned box and the planned type size are authoritative, so a region that
 * renders outside them is corrected here rather than shipped (see
 * src/layout/regionFit.js). Logged, never silent.
 */
function fitRegionChecked(elements, component) {
  const { elements: fitted, notes } = fitRegion(elements, component);
  for (const note of notes) console.warn(`[ai] region ${component?.id || "?"}: ${note}`);
  return fitted;
}

/**
 * The last deterministic step for a region: paint text onto its semantic role,
 * then fit it to the reserved box. The role pass is what makes the palette true
 * at the source; L5 correctColors() still runs over the finished design as a
 * safety net (it can see artwork and local backdrops this cannot).
 */
function finishRegion(elements, component, plan, goal = null, rawPrompt = "") {
  const roleFixed = normalizeElementRoles(elements, component?.role || "body");
  const painted = applyRoleFills(roleFixed, component?.role, plan?.palette);
  const copied = sanitizeRegionCopy(painted, component, goal, rawPrompt);
  return fitRegionChecked(copied, component);
}

/**
 * q8 frequently writes a palette ROLE ("textPrimary"), a bare hex
 * ("E8F0FF"), an empty string, or a fragment of the prompt into `fill`.
 * validateDesign rightly rejects those, but rejecting the whole region wastes
 * a multi-minute call. Repair colors to the palette before validation: text
 * is painted by role anyway, and shapes get a safe palette fallback.
 */
const COLOR_ROLE_ALIASES = [
  ["textprimary", "textPrimary"],
  ["secondary text", "textSecondary"],
  ["textsecondary", "textSecondary"],
  ["secondary", "textSecondary"],
  ["muted", "muted"],
  ["ctasurface", "ctaSurface"],
  ["ctatext", "ctaText"],
  ["onaccent", "onAccent"],
  ["background", "background"],
  ["canvas", "background"],
  ["surface", "surface"],
  ["border", "border"],
  ["accent", "accent"],
  ["ink", "textPrimary"],
  ["text", "textPrimary"],
];

function coerceColor(value, roles, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  const direct = normRoleColor(raw);
  if (direct) return direct;
  const lower = raw.toLowerCase();
  for (const [needle, role] of COLOR_ROLE_ALIASES) {
    if (lower.includes(needle)) return roles[role] || fallback;
  }
  const embedded = raw.match(/#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i);
  if (embedded) return normRoleColor(`#${embedded[1]}`) || fallback;
  const bare = raw.match(/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (bare) return normRoleColor(`#${bare[1]}`) || fallback;
  return fallback;
}

function repairElementColors(elements, componentRole, palette) {
  const roles = ensurePaletteRoles(palette);
  const walk = (list) =>
    list.map((element) => {
      if (!element || typeof element !== "object") return element;
      if (element.type === "group" && Array.isArray(element.children)) {
        return { ...element, children: walk(element.children) };
      }
      const out = { ...element };
      if (out.type === "text" || out.type === "rectangle" || out.type === "circle") {
        const fallback =
          out.type === "text"
            ? roles[textRoleFor(out.role || componentRole)] || roles.textPrimary
            : componentRole === "cta"
              ? roles.ctaSurface
              : componentRole === "decoration"
                ? roles.accent
                : roles.accent;
        out.fill = coerceColor(out.fill, roles, fallback);
      }
      if (out.type === "line" || typeof out.stroke === "string") {
        out.stroke = coerceColor(out.stroke, roles, roles.border || roles.textPrimary);
      }
      if (out.gradient && Array.isArray(out.gradient.stops)) {
        out.gradient = {
          ...out.gradient,
          stops: out.gradient.stops.map((stop) => ({
            ...(stop && typeof stop === "object" ? stop : {}),
            color: coerceColor(stop?.color, roles, roles.accent),
          })),
        };
      }
      return out;
    });
  return walk(elements);
}

export async function componentDesign(component, canvas, plan, goal = null, opts = {}) {
  const palette = plan.palette;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const onElement = typeof opts.onElement === "function" ? opts.onElement : null;
  const onStreamStart = typeof opts.onStreamStart === "function" ? opts.onStreamStart : null;
  const correction = typeof opts.correction === "string" ? opts.correction.trim() : "";
  const rawPrompt = typeof opts.rawPrompt === "string" ? opts.rawPrompt.trim() : "";
  if (isMockEnabled()) {
    const elements = mockComponent(component, canvas);
    const check = validateDesign({ canvas, elements });
    if (!check.ok) throw new Error(`Mock component invalid: ${check.errors.slice(0, 2).join("; ")}`);
    return { elements: finishRegion(check.design.elements, component, plan, goal, rawPrompt), source: "mock" };
  }
  const tStart = Date.now();
  console.log(
    `[ai] component start ${component.id} (${component.kind}/${component.role || "?"})${correction ? " [refine]" : ""}`,
  );
  let errors = [];
  let lastParsed = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const base = buildComponentPrompt(component, canvas, plan, goal, rawPrompt);
    const requestPrompt =
      attempt === 1
        ? correction
          ? `${base}\n\n[Correction]\n${correction}`
          : base
        : `${base}\n\n[Correction]\nYour previous response failed (${errors.join("; ")}). Return ONLY {"elements":[...]}.`;
    // Same fail-fast rule as planning: corrections fix bad JSON, not networks.
    // Each attempt gets a fresh scanner and tells the caller to retract
    // anything painted from the previous attempt's partial output.
    onStreamStart?.();
    const scan = onElement ? createElementScanner() : null;
    let text;
    try {
      text = await fetchAiChat(requestPrompt, {
        schema: COMPONENTS_SCHEMA,
        // Template plans carry a slot-specific example that anchors q8 copy.
        // Without a template there is no anchor; the tiny model tends to
        // echo the prompt rules there, so that path stays on the fallback.
        name: plan?.template ? "oovi_component" : "oovi_component_free",
        maxTokens: 800,
        effort: "low",
        onProgress,
        // Chunk development: hand each completed element to the caller as the
        // model writes it, instead of only at the end.
        onPartial: scan
          ? (partial) => {
              for (const element of scan(partial)) onElement(element);
            }
          : null,
      });
    } catch (error) {
      throw new Error(`Component "${component.id}" failed: ${error.message}`);
    }
    const parsed = regexRepairJson(text);
    if (parsed === null || !Array.isArray(parsed.elements)) {
      console.warn(`[ai] component retry ${component.id} attempt=${attempt} errors=unrecoverable JSON`);
      errors = ["unrecoverable JSON"];
      continue;
    }
    // The model sometimes invents an element role ("hidden") or writes a
    // palette role into that field. Normalise before colour repair so the
    // owning region's role remains authoritative.
    const roleFixed = normalizeElementRoles(parsed.elements, component.role);
    // Colors are the #1 q8 failure: it writes role names ("textPrimary"),
    // bare hex ("E8F0FF"), empty strings, or prose into `fill`. Repair to the
    // palette before validation so a color typo cannot discard a good region.
    const prepared = repairElementColors(roleFixed, component.role, palette);
    lastParsed = { ...parsed, elements: prepared };
    const check = validateDesign({ canvas, elements: prepared });
    if (check.ok) {
      // The model sometimes draws a sibling region (usually the CTA) inside
      // this one. Those elements are valid on their own, so validation passes;
      // the fitter then scales the whole set until it becomes unreadable.
      // Keep elements this component owns by id, and drop leaked siblings.
      const owns = (e) => {
        const id = String(e.id || "");
        return id === component.id || id.startsWith(`${component.id}-`) || id.startsWith(`${component.id}_`);
      };
      const owned = check.design.elements.filter(owns);
      let usable = owned.length ? owned : check.design.elements;
      // Decoration is a shape layer. The 270m sometimes puts a sentence in it;
      // the fitter then shrinks that text into an unreadable 7px strip. Drop
      // text there, and if nothing shape-like is left, draw one accent rule.
      if (component.role === "decoration") {
        const shapes = usable.filter((e) => e.type !== "text");
        usable = shapes.length
          ? shapes
          : [
              {
                id: `${component.id}-bar`,
                type: "rectangle",
                x: component.box.x,
                y: component.box.y,
                width: component.box.width,
                height: Math.min(8, component.box.height),
                fill: palette.accent,
              },
            ];
      }
      const finished = finishRegion(usable, component, plan, goal, rawPrompt);
      console.log(
        `[ai] component ok ${component.id} ${Date.now() - tStart}ms attempts=${attempt} elements=${check.design.elements.length}`,
      );
      return { elements: finished, source: "ai" };
    }
    console.warn(
      `[ai] component retry ${component.id} attempt=${attempt} errors=${check.errors.slice(0, 2).join("; ")}`,
    );
    errors = check.errors;
  }
  // Salvage before giving up. The region's elements are ALREADY on the canvas
  // from the token stream — the user watched them arrive — so rejecting the
  // whole set means retracting them and leaving a hole where their content was
  // (and the hole then reads as `empty-section`, which triggers a full
  // ~250 s regeneration). When one bad piece is what failed validation, keep
  // the pieces that are valid on their own: partial content beats an empty
  // region, and the quality gate still checks the result as a whole.
  const salvaged = salvageElements(lastParsed, canvas);
  if (salvaged.length) {
    console.warn(
      `[ai] component salvage ${component.id} ${Date.now() - tStart}ms kept=${salvaged.length}/${lastParsed.elements.length} errors=${errors.slice(0, 2).join("; ")}`,
    );
    return { elements: finishRegion(salvaged, component, plan, goal, rawPrompt), source: "salvage" };
  }
  throw new Error(`Component "${component.id}" failed: ${errors.slice(0, 3).join("; ")}`);
}

/**
 * Keep whichever elements are valid on their own. Validation is run per
 * element, so a set that only failed because of one out-of-bounds or malformed
 * piece still yields everything else.
 */
export function salvageElements(parsed, canvas) {
  const elements = parsed && Array.isArray(parsed.elements) ? parsed.elements : [];
  if (!elements.length) return [];
  const kept = [];
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    try {
      if (validateDesign({ canvas, elements: [element] }).ok) kept.push(element);
    } catch {
      // a malformed element must never take the rest of the region down
    }
  }
  return kept;
}