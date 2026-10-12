import {
  ALIGN_VALUES,
  DIRECTION_VALUES,
  JUSTIFY_VALUES,
  MAX_SEMANTIC_ELEMENTS,
  ROLE_VALUES,
  SEMANTIC_ELEMENT_TYPES,
} from "../layout/semanticTypes";

/**
 * Semantic DSL prompt builder.
 *
 * The semantic prompt instructs the model to describe WHAT a design contains
 * (roles, containers, relative sizes) and NEVER pixel coordinates. A separate
 * layout engine turns the output into the pixel Design JSON.
 *
 * When a reference analysis is supplied, a [Reference] block is appended so
 * the model can borrow the reference's visual language (palette, composition,
 * type scale, decorations) while always using the user's new content.
 */

const sizeTokens = ["display", "headline", "title", "subtitle", "body", "caption", "small"];

export function buildSemanticSystemInstruction() {
  return [
    "You are a graphic design layout engine that composes SEMANTIC designs.",
    "You describe WHAT a design contains and its relative proportions - NEVER pixel coordinates.",
    "A separate layout engine converts your semantic design into exact x/y/w/h pixels on canvas.",
    "",
    'Return JSON with this shape:',
    '{"canvas":{"width":1080,"height":1080,"background":"#FAF7F2"},"containers":[...],"elements":[...],"layout":{"direction":"vertical","gap":32,"padding":48}}',
    "",
    'canvas: width/height in px (default 1080x1080), background a valid CSS color.',
    "",
    'containers: the building blocks that place elements.',
    '  - id: lowercase, unique, no spaces',
    '  - direction: "vertical" | "horizontal" (default vertical)',
    '  - justify (main axis): "start" | "center" | "end" | "between" | "around"',
    '  - align (cross axis): "start" | "center" | "end" | "stretch" (default stretch)',
    "  - gap: px between children; padding: px or {top,right,bottom,left}; margin: px",
    '  - width / height: px number | "50%".."100%" (relative to the PARENT) | "fit-content" | "auto"',
    "  - children: element ids placed in this container, in flow order",
    "",
    "elements: the content pieces. Every element needs an id (lowercase, unique), type, role and container.",
    `  - types: ${SEMANTIC_ELEMENT_TYPES.join(" | ")}`,
    `  - roles (pick the most specific): ${ROLE_VALUES.join(" | ")}`,
    "  - container: the container id that places this element (omit for the canvas root)",
    "  - width / height: same tokens as containers; fit-content wraps text/buttons naturally",
    "  - content: the text string for text/button elements - always write real copy matching the user's request",
    '  - fit: "cover" | "contain" for images',
    "  - style: { size, fontSize, weight, color, family, alignment, lineHeight, cornerRadius, fill, aspectRatio }",
    `    size: ${sizeTokens.join(" | ")} (the engine scales these relative to the canvas)`,
    "    weight: 100-900 or light/regular/medium/bold/extrabold",
    "    color / fill: CSS colors; alignment: left | center | right",
    "",
    "Guidelines:",
    "  - Compose with containers: a header band, a main split (text column + visual column), a footer band.",
    `  - Use 8 to ${Math.min(28, MAX_SEMANTIC_ELEMENTS)} elements total. Keep it intentional, minimal and balanced.`,
    "  - Percent widths inside a horizontal parent should sum to ~100% (plus gaps).",
    "  - Never include x/y coordinates, angles, strokes or dash patterns.",
    "  - Buttons are type \"button\" with content. Images are type \"image\" (keep to 1-2; they render as placeholders).",
    "  - Use the size tokens for a clear type hierarchy: display → headline/title → body → caption.",
    '  - Background should be a calm, valid CSS color.',
    "",
    "Return ONLY valid JSON.",
    "No Markdown, no code fences, no comments, no explanation.",
  ].join("\n");
}

function influenceWord(influence) {
  if (influence >= 0.85) return "reproduce";
  if (influence >= 0.6) return "strongly follow";
  if (influence >= 0.35) return "borrow the visual spirit of";
  return "lightly hint at";
}

/**
 * Builds the [Reference] guide from a ReferenceDesignAnalysis. Describes the
 * reference's visual language in semantic terms the model can act on.
 *
 * @param {import("../reference/analysisTypes").ReferenceDesignAnalysis} analysis
 * @param {number} influence 0..1
 */
