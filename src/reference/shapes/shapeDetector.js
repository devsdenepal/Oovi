/**
 * Shape detector (rectangles, circles, lines).
 *
 * Runs on dense connected components (>50% ink density) that are large
 * enough to be deliberate shapes rather than texture. Returns normalized
 * ShapeAnalysis entries with approximated corner radius and roles.
 */

import { buildMask, labelComponents, componentToPx, averageColor } from "../imageParser/mask";

const SHAPE_CELL = 5;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{r:number,g:number,b:number}} background
 * @returns {Promise<import("../analysisTypes").ShapeAnalysis[]>} in original-image px
 */
export async function detectShapes(ctx, width, height, background) {
  const mask = buildMask(ctx, width, height, background, SHAPE_CELL);
  const comps = labelComponents(mask.grid, mask.rows, mask.cols);

  const minDim = Math.min(width, height);
  const shapes = [];
  let index = 0;

  for (const comp of comps) {
    const w = (comp.maxX - comp.minX + 1) * mask.cellW;
    const h = (comp.maxY - comp.minY + 1) * mask.cellH;
    if (comp.dens < 0.55) continue;
    if (w < minDim * 0.03 && h < minDim * 0.03) continue;

    const aspect = w / Math.max(1, h);
    const bboxPx = {
      x: comp.minX * mask.cellW,
      y: comp.minY * mask.cellH,
      width: w,
      height: h,
    };
    const color = averageColor(ctx, width, height, bboxPx, background, 8);

    let type = "rectangle";
    let radius = null;
    if (aspect > 5 && h <= minDim * 0.03) {
      type = "line";
    } else if (aspect < 0.2 && w <= minDim * 0.03) {
      type = "line";
    } else if (aspect <= 1.3 && aspect >= 0.7 && comp.dens >= 0.68) {
      type = "circle";
      radius = Math.round(Math.min(w, h) / 2);
    }

    const cornerRadius =
      type === "rectangle" && comp.dens < 0.9
        ? Math.round(Math.min(w, h) * 0.2)
        : type === "rectangle"
          ? 0
          : 0;

    shapes.push({
      id: `shape_${index++}`,
      type,
      role: "decoration",
      x: Math.round(bboxPx.x),
      y: Math.round(bboxPx.y),
      width: Math.round(w),
      height: Math.round(h),
      radius,
      cornerRadius,
      color,
    });
  }

  // Assign more meaningful roles based on size relative to the canvas.
  const canvasArea = width * height;
  for (const shape of shapes) {
    const area = shape.width * shape.height;
    if (shape.type === "rectangle") {
      if (area > canvasArea * 0.12) shape.role = "card";
      else if (shape.width >= width * 0.12 && shape.width <= width * 0.38 && shape.height >= height * 0.05 && shape.height <= height * 0.14) {
        shape.role = "button";
      } else if (shape.height >= height * 0.03 && shape.height <= height * 0.12) {
        shape.role = "badge";
      } else {
        shape.role = "decoration";
      }
    } else if (shape.type === "line") {
      shape.role = "divider";
    } else {
      shape.role = "dot";
    }
  }

  return shapes;
}