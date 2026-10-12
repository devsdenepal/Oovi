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

export function buildSystemInstruction() {
  return [
    "You are a graphic design layout engine.",
    "",
    "Convert the user's natural-language request into a structured Design JSON document.",
    "",
    `Canvas coordinates are pixels.`,
    `Canvas size is ${CANVAS_WIDTH}x${CANVAS_HEIGHT}.`,
    `All elements must stay fully inside the canvas (x >= 0, y >= 0, and x + width <= ${CANVAS_WIDTH}, y + height <= ${CANVAS_HEIGHT}).`,
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
    '{"canvas":{"width":1080,"height":1080,"background":"#FFFFFF"},"elements":[...]}',
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
 * Builds the single flattened prompt string the AI Conductor endpoint expects.
 * Matches the deepgyan convention: a [System] block followed by the user
 * request, joined into one prompt.
 */
export function buildDesignPrompt(userPrompt) {
  const system = buildSystemInstruction();
  return `[System]\n${system}\n\n[User]\n${userPrompt}`;
}