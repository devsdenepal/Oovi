/**
 * Plan → pixels (Phase 3).
 *
 * A plan is abstract (boxes, roles, font sizes, character limits); the quality
 * gate measures a real design. This is the deliberate worst-case filler the
 * tests already used: every text slot is filled edge-to-edge with as many
 * whole lines as its box holds, so a slot that is too short for its own type
 * shows up as an overlap rather than hiding behind short sample copy.
 *
 * It lives in src/ so "Save as template" validates a saved layout through
 * exactly the same lens the test suite uses | one definition of what a
 * template renders like.
 */

import { buildDecorations, defaultDecorationSpecs } from "./decorations";

/**
 * @param {Array} components instantiated plan components
 * @param {{width:number,height:number}} canvas
 * @param {{background:string,ink:string,accent:string,roles?:object}} palette
 * @returns {{canvas:object, elements:Array}}
 */
export function materializePlan(components, canvas, palette) {
  const roles = palette?.roles || {};
  const ink = roles.textPrimary || palette.ink;
  const elements = [];
  for (const c of components || []) {
    const box = c.box;
    if (!box) continue;
    if (c.kind === "image") {
      elements.push({
        id: `${c.id}-img`,
        type: "image",
        role: c.role,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
      continue;
    }
    if (c.role === "decoration") {
      // Use the same vocabulary and deterministic expansion as the live
      // preview and the AI region pass. A saved template must not render a
      // different decoration from the one the user saw.
      const decoration = buildDecorations(defaultDecorationSpecs(c), box, palette, { prefix: c.id });
      if (decoration.length) {
        elements.push(...decoration);
        continue;
      }
      elements.push({
        id: `${c.id}-bar`,
        type: "rectangle",
        role: "decoration",
        x: box.x,
        y: Math.round(box.y + box.height / 2 - Math.min(4, box.height / 2)),
        width: box.width,
        height: Math.max(1, Math.min(8, box.height)),
        fill: palette.accent,
      });
      continue;
    }
    const fontSize = c.fontSize || 24;
    const perLine = Math.max(2, Math.floor(box.width / (fontSize * 0.55)));
    const lines = Math.max(1, Math.floor(box.height / (fontSize * 1.2)));
    const cap = c.maxChars > 0 ? Math.min(c.maxChars, perLine * lines) : perLine * lines;
    const length = Math.max(2, cap);
    elements.push({
      id: `${c.id}-text`,
      type: "text",
      role: c.role,
      content: "Aa".repeat(Math.ceil(length / 2)).slice(0, length),
      x: box.x,
      y: box.y,
      width: box.width,
      fontSize,
      fontWeight: 600,
      lineHeight: 1.2,
      fill: ink,
    });
  }
  return { canvas: { ...canvas, background: palette.background }, elements };
}
