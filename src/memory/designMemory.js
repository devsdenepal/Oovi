/**
 * Per-design model memory.
 *
 * This is deliberately NOT a generic chat-memory layer. It stores the compact,
 * authoritative facts a design pipeline needs after a reload or a follow-up
 * edit: the brief, the model's scope answer, the chosen template/palette, the
 * approved copy, image intent, and the exact content words already used.
 *
 * Storage lives in Postgres (`designs.ai_memory`); this module is pure so it can
 * be tested without a browser or database. The rendered design remains the
 * source of truth: copy and usedWords are recomputed from it on every save.
 */

import { collectTextElements, distinctiveWords, textElementsUnder } from "../ai/copySanitize";
import { FEATURES } from "../config/features";

export const DESIGN_MEMORY_VERSION = FEATURES.memory.version;
const MAX_EDITS = FEATURES.memory.maxEdits;
const MAX_IMAGES = FEATURES.memory.maxImages;
const MAX_LINES_PER_REGION = FEATURES.memory.maxLinesPerRegion;
const MAX_LINE_CHARS = FEATURES.memory.maxLineChars;

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

function text(value, cap = 500) {
  return typeof value === "string" ? value.trim().slice(0, cap) : "";
}

function stringList(value, cap = 12, itemCap = 120) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim().slice(0, itemCap))
    .slice(0, cap);
}

function compactGoal(raw) {
  if (!isObject(raw)) return {};
  return {
    summary: text(raw.summary, 700),
    subject: text(raw.subject, 240),
    brand: text(raw.brand, 160),
    audience: text(raw.audience, 220),
    purpose: text(raw.purpose, 220),
    tone: text(raw.tone, 220),
    designType: text(raw.designType, 80),
    industry: text(raw.industry, 120),
    keywords: stringList(raw.keywords, 8, 60),
    composition: text(raw.composition, 80),
    imageSubject: text(raw.imageSubject, 300),
    mustInclude: stringList(raw.mustInclude, 10, 160),
    avoid: stringList(raw.avoid, 10, 160),
    style: text(raw.style, 220),
  };
}

function compactTemplate(plan) {
  if (!isObject(plan)) return {};
  // Accept both a full plan ({template, tuning:{variant,density,tuning}}) and
  // an already-normalized memory template ({id,variant,density,tuning}).
  const fromPlan = typeof plan.template === "string";
  const wrapper = isObject(plan.tuning) ? plan.tuning : {};
  return {
    id: text(fromPlan ? plan.template : plan.id, 100),
    variant: text(fromPlan ? wrapper.variant : plan.variant, 60),
    density: text(fromPlan ? wrapper.density : plan.density, 40),
    tuning: isObject(fromPlan ? wrapper.tuning : plan.tuning)
      ? (fromPlan ? wrapper.tuning : plan.tuning)
      : null,
  };
}

function compactPalette(palette) {
  if (!isObject(palette)) return {};
  return {
    id: text(palette.id, 100),
    name: text(palette.name, 120),
    style: text(palette.style, 160),
    background: text(palette.background, 24),
    ink: text(palette.ink, 24),
    accent: text(palette.accent, 24),
    roles: isObject(palette.roles) ? palette.roles : undefined,
  };
}

function compactQuality(report) {
  if (!isObject(report)) return null;
  return {
    score: Number.isFinite(Number(report.score)) ? Number(report.score) : 0,
    issues: Array.isArray(report.issues)
      ? report.issues.slice(0, 12).map((issue) => ({
          severity: text(issue?.severity, 20),
          code: text(issue?.code, 60),
          message: text(issue?.message, 220),
        }))
      : [],
  };
}

function compactRegions(plan, regions) {
  const out = {};
  const list = Array.isArray(plan?.components) ? plan.components : [];
  const lookup = (id) => {
    if (regions instanceof Map) return regions.get(id);
    return isObject(regions) ? regions[id] : null;
  };
  for (const component of list) {
    if (!component || typeof component.id !== "string" || !component.id) continue;
    const rendered = lookup(component.id);
    out[component.id] = {
      kind: text(component.kind, 40),
      role: text(component.role, 40),
      describe: text(component.describe, 240),
      elementIds: Array.isArray(rendered?.ids)
        ? rendered.ids.filter((id) => typeof id === "string").slice(0, 80)
        : [],
      lines: [],
      text: "",
    };
  }
  return out;
}

function compactImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .slice(0, MAX_IMAGES)
    .map((image) => {
      if (!isObject(image)) return null;
      return {
        region: text(image.region, 100),
        query: text(image.query, 300),
        source: text(image.source, 160),
        photographer: text(image.photographer, 160),
      };
    })
    .filter(Boolean);
}

