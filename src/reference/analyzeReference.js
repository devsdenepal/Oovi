/**
 * Reference Design Understanding - the public facade.
 *
 * analyzeReferenceImage(image) -> Promise<ReferenceDesignAnalysis>
 *
 * Runs the heuristic extractors (colors, layout, text regions, shapes,
 * decorations) plus the optional OCR pass, then assembles a normalized,
 * strongly-typed analysis document. This is the ONLY entry point the rest
 * of the app (prompt builder / debug UI) is allowed to use - swapping the
 * parser for a vision model later is a change local to this directory.
 *
 * Provider-agnostic by design: the raw image is never sent to the text LLM;
 * only this analysis is.
 */

import { decodeImage, downscale, samplePixels } from "./imageParser/preprocess";
import { extractBackground, extractPalette } from "./colors/colorExtractor";
import { detectLayout, detectImageBlobs } from "./layout/layoutDetector";
import { detectTextRegions } from "./text/textRegionDetector";
import { detectShapes } from "./shapes/shapeDetector";
import { detectDecorations } from "./decorations/decorations";
import { recognizeText } from "./ocr/ocrProvider";
import { OcrStatus, SEMANTIC_ANALYSIS_VERSION } from "./analysisTypes";

/** analysis px -> original image px */
function scaleBoxes(list, scale) {
  if (!Array.isArray(list)) return list;
  return list.map((b) => {
    const out = { ...b };
    for (const key of ["x", "y", "width", "height", "radius", "cornerRadius", "spacing", "estimatedFontSize"]) {
      if (typeof b[key] === "number" && key !== "count") out[key] = Math.round(b[key] * scale);
    }
    return out;
  });
}

