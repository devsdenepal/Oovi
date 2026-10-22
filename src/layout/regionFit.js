/**
 * Region fitting (live-fire finding, Phase 3).
 *
 * L4 is asked to fill ONE reserved box, and the plan states that the box and
 * the type size are fixed. The model can still return a region that renders
 * bigger than its box. Measured live on the Diwali poster: a `tagline-line`
 * slot of 1072x144 came back with text whose rendered extent was ~4x the
 * reserved rectangle, and three elements across two regions rendered outside
 * the canvas. Nothing caught it:
 *
 *   - the design validator checks each element's DECLARED x/y/width against the
 *     canvas, not the extent the type actually paints;
 *   - the quality gate's per-component check looks for UNDER-filled sections,
 *     never for overflow.
 *
 * So the correction is deterministic, applied to the region's own elements
 * before they reach the editor, and it keeps the composition intact:
 *
 *   1. type is capped at the size the template fixed | the prompt already says
 *      "keep the type at this size", this makes it true;
 *   2. if the region still renders outside its reservation, the whole region is
 *      scaled about the box origin, uniformly, so an icon keeps its place beside
 *      its label.
 *
 * Pure geometry: no Fabric, no network.
 */

import { elementBoxes } from "../ai/quality";

/** A region may miss its reservation by this many px (grid rounding) free. */
const SLACK = 2;
/** Type may exceed the planned size by this much before it is capped. */
const TYPE_TOLERANCE = 1.15;
/** Below this, copy is unreadable at export; the fitter warns instead of lying. */
const MIN_READABLE = 12;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Union of every rendered extent in a region. */
export function regionExtent(elements) {
  const boxes = elementBoxes(elements);
  if (!boxes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.box.x);
    y1 = Math.min(y1, b.box.y);
    x2 = Math.max(x2, b.box.x + b.box.w);
    y2 = Math.max(y2, b.box.y + b.box.h);
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

/**
 * Cap text sizes at the region's own size. The plan fixed the type because the
 * box is fixed; a region writing 130px into a 20px slot is not a style choice,
 * it is a spilled region.
 */
export function clampRegionType(elements, fontSize, opts = {}) {
  const planned = num(fontSize);
  if (!planned || planned <= 0) return elements;
  const cap = planned * (opts.tolerance ?? TYPE_TOLERANCE);
  let changed = false;
  const out = (elements || []).map((el) => {
    if (!el || el.type !== "text") return el;
    const size = num(el.fontSize);
    if (!size || size <= cap) return el;
    changed = true;
    return { ...el, fontSize: Math.max(MIN_READABLE, Math.round(cap)) };
  });
  return changed ? out : elements;
}

/**
 * Scale + translate a region so it renders inside `box`.
 *
 * Never enlarges: a region that renders smaller than its reservation is an
 * under-fill, which the quality gate already reports | silently blowing it up
 * would hide that signal.
 *
 * @param {Array} elements the model's elements for this region
 * @param {{x:number,y:number,width:number,height:number}} box reserved box, px
 * @returns {Array} the same array when nothing needed fixing
 */
export function fitElementsToBox(elements, box, opts = {}) {
  if (!Array.isArray(elements) || !elements.length) return elements;
  const bw = num(box?.width);
  const bh = num(box?.height);
  const bx = num(box?.x);
  const by = num(box?.y);
  if (bw === null || bh === null || bx === null || by === null || bw <= 0 || bh <= 0) return elements;

  const slack = opts.slack ?? SLACK;
  const extent = opts.extent || regionExtent(elements);
  if (!extent || !(extent.w > 0) || !(extent.h > 0)) return elements;

  const overflows =
    extent.x1 < bx - slack || extent.x2 > bx + bw + slack || extent.y1 < by - slack || extent.y2 > by + bh + slack;
  if (!overflows) return elements;

  const scale = Math.min(1, (bw - slack * 2) / extent.w, (bh - slack * 2) / extent.h);
  if (!(scale > 0)) return elements;
  if (scale >= 1) {
    // The region is no bigger than its reservation but is drawn OFF it (a
    // model that ignores x/y and paints at the canvas origin, or at the wrong
    // edge). Scaling cannot fix an offset, and returning it unchanged left the
    // region outside its slot. Translate it in, which preserves the composition
    // the model drew and makes the template box authoritative.
    const dx =
      extent.x1 < bx + slack
        ? bx + slack - extent.x1
        : extent.x2 > bx + bw - slack
          ? bx + bw - slack - extent.x2
          : 0;
    const dy =
      extent.y1 < by + slack
        ? by + slack - extent.y1
        : extent.y2 > by + bh - slack
          ? by + bh - slack - extent.y2
          : 0;
    if (!dx && !dy) return elements;
    const tx = (v) => Math.round(v + dx);
    const ty = (v) => Math.round(v + dy);
    return elements.map((el) => {
      if (!el || typeof el !== "object") return el;
      const next = { ...el };
      if (num(next.x) !== null) next.x = tx(next.x);
      if (num(next.y) !== null) next.y = ty(next.y);
      if (num(next.x2) !== null) next.x2 = tx(next.x2);
      if (num(next.y2) !== null) next.y2 = ty(next.y2);
      return next;
    });
  }

  // Fold the scale and the translation into one map: the region's own top-left
  // lands at the box's top-left (plus slack), so the fit is exact.
  const shiftX = bx + slack - extent.x1 * scale;
  const shiftY = by + slack - extent.y1 * scale;
  const px = (v) => Math.round(v * scale + shiftX);
  const py = (v) => Math.round(v * scale + shiftY);
  const size = (v) => Math.max(1, Math.round(v * scale));

  return elements.map((el) => {
    if (!el || typeof el !== "object") return el;
    const next = { ...el };
    if (num(next.x) !== null) next.x = px(next.x);
    if (num(next.y) !== null) next.y = py(next.y);
    if (num(next.x2) !== null) next.x2 = px(next.x2);
    if (num(next.y2) !== null) next.y2 = py(next.y2);
    for (const key of ["width", "height", "radius", "fontSize", "lineHeight"]) {
      const v = num(next[key]);
      if (v !== null && v > 0) next[key] = size(v);
    }
    const sw = num(next.strokeWidth);
    if (sw !== null && sw > 0) next.strokeWidth = Math.max(1, Math.round(sw * scale));
    return next;
  });
}

/**
 * The whole correction for one region: planned type, then fit to the box.
 * Returns `{elements, notes}` | notes are what the console reports, so a
 * correction is never silent.
 */
export function fitRegion(elements, component, opts = {}) {
  const notes = [];
  if (!Array.isArray(elements) || !elements.length) return { elements, notes };
  let out = elements;
  const typed = clampRegionType(out, component?.fontSize, opts);
  if (typed !== out) {
    out = typed;
    notes.push(`type capped at ${Math.round(Number(component.fontSize) * (opts.tolerance ?? TYPE_TOLERANCE))}px`);
  }
  const fitted = fitElementsToBox(out, component?.box, opts);
  if (fitted !== out) {
    const extent = regionExtent(fitted);
    const smallest = fitted
      .filter((e) => e && e.type === "text")
      .reduce((min, e) => Math.min(min, Number(e.fontSize) || Infinity), Infinity);
    notes.push(`scaled to fit ${Math.round(component.box.width)}x${Math.round(component.box.height)}`);
    if (smallest < MIN_READABLE) notes.push(`copy is now ${Math.round(smallest)}px | unreadably small`);
    if (extent) notes.push(`extent ${Math.round(extent.w)}x${Math.round(extent.h)}`);
    out = fitted;
  }
  return { elements: out, notes };
}
