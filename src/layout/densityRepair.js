/**
 * Deterministic density repair.
 *
 * The quality gate measures what actually rendered. When a text region fills
 * too little of its reserved box, or the design carries fewer decoration
 * pieces than the dense default, this module adds deliberate composition —
 * a backing frame, an accent rail, a rule and a few dots — from the design's
 * own palette. It never invents copy, never changes the template, and never
 * replaces a region the model already filled.
 *
 * Inputs are the report's own metrics plus the active plan, so the repair is
 * anchored to the same boxes the layout was built from.
 */

import { FEATURES } from "../config/features";
import { ensurePaletteRoles } from "./paletteRoles";
import { buildDecorations } from "./decorations";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value) => Math.round(Number(value) || 0);

function elementIds(design) {
  const ids = new Set();
  const walk = (elements) => {
    for (const element of elements || []) {
      if (element && typeof element.id === "string") ids.add(element.id);
      if (element?.type === "group") walk(element.children);
    }
  };
  walk(design?.elements);
  return ids;
}

function uniqueId(used, base) {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function circle(id, cx, cy, radius, fill, extra = {}) {
  return {
    id,
    type: "circle",
    role: "decoration",
    x: round(cx - radius),
    y: round(cy - radius),
    radius: Math.max(1, round(radius)),
    fill,
    ...extra,
  };
}

function line(id, x1, y1, x2, y2, stroke, strokeWidth, extra = {}) {
  return {
    id,
    type: "line",
    role: "decoration",
    x: round(x1),
    y: round(y1),
    x2: round(x2),
    y2: round(y2),
    stroke,
    strokeWidth: Math.max(1, Math.round(strokeWidth)),
    ...extra,
  };
}

/**
 * One backing composition for a text region that is visually under-filled.
 * All pieces sit behind the region's text when inserted at the bottom of the
 * stack, so the copy stays readable.
 */
function frameFor(component, roles, used) {
  const box = component.box;
  const width = Number(box?.width) || 0;
  const height = Number(box?.height) || 0;
  if (width <= 0 || height <= 0) return [];
  const minDim = Math.min(width, height);
  const inset = clamp(round(minDim * 0.045), 3, 14);
  const railWidth = clamp(round(minDim * 0.018), 3, 10);
  const dots = clamp(Math.round(width / 120), 2, 4);
  const dotRadius = clamp(round(minDim * 0.012), 1.5, 4.5);
  const base = `${component.id}-density`;
  const out = [];

  out.push({
    id: uniqueId(used, `${base}-frame`),
    type: "rectangle",
    role: "decoration",
    x: round(box.x),
    y: round(box.y),
    width: Math.max(1, round(width)),
    height: Math.max(1, round(height)),
    fill: roles.background,
    stroke: roles.border,
    strokeWidth: Math.max(1, round(minDim * 0.004)),
    cornerRadius: clamp(round(minDim * 0.04), 0, 18),
    opacity: 0.96,
  });
  out.push({
    id: uniqueId(used, `${base}-rail`),
    type: "rectangle",
    role: "decoration",
    x: round(box.x + inset),
    y: round(box.y + inset),
    width: Math.max(1, railWidth),
    height: Math.max(1, round(height * 0.56)),
    fill: roles.accent,
    cornerRadius: Math.max(1, Math.round(railWidth / 2)),
  });
  out.push(
    line(
      uniqueId(used, `${base}-rule`),
      box.x + width * 0.62,
      box.y + height - inset,
      box.x + width - inset,
      box.y + height - inset,
      roles.border,
      Math.max(1, round(minDim * 0.005)),
      { opacity: 0.7 },
    ),
  );
  for (let i = 0; i < dots; i++) {
    out.push(
      circle(
        uniqueId(used, `${base}-dot-${i}`),
        box.x + width - inset - i * dotRadius * 3.2,
        box.y + height - inset - dotRadius,
        dotRadius,
        i % 2 === 0 ? roles.accent : roles.textSecondary,
        { opacity: i % 2 === 0 ? 0.85 : 0.45 },
      ),
    );
  }
  return out;
}

/**
 * @param {{issues?:Array, metrics?:{regionFills?:Array, decorationPieces?:number}}} report
 * @param {object} plan active template plan (components carry pixel boxes)
 * @param {object} palette active palette
 * @param {{width:number,height:number}} canvas
 * @param {object} design current rendered design (for id collisions)
 * @returns {{behind:Array, front:Array, notes:string[]}}
 */
export function buildDensityRepair(report, plan, palette, canvas, design) {
  const out = { behind: [], front: [], notes: [] };
  if (!FEATURES.layout.densityRepair || !report?.metrics) return out;
  const components = Array.isArray(plan?.components) ? plan.components : [];
  if (!components.length) return out;

  const roles = ensurePaletteRoles(palette || {});
  const used = elementIds(design);
  const fills = Array.isArray(report.metrics.regionFills) ? report.metrics.regionFills : [];
  const thin = new Map(fills.map((entry) => [entry.id, entry.fill]));
  const thinComponents = components.filter((component) => {
    if (!component || component.kind === "image" || component.role === "decoration") return false;
    const fill = thin.get(component.id);
    if (typeof fill !== "number") return false;
    const target = FEATURES.layout.regionFill[component.role] ?? FEATURES.layout.regionFill.default;
    return fill < target;
  });

  for (const component of thinComponents) {
    const pieces = frameFor(component, roles, used);
    if (pieces.length) {
      out.behind.push(...pieces);
      out.notes.push(`${component.id}: ${Math.round((thin.get(component.id) || 0) * 100)}% filled → frame + accents`);
    }
  }

  // Frames count as decoration pieces. Only add more when the design is still
  // below the dense floor, so a design with several frames does not get an
  // unrelated pile of dots on top.
  const need = Math.max(0, FEATURES.decoration.minPieces - (report.metrics.decorationPieces || 0) - out.behind.length);
  if (need > 0) {
    const decoration = components.find((component) => component?.role === "decoration" && component.box);
    if (decoration) {
      const specs = [
        { kind: "dots", variant: "scatter", density: FEATURES.decoration.density, color: "accent" },
        { kind: "dividers", variant: "rule", density: "normal", color: "secondary" },
      ];
      const pieces = buildDecorations(specs, decoration.box, palette, {
        prefix: `${decoration.id}-density`,
        limit: need,
      }).filter((piece) => {
        if (used.has(piece.id)) return false;
        used.add(piece.id);
        return true;
      });
      out.front.push(...pieces);
      out.notes.push(`decorations: ${report.metrics.decorationPieces || 0} → +${pieces.length} in ${decoration.id}`);
    } else {
      const width = Number(canvas?.width) || 0;
      const height = Number(canvas?.height) || 0;
      if (width > 0 && height > 0) {
        const margin = clamp(round(Math.min(width, height) * 0.05), 8, 40);
        const strip = {
          x: Math.max(margin, width - margin - Math.min(width * 0.2, 220)),
          y: margin,
          width: Math.min(width * 0.2, 220),
          height: Math.min(height * 0.16, 140),
        };
        const pieces = buildDecorations(
          [{ kind: "dots", variant: "scatter", density: FEATURES.decoration.density, color: "accent" }],
          strip,
          palette,
          { prefix: "density-accent", limit: need },
        ).filter((piece) => {
          if (used.has(piece.id)) return false;
          used.add(piece.id);
          return true;
        });
        out.front.push(...pieces);
        out.notes.push(`decorations: added ${pieces.length} honest marks on the canvas`);
      }
    }
  }

  return out;
}
