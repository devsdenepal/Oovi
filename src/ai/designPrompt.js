import { CANVAS_HEIGHT, CANVAS_WIDTH, ELEMENT_SCHEMA, ELEMENT_TYPES } from "../design/designSchema";

/**
 * Constructs the system instruction that tells the model it is a
 * graphic-design layout engine and exactly what JSON shape it must return.
 *
 * The schema text is derived from designSchema.js so the model is told
 * precisely what the validator will accept.
 */

const buildElementDocs = () => {
  return Object.entries(ELEMENT_SCHEMA)
    .map(([type, spec]) => {
      const fields = [...spec.required];
      const optional = Object.keys(spec.defaults);
      return `- ${type}\n  required: ${fields.join(", ")}\n  optional: ${optional.join(", ")}`;
    })
    .join("\n");
};

export function buildSystemInstruction(canvas = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }) {
  const width = Number(canvas?.width) || CANVAS_WIDTH;
  const height = Number(canvas?.height) || CANVAS_HEIGHT;
  return [
    "You are a graphic design layout engine.",
    "",
    "Convert the user's natural-language request into a structured Design JSON document.",
    "",
    `Canvas coordinates are pixels.`,
    `Canvas size is ${width}x${height}.`,
    `All elements must stay fully inside the canvas (x >= 0, y >= 0, and x + width <= ${width}, y + height <= ${height}).`,
    "",
    "Every element must have an id (unique, lowercase, no spaces), a type, and x/y coordinates.",
    "Use a semantic role value for each element where sensible: header, headline, body, footer, decoration, button, tagline, label.",
    "",
    "Available element types:",
    buildElementDocs(),
    "",
    "Text elements additionally require: content, fontSize (12-120), fontWeight (number), fill (CSS color), width (px).",
    "Rectangle elements require: width, height, fill.",
    "Circle elements require: radius, fill.",
    "Line elements require: x2, y2, stroke.",
    "Group elements require: children (array of elements).",
    "",
    "Design JSON shape:",
    `{"canvas":{"width":${width},"height":${height},"background":"#FFFFFF"},"elements":[...]}`,
    "",
    "The background must be a valid CSS color.",
    "Produce a clean, modern, minimal layout. Balance the composition. Keep at least a header, a headline, some body text, and a footer.",
    "",
    "Return ONLY valid JSON.",
    "Do not return Markdown.",
    "Do not wrap the JSON in code fences.",
    "Do not explain your answer.",
    "Do not include any commentary before or after the JSON.",
  ].join("\n");
}

/**
 * Builds the single flattened prompt string sent to the model chain.
 * A [System] block followed by the user request, joined into one prompt;
 * the transport splits it back into chat roles.
 */
export function buildDesignPrompt(userPrompt, canvas) {
  const system = buildSystemInstruction(canvas);
  return `[System]\n${system}\n\n[User]\n${userPrompt}`;
}

/**
 * Builds a revalidation prompt: resends the original request plus the model's
 * previously-invalid output and the exact validation errors, asking for a
 * corrected Design JSON.
 */
export function buildRevalidationPrompt(userPrompt, previousOutput, errors, canvas) {
  const system = buildSystemInstruction(canvas);
  const cappedOutput = String(previousOutput).slice(0, 12000);
  const errorList = errors.map((e) => `- ${e}`).join("\n");

  return [
    "[System]",
    system,
    "",
    "[Correction]",
    "Your previous response failed validation. Fix it and return the corrected Design JSON.",
    "Validation errors:",
    errorList,
    "",
    "Your previous (invalid) output:",
    `\`\`\`json\n${cappedOutput}\n\`\`\``,
    "",
    "[Original request]",
    userPrompt,
    "",
    "Rules: keep the user's original design intent. If a text element is missing 'content', add sensible placeholder copy matching that element's role. Do not remove elements unless an error requires it. Return ONLY valid JSON. Do not use Markdown or explain.",
  ].join("\n");
}