function buildTypography(textRegions) {
  const sorted = [...textRegions]
    .filter((t) => t.height > 0)
    .sort((a, b) => b.estimatedFontSize - a.estimatedFontSize);

  const hierarchy = [];
  const maxSize = sorted[0]?.estimatedFontSize || 16;
  for (const t of sorted) {
    const ratio = t.estimatedFontSize / Math.max(1, maxSize);
    const role = ratio >= 0.75 ? "headline" : ratio >= 0.5 ? "subtitle" : ratio >= 0.3 ? "body" : "caption";
    hierarchy.push({ role, estimatedFontSize: t.estimatedFontSize, weight: t.weight, color: t.color });
  }

  let alignment = "left";
  if (sorted.length) {
    const center = sorted.filter((t) => t.alignment === "center").length;
    const right = sorted.filter((t) => t.alignment === "right").length;
    if (center > sorted.length / 2) alignment = "center";
    else if (right > sorted.length / 3) alignment = "right";
  }

  let casing = "mixed";
  const withContent = sorted.filter((t) => typeof t.content === "string" && t.content.length);
  if (withContent.length) {
    const words = withContent.map((t) => t.content.split(/\s+/)).flat();
    const upper = words.filter((w) => /^[A-Z0-9]+[.,!?'"-]*$/.test(w)).length;
    if (upper > words.length * 0.6) casing = "upper";
    else if (words.length > 0 && upper > words.length * 0.15) casing = "title";
  }

  return { hierarchy, emphasis: { alignment, casing } };
}

function buildSummary(analysis) {
  const { canvas, palette, layout, typography, elements, source, ocr } = analysis;
  const s = (n, w = "s") => (n === 1 ? w : w + "s");
  const lines = [];
  lines.push(
    `Reference image: ${canvas.width}x${canvas.height}px (aspect ${canvas.aspectRatio.toFixed(2)}${source.fileName ? `, "${source.fileName}"` : ""}).`,
  );
  if (source.hasBackgroundImage) {
    lines.push("Full-bleed background image detected and ignored for layout (flat background assumed).");
  }
  lines.push(
    `Palette: background ${palette.background}, primary ${palette.primary}, accent ${palette.accent}${palette.dominant.length ? `, dominant ${palette.dominant.map((d) => d.hex).join(", ")}` : ""} (${palette.isLight ? "light" : "dark"} background).`,
  );
  lines.push(
    `Composition: ${layout.type.replace(/_/g, " ")} layout, ${layout.bands} horizontal ${s(layout.bands, "band")}, aligned ${layout.alignment}; margins ${layout.margins.top}/${layout.margins.right}/${layout.margins.bottom}/${layout.margins.left}px, gutters ~${layout.gap}px.`,
  );
  if (layout.regions.length) {
    lines.push(
      `Regions: ${layout.regions
        .map((r) => `${r.role} (${Math.round(r.relativeWidth * 100)}%x${Math.round(r.relativeHeight * 100)}%)`)
        .join(", ")}.`,
    );
  }
  if (typography.hierarchy.length) {
    lines.push(
      `Typography (${typography.style}): ${typography.hierarchy
        .map((h) => `${h.role} ~${h.estimatedFontSize}px ${h.weight}`)
        .join(", ")}.`,
    );
  }
  const recognized = elements.text.filter((t) => typeof t.content === "string" && t.content.length).length;
  lines.push(
    `Elements: ${elements.text.length} text ${s(elements.text.length, "line")}${recognized ? ` (OCR recognized ${recognized})` : ""}, ${elements.images.length} image ${s(elements.images.length, "area")}, ${elements.shapes.length} shape${elements.shapes.length === 1 ? "" : "s"}, ${elements.decorations.length} decoration${elements.decorations.length === 1 ? "" : "s"}.`,
  );
  if (ocr.status !== OcrStatus.OK && ocr.status !== OcrStatus.REGION_ONLY) {
    lines.push(`Note: ${ocr.notes || "OCR unavailable."}`);
  }
  return lines.join("\n");
}

function buildStyleLabel(layout, typography) {
  const parts = [];
  if (typography.emphasis.alignment === "center") parts.push("centered");
  else parts.push(layout.alignment === "right" ? "right_aligned" : "left_aligned");
  if (layout.type === "two_column") parts.push("split");
  else if (layout.type === "three_column") parts.push("multi_column");
  else if (layout.bands > 1) parts.push("stacked");
  else parts.push("single_column");
  return parts.join("_");
}

/**
 * Analyzes a reference image.
 *
 * @param {File|Blob|string|HTMLImageElement} image
 * @param {{maxDim?:number, runOcr?:boolean}} [options]
 * @returns {Promise<import("./analysisTypes").ReferenceDesignAnalysis>}
 */
export async function analyzeReferenceImage(image, options = {}) {
  const img = await decodeImage(image);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  const { canvas, ctx, scale } = downscale(img, options.maxDim || 480);
  const width = canvas.width;
  const height = canvas.height;

  const backgroundRgb = extractBackground(ctx, width, height);
  const samples = samplePixels(ctx, width, height, 4);
  const palette = extractPalette(ctx, width, height, samples, backgroundRgb);

  // --- analysis-bitmap space ---
  const layoutRaw = await detectLayout(ctx, width, height, backgroundRgb);
  let textRegions = await detectTextRegions(ctx, width, height, backgroundRgb);
  const shapes = await detectShapes(ctx, width, height, backgroundRgb);
  const blobResult = await detectImageBlobs(ctx, width, height, backgroundRgb);
  const imageBlobs = blobResult.images;
  const hasBackgroundImage = blobResult.backgroundImage;

  // --- OCR (optional, fills text content) ---
  let ocr = {
    status: OcrStatus.UNAVAILABLE,
    units: 0,
    notes: undefined,
  };
  if (options.runOcr !== false) {
    const result = await recognizeText(canvas, textRegions);
    ocr = { status: result.status, units: result.units, notes: result.notes };
    if (result.status === OcrStatus.OK || result.status === OcrStatus.REGION_ONLY) {
      textRegions = result.regions;
    }
  }

  const visualRegions = hasBackgroundImage
    ? []
    : layoutRaw.regions.filter((r) => r.role.includes("visual"));
  const decorations = await detectDecorations(ctx, width, height, backgroundRgb, textRegions, shapes);

  // --- image areas: visual column slots + the single hero blob, deduped ---
  // Background/asset imagery (characters, icons, photos) is deliberately
  // ignored: it cannot be reproduced by the layout engine and only pollutes
  // the composition guide. At most one prominent visual area is kept.
  const imageAreas = [];
  for (const v of visualRegions) {
    imageAreas.push({ id: `image_slot_${imageAreas.length + 1}`, role: "image", ...v });
  }
  imageBlobs.forEach((b, i) => {
    const tooClose = imageAreas.some(
      (a) =>
        b.x < a.x + a.width &&
        b.x + b.width > a.x &&
        b.y < a.y + a.height &&
        b.y + b.height > a.y,
    );
    if (!tooClose) imageAreas.push({ id: `image_${i + 1}`, role: "image", ...b });
  });

  // --- typography ---
  const typography = buildTypography(textRegions);
  const style = buildStyleLabel(layoutRaw, typography);
  const typographyFinal = { ...typography, style };

  // --- scale everything to original image px ---
  const layoutRegions = scaleBoxes(layoutRaw.regions, scale);
  const layout = {
    ...layoutRaw,
    margins: {
      top: Math.round(layoutRaw.margins.top * scale),
      right: Math.round(layoutRaw.margins.right * scale),
      bottom: Math.round(layoutRaw.margins.bottom * scale),
      left: Math.round(layoutRaw.margins.left * scale),
    },
    gap: Math.round((layoutRaw.gap || 0) * scale),
    regions: layoutRegions,
  };

  const elements = {
    text: scaleBoxes(textRegions, scale),
    images: scaleBoxes(imageAreas, scale),
    shapes: scaleBoxes(shapes, scale),
    decorations: scaleBoxes(decorations, scale),
  };

  const kind =
    image instanceof File ? "image_file" : typeof image === "string" ? "image_data" : "image_element";
  const source = {
    kind,
    fileName: image instanceof File ? image.name : undefined,
    width: srcW,
    height: srcH,
    aspectRatio: Math.round((srcW / Math.max(1, srcH)) * 100) / 100,
    hasBackgroundImage,
  };
  const analysis = {
    version: SEMANTIC_ANALYSIS_VERSION,
    source,
    canvas: { width: srcW, height: srcH, aspectRatio: source.aspectRatio },
    palette,
    layout,
    typography: typographyFinal,
    elements,
    ocr,
  };
  analysis.summary = buildSummary(analysis);
  return analysis;
}