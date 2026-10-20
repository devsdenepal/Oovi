/**
 * Save as template (Phase 3, step 5).
 *
 * A finished design already contains the one thing a hand-written template is
 * guessing at: a real, checked arrangement of regions on a real canvas. This
 * turns that back into a template — slots, boxes, roles, type sizes and the
 * design's own copy as example lines — so a layout the user liked can be
 * reused deliberately instead of being re-described to the model.
 *
 * Two rules make it safe to put user layouts into the same library the
 * hand-written ones live in:
 *
 *   1. boxes come from the RENDERED design, so the partition is real;
 *   2. the result must clear the SAME quality gate the test suite runs every
 *      template through (src/ai/quality.js) — a saved template that would
 *      overflow, collide or fade is refused with the reasons, not stored.
 *
 * Pure: no Fabric, no network, no localStorage. The store is separate.
 */

import { elementBoxes, evaluateDesign } from "../ai/quality";
import { SIZE_FACTORS } from "./typeScale";
import { instantiateTemplate, sizeClassOf } from "./templates";
import { materializePlan } from "./materialize";
import { ensurePaletteRoles } from "./paletteRoles";

/** Fallback palette for validation when the caller has none to hand. */
const DEFAULT_PALETTE = { background: "#FFFFFF", ink: "#111111", accent: "#E02020" };

/** A slot count above this makes L4 (one call per region) unaffordable. */
const MAX_SLOTS = 12;

