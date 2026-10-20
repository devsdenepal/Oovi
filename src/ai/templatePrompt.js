/**
 * L3 prompts (Phase 3) — retrieval first, then choice, then bounded tuning.
 *
 * L3 used to show the model EVERY template and ask it to pick one, then tune
 * it. That does not survive a library of ~30 layouts: the menu alone is most
 * of a 1024-token batch on this box, and a flat list spends the model's
 * attention on templates that cannot fit the canvas at all.
 *
 * Now the order is:
 *
 *   1. src/layout/retrieve.js filters by canvas shape and ranks the survivors
 *      against the brief — free, synchronous, deterministic;
 *   2. (a) the model is asked ONLY when the top candidates are close enough to
 *      need judgement, and it sees only the retrieved shortlist;
 *   3. (b) a tuning patch over the chosen template: variant, show/hide
 *      optional regions, +-25% type, alignment, density. Boxes are never
 *      accepted from the model.
 *
 * TEMPLATE_RULES is the STATIC prefix: it names no template, so it is
 * byte-identical on every call and the tuning call reuses the choice call's
 * prefix verbatim. Everything brief-specific — including the retrieved
 * candidates — comes after it, and the retrieved block is last so it sits
 * closest to the model's answer.
 */

import { getTemplate, sizeClassOf, templateSlots } from "../layout/templates";
import { formatGoal } from "./layerPrompt";

export const TEMPLATE_RULES = [
  "[System]",
  "You are the layout director of a design pipeline. The regions of a design are fixed by ONE template; your job is to choose and tune a template, never to invent boxes or coordinates.",
  "Every template already reserves regions for a headline, a supporting line, the facts and a call to action, and every template's boxes are already guaranteed not to overlap.",
  "Choice rules:",
  "- Choose by what the design IS and how much content it must hold — not by taste.",
  "- Prefer the template whose regions match the brief's content blocks: a brief with many facts and a programme wants a listing, a brief that is one sentence wants a statement.",
  "- Answer with one of the candidates offered below.",
  "Tuning rules:",
  "- You may ONLY pick a variant, hide optional regions, scale a region's type by up to a quarter, set a region's text alignment, and choose the overall density.",
  "- Pick the variant whose composition matches the brief's desired arrangement: artwork left vs right, centered vs split, stacked vs grid, the footer's side.",
  '- "hide" may contain ONLY region ids marked optional, and only when the brief has no content for that region.',
  '- "scale" takes one entry per region you want to re-size, factor between three quarters and one and a quarter.',
  '- "align" is left, center or right — use it to resolve a deliberate symmetry, not to scatter. Moving the header/logo to the opposite edge from the hero is a valid deliberate mirror.',
  '- "density" is tight, normal or airy: how much breathing room between regions.',
  "- Change nothing else. An untouched template is a valid answer.",
  "Return ONLY valid JSON — no prose and no markdown.",
].join("\n");

export const TUNING_SCHEMA = {
  type: "object",
  properties: {
    variant: { type: "string" },
    density: { type: "string", enum: ["tight", "normal", "airy"] },
    hide: { type: "array", items: { type: "string" } },
    scale: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, factor: { type: "number" } },
        required: ["id", "factor"],
        additionalProperties: false,
      },
    },
    align: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, value: { type: "string", enum: ["left", "center", "right"] } },
        required: ["id", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["variant", "density", "hide", "scale", "align"],
  additionalProperties: false,
};

/**
 * The choice is constrained to the shortlist, not to the whole library: the
 * enum is what the grammar will actually accept, so the model cannot answer
 * with an id retrieval ruled out for this canvas shape.
 */
export function templateChoiceSchema(candidates) {
  const ids = (candidates || []).map((c) => (typeof c === "string" ? c : c.id)).filter(Boolean);
  return {
    type: "object",
    properties: {
      template: ids.length ? { type: "string", enum: ids } : { type: "string" },
      why: { type: "string" },
    },
    required: ["template", "why"],
    additionalProperties: false,
  };
}

function paletteLine(palette) {
  if (!palette) return "";
  return `Palette: background ${palette.background}, ink ${palette.ink}, accent ${palette.accent}. Theme: ${palette.style || "clean modern"}.`;
}

/** The retrieved shortlist, rendered last so it sits beside the answer. */
function candidateBlock(retrieved) {
  const lines = (retrieved || [])
    .map((entry) => {
      const template = getTemplate(typeof entry === "string" ? entry : entry.id);
      if (!template) return "";
      const variants = (template.variants || []).map((v) => v.id).join(", ");
      return `- ${template.id} (${template.type}, ${template.density} density; variants: ${variants}): ${template.blurb}. ${template.description}`;
    })
    .filter(Boolean);
  return lines.length ? ["Candidates, best match first:", ...lines].join("\n") : "";
}

/**
 * Step (a): choose one template from the retrieved shortlist.
 * @param {Array<string|{id:string,score:number,coverage:number}>} retrieved
 */
export function buildTemplateChoicePrompt(goal, palette, canvas, retrieved) {
  return [
    TEMPLATE_RULES,
    "",
    "Your task now: choose the ONE template that best fits this design.",
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height} pixels (${sizeClassOf(canvas)} shape).`,
    paletteLine(palette),
    "The brief:",
    formatGoal(goal),
    candidateBlock(retrieved),
    'Return ONLY valid JSON: {"template":"<id>","why":"five words"}.',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Step (b): the bounded knobs for the chosen template. The region list is
 * deliberately short — id, role, and what the region holds.
 */
export function buildTuningPrompt(template, goal, palette, canvas) {
  const variantList = template.variants.map((v) => `- ${v.id}: ${v.label}`).join("\n");
  const slotList = templateSlots(template)
    .map((s) => `- ${s.id} (${s.role}${s.optional ? ", optional" : ""}): ${s.describe}`)
    .join("\n");
  return [
    TEMPLATE_RULES,
    "",
    `Your task now: tune the chosen template "${template.id}" (${template.blurb}) for this design.`,
    `Variants:\n${variantList}`,
    `Regions:\n${slotList}`,
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height} pixels.`,
    paletteLine(palette),
    "The brief:",
    formatGoal(goal),
    'Return ONLY valid JSON: {"variant":"<id>","density":"normal","hide":[],"scale":[{"id":"<region>","factor":1}],"align":[{"id":"<region>","value":"left"}]}.',
  ].join("\n");
}
