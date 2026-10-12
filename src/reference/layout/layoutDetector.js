/**
 * Layout (regions) detector.
 *
 * Detects horizontal bands (header / content / footer) and vertical columns
 * inside the content band from the foreground mask, then normalizes the
 * results into a LayoutAnalysis with relative sizes and margins.
 */

import { buildMask, labelComponents, componentToPx, averageColor } from "../imageParser/mask";

const LAYOUT_CELL = 10; // analysis px per mask cell

function runs(bools, minRunLen) {
  // Returns contiguous true-runs as [start, end] inclusive.
  const out = [];
  let i = 0;
  while (i < bools.length) {
    if (!bools[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < bools.length && bools[j + 1]) j++;
    const len = j - i + 1;
    if (len >= minRunLen) out.push([i, j]);
    i = j + 1;
  }
  return out;
}

/**
 * Detects layout regions and summarizes the composition.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{r:number,g:number,b:number}} background
 * @returns {Promise<import("../analysisTypes").LayoutAnalysis>}
 */
export async function detectLayout(ctx, width, height, background) {
  const mask = buildMask(ctx, width, height, background, LAYOUT_CELL);
  const { rows, cols, rowProfile, colProfile, cellW, cellH } = mask;

  const contentRows = new Array(rows).fill(false);
  for (let r = 0; r < rows; r++) contentRows[r] = rowProfile[r] >= Math.max(2, cols * 0.02 || 1);
  let minContentRow = rows;
  let maxContentRow = -1;
  for (let r = 0; r < rows; r++) {
    if (contentRows[r]) {
      if (r < minContentRow) minContentRow = r;
      if (r > maxContentRow) maxContentRow = r;
    }
  }
  if (maxContentRow < 0) {
    // Fully empty canvas - nothing to detect.
    return {
      type: "single_column",
      columns: 1,
      bands: 0,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      gap: 0,
      alignment: "center",
      regions: [],
    };
  }

  // --- horizontal bands ---
  // Collapse small gaps (< 2% of the canvas height) and drop noise bands.
  const maxGap = Math.max(1, Math.round(rows * 0.02));
  const minBandHeight = Math.max(2, Math.round(rows * 0.04));
  const raw = runs(contentRows, 1);
  const bandsFinal = mergeRuns(raw, rows, maxGap, minBandHeight);

  // --- margins ---
  let minCol = cols;
  let maxCol = -1;
  for (let r = minContentRow; r <= maxContentRow; r++) {
    for (let c = 0; c < cols; c++) {
      if (mask.grid[r * cols + c]) {
        if (c < minCol) minCol = c;
        if (c > maxCol) maxCol = c;
      }
    }
  }
  const margins = {
    top: Math.round(minContentRow * cellH),
    right: Math.round((cols - 1 - maxCol) * cellW),
    bottom: Math.round((rows - 1 - maxContentRow) * cellH),
    left: Math.round(minCol * cellW),
  };

  // --- classify bands ---
  const regions = [];
  const bandObjects = bandsFinal.map(([top, bottom]) => ({
    top,
    bottom,
    height: bottom - top + 1,
  }));
  bandObjects.sort((a, b) => b.height - a.height);

  const totalContentHeight = maxContentRow - minContentRow + 1;
  const widest = bandObjects[0];

  for (let i = 0; i < bandsFinal.length; i++) {
    const [top, bottom] = bandsFinal[i];
    const bandH = bottom - top + 1;
    let role = "content";
    if (bandsFinal.length > 1) {
      if (i === 0 && bandH < totalContentHeight * 0.35) role = "header";
      else if (i === bandsFinal.length - 1 && bandH < totalContentHeight * 0.3) role = "footer";
      else if (bandH === widest.height) role = bandsFinal.length > 2 ? "hero" : "content";
      else role = "section";
    }
    regions.push(...detectColumnsInBand(mask, top, bottom, role));
  }

  // --- gap & alignment ---
  const gaps = [];
  for (let r = 1; r < rows; r++) {
    if (contentRows[r] && !contentRows[r - 1]) {
      let len = 0;
      for (let k = r - 1; k >= 0 && !contentRows[k]; k--) len++;
      if (len > 0 && len <= rows * 0.15) gaps.push(len * cellH);
    }
  }
  for (let c = 1; c < cols; c++) {
    if (colProfile[c] > 0 && colProfile[c - 1] === 0) {
      let len = 0;
      for (let k = c - 1; k >= 0 && colProfile[k] === 0; k--) len++;
      if (len > 0 && len <= cols * 0.12) gaps.push(len * cellW);
    }
  }
  const gap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;

  let inkCxSum = 0;
  let inkN = 0;
  for (let r = minContentRow; r <= maxContentRow; r++) {
    for (let c = 0; c < cols; c++) {
      if (mask.grid[r * cols + c]) {
        inkCxSum += c;
        inkN++;
      }
    }
  }
  const inkCenterX = inkN ? inkCxSum / inkN : cols / 2;
  const canvasCenter = cols / 2;
  let alignment = "mixed";
  if (Math.abs(inkCenterX - canvasCenter) <= cols * 0.04) alignment = "center";
  else if (inkCenterX < canvasCenter) alignment = "left";
  else alignment = "right";

  const columnCount = regions.filter((r) => r.role && r.role.endsWith("_column")).length || 1;
  const type =
    columnCount >= 3 ? "three_column" : columnCount === 2 ? "two_column" : bandsFinal.length > 1 ? "stacked" : alignment === "center" ? "centered" : "single_column";

  return {
    type,
    columns: columnCount,
    bands: bandsFinal.length,
    margins,
    gap,
    alignment,
    regions,
  };
}

function mergeRuns(runsList, rows, maxGap, minBandHeight) {
  // Merge runs separated by <= maxGap empty rows; then drop tiny bands under
  // minBandHeight (unless they are the only content).
  const merged = [];
  for (const [s, e] of runsList) {
    const last = merged[merged.length - 1];
    if (last && s - last[1] - 1 <= maxGap && e - last[1] <= rows * 0.1) {
      last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  const kept = merged.filter(([s, e]) => e - s + 1 >= minBandHeight || merged.length === 1);
  return kept.length ? kept : (merged.length ? merged : runsList);
}

function detectColumnsInBand(mask, topRow, bottomRow, role) {
  const bandH = bottomRow - topRow + 1;
  const { cols, cellW, cellH, grid } = mask;

  // Column profile inside the band.
  const bandCols = new Array(cols).fill(false);
  for (let c = 0; c < cols; c++) {
    let count = 0;
    for (let r = topRow; r <= bottomRow; r++) {
      if (grid[r * cols + c]) count++;
    }
    bandCols[c] = (count / bandH) >= 0.12;
  }

  const colRuns = runs(bandCols, Math.max(2, Math.round(cols * 0.04)));
  if (colRuns.length <= 1) {
    return [
      {
        id: kebab(role),
        role: bandRole(role, "band"), // e.g. content, header, footer
        x: Math.round(0),
        y: Math.round(topRow * cellH),
        width: Math.round(cols * cellW),
        height: Math.round(bandH * cellH),
        relativeWidth: 1,
        relativeHeight: Math.round(bandH * cellH) / Math.max(1, mask.height),
      },
    ];
  }

  // Ink density per column → the least-dense column is the "visual" one.
  const densities = colRuns.map(([s, e]) => {
    let ink = 0;
    const cells = (e - s + 1) * bandH;
    for (let c = s; c <= e; c++) {
      for (let r = topRow; r <= bottomRow; r++) {
        if (grid[r * cols + c]) ink++;
      }
    }
    return { s, e, density: ink / Math.max(1, cells) };
  });

  return densities.map(({ s, e, density }, i) => {
    let colRole = "content";
    if (colRuns.length === 2) {
      colRole = i === 0 ? "left_content" : "right_visual";
      if (density < 0.04) {
        colRole = i === 0 ? "left_visual" : "right_content";
      }
    } else if (colRuns.length === 3) {
      colRole = ["left_content", "center_content", "right_visual"][i] || "content";
    }
    return {
      id: colRole,
      role: colRole,
      x: Math.round(s * cellW),
      y: Math.round(topRow * cellH),
      width: Math.round((e - s + 1) * cellW),
      height: Math.round(bandH * cellH),
      relativeWidth: Math.round(((e - s + 1) * cellW) / mask.width * 100) / 100,
      relativeHeight: Math.round((bandH * cellH) / mask.height * 100) / 100,
    };
  });
}

function bandRole(role) {
  const map = { header: "header", footer: "footer", hero: "hero", content: "content", section: "section" };
  return map[role] || "content";
}

function kebab(s) {
  return s.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

/**
 * Detects large image-like blobs (dense pixel areas that look like a photo).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{r,g,b}} background
 * @returns {Array<{x,y,width,height,color,role}>} image candidates in analysis px
 */
export function detectImageBlobs(ctx, width, height, background) {
  const mask = buildMask(ctx, width, height, background, 6);
  const comps = labelComponents(mask.grid, mask.rows, mask.cols);
  const out = [];
  const minArea = mask.width * mask.height * 0.08;
  for (const comp of comps) {
    const px = componentToPx(comp, mask);
    const area = px.width * px.height;
    if (area < minArea || comp.dens < 0.35) continue;
    out.push({
      x: Math.round(px.x),
      y: Math.round(px.y),
      width: Math.round(px.width),
      height: Math.round(px.height),
      color: averageColor(ctx, width, height, px, background),
      role: "image",
    });
  }
  return out;
}