function normalizeEdits(edits) {
  if (!Array.isArray(edits)) return [];
  return edits
    .slice(-MAX_EDITS)
    .map((edit) => {
      if (!isObject(edit)) return null;
      return {
        at: text(edit.at, 40),
        request: text(edit.request, 500),
        source: text(edit.source, 40),
        changedIds: stringList(edit.changedIds, 20, 100),
      };
    })
    .filter((edit) => edit && (edit.request || edit.changedIds.length));
}

function normalizeCopy(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [id, lines] of Object.entries(raw)) {
    if (!id) continue;
    const clean = stringList(lines, MAX_LINES_PER_REGION, MAX_LINE_CHARS);
    if (clean.length) out[id] = clean;
  }
  return out;
}

function parseMemory(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return isObject(value) ? value : null;
}

/**
 * Upgrade older memory payloads before normalization. New schema versions add
 * a case here; callers never need to know which version the row came from.
 */
export function migrateDesignMemory(raw) {
  const value = parseMemory(raw);
  if (!value) return null;
  const version = Number(value.version) || 0;
  if (version > DESIGN_MEMORY_VERSION) {
    // A newer app wrote this row. Keep the known fields; do not invent or
    // destroy fields we do not understand until a migration exists.
    return value;
  }
  let next = value;
  if (version < 1) {
    next = {
      ...next,
      version: 1,
      goal: isObject(next.goal) ? next.goal : next.scope || next.goal || {},
      usedWords: next.usedWords || next.used_words || next.copyLedger || [],
      template:
        typeof next.template === "string"
          ? { id: next.template }
          : next.template || next.layout || {},
      images: next.images || next.assets || [],
      updatedAt: next.updatedAt || next.updated_at || new Date().toISOString(),
    };
  }
  return next;
}

/**
 * Normalize a value returned by the API, a draft, or a previous version.
 * Unknown fields are dropped; oversized values are capped.
 */
export function normalizeDesignMemory(raw) {
  const value = migrateDesignMemory(raw);
  if (!value) return emptyDesignMemory();
  return {
    version: DESIGN_MEMORY_VERSION,
    brief: text(value.brief, 1200),
    goal: compactGoal(value.goal),
    template: compactTemplate(value.template),
    palette: compactPalette(value.palette),
    regions: normalizeRegions(value.regions),
    copy: normalizeCopy(value.copy),
    usedWords: stringList(value.usedWords, FEATURES.memory.maxUsedWords, 80)
      .map((word) => word.toLowerCase())
      .filter((word, index, list) => list.indexOf(word) === index)
      .sort(),
    images: compactImages(value.images),
    edits: normalizeEdits(value.edits),
    quality: compactQuality(value.quality),
    updatedAt: text(value.updatedAt, 40) || new Date().toISOString(),
  };
}

function normalizeRegions(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [id, region] of Object.entries(raw)) {
    if (!id || !isObject(region)) continue;
    out[id] = {
      kind: text(region.kind, 40),
      role: text(region.role, 40),
      describe: text(region.describe, 240),
      elementIds: stringList(region.elementIds, 80, 100),
      lines: stringList(region.lines, MAX_LINES_PER_REGION, MAX_LINE_CHARS),
      text: text(region.text, 2000),
    };
  }
  return out;
}

/** True when there is enough saved context to be worth putting in a prompt. */
export function hasDesignMemory(memory) {
  const value = normalizeDesignMemory(memory);
  return Boolean(
    value.brief ||
      value.goal?.summary ||
      value.goal?.brand ||
      value.goal?.imageSubject ||
      value.usedWords?.length ||
      Object.keys(value.copy || {}).length,
  );
}

