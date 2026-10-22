/**
 * Human-readable metadata for saved designs.
 *
 * These helpers only reformat values returned by the project API. They never
 * infer or invent canvas information.
 */

const CANVAS_FORMATS = [
  { width: 1200, height: 630, label: "Feed" },
  { width: 1080, height: 1080, label: "Square" },
  { width: 1080, height: 1350, label: "Portrait" },
  { width: 1080, height: 1920, label: "Story" },
  { width: 1200, height: 675, label: "Banner" },
  { width: 2480, height: 3508, label: "A4" },
];

/**
 * A familiar output name for a saved canvas. Unknown sizes stay "Custom".
 * @param {number|string} width
 * @param {number|string} height
 * @returns {string}
 */
export function formatForCanvas(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "";

  const exact = CANVAS_FORMATS.find((item) => item.width === w && item.height === h);
  if (exact) return exact.label;

  const ratio = w / h;
  if (Math.abs(ratio - 1) <= 0.02) return "Square";
  if (ratio >= 1.3) return "Banner";
  if (ratio <= 0.85) return "Portrait";
  return "Custom";
}
