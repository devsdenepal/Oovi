/**
 * Image preprocessing for the reference parser.
 *
 * Decodes an uploaded image (File / Blob / data URL / HTMLImageElement),
 * downscales it to a fixed analysis resolution, and exposes pixel sampling
 * helpers used by the color, layout and shape detectors.
 */

/** Default max dimension of the analysis bitmap (keeps parsing fast). */
const ANALYSIS_MAX_DIM = 480;

/**
 * Decodes an image source into a loaded HTMLImageElement.
 * @param {File|Blob|string|HTMLImageElement} input
 * @returns {Promise<HTMLImageElement>}
 */
export async function decodeImage(input) {
  if (input instanceof HTMLImageElement && input.complete && input.naturalWidth > 0) {
    return input;
  }

  const url =
    typeof input === "string"
      ? input
      : URL.createObjectURL(input instanceof Blob ? input : input);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      if (typeof input !== "string") URL.revokeObjectURL(url);
      reject(new Error("Could not decode the reference image (unsupported format or corrupt file)."));
    };
    img.src = url;
  });
}

/**
 * Downsizes an image bitmap to a working canvas no larger than maxDim.
 * @param {HTMLImageElement} img
 * @param {number} [maxDim=ANALYSIS_MAX_DIM]
 * @returns {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, scale:number}}
 *          scale = analysis px -> original image px multiplier
 */
export function downscale(img, maxDim = ANALYSIS_MAX_DIM) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) {
    throw new Error("Reference image has no usable dimensions.");
  }

  const ratio = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * ratio));
  const h = Math.max(1, Math.round(srcH * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  return { canvas, ctx, scale: srcW / w };
}

/**
 * Samples pixels on a coarse grid.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {number} step  - sample every `step` px
 * @returns {Array<{r:number,g:number,b:number}>} opaque RGB samples
 */
export function samplePixels(ctx, width, height, step) {
  const samples = [];
  for (let y = Math.min(step, Math.floor(height / 2)); y < height; y += step) {
    for (let x = Math.min(step, Math.floor(width / 2)); x < width; x += step) {
      const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
      if (a < 128) {
        samples.push({ r: 255, g: 255, b: 255, a: 0 });
        continue;
      }
      samples.push({ r, g, b, a });
    }
  }
  return samples;
}

/** Fill color of a target cell in the analysis bitmap. */
export function pixelAt(ctx, width, height, x, y, fallback) {
  const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const [r, g, b, a] = ctx.getImageData(cx, cy, 1, 1).data;
  if (a < 128) return fallback;
  return { r, g, b };
}