function sizeTokenFor(px, height) {
  const size = Number(px) || 0;
  if (!(height > 0) || !(size > 0)) return "body";
  let best = "body";
  let bestDist = Infinity;
  for (const [token, factor] of Object.entries(SIZE_FACTORS)) {
    const distance = Math.abs(size - height * factor);
    if (distance < bestDist) {
      bestDist = distance;
      best = token;
    }
  }
  return best;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * True when two boxes are two runs of the same visual line: their vertical
 * ranges overlap and they start at the same left edge. That is how a headline
 * split into per-colour runs becomes one slot instead of four.
 */
function sameLine(a, b) {
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapY > 0.5 * Math.min(a.h, b.h) && Math.abs(a.x - b.x) <= 8;
}

function textOf(element) {
  if (!element || typeof element !== "object") return [];
  if (element.type === "text" && typeof element.content === "string") return [element.content];
  if (Array.isArray(element.children)) return element.children.flatMap(textOf);
  return [];
}

/**
 * Convert a rendered design into a template.
 *
 * @param {{canvas:{width:number,height:number},elements:Array}} design
 * @param {{id?:string,label?:string,type?:string,mood?:string[],density?:string,tags?:string[],description?:string,keywords?:string[]}} [meta]
 * @returns {{ok:true,template:object,issues:Array}|{ok:false,reason:string,issues?:Array}}
 */
export function designToTemplate(design, meta = {}) {
  const canvas = design?.canvas || {};
  const W = Number(canvas.width) || 0;
  const H = Number(canvas.height) || 0;
  if (!(W > 0) || !(H > 0)) return { ok: false, reason: "the design has no canvas size" };

  const boxes = elementBoxes(design.elements).filter((b) => b.role && b.role !== "decoration");
  if (boxes.length < 3) return { ok: false, reason: "a template needs at least three regions" };

  // Text and image boxes become slots; unroled shapes do not, because a bar
  // the model drew as a text bed is a rendering detail, not structure — and
  // dropping it can only make the contrast check stricter, never looser.
  const items = [];
  for (const b of boxes) {
    if (b.kind !== "text" && b.kind !== "image") continue;
    const source = (design.elements || []).find((el) => el && el.id === b.id);
    const texts = textOf(source);
    items.push({
      role: b.role,
      kind: b.kind === "image" ? "image" : "dsl",
      asset: b.kind === "image" ? source?.asset || "illustration" : "none",
      box: { ...b.box },
      texts,
      fontSize: Number(b.fontSize) || 0,
      align: source?.textAlign || source?.align || "left",
    });
  }
  if (items.length < 3) return { ok: false, reason: "the design has no reusable text or image regions" };

  // Merge runs that are really one line, then keep roles unique by id.
  items.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const merged = [];
  for (const item of items) {
    const host = merged.find((m) => m.role === item.role && m.kind === item.kind && sameLine(m.box, item.box));
    if (host) {
      host.box = union(host.box, item.box);
      host.texts.push(...item.texts);
      host.fontSize = Math.max(host.fontSize, item.fontSize);
      continue;
    }
    merged.push({ ...item, box: { ...item.box }, texts: [...item.texts] });
  }

  const decorations = elementBoxes(design.elements).filter((b) => b.role === "decoration");
  const slots = [];
  const roleCounts = new Map();
  for (const item of merged.slice(0, decorations.length ? MAX_SLOTS - 1 : MAX_SLOTS)) {
    const seen = (roleCounts.get(item.role) || 0) + 1;
    roleCounts.set(item.role, seen);
    const id = seen === 1 ? `${item.role}-saved` : `${item.role}-saved-${seen}`;
    // Remember which slot this item became, so its own copy lands on its own
    // slot below: two `sections` regions must not both take the first one's
    // example (the second region would silently get the wrong one-shot).
    item.slotId = id;
    const longest = item.texts.reduce((max, t) => Math.max(max, String(t).length), 0);
    slots.push({
      id,
      role: item.role,
      box: { x: item.box.x / W, y: item.box.y / H, w: item.box.w / W, h: item.box.h / H },
      kind: item.kind,
      asset: item.asset,
      optional: item.role === "tagline" || item.role === "audience" || item.role === "cta",
      size: sizeTokenFor(item.fontSize, H),
      align: ["left", "center", "right"].includes(item.align) ? item.align : "left",
      maxChars: item.kind === "image" ? 0 : Math.max(8, Math.round(longest * 1.15)),
      describe: item.texts.length
        ? `the region that held "${String(item.texts[0]).slice(0, 40)}"`
        : "the artwork region from the saved design",
    });
  }

  if (decorations.length) {
    const d = decorations.reduce((acc, b) => (acc ? union(acc, b.box) : { ...b.box }), null);
    slots.push({
      id: "decoration-accent",
      role: "decoration",
      box: { x: d.x / W, y: d.y / H, w: d.w / W, h: d.h / H },
      kind: "dsl",
      asset: "none",
      optional: true,
      size: "small",
      align: "left",
      maxChars: 0,
      describe: "the accent shapes from the saved design",
    });
  }

  const examples = {};
  for (const item of merged) {
    if (!item.slotId || !item.texts.length) continue;
    const best = item.texts.reduce((a, b) => (String(b).length > String(a).length ? b : a), "");
    if (best) examples[item.slotId] = [best];
  }

  const template = {
    id: meta.id || `saved-${Math.abs(hash(`${W}x${H}:${slots.map((s) => s.id + s.box.x.toFixed(3)).join("|")}`))}`,
    label: meta.label || "Saved layout",
    blurb: meta.blurb || "a layout saved from a finished design",
    type: meta.type || "poster",
    mood: Array.isArray(meta.mood) && meta.mood.length ? meta.mood : ["custom"],
    density: ["airy", "normal", "dense"].includes(meta.density) ? meta.density : "normal",
    tags: Array.isArray(meta.tags) && meta.tags.length ? meta.tags : ["saved"],
    description:
      meta.description ||
      `A layout saved from a finished ${W}x${H} design: ${slots.filter((s) => s.role !== "decoration").length} regions, reused as-is.`,
    sizes: [sizeClassOf(canvas)],
    keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
    variants: [{ id: "as-saved", label: "as saved" }],
    build: () => slots.map((s) => ({ ...s, box: { ...s.box } })),
    examples,
    saved: true,
  };
  return { ok: true, template, issues: [] };
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

/**
 * The palette a saved design actually uses: its canvas background, its most
 * common text colour as ink, and its most common other fill as accent. Without
 * this a dark design would be validated against a default black-on-white
 * palette and refused for a contrast failure it does not have.
 */
export function paletteFromDesign(design) {
  const boxes = elementBoxes(design?.elements || []);
  const counts = new Map();
  for (const b of boxes) {
    if (!b.fill || typeof b.fill !== "string") continue;
    const key = b.fill.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + (b.kind === "text" ? 3 : 1));
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([fill]) => fill);
  const background = design?.canvas?.background || "#FFFFFF";
  const ink = ranked.find((c) => c !== background.toLowerCase()) || "#111111";
  const accent = ranked.find((c) => c !== background.toLowerCase() && c !== ink) || "#E02020";
  // A saved design's palette is re-used downstream (L4 role prompt, L5
  // correction, the gate). Carry the derived role set with it so a template
  // saved from a finished design behaves exactly like a library palette.
  return { background, ink, accent, roles: ensurePaletteRoles({ background, ink, accent }) };
}

/**
 * Run a template through the real quality gate: instantiate it, render the
 * worst-case fill, and demand zero ERRORS (warnings are advisory).
 */
export function validateTemplate(template, canvas, palette = DEFAULT_PALETTE) {
  const built = instantiateTemplate(template, {}, canvas);
  if (!built.ok) return { ok: false, reason: built.reason, issues: [] };
  const design = materializePlan(built.components, canvas, palette);
  const report = evaluateDesign(design, {
    palette,
    expectHero: built.components.some((c) => c.kind === "image"),
  });
  const errors = report.issues.filter((i) => i.severity === "error");
  return {
    ok: errors.length === 0,
    reason: errors.map((e) => `${e.code}: ${e.message}`).join("; "),
    issues: report.issues,
    components: built.components,
  };
}

/**
 * The whole path: design → template → quality gate. Refuses (with reasons)
 * rather than storing a layout that would render badly.
 */
export function templateFromDesign(design, meta = {}) {
  const converted = designToTemplate(design, meta);
  if (!converted.ok) return converted;
  const palette = meta.palette || paletteFromDesign(design);
  const check = validateTemplate(converted.template, design.canvas, palette);
  if (!check.ok) {
    return {
      ok: false,
      reason: `the saved layout does not pass the quality gate — ${check.reason}`,
      template: converted.template,
      issues: check.issues,
    };
  }
  return { ok: true, template: converted.template, issues: check.issues };
}

/** Serialisable form (a template carries a build function; storage cannot). */
export function templateToRecord(template) {
  return {
    id: template.id,
    label: template.label,
    blurb: template.blurb,
    type: template.type,
    mood: template.mood,
    density: template.density,
    tags: template.tags,
    description: template.description,
    sizes: template.sizes,
    keywords: template.keywords,
    variants: template.variants,
    examples: template.examples || {},
    slots: template.build(template.variants[0].id, 0.025),
  };
}

/** Rehydrate a stored record back into a usable template. */
export function templateFromRecord(record) {
  if (!record || !Array.isArray(record.slots) || !record.slots.length) return null;
  const slots = record.slots.map((s) => ({ ...s, box: { ...s.box } }));
  return {
    ...record,
    variants: Array.isArray(record.variants) && record.variants.length ? record.variants : [{ id: "as-saved", label: "as saved" }],
    build: () => slots.map((s) => ({ ...s, box: { ...s.box } })),
    examples: record.examples || {},
    saved: true,
  };
}
