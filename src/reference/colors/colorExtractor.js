/**
 * Color extraction for reference images.
 *
 * Heuristic, deterministic, and dependency-free:
 *  - background  = median color of the outer border ring
 *  - dominant    = k-means-free color quantization of the interior
 *  - primary     = highest-contrast color vs. the background
 *  - accent      = most saturated standout color
 */

export function rgbToHex(r, g, b) {
  const to2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

export function luminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isLight(color) {
  return luminance(color) >= 150;
}

export function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** Max per-channel saturation (HSV) - higher = more colorful. */
export function saturation({ r, g, b }) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

export function isNear(a, b, tolerance = 40) {
  return colorDistance(a, b) <= tolerance;
}

/**
 * Average edge color = the background.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {number} [band] - border thickness in px to sample
 */
export function extractBackground(ctx, width, height, band = 4) {
  const thickness = Math.max(1, Math.min(band, Math.floor(Math.min(width, height) / 8)));
  const samples = [];
  for (let i = 0; i < width; i++) {
    for (let y of [Math.floor(thickness / 2), height - 1 - Math.floor(thickness / 2)]) {
      const [r, g, b, a] = ctx.getImageData(i, y, 1, 1).data;
      if (a < 128) continue;
      samples.push({ r, g, b });
    }
  }
  for (let j = 0; j < height; j++) {
    for (let x of [Math.floor(thickness / 2), width - 1 - Math.floor(thickness / 2)]) {
      const [r, g, b, a] = ctx.getImageData(x, j, 1, 1).data;
      if (a < 128) continue;
      samples.push({ r, g, b });
    }
  }
  if (samples.length === 0) return { r: 255, g: 255, b: 255 };
  const median = (key) => {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return { r: median("r"), g: median("g"), b: median("b") };
}

/**
 * Quantizes a sample set into dominant color buckets (fixed-bit quantization,
 * weighted by count). Excludes pixels near the background so the palette
 * reflects the content.
 * @param {Array<{r:number,g:number,b:number}>} samples
 * @param {{r:number,g:number,b:number}} background
 * @param {number} [maxColors]
 * @returns {Array<{hex:string, share:number, rgb:import("../../reference/colors/colorExtractor").Color}>}
 */
export function extractDominantColors(samples, background, maxColors = 5) {
  const bucketBits = 5; // 32 levels per channel
  const buckets = new Map();
  let total = 0;

  for (const s of samples) {
    if (isNear(s, background, 18)) continue;
    total++;
    const key = `${s.r >> (8 - bucketBits)}_${s.g >> (8 - bucketBits)}_${s.b >> (8 - bucketBits)}`;
    const entry = buckets.get(key) || { count: 0, rSum: 0, gSum: 0, bSum: 0 };
    entry.count++;
    entry.rSum += s.r;
    entry.gSum += s.g;
    entry.bSum += s.b;
    buckets.set(key, entry);
  }

  if (total === 0) return [];

  const ranked = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
  const colors = [];
  for (let i = 0; i < Math.min(maxColors, ranked.length); i++) {
    const [, entry] = ranked[i];
    if (entry.count / total < 0.02) continue;
    colors.push({
      hex: rgbToHex(entry.rSum / entry.count, entry.gSum / entry.count, entry.bSum / entry.count),
      share: entry.count / total,
      rgb: {
        r: entry.rSum / entry.count,
        g: entry.gSum / entry.count,
        b: entry.bSum / entry.count,
      },
    });
  }
  return colors;
}

/**
 * Full palette: background, primary (max contrast), accent (max saturation),
 * dominant swatches, and suggested text colors.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {Array<{r:number,g:number,b:number}>} samples
 * @param {{r:number,g:number,b:number}} backgroundRgb
 */
export function extractPalette(ctx, width, height, samples, backgroundRgb) {
  const background = rgbToHex(backgroundRgb.r, backgroundRgb.g, backgroundRgb.b);

  const dominant = extractDominantColors(samples, backgroundRgb).slice(0, 4);

  let primary = backgroundRgb;
  let primaryScore = -1;
  const allCandidates = [{ rgb: backgroundRgb, hex: rgbToHex(backgroundRgb.r, backgroundRgb.g, backgroundRgb.b) }, ...dominant];
  for (const c of allCandidates) {
    const d = colorDistance(c.rgb || c, backgroundRgb);
    if (d > primaryScore) {
      primaryScore = d;
      primary = c.rgb || c;
    }
  }

  let accent = null;
  let accentScore = -1;
  for (const c of allCandidates) {
    const sat = saturation(c.rgb || c);
    const dFromBg = colorDistance(c.rgb || c, backgroundRgb);
    if (c.hex !== background && sat * (dFromBg / 400 + 0.2) > accentScore) {
      accentScore = sat * (dFromBg / 400 + 0.2);
      accent = c;
    }
  }

  const light = isLight(backgroundRgb);
  const text = light ? "#1B1B1F" : "#FFFFFF";
  const subtext = light ? "#6E6E76" : "#C8C8D0";

  return {
    background,
    primary: rgbToHex(primary.r, primary.g, primary.b),
    accent: accent ? accent.hex : background === "#FFFFFF" ? "#6C6CFF" : background,
    dominant: dominant.map(({ hex, share }) => ({ hex, share })),
    text,
    subtext,
    isLight: light,
    colors: [background, ...dominant.map((d) => d.hex)],
  };
}