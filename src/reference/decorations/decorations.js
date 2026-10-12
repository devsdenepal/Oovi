/**
 * Decoration detector (dot grids, icons, dividers).
 *
 * Tries to find the small deliberate details of a layout: a repeating dot
 * grid in a corner, small icons next to text, and thin divider lines.
 * Best-effort and heuristic - they only inform the model, never block it.
 */

import { buildMask, labelComponents, componentToPx, averageColor } from "../imageParser/mask";

const DOT_CELL = 5;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{r:number,g:number,b:number}} background
 * @param {import("../analysisTypes").TextRegionAnalysis[]} textRegions
 * @param {import("../analysisTypes").ShapeAnalysis[]} shapes
 * @returns {Promise<import("../analysisTypes").DecorationAnalysis[]>} in original-image px
 */
export async function detectDecorations(ctx, width, height, background, textRegions, shapes) {
  const mask = buildMask(ctx, width, height, background, DOT_CELL);
  const comps = labelComponents(mask.grid, mask.rows, mask.cols);
  const cellW = mask.cellW;
  const cellH = mask.cellH;

  const dots = [];
  const icons = [];
  for (const comp of comps) {
    const bw = (comp.maxX - comp.minX + 1) * cellW;
    const bh = (comp.maxY - comp.minY + 1) * cellH;
    const aspect = bw / Math.max(1, bh);
    if (comp.dens < 0.5) continue;
    if (bw > 0.02 * width && bh > 0.02 * height) continue; // big object, not a dot
    if (bw <= 2.6 * cellW && bh <= 2.6 * cellH && aspect >= 0.5 && aspect <= 2.5) {
      dots.push(comp);
    } else if (bw <= 6 * cellW && bh <= 6 * cellH) {
      icons.push(comp);
    }
  }

  const decorations = [];
  const decorationsByType = { dot_grid: [], icon: [], divider: [] };

  // --- dot grids: cluster dots into corner quadrants, count grids ---
  const quadrants = [
    { label: "top_left", test: (cx, cy) => cx <= width / 2 && cy <= height / 2 },
    { label: "top_right", test: (cx, cy) => cx > width / 2 && cy <= height / 2 },
    { label: "bottom_left", test: (cx, cy) => cx <= width / 2 && cy > height / 2 },
    { label: "bottom_right", test: (cx, cy) => cx > width / 2 && cy > height / 2 },
  ];
  for (const q of quadrants) {
    const group = dots.filter((d) => {
      const x = (d.cx + 0.5) * cellW;
      const y = (d.cy + 0.5) * cellH;
      return q.test(x, y);
    });
    if (group.length < 8) continue;
    const avgColor =
      group.length > 0
        ? averageColor(
            ctx,
            width,
            height,
            { x: group[0].minX * cellW, y: group[0].minY * cellH, width: cellW, height: cellH },
            background,
            3,
          )
        : "#000000";
    const xs = group.map((d) => (d.cx + 0.5) * cellW);
    xs.sort((a, b) => a - b);
    const deltas = [];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (d > 0 && d < width * 0.12) deltas.push(d);
    }
    const spacing = deltas.length ? medianSorted(deltas.slice().sort((a, b) => a - b)) : cellW * 2;
    decorationsByType.dot_grid.push({
      id: `deco_dot_${decorationsByType.dot_grid.length + 1}`,
      type: "dot_grid",
      role: "decoration",
      position: q.label,
      spacing: Math.round(spacing),
      radius: Math.round(cellW / 2),
      count: group.length,
      x: Math.round(group.reduce((s, d) => s + (d.minX * cellW), 0) / group.length),
      y: Math.round(group.reduce((s, d) => s + (d.minY * cellH), 0) / group.length),
      width: cellW,
      height: cellH,
      color: avgColor,
    });
  }

  // --- icons near text lines ---
  for (const icon of icons.slice(0, 12)) {
    const x = (icon.cx + 0.5) * cellW;
    const y = (icon.cy + 0.5) * cellH;
    const near = textRegions.some((t) => {
      const closeness =
        Math.abs((t.x + t.width / 2) - x) < Math.max(t.height, cellW * 6) * 1.4 &&
        Math.abs((t.y + t.height / 2) - y) < Math.max(t.height, cellH * 6) * 1.4;
      return closeness;
    });
    if (!near) continue;
    const bboxPx = {
      x: icon.minX * cellW,
      y: icon.minY * cellH,
      width: (icon.maxX - icon.minX + 1) * cellW,
      height: (icon.maxY - icon.minY + 1) * cellH,
    };
    decorationsByType.icon.push({
      id: `deco_icon_${decorationsByType.icon.length + 1}`,
      type: "icon",
      role: "decoration",
      position: null,
      x: Math.round(bboxPx.x),
      y: Math.round(bboxPx.y),
      width: Math.round(bboxPx.width),
      height: Math.round(bboxPx.height),
      color: averageColor(ctx, width, height, bboxPx, background, 3),
    });
  }

  // --- dividers from thin line shapes ---
  for (const shape of shapes) {
    if (shape.type !== "line") continue;
    decorationsByType.divider.push({
      id: `deco_divider_${decorationsByType.divider.length + 1}`,
      type: "divider",
      role: "decoration",
      position: null,
      x: shape.x,
      y: shape.y,
      width: shape.width,
      height: shape.height,
      color: shape.color,
    });
  }

  for (const list of Object.values(decorationsByType)) {
    decorations.push(...list);
  }
  return decorations;
}

function medianSorted(sorted) {
  if (!sorted.length) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}