export function emptyDesignMemory() {
  return {
    version: DESIGN_MEMORY_VERSION,
    brief: "",
    goal: {},
    template: {},
    palette: {},
    regions: {},
    copy: {},
    usedWords: [],
    images: [],
    edits: [],
    quality: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Recompute the copy ledger from the rendered design. This is the only place
 * `copy` and `usedWords` are allowed to become authoritative: a model can
 * propose anything, but what actually rendered is what may repeat-vs-not.
 */
export function syncMemoryCopy(memory, design) {
  const base = normalizeDesignMemory(memory);
  const elements = Array.isArray(design?.elements) ? design.elements : [];
  const allTexts = collectTextElements(elements);
  const allIds = new Set();
  const indexIds = (list) => {
    for (const element of list || []) {
      if (!element || typeof element !== "object") continue;
      if (typeof element.id === "string") allIds.add(element.id);
      if (element.type === "group" && Array.isArray(element.children)) indexIds(element.children);
    }
  };
  indexIds(elements);
  const regions = { ...base.regions };
  const owned = new Set();

  for (const [id, region] of Object.entries(regions)) {
    const elementIds = (region.elementIds || []).filter((elementId) => allIds.has(elementId));
    const lines = textElementsUnder(design, elementIds)
      .map((entry) => entry.text.slice(0, MAX_LINE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_LINES_PER_REGION);
    regions[id] = {
      ...region,
      elementIds,
      lines,
      text: lines.join("\n").slice(0, 2000),
    };
    for (const entry of textElementsUnder(design, elementIds)) owned.add(entry.id);
  }

  // Text the memory does not own — a manual insert or an assistant-added line —
  // still enters the ledger. Treat each such element as its own region so the
  // no-repeat gate can see it without inventing a semantic role.
  for (const entry of allTexts) {
    if (owned.has(entry.id)) continue;
    const id = `manual-${entry.id}`;
    const lines = [entry.text.slice(0, MAX_LINE_CHARS)];
    regions[id] = {
      kind: "dsl",
      role: "",
      describe: "",
      elementIds: [entry.id],
      lines,
      text: lines[0],
    };
  }

  const copy = {};
  for (const [id, region] of Object.entries(regions)) {
    if (region.lines?.length) copy[id] = region.lines;
  }
  const usedWords = [
    ...new Set(allTexts.flatMap((entry) => distinctiveWords(entry.text))),
  ]
    .sort()
    .slice(0, FEATURES.memory.maxUsedWords);

  const next = { ...base, regions, copy, usedWords };
  const before = JSON.stringify({ ...base, updatedAt: undefined });
  const after = JSON.stringify({ ...next, updatedAt: undefined });
  if (before !== after) next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * Build memory after an approved generation. `regions` is the renderer's
 * per-region ownership map; `plan` supplies template/palette/region metadata.
 */
export function createDesignMemory({
  brief = "",
  goal = null,
  plan = null,
  design = null,
  regions = null,
  images = [],
  quality = null,
} = {}) {
  const base = normalizeDesignMemory({
    version: DESIGN_MEMORY_VERSION,
    brief,
    goal: compactGoal(goal),
    template: compactTemplate(plan),
    palette: compactPalette(plan?.palette),
    regions: compactRegions(plan, regions),
    images: compactImages(images),
    quality: compactQuality(quality),
    edits: [],
    updatedAt: new Date().toISOString(),
  });
  return syncMemoryCopy(base, design);
}

/** A bounded, prompt-safe projection. Never include full element geometry. */
export function memoryForPrompt(memory, maxChars = FEATURES.memory.promptChars) {
  const value = normalizeDesignMemory(memory);
  const copy = {};
  for (const [id, lines] of Object.entries(value.copy).slice(0, 16)) {
    copy[id] = lines.slice(0, 4).map((line) => line.slice(0, 120));
  }
  const payload = {
    brief: value.brief.slice(0, 500),
    goal: value.goal,
    template: value.template,
    palette: value.palette,
    copy,
    usedWords: value.usedWords.slice(0, 80),
    edits: value.edits.slice(-5).map((edit) => edit.request),
  };
  let text = JSON.stringify(payload, null, 1);
  if (text.length <= maxChars) return text;
  // Shrink the least useful fields first; never return invalid JSON.
  payload.usedWords = payload.usedWords.slice(0, 40);
  for (const id of Object.keys(payload.copy)) payload.copy[id] = payload.copy[id].slice(0, 2);
  text = JSON.stringify(payload, null, 1);
  if (text.length <= maxChars) return text;
  payload.brief = payload.brief.slice(0, 240);
  payload.goal = { summary: String(payload.goal?.summary || "").slice(0, 240) };
  payload.template = {};
  payload.copy = {};
  payload.usedWords = [];
  payload.edits = [];
  text = JSON.stringify(payload, null, 1);
  if (text.length <= maxChars) return text;
  // Last resort: a tiny but valid JSON object. Never slice serialized JSON —
  // a half object is worse than no context because the prompt becomes
  // syntactically ambiguous to the model.
  return "{}";
}

export function recordMemoryEdit(memory, { request = "", source = "", changedIds = [] } = {}) {
  const base = normalizeDesignMemory(memory);
  const edits = [
    ...base.edits,
    {
      at: new Date().toISOString(),
      request: text(request, 500),
      source: text(source, 40),
      changedIds: stringList(changedIds, 20, 100),
    },
  ].slice(-MAX_EDITS);
  return { ...base, edits, updatedAt: new Date().toISOString() };
}

/** Stable key for persist dedupe: timestamps must not trigger a write loop. */
export function memoryPersistKey(memory) {
  const value = normalizeDesignMemory(memory);
  const { updatedAt, ...rest } = value;
  return JSON.stringify(rest);
}
