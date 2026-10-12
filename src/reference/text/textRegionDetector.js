/**
 * Text-region detector.
 *
 * Uses connected components on a fine foreground mask to find text-LIKE
 * blocks (sparse, word-shaped clusters). Real OCR (content recognition) is
 * handled separately by the pluggable OCR provider - this module only finds
 * where text lives, how big it is, and what color it is.
 */

import { buildMask, labelComponents, componentToPx, averageColor } from "../imageParser/mask";

const TEXT_CELL = 5; // analysis px per mask cell (fine enough for words)

/**
 * Detects text-like lines/regions.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{r:number,g:number,b:number}} background
 * @returns {Promise<import("../analysisTypes").TextRegionAnalysis[]>} in original-image px
 */
export async function detectTextRegions(ctx, width, height, background) {
  const mask = buildMask(ctx, width, height, background, TEXT_CELL);
  const comps = labelComponents(mask.grid, mask.rows, mask.cols);

  const minDim = Math.min(width, height);
  const candidates = [];
  for (const comp of comps) {
    const w = (comp.maxX - comp.minX + 1) * mask.cellW;
    const h = (comp.maxY - comp.minY + 1) * mask.cellH;
    if (h < minDim * 0.008 || h > minDim * 0.3) continue;
    if (w < minDim * 0.006 || w > width * 0.95) continue;
    const aspect = w / Math.max(1, h);
    if (aspect < 0.35 || aspect > 45) continue;
    // Text ink is sparse; dense blocks are shapes/images instead.
    if (comp.dens > 0.62) continue;
    candidates.push({ comp, w, h, color: null });
  }

  if (candidates.length === 0) return [];

  // Merge components into lines by vertical overlap.
  const lines = [];
  const horizontalStep = Math.max(mask.cellW * 2, (candidates[0].h || minDim * 0.02) * 0.6);
  for (const cand of candidates) {
    const { comp } = cand;
    let merged = null;
    for (const line of lines) {
      const overlapY =
        Math.min(line.maxY, comp.maxY) - Math.max(line.minY, comp.minY) + 1;
      const lineH = line.maxY - line.minY + 1;
      const compH = comp.maxY - comp.minY + 1;
      if (overlapY >= Math.min(lineH, compH) * 0.45) {
        // Horizontal gap must stay small (same word line).
        const gapX = Math.max(0, comp.minX - line.maxX);
        if (gapX <= horizontalStep / mask.cellW + 2) {
          merged = line;
          break;
        }
      }
    }
    if (merged) {
      merged.comps.push(comp);
      if (comp.minX < merged.minX) merged.minX = comp.minX;
      if (comp.maxX > merged.maxX) merged.maxX = comp.maxX;
      if (comp.minY < merged.minY) merged.minY = comp.minY;
      if (comp.maxY > merged.maxY) merged.maxY = comp.maxY;
    } else {
      lines.push({
        minX: comp.minX,
        maxX: comp.maxX,
        minY: comp.minY,
        maxY: comp.maxY,
        comps: [comp],
      });
    }
  }

  const regions = [];
  let index = 0;
  for (const line of lines) {
    const bboxPx = {
      x: line.minX * mask.cellW,
      y: line.minY * mask.cellH,
      width: (line.maxX - line.minX + 1) * mask.cellW,
      height: (line.maxY - line.minY + 1) * mask.cellH,
    };
    const h = bboxPx.height;
    if (bboxPx.width < minDim * 0.008 || h < minDim * 0.008) continue;

    let ink = 0;
    let area = 0;
    for (const comp of line.comps) {
      ink += comp.count;
      area += comp.area;
    }
    const dens = ink / Math.max(1, area);
    const weight = dens > 0.42 ? "bold" : dens > 0.3 ? "medium" : dens > 0.21 ? "regular" : "light";

    const centerX = bboxPx.x + bboxPx.width / 2;
    const alignment =
      Math.abs(centerX - width / 2) <= width * 0.03 ? "center" : centerX < width / 2 ? "left" : "right";

    const color = averageColor(ctx, width, height, bboxPx, background, 7);

    regions.push({
      id: `text_${index++}`,
      role: "text",
      x: Math.round(bboxPx.x),
      y: Math.round(bboxPx.y),
      width: Math.round(bboxPx.width),
      height: Math.round(bboxPx.height),
      estimatedFontSize: Math.round(Math.min(h * 0.85, width * 0.4)),
      weight,
      color,
      alignment,
      content: null,
      confidence: 0,
    });
  }
  return regions;
}