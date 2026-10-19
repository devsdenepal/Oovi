/**
 * Grid + type-scale snapping (Phase 2G).
 *
 * The model never gets to place pixels freely: template boxes are snapped to
 * an 8px grid and any font size it can influence is snapped back onto the
 * existing type scale. Pure functions, no imports beyond the scale itself,
 * so node tests and the browser share one implementation.
 */

import { SIZE_FACTORS } from "./typeScale";

/** Base grid in px. 8 divides every platform preset cleanly. */
export const GRID = 8;

export function snapToGrid(value, grid = GRID) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (!(grid > 0)) return Math.round(v);
  return Math.round(v / grid) * grid;
}

/**
 * Snaps a fractional/px box to the grid. When `toEdges` is true the right and
 * bottom edges are snapped from x+w / y+h so adjacent boxes keep a clean seam
 * instead of drifting apart.
 */
export function snapBox(box, grid = GRID, canvas = null) {
  const b = box || {};
  const read = (key, alt) => (Number.isFinite(b[key]) ? b[key] : Number.isFinite(b[alt]) ? b[alt] : 0);
  const x = snapToGrid(read("x", "left"), grid);
  const y = snapToGrid(read("y", "top"), grid);
  const right = snapToGrid(x + read("w", "width"), grid);
  const bottom = snapToGrid(y + read("h", "height"), grid);
  const out = { x, y, width: Math.max(grid, right - x), height: Math.max(grid, bottom - y) };
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    out.width = Math.max(grid, Math.min(out.width, canvas.width - out.x));
    out.height = Math.max(grid, Math.min(out.height, canvas.height - out.y));
  }
  return out;
}

/**
 * Snaps a px font size onto the nearest step of the canvas-relative type
 * scale, so a "+12% bigger headline" lands on a real scale step instead of an
 * arbitrary number. Returns the input unchanged when it is below the smallest
 * step or off-canvas.
 */
export function snapFontSize(px, canvasHeight) {
  const size = Number(px);
  const H = Number(canvasHeight);
  if (!Number.isFinite(size) || !(H > 0)) return Math.round(size) || 0;
  const steps = Object.values(SIZE_FACTORS).map((f) => H * f);
  let best = steps[0];
  let bestDist = Infinity;
  for (const step of steps) {
    const d = Math.abs(step - size);
    if (d < bestDist) {
      bestDist = d;
      best = step;
    }
  }
  return Math.max(8, Math.round(best));
}

/** True when two px boxes overlap by more than `tolerance` px on both axes.
 * Accepts either {w,h} or {width,height}. */
export function boxesOverlap(a, b, tolerance = 0) {
  if (!a || !b) return false;
  const w = (r) => (Number.isFinite(r.w) ? r.w : Number(r.width) || 0);
  const h = (r) => (Number.isFinite(r.h) ? r.h : Number(r.height) || 0);
  const ox = Math.min(a.x + w(a), b.x + w(b)) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + h(a), b.y + h(b)) - Math.max(a.y, b.y);
  return ox > tolerance && oy > tolerance;
}
