/**
 * Reference Design Analysis - types and constants.
 *
 * A ReferenceDesignAnalysis is the normalized, strongly-typed description of
 * an uploaded inspiration image. It is produced by the local, heuristic
 * parser in src/reference and consumed by:
 *   - the semantic prompt builder (src/ai/semanticPrompt.js) so the model
 *     can borrow the reference's composition / colors / typography,
 *   - the layout engine (src/layout/layoutEngine.js) for baseline canvas
 *     and region hints,
 *   - the debug UI (Analysis / Semantic SVG tabs).
 *
 * Responsibilities are kept separate: the parser never knows about the LLM,
 * the LLM never sees the raw image - only this analysis.
 */

/** Recognition state for the optional OCR pass. */
export const OcrStatus = Object.freeze({
  OK: "ok",
  REGION_ONLY: "region_only",
  LOADING: "loading",
  UNAVAILABLE: "unavailable",
});

/** Roles used when classifying regions/lines of a reference layout. */
export const RegionRole = Object.freeze({
  HEADER: "header",
  HERO: "hero",
  CONTENT: "content",
  VISUAL: "visual",
  FOOTER: "footer",
  SECTION: "section",
  TEXT: "text",
  IMAGE: "image",
  DECORATION: "decoration",
});

/**
 * @typedef {Object} ColorSwatch
 * @property {string} hex  - "#RRGGBB"
 * @property {number} share - 0..1 share of the sampled pixels
 */

/**
 * @typedef {Object} PaletteAnalysis
 * @property {string} background - dominant edge color (hex)
 * @property {string} primary    - main content color (highest contrast vs background)
 * @property {string} accent     - most saturated standout color
 * @property {ColorSwatch[]} dominant - dominant interior colors, by share
 * @property {string} text       - suggested body text color
 * @property {string} subtext    - suggested muted text color
 * @property {boolean} isLight   - whether the background is light
 * @property {string[]} colors   - all candidate hex colors (background + dominant)
 */

/**
 * @typedef {Object} RegionAnalysis
 * @property {string} id                 - stable kebab-case id (content, header, left_content...)
 * @property {string} role               - RegionRole value
 * @property {number} x                  - x in original image px
 * @property {number} y                  - y in original image px
 * @property {number} width              - width in original image px
 * @property {number} height             - height in original image px
 * @property {number} relativeWidth      - 0..1 of canvas width
 * @property {number} relativeHeight     - 0..1 of canvas height
 */

/**
 * @typedef {Object} LayoutAnalysis
 * @property {string} type               - "single_column" | "two_column" | "three_column" | "stacked" | "centered"
 * @property {number} columns            - detected column count
 * @property {number} bands              - detected horizontal bands count
 * @property {{top:number,right:number,bottom:number,left:number}} margins
 * @property {number} gap                - average gutter width in original px
 * @property {string} alignment          - "left" | "center" | "right" | "mixed"
 * @property {RegionAnalysis[]} regions
 */

/**
 * @typedef {Object} TextRegionAnalysis
 * @property {string} id
 * @property {string} role               - always "text"
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} estimatedFontSize  - approximated from line height, in original px
 * @property {string} weight             - "light" | "regular" | "medium" | "bold"
 * @property {string} color              - average ink color (hex)
 * @property {string} alignment          - "left" | "center" | "right"
 * @property {string|null} content       - recognized text (null when OCR unavailable)
 * @property {number} confidence         - OCR confidence 0..1 (0 when unavailable)
 */

/**
 * @typedef {Object} ShapeAnalysis
 * @property {string} id
 * @property {string} type               - "rectangle" | "circle" | "line"
 * @property {string} role               - e.g. "decoration" | "card" | "badge"
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} [radius]           - circle radius
 * @property {number} cornerRadius       - approximated (0 = sharp, >0 = rounded)
 * @property {string} color              - fill color (hex)
 */

/**
 * @typedef {Object} ImageRegionAnalysis
 * @property {string} id
 * @property {string} role               - always "image"
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} DecorationAnalysis
 * @property {string} id
 * @property {string} type               - "dot_grid" | "icon" | "divider"
 * @property {string} role               - "decoration"
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {string} color              - hex
 * @property {number} [spacing]          - dot-grid spacing
 * @property {number} [radius]           - dot radius / divider thickness
 * @property {string} [position]         - "top_left" | "top_right" | "bottom_left" | "bottom_right" | "center"
 */

/**
 * @typedef {Object} TypographyAnalysis
 * @property {string} style              - high-level style label ("title_centered", "left_aligned_compact", ...)
 * @property {Array<{role:string, estimatedFontSize:number, weight:string, color:string}>} hierarchy
 * @property {{alignment:string, casing:string}} emphasis
 */

/**
 * @typedef {Object} ReferenceDesignAnalysis
 * @property {{kind:string, fileName?:string, width:number, height:number, aspectRatio:number}} source
 * @property {{width:number, height:number, aspectRatio:number}} canvas
 * @property {PaletteAnalysis} palette
 * @property {LayoutAnalysis} layout
 * @property {TypographyAnalysis} typography
 * @property {{text:TextRegionAnalysis[], images:ImageRegionAnalysis[], shapes:ShapeAnalysis[], decorations:DecorationAnalysis[]}} elements
 * @property {{status:string, language?:string, units:number, notes?:string}} ocr
 * @property {string} summary
 */

export const SEMANTIC_ANALYSIS_VERSION = 1;