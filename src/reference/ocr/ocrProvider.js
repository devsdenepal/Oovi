/**
 * OCR provider abstraction.
 *
 * The reference parser MUST NOT force the image into the text LLM - at most
 * it locally recognizes text so the analysis can contain real copy.
 *
 * This module is the single seam for OCR. It ships with a dependency-free
 * "region-only" mode (text boundaries detected, no content) and optionally
 * upgrades to real OCR when the tesseract.js package is importable. Any
 * future vision/OCR provider plugs in here without touching the rest of the
 * parser, the prompt builder, or the app.
 */

import { OcrStatus } from "../analysisTypes";

let tesseractPromise = null;

/**
 * Lazily loads the tesseract.js module. Returns null when unavailable.
 * @returns {Promise<object|null>}
 */
async function loadTesseract() {
  if (tesseractPromise === null) {
    tesseractPromise = import("tesseract.js")
      .then((mod) => mod)
      .catch(() => null);
  }
  return tesseractPromise;
}

/**
 * Recognizes text in the analysis bitmap and attributes words to regions.
 *
 * @param {HTMLCanvasElement} canvas   - analysis-resolution canvas
 * @param {import("../analysisTypes").TextRegionAnalysis[]} regions - original-px regions
 * @param {{scale:number}} opts
 * @returns {Promise<{status:string, regions:import("../analysisTypes").TextRegionAnalysis[], units:number, notes?:string}>}
 */
export async function recognizeText(canvas, regions, opts) {
  const Tesseract = await loadTesseract();
  if (!Tesseract || !Tesseract.createWorker) {
    return {
      status: OcrStatus.UNAVAILABLE,
      regions: regions.map((r) => ({ ...r, content: null, confidence: 0 })),
      units: 0,
      notes: "OCR engine unavailable (tesseract.js not installed)",
    };
  }

  // Downscale to the analysis bitmap the mask detectors already used.
  const scale = opts.scale || 1;
  const w = Math.round(canvas.width / scale);
  const h = Math.round(canvas.height / scale);
  const work = document.createElement("canvas");
  work.width = Math.max(1, w);
  work.height = Math.max(1, h);
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  workCtx.drawImage(canvas, 0, 0, work.width, work.height);

  let data;
  let worker = null;
  try {
    worker = await Tesseract.createWorker("eng", 1, {
      logger: () => {},
    });
    const result = await worker.recognize(work);
    data = result?.data || null;
  } catch {
    try {
      if (worker && typeof worker.terminate === "function") await worker.terminate();
    } catch {
      // ignore cleanup failures
    }
    return {
      status: OcrStatus.UNAVAILABLE,
      regions: regions.map((r) => ({ ...r, content: null, confidence: 0 })),
      units: 0,
      notes: "OCR failed (network/lang-data unavailable). Detected text regions only.",
    };
  }

  try {
    if (worker && typeof worker.terminate === "function") await worker.terminate();
  } catch {
    // ignore
  }

  if (!data || !Array.isArray(data.words)) {
    return {
      status: OcrStatus.REGION_ONLY,
      regions: regions.map((r) => ({ ...r, content: null, confidence: 0 })),
      units: regions.length,
      notes: "OCR produced no words.",
    };
  }

  const words = [];
  for (const word of data.words) {
    if (!word || !word.text) continue;
    const t = String(word.text).trim();
    if (!t) continue;
    const bbox = word.bbox || word;
    words.push({
      text: t,
      x: bbox.x0 * scale,
      y: bbox.y0 * scale,
      width: Math.abs((bbox.x1 ?? bbox.x0 + 1) - bbox.x0) * scale,
      height: Math.abs((bbox.y1 ?? bbox.y0 + 1) - bbox.y0) * scale,
      confidence: word.confidence || 0,
    });
  }

  const withContent = regions.map((region) => {
    const matched = words
      .filter((w) => {
        const cx = w.x + w.width / 2;
        const cy = w.y + w.height / 2;
        return (
          cx >= region.x &&
          cx <= region.x + region.width &&
          cy >= region.y &&
          cy <= region.y + region.height
        );
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (matched.length === 0) return { ...region, content: null, confidence: 0 };
    return {
      ...region,
      content: matched.map((m) => m.text).join(" "),
      confidence: Math.round(matched.reduce((s, m) => s + m.confidence, 0) / matched.length) / 100,
    };
  });

  return { status: OcrStatus.OK, regions: withContent, units: words.length };
}

/** Text-only consumer hook (kept as the extension seam for future providers). */
export const ocrPreferences = { language: "eng" };