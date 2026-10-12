/**
 * Type scale - maps semantic size tokens to pixel font sizes.
 *
 * Sizes are RELATIVE to the canvas height so designs scale predictably and
 * the model never has to reason about absolute pixels.
 */

export const SIZE_FACTORS = Object.freeze({
  display: 0.085,
  headline: 0.06,
  title: 0.045,
  subtitle: 0.032,
  body: 0.022,
  caption: 0.015,
  small: 0.011,
});

export const WEIGHT_TO_NUMBER = Object.freeze({
  thin: 100,
  extralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Resolves a size token / explicit px into a pixel font size.
 * @param {string|number} token
 * @param {number} canvasHeight - reference resolution height
 */
export function sizeToPx(token, canvasHeight) {
  const cap = clamp(canvasHeight * 0.4, 32, 400);
  if (typeof token === "number") {
    return clamp(Math.round(token), 8, cap);
  }
  if (typeof token === "string") {
    const key = token.trim().toLowerCase();
    const factor = SIZE_FACTORS[key];
    if (factor !== undefined) return clamp(Math.round(canvasHeight * factor), 8, cap);
    const px = parseInt(token, 10);
    if (!Number.isNaN(px)) return clamp(px, 8, cap);
  }
  return clamp(Math.round(canvasHeight * SIZE_FACTORS.body), 8, cap);
}

/**
 * Converts a weight name or number into a numeric CSS weight (100-900).
 * @param {string|number} [weight]
 */
export function weightToNumber(weight) {
  if (typeof weight === "number") return clamp(Math.round(weight), 100, 900);
  if (typeof weight === "string") {
    const key = weight.trim().toLowerCase();
    if (WEIGHT_TO_NUMBER[key] !== undefined) return WEIGHT_TO_NUMBER[key];
    const n = parseInt(weight, 10);
    if (!Number.isNaN(n)) return clamp(n, 100, 900);
  }
  return 400;
}

/**
 * Resolves an aspect ratio value into a numeric w/h ratio.
 * @param {string|number} [ratio]
 */
export function aspectToNumber(ratio) {
  if (typeof ratio === "number") return ratio > 0 ? ratio : null;
  if (typeof ratio === "string") {
    const parts = ratio.trim().split(/[:x/]/).map(Number);
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) return parts[0] / parts[1];
    const single = parseFloat(ratio);
    if (single > 0) return single;
  }
  return null;
}