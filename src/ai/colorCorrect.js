/**
 * L5 — Color correction (deterministic, no AI, fast).
 *
 * The final layer of the cascade. It reads the RENDERED design against the
 * chosen palette and repairs the two failure modes the user cares about:
 *
 *   fading  — text whose fill has too little contrast against the shape
 *             actually behind it (bar, disc, artwork, canvas). Fixed by
 *             re-inking the text to the palette colour with the best contrast.
 *   mismatch — shapes painted outside the palette. Fixed by snapping their
 *             fill to the nearest palette colour.
 *
 * Returns PATCH ops (never mutates), so the App applies them as one undo step
 * through the normal patch pipeline. Deliberately conservative: it only acts
 * when a measurement fails, and it never moves anything.
 */

import { contrastRatio, elementBoxes } from "./quality";

const NAMED = {
  white: "#ffffff", black: "#000000", red: "#ff0000", blue: "#0000ff",
  green: "#008000", yellow: "#ffff00", purple: "#800080", orange: "#ffa500",
  pink: "#ffc0cb", gray: "#808080", grey: "#808080",
};

/** Normalises a CSS hex/named colour to "#rrggbb", or null. */
export function normHex(color) {
  if (typeof color !== "string") return null;
  const v = color.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex}`;
}

function rgb(hex) {
  const n = normHex(hex);
  if (!n) return null;
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

function isNeutral(color) {
  const n = normHex(color);
  if (!n) return false;
  const { r, g, b } = rgb(n);
  return r === g && g === b;
}

function distance(a, b) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return Infinity;
  return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
}

function nearest(hex, options) {
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(hex, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/** Picks the palette colour with the highest contrast against `against`. */
function bestAgainst(against, candidates) {
  let best = null;
  let bestRatio = -1;
  for (const c of candidates) {
    const r = contrastRatio(c, against);
    if (r !== null && r > bestRatio) {
      bestRatio = r;
      best = c;
    }
  }
  return { color: best, ratio: bestRatio };
}

function walk(elements, fn, context = {}) {
  for (const el of elements || []) {
    if (!el || typeof el !== "object") continue;
    fn(el, context);
    if (el.type === "group" && Array.isArray(el.children)) walk(el.children, fn, context);
  }
}

/**
 * @param {object} design validated Design JSON (canvas + elements)
 * @param {{background?:string, ink?:string, accent?:string}} palette
 * @returns {{ops: Array, notes: string[]}} patch ops + human-readable notes
 */
export function correctColors(design, palette) {
  const canvas = design?.canvas || {};
  const planRaw = [palette?.background, palette?.ink, palette?.accent]
    .map(normHex)
    .filter(Boolean);
  const notes = [];
  if (!planRaw.length) return { ops: [], notes };

  const planInk = normHex(palette?.ink) || "#111111";
  const planBg = normHex(palette?.background) || "#FFFFFF";
  const candidates = [planInk, planBg, normHex(palette?.accent)].filter(Boolean);

  const boxes = elementBoxes(design?.elements);
  const texts = boxes.filter((b) => b.kind === "text");

  const changes = new Map(); // id -> { props, notes }
  const change = (id, props, note) => {
    const cur = changes.get(id) || { props: {}, notes: [] };
    Object.assign(cur.props, props);
    if (note) cur.notes.push(note);
    changes.set(id, cur);
  };

  // 1. Fading: re-ink text that loses contrast against its LOCAL backdrop.
  for (const t of texts) {
    if (typeof t.fill !== "string") continue;
    const ratio0 = contrastRatio(t.fill, canvas.background);
    if (ratio0 === null && !normHex(t.fill)) continue; // unparseable fill

    const idx = boxes.indexOf(t);
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    let bed = null;
    for (let k = idx - 1; k >= 0; k--) {
      const s = boxes[k];
      if (s.kind !== "rectangle" && s.kind !== "circle" && s.kind !== "image") continue;
      if (cx > s.box.x && cx < s.box.x + s.box.w && cy > s.box.y && cy < s.box.y + s.box.h) {
        bed = s;
        break;
      }
    }

    if (bed && bed.kind === "image") {
      notes.push(`${t.id}: sits on artwork — verify contrast on export`);
      continue;
    }
    const backdrop = (bed && normHex(bed.fill)) || normHex(canvas.background);
    if (!backdrop) continue;

    const ratio = contrastRatio(t.fill, backdrop);
    if (ratio === null || ratio >= 4.5) continue;

    const pick = bestAgainst(backdrop, candidates) || { color: null, ratio: -1 };
    let chosen = pick.color;
    if (pick.ratio < 4.5) {
      // Palette cannot clear the bar (e.g. mid-tone accent bar): fall back
      // to pure black/white, whichever wins, so text never fades.
      chosen = (contrastRatio("#000000", backdrop) || 0) >= (contrastRatio("#ffffff", backdrop) || 0)
        ? "#000000"
        : "#ffffff";
    }
    if (chosen && normHex(chosen) !== normHex(t.fill)) {
      change(t.id, { fill: chosen }, `re-inked "${t.id}" ${t.fill} -> ${chosen} (${ratio.toFixed(1)}:1 on backdrop)`);
    }
  }

  // 2. Mismatch: snap shape fills that fall outside the palette.
  for (const b of boxes) {
    if (b.kind === "image") continue;
    if (typeof b.fill !== "string") continue;
    if (b.kind === "text") continue; // handled above
    if (isNeutral(b.fill)) continue;
    const n = normHex(b.fill);
    if (!n || planRaw.includes(n)) continue;
    const near = nearest(n, planRaw);
    if (near && near !== n) {
      change(b.id, { fill: near }, `snapped "${b.id}" ${b.fill} to palette (${near})`);
    }
  }

  // 3. Fading, part two: text drawn semi-transparent washes out regardless
  // of colour — lift it back to full opacity.
  walk(design?.elements, (el) => {
    if (el.type !== "text") return;
    if (typeof el.opacity === "number" && el.opacity > 0 && el.opacity < 0.5) {
      change(el.id, { opacity: 1 }, `raised "${el.id}" opacity ${el.opacity} -> 1 (faded)`);
    }
  });

  const ops = [];
  for (const [id, { props, notes: why }] of changes) {
    ops.push({ op: "update", id, props });
    notes.push(...why);
  }
  return { ops, notes };
}
