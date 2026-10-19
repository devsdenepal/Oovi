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
 * exactly the same lens the test suite uses — one definition of what a
 * template renders like.
 */

/**
 * @param {Array} components instantiated plan components
 * @param {{width:number,height:number}} canvas
 * @param {{background:string,ink:string,accent:string}} palette
 * @returns {{canvas:object, elements:Array}}
 */
export function materializePlan(components, canvas, palette) {
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
      // L4 scatters small shapes inside a decoration reservation, not a slab.
      const dots = 8;
      const radius = Math.max(3, Math.floor(box.height / 4));
      for (let i = 0; i < dots; i++) {
        const cx = box.x + ((i + 0.5) / dots) * box.width;
        elements.push({
          id: `${c.id}-dot-${i}`,
          type: "circle",
          role: "decoration",
          x: Math.round(cx - radius),
          y: Math.round(box.y + box.height / 2 - radius),
          radius,
          fill: palette.accent,
        });
      }
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
      fill: palette.ink,
    });
  }
  return { canvas: { ...canvas, background: palette.background }, elements };
}