export function buildSemanticReferenceGuide(analysis, influence = 1) {
  const { canvas, palette, layout, typography, elements, ocr } = analysis;
  const lines = [];
  lines.push(
    `A reference design was analyzed. ${influenceWord(influence).charAt(0).toUpperCase() + influenceWord(influence).slice(1)} its visual language:`,
  );
  lines.push(`  Canvas: ${canvas.width}x${canvas.height}px (aspect ratio ${canvas.aspectRatio.toFixed(2)}).`);
  lines.push(
    `  Palette: background ${palette.background} (${palette.isLight ? "light" : "dark"}), primary ${palette.primary}, accent ${palette.accent}, text ${palette.text}, subtext ${palette.subtext}${
      palette.dominant.length ? `; also: ${palette.dominant.slice(0, 4).map((d) => d.hex).join(", ")}` : ""
    }.`,
  );
  lines.push(
    `  Composition: ${layout.type.replace(/_/g, " ")} layout, ${layout.bands} horizontal band(s), ${layout.alignment}-aligned. Regions: ${
      layout.regions.length
        ? layout.regions
            .map((r) => `${r.role} ${Math.round(r.relativeWidth * 100)}%w x ${Math.round(r.relativeHeight * 100)}%h`)
            .join(", ")
        : "none"
    }.`,
  );
  if (typography.hierarchy.length) {
    const scaleOf =
      (fs) => (fs / Math.max(1, canvas.height));
    const labelOf = (r) => (r >= 0.08 ? "display" : r >= 0.055 ? "headline" : r >= 0.035 ? "title" : r >= 0.02 ? "body" : "caption");
    lines.push(
      `  Typography hierarchy: ${typography.hierarchy
        .map((h) => `${h.role} ≈ ${Math.round(scaleOf(h.estimatedFontSize) * 100)}% of canvas height → "${labelOf(scaleOf(h.estimatedFontSize))}" size, ${h.weight} weight`)
        .join("; ")}${typography.emphasis.alignment ? `; overall ${typography.emphasis.alignment}-aligned${typography.emphasis.casing === "upper" ? ", all-caps feel" : ""}` : ""}.`,
    );
  }
  if (elements.shapes.length) {
    lines.push(`  Shapes: ${elements.shapes.map((s) => `${s.type} (${s.role}, ${s.color})`).join(", ")}.`);
  }
  if (elements.decorations.length) {
    lines.push(
      `  Decorations: ${elements.decorations.map((d) => `${d.type} ${d.color}${d.position ? ` ${d.position}` : ""}`).join(", ")}.`,
    );
  }
  const recognized = elements.text.filter((t) => typeof t.content === "string" && t.content.length);
  if (recognized.length) {
    lines.push(
      `  Reference words (style hints only, DO NOT copy): ${JSON.stringify(recognized.slice(0, 8).map((t) => t.content))}.`,
    );
  }
  if (ocr.status === "ok" || ocr.status === "region_only") {
    lines.push(`  OCR status: ${ocr.status}.`);
  }
  lines.push(
    "  Rules: mirror the reference's layout and palette, but use the NEW content and message from the user's request. Never reproduce the reference's own words.",
  );
  return lines.join("\n");
}

/**
 * @param {string} userPrompt
 * @param {{analysis?: import("../reference/analysisTypes").ReferenceDesignAnalysis, influence?: number}} [options]
 * @returns {string} flattened prompt for the AI Conductor endpoint
 */
export function buildSemanticDesignPrompt(userPrompt, options = {}) {
  const chunks = ["[System]", buildSemanticSystemInstruction()];
  if (options.analysis) {
    chunks.push("", "[Reference]", buildSemanticReferenceGuide(options.analysis, options.influence ?? 1));
  }
  chunks.push("", "[User]", userPrompt);
  return chunks.join("\n");
}

/**
 * @param {string} userPrompt
 * @param {object|null} previousSemantic
 * @param {string[]} errors
 * @param {{analysis?: import("../reference/analysisTypes").ReferenceDesignAnalysis, influence?: number}} [options]
 * @returns {string}
 */
export function buildSemanticRevalidationPrompt(userPrompt, previousSemantic, errors, options = {}) {
  const chunks = ["[System]", buildSemanticSystemInstruction()];
  if (options.analysis) {
    chunks.push("", "[Reference]", buildSemanticReferenceGuide(options.analysis, options.influence ?? 1));
  }
  chunks.push(
    "",
    "[Correction]",
    "Your previous semantic design failed validation. Fix it and return the corrected semantic JSON.",
    "Errors:",
    (errors.length ? errors : ["Unknown semantic/structural error."]).map((e) => `  - ${e}`).join("\n"),
    "",
    "Your previous (invalid) semantic design:",
    "```json",
    String(JSON.stringify(previousSemantic ?? {})).slice(0, 12000),
    "```",
    "",
    "[Original request]",
    userPrompt,
    "",
    "Rules: keep the user's design intent and any reference style. If text is missing content, add placeholder copy matching its role. Never add x/y coordinates. Return ONLY valid JSON.",
  );
  return chunks.join("\n");
}