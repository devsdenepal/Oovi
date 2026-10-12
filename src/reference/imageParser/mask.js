/**
 * Binary mask + connected-component helpers shared by the detectors.
 *
 * A "mask" is a boolean grid computed by thresholding each pixel against the
 * detected background color. Everything downstream (bands, columns, text-like
 * blocks, shapes) works on this grid so the algorithms stay deterministic
 * and independent of the source image format.
 */

import { isNear, luminance, rgbToHex } from "../colors/colorExtractor";

/**
 * Builds a foreground/background binary mask.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{r:number,g:number,b:number}} background
 * @param {number} cellSize - px per grid cell (square)
 */
export function buildMask(ctx, width, height, background, cellSize) {
  const cols = Math.max(4, Math.ceil(width / cellSize));
  const rows = Math.max(4, Math.ceil(height / cellSize));
  const cellW = width / cols;
  const cellH = height / rows;

  const grid = new Uint8Array(cols * rows);
  const rowProfile = new Uint16Array(rows);
  const colProfile = new Uint16Array(cols);
  const imageData = ctx.getImageData(0, 0, width, height).data;
  const bgLum = luminance(background);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Sample the cell center. Skip near-transparent (=> treat as background).
      const x = Math.min(width - 1, Math.round((c + 0.5) * cellW));
      const y = Math.min(height - 1, Math.round((r + 0.5) * cellH));
      const idx = (y * width + x) * 4;
      const a = imageData[idx + 3];
      if (a < 128) continue;
      const r_ = imageData[idx];
      const g_ = imageData[idx + 1];
      const b_ = imageData[idx + 2];
      const lum = luminance({ r: r_, g: g_, b: b_ });
      const contrast = Math.abs(lum - bgLum) / 255;
      const chroma = colorChroma(r_, g_, b_, background);
      // Foreground = clearly different from the background in luminance or
      // chroma, or a colorful pixel standing out on a neutral background.
      if (contrast > 0.22 || chroma > 0.32) {
        grid[r * cols + c] = 1;
        rowProfile[r]++;
        colProfile[c]++;
      }
    }
  }

  return { grid, rows, cols, cellW, cellH, rowProfile, colProfile, width, height, background };
}

/** Approximate chroma difference vs the background in 0..1. */
function colorChroma(r, g, b, background) {
  const dr = Math.abs(r - background.r) / 255;
  const dg = Math.abs(g - background.g) / 255;
  const db = Math.abs(b - background.b) / 255;
  return Math.max(dr, dg, db);
}

/**
 * @typedef {Object} Component
 * @property {number} minX - cell index (column)
 * @property {number} maxX
 * @property {number} minY - cell index (row)
 * @property {number} maxY
 * @property {number} count  - number of foreground cells
 * @property {number} area   - count of cells
 * @property {number} dens   - count / bbox area (text is sparse, shapes dense)
 * @property {number} cx     - centroid cell x
 * @property {number} cy     - centroid cell y
 */

/**
 * Labels connected components (8-connectivity) on a mask grid.
 * @param {Uint8Array} grid
 * @param {number} rows
 * @param {number} cols
 * @returns {Component[]}
 */
export function labelComponents(grid, rows, cols) {
  const visited = new Uint8Array(rows * cols);
  const comps = [];
  const stack = new Int32Array(rows * cols * 2);
  const neighbors = [-1, 0, 1, -1, 1, 1, -1, 0, -1, -1, 0, 1, 1, -1, 1, 1];

  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || visited[start]) continue;

    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    // pre-seed with the start cell
    let minX = start % cols;
    let maxX = minX;
    let minY = (start / cols) | 0;
    let maxY = minY;
    let count = 0;
    let cx = 0;
    let cy = 0;

    while (top > 0) {
      const idx = stack[--top];
      const y = (idx / cols) | 0;
      const x = idx - y * cols;
      count++;
      cx += x;
      cy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let n = 0; n < neighbors.length; n += 2) {
        const nx = x + neighbors[n];
        const ny = y + neighbors[n + 1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nIdx = ny * cols + nx;
        if (!grid[nIdx] || visited[nIdx]) continue;
        visited[nIdx] = 1;
        stack[top++] = nIdx;
      }
    }

    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    comps.push({
      minX,
      maxX,
      minY,
      maxY,
      count,
      area: bboxW * bboxH,
      dens: count / (bboxW * bboxH),
      cx: cx / count,
      cy: cy / count,
    });
  }
  return comps;
}

/**
 * Average color of the ink inside a component, excluding background pixels.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {object} bboxPx - {x, y, width, height} in analysis px
 * @param {{r:number,g:number,b:number}} background
 * @param {number} [samples=6]
 */
export function averageColor(ctx, width, height, bboxPx, background, samples = 6) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(samples));
  for (let i = 0; i < step; i++) {
    for (let j = 0; j < step; j++) {
      const x = Math.min(width - 1, Math.round(bboxPx.x + ((i + 0.5) / step) * bboxPx.width));
      const y = Math.min(height - 1, Math.round(bboxPx.y + ((j + 0.5) / step) * bboxPx.height));
      const [pr, pg, pb, pa] = ctx.getImageData(x, y, 1, 1).data;
      if (pa < 128) continue;
      if (isNear({ r: pr, g: pg, b: pb }, background, 46)) continue;
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  if (n === 0) return rgbToHex(background.r, background.g, background.b);
  return rgbToHex(r / n, g / n, b / n);
}

/**
 * Converts a component + mask geometry into px-space bbox.
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function componentToPx(comp, { cellW, cellH, width, height }) {
  const x = comp.minX * cellW;
  const y = comp.minY * cellH;
  const w = (comp.maxX - comp.minX + 1) * cellW;
  const h = (comp.maxY - comp.minY + 1) * cellH;
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
    width: Math.max(1, Math.min(width - x, w)),
    height: Math.max(1, Math.min(height - y, h)),
  };
}