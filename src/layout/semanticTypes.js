/**
 * Semantic Design DSL - types and constants.
 *
 * The semantic DSL describes WHAT a design contains (roles, containers,
 * relative sizes) and never WHERE pixels live. Coordinates are computed by
 * the constraint-based layout engine (src/layout/layoutEngine.js) which
 * produces the pixel Design JSON the existing renderer/editor consume.
 *
 *   Semantic:  { canvas, containers, elements }   <- LLM output
 *   Pixel:     { canvas, elements }               <- layout engine output
 *
 * The old pixel DSL in src/design stays the stored/edited format; this layer
 * only sits between the AI and the storage format.
 */

export const SEMANTIC_VERSION = 1;
export const MAX_SEMANTIC_ELEMENTS = 40;

export const SEMANTIC_ELEMENT_TYPES = [
  "text",
  "image",
  "button",
  "rectangle",
  "circle",
  "line",
  "group",
];

export const DIRECTION_VALUES = ["vertical", "horizontal"];
export const JUSTIFY_VALUES = ["start", "center", "end", "between", "around"];
export const ALIGN_VALUES = ["start", "center", "end", "stretch"];
export const FIT_VALUES = ["cover", "contain"];

/** Recognized role vocabulary (semantic, not pixel). */
export const ROLE_VALUES = [
  "header",
  "headline",
  "subtitle",
  "body",
  "footer",
  "hero",
  "logo",
  "nav",
  "cta",
  "button",
  "image",
  "visual",
  "icon",
  "decoration",
  "divider",
  "card",
  "badge",
  "label",
  "tagline",
  "caption",
];

/**
 * @typedef {Object} SemanticCanvas
 * @property {number} [width]      - desired canvas width (px); engine default 1080
 * @property {number} [height]     - desired canvas height (px); engine default 1080
 * @property {string} [background] - CSS color
 */

/**
 * @typedef {Object} SemanticContainer
 * @property {string} id
 * @property {string} [direction]  - "vertical" | "horizontal" (default vertical)
 * @property {string} [justify]    - main-axis distribution: start|center|end|between|around
 * @property {string} [align]      - cross-axis: start|center|end|stretch (default stretch)
 * @property {number} [gap]        - px between children
 * @property {number|{top?:number,right?:number,bottom?:number,left?:number}} [padding]
 * @property {number|{top?:number,right?:number,bottom?:number,left?:number}} [margin]
 * @property {"auto"|"fit-content"|"100%"|string|number} [width]
 * @property {"auto"|"fit-content"|"100%"|string|number} [height]
 * @property {string[]} [children] - element ids placed in this container (in flow order)
 */

/**
 * @typedef {Object} SemanticStyle
 * @property {string} [size]        - "display"|"headline"|"title"|"subtitle"|"body"|"caption"|"small"
 * @property {number} [fontSize]    - explicit px (overrides size)
 * @property {string|number} [weight]
 * @property {string} [color]
 * @property {string} [family]
 * @property {"left"|"center"|"right"} [alignment]
 * @property {number} [lineHeight]
 * @property {number} [cornerRadius]
 * @property {string} [fill]
 * @property {number} [strokeWidth]
 * @property {string} [stroke]
 * @property {string|number} [aspectRatio] - e.g. "16:9", "1", 1.5
 */

/**
 * @typedef {Object} SemanticElement
 * @property {string} id
 * @property {"text"|"image"|"button"|"rectangle"|"circle"|"line"|"group"} type
 * @property {string} [role]
 * @property {string} [container] - container id (default "root")
 * @property {"auto"|"fit-content"|"100%"|string|number} [width]
 * @property {"auto"|"fit-content"|"100%"|string|number} [height]
 * @property {"start"|"center"|"end"|"stretch"} [align]
 * @property {number} [margin]
 * @property {number} [gap]
 * @property {string} [content]   - text/button label
 * @property {"cover"|"contain"} [fit] - image scaling inside its box
 * @property {SemanticStyle} [style]
 * @property {number} [x]         - legacy: absolute position (bypasses flow)
 * @property {number} [y]         - legacy: absolute position (bypasses flow)
 */

/**
 * @typedef {Object} SemanticDesign
 * @property {SemanticCanvas} [canvas]
 * @property {SemanticContainer[]} [containers]
 * @property {SemanticElement[]} elements
 * @property {object} [layout] - shorthand top-level layout (direction/gap/padding/align)
 */