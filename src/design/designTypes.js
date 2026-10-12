/**
 * Design DSL types.
 *
 * The Design JSON produced by the AI layer follows this shape:
 *
 *   {
 *     canvas: { width, height, background },
 *     elements: [
 *       { id, type, role, x, y, ... typeSpecificFields }
 *     ]
 *   }
 *
 * The renderer consumes this shape. The AI layer must never know about
 * Fabric.js; the renderer must never know about the AI provider.
 */

/**
 * @typedef {Object} CanvasSpec
 * @property {number} width        - Canvas width in px
 * @property {number} height       - Canvas height in px
 * @property {string} background   - CSS color for the canvas background
 */

/**
 * @typedef {Object} BaseElement
 * @property {string} id      - unique element id returned to the DSL layer
 * @property {string} type    - element type: text | rectangle | circle | line | group
 * @property {string} [role]  - semantic role: header | headline | body | footer | decoration | ...
 * @property {number} x       - x coordinate of the element's origin (px)
 * @property {number} y       - y coordinate of the element's origin (px)
 */

/**
 * @typedef {BaseElement & {
 *   type: "text",
 *   content: string,
 *   width: number,
 *   fontSize: number,
 *   fontWeight: number | string,
 *   fill: string,
 *   textAlign?: string,
 *   lineHeight?: number,
 *   fontFamily?: string
 * }} TextElement
 */

/**
 * @typedef {BaseElement & {
 *   type: "rectangle",
 *   width: number,
 *   height: number,
 *   fill: string,
 *   cornerRadius?: number
 * }} RectangleElement
 */

/**
 * @typedef {BaseElement & {
 *   type: "circle",
 *   radius: number,
 *   fill: string
 * }} CircleElement
 */

/**
 * @typedef {BaseElement & {
 *   type: "line",
 *   x2: number,
 *   y2: number,
 *   stroke: string,
 *   strokeWidth?: number
 * }} LineElement
 */

/**
 * @typedef {BaseElement & {
 *   type: "group",
 *   children: Element[]
 * }} GroupElement
 */

/** @typedef {TextElement | RectangleElement | CircleElement | LineElement | GroupElement} Element */

/**
 * @typedef {Object} Design
 * @property {CanvasSpec} canvas
 * @property {Element[]} elements
 */

export const DESIGN_VERSION = 1;