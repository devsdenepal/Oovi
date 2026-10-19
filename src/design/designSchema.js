import { DESIGN_VERSION } from "./designTypes";

/**
 * Design JSON schema definition.
 *
 * This is the single source of truth for the DSL:
 * - what element types exist,
 * - which fields each type requires,
 * - which canvas settings are supported.
 *
 * It is used both by the AI prompt (designPrompt.js) and by the
 * validator (designValidator.js), so the model is always told exactly
 * what will pass validation.
 */

export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1080;
export const MAX_ELEMENTS = 60;

export const ELEMENT_TYPES = ["text", "rectangle", "circle", "line", "group", "image"];

/**
 * Field rules per element type.
 * - required: fields that must be present with a usable value
 * - defaults: applied when the field is missing (post-validation normalization)
 */
export const ELEMENT_SCHEMA = {
  text: {
    required: ["id", "type", "content", "x", "y", "width", "fontSize", "fontWeight", "fill"],
    defaults: {
      textAlign: "left",
      lineHeight: 1.2,
      fontFamily: "Arial",
    },
  },
  rectangle: {
    required: ["id", "type", "x", "y", "width", "height", "fill"],
    defaults: {
      cornerRadius: 0,
    },
  },
  circle: {
    required: ["id", "type", "x", "y", "radius", "fill"],
    defaults: {},
  },
  line: {
    required: ["id", "type", "x", "y", "x2", "y2", "stroke"],
    defaults: {
      strokeWidth: 2,
    },
  },
  group: {
    required: ["id", "type", "x", "y", "children"],
    defaults: {},
  },
  image: {
    required: ["id", "type", "x", "y", "width", "height", "src"],
    defaults: {},
  },
};

export const CANVAS_SCHEMA = {
  width: { min: 64, max: 4096 },
  height: { min: 64, max: 4096 },
};

export const DESIGN_SCHEMA = {
  canvas: {
    width: { min: 64, max: 4096 },
    height: { min: 64, max: 4096 },
    background: { type: "string" },
  },
  elements: { maxCount: MAX_ELEMENTS },
  version: DESIGN_VERSION,
};