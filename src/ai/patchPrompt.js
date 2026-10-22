/**
 * Patch prompt (Goal 4): asks the model for a PATCH against the live
 * design | changed props only | never a full redesign.
 */

import { hasDesignMemory, memoryForPrompt } from "../memory/designMemory";
import { FEATURES } from "../config/features";

const OP_DOCS = [
  '{"op":"update","id":"headline","props":{"fontSize":72}}',
  '{"op":"add","element":{"id":"badge","type":"circle","x":900,"y":80,"radius":40,"fill":"#4F46E5"}}',
  '{"op":"remove","id":"old-footer"}',
  '{"op":"move","id":"cta","to":"front"}  // front|forward|backward|back',
].join("\n");

/** Slim the design for the prompt: identity + geometry + paint only. */
function slimDesign(design) {
  const slim = {
    canvas: design.canvas,
    elements: (design.elements || []).map((e) => {
      const keep = { id: e.id, type: e.type };
      for (const k of ["role", "x", "y", "width", "height", "radius", "fontSize", "fill", "locked", "visible"]) {
        if (e[k] !== undefined) keep[k] = e[k];
      }
      return keep;
    }),
  };
  return JSON.stringify(slim).slice(0, 8000);
}

export function buildPatchPrompt(message, design, selectedIds = [], memory = null) {
  const locked = (design.elements || []).filter((e) => e.locked === true).map((e) => e.id);
  const prior = hasDesignMemory(memory)
    ? memoryForPrompt(memory, FEATURES.memory.assistantMemoryChars)
    : "";
  const memoryBlock = prior
    ? [
        "",
        "[Design memory]",
        prior,
        "This memory is authoritative context for the saved design. Copy keys are region names, not element ids; use the [Design] section for ids.",
        "Do not introduce a content word already used in another region, including the brand and occasion words. If the request adds or rewrites text, use different words.",
      ].join("\n")
    : "";
  return [
    "[System]",
    "You are a design-editing assistant. Return ONLY a JSON patch object.",
    "",
    "Allowed ops (changed props only, never full elements except add):",
    OP_DOCS,
    "",
    `Editable props: x, y, width, height, radius, angle, opacity, content, fontSize (4-400), fontWeight, fontFamily, textAlign, lineHeight, charSpacing, fill, stroke, strokeWidth, cornerRadius.`,
    `Coordinates are pixels on a ${design.canvas.width}x${design.canvas.height} canvas. Keep x/y >= 0 and sizes inside the canvas.`,
    locked.length ? `Locked (never touch): ${locked.join(", ")}.` : "Nothing is locked.",
    selectedIds.length ? `User selection: ${selectedIds.join(", ")} | prefer editing these.` : "No selection | infer the target from the request.",
    "Max 20 ops. Unknown ids fail validation, so only use ids from the design below.",
    memoryBlock,
    "",
    "[Design]",
    slimDesign(design),
    "",
    "[Request]",
    message,
    "",
    "Rules: return ONLY valid JSON like {\"ops\":[...]}. No Markdown, no fences, no commentary.",
  ].join("\n");
}
