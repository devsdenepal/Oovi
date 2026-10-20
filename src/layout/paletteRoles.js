/**
 * Semantic palette roles.
 *
 * Until now a palette was three hex values (background / ink / accent) and L4
 * was free to paint whatever it liked; L5 then snapped rogue fills back by
 * nearest RGB distance, which is a guess, not a decision. A design needs more
 * than three decisions: body copy is not the same ink as a muted caption, a CTA
 * needs its own surface AND its own text colour, cards need a surface that is
 * not the canvas, and borders need to exist at all.
 *
 * So the palette grows a closed vocabulary of ROLES, and every consumer uses
 * one of them:
 *
 *   background     the canvas
 *   surface        cards / panels / bars that sit ON the canvas
 *   textPrimary    body copy and headings on `background` or `surface`
 *   textSecondary  supporting copy, captions, facts — quieter than primary
 *   accent         the one rationed hue (rules, badges, highlights)
 *   onAccent       text that sits ON `accent`
 *   ctaSurface     a call-to-action button/bar
 *   ctaText        text that sits ON `ctaSurface`
 *   border         hairlines, dividers, card outlines
 *   muted          disabled/secondary marks, icons, texture
 *
 * Every role is DERIVED from the three base colours rather than hand-authored,
 * for two reasons: 15 palettes × 10 roles is 150 values nobody will maintain,
 * and a derived role is guaranteed to be readable against its own backdrop
 * (which is asserted in tests/palettes.test.mjs). The derivation is pure and
 * deterministic — the same palette always yields the same roles, in node and in
 * the browser.
 *
 * Pure functions: no Fabric, no network.
 */

import { contrastRatio } from "../ai/quality";

const NAMED = {
  white: "#ffffff", black: "#000000", red: "#ff0000", blue: "#0000ff",
  green: "#008000", yellow: "#ffff00", purple: "#800080", orange: "#ffa500",
  pink: "#ffc0cb", gray: "#808080", grey: "#808080",
};

/** The role names, in the order prompts and docs present them. */
export const PALETTE_ROLES = [
  "background",
  "surface",
  "textPrimary",
  "textSecondary",
  "accent",
  "onAccent",
  "ctaSurface",
  "ctaText",
  "border",
  "muted",
];

/** Minimum contrast for body copy. Below this the quality gate errors. */
export const ROLE_CONTRAST = { text: 4.5, secondary: 4.5, cta: 4.5, border: 1.2, muted: 1.8 };

/** Parses #rgb/#rrggbb/named to {r,g,b}, or null. */
export function toRgb(color) {
  if (typeof color !== "string") return null;
  const v = color.trim().toLowerCase();
  if (NAMED[v] !== undefined) return NAMED[v] ? toRgb(NAMED[v]) : null;
  const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Normalises any accepted colour to "#RRGGBB", or null. */
export function normRoleColor(color) {
  const rgb = toRgb(color);
  return rgb ? toHex(rgb) : null;
}

/** Relative luminance (WCAG). */
function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Mixes `a` toward `b` by `t` (0..1). */
export function mix(a, b, t) {
  const x = toRgb(a);
  const y = toRgb(b);
  if (!x || !y) return null;
  const k = Math.max(0, Math.min(1, t));
  return toHex({
    r: x.r + (y.r - x.r) * k,
    g: x.g + (y.g - x.g) * k,
    b: x.b + (y.b - x.b) * k,
  });
}

/** The darker of two colours (by luminance). */
function darker(a, b) {
  const x = toRgb(a);
  const y = toRgb(b);
  if (!x || !y) return a;
  return luminance(x) <= luminance(y) ? a : b;
}

/** The lighter of two colours (by luminance). */
function lighter(a, b) {
  const x = toRgb(a);
  const y = toRgb(b);
  if (!x || !y) return a;
  return luminance(x) >= luminance(y) ? a : b;
}

/** True when the canvas is dark, so "toward white" means "toward contrast". */
function isDark(color) {
  const rgb = toRgb(color);
  return rgb ? luminance(rgb) < 0.18 : false;
}

/**
 * Picks the first candidate that clears `min` against `against`, else the
 * highest-contrast candidate. Never returns an unreadable colour when a
 * readable one exists.
 */
function readable(against, candidates, min) {
  let best = null;
  let bestRatio = -1;
  for (const c of candidates) {
    if (!c) continue;
    const ratio = contrastRatio(c, against);
    if (ratio === null) continue;
    if (ratio >= min) return c;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }
  return best;
}

/**
 * Derives the full semantic role set from the three base colours.
 *
 * The rules are deliberately conservative — they nudge the base palette into a
 * complete, readable system rather than inventing a new look:
 *
 *   - `surface` moves the background slightly toward the ink, so cards read as
 *     raised (dark themes get lighter cards, light themes get darker cards);
 *   - `textSecondary` is ink mixed 35% toward the background, then pushed back
 *     toward ink until it clears the body-copy floor;
 *   - `ctaSurface` prefers the accent (the rationed hue), but falls back to the
 *     ink when the accent cannot carry readable text;
 *   - `ctaText` / `onAccent` pick whichever of background/ink/black/white wins
 *     against that surface;
 *   - `border` and `muted` are low-contrast by design: they are hairlines and
 *     secondary marks, not copy.
 *
 * @param {{background:string, ink:string, accent:string}} palette
 * @returns {{background:string, surface:string, textPrimary:string,
 *   textSecondary:string, accent:string, onAccent:string, ctaSurface:string,
 *   ctaText:string, border:string, muted:string}}
 */
export function derivePaletteRoles(palette) {
  const bg = normRoleColor(palette?.background) || "#FFFFFF";
  const ink = normRoleColor(palette?.ink) || "#111111";
  const accent = normRoleColor(palette?.accent) || "#4F46E5";
  const dark = isDark(bg);

  // A surface that reads as raised from the canvas but stays close to it.
  const surface = mix(bg, ink, dark ? 0.1 : 0.05) || bg;

  // Primary text: the palette's ink, but never below the body floor.
  const textPrimary = readable(surface, [ink, "#111111", "#FFFFFF"], ROLE_CONTRAST.text) || ink;

  // Secondary text: quieter than primary, still readable.
  const softened = mix(textPrimary, bg, 0.35) || textPrimary;
  const textSecondary =
    readable(surface, [softened, mix(textPrimary, bg, 0.2), textPrimary], ROLE_CONTRAST.secondary) || textPrimary;

  // CTA: the accent is the natural action colour, but only if it can hold text.
  const accentHoldsText = ["#FFFFFF", "#000000", ink, bg].some(
    (c) => (contrastRatio(c, accent) ?? 0) >= ROLE_CONTRAST.cta,
  );
  const ctaSurface = accentHoldsText
    ? accent
    : readable(surface, [ink, mix(ink, accent, 0.35)], ROLE_CONTRAST.cta) || ink;
  const ctaText = readable(ctaSurface, [bg, ink, "#FFFFFF", "#000000"], ROLE_CONTRAST.cta) || "#FFFFFF";
  const onAccent = readable(accent, [bg, ink, "#FFFFFF", "#000000"], ROLE_CONTRAST.cta) || "#FFFFFF";

  // Hairline and muted marks: intentionally low contrast.
  const border = mix(bg, ink, dark ? 0.28 : 0.18) || surface;
  const muted = mix(textPrimary, bg, 0.55) || textSecondary;

  return {
    background: bg,
    surface,
    textPrimary,
    textSecondary,
    accent,
    onAccent,
    ctaSurface,
    ctaText,
    border,
    muted,
  };
}

/**
 * The role a given element role should paint its text with. This is the one
 * mapping the prompt, the L5 correction and the quality gate share, so a
 * "footer" cannot be asked for one colour and judged against another.
 *
 * @param {string} role a template slot role (headline/tagline/details/…)
 * @returns {keyof ReturnType<typeof derivePaletteRoles>}
 */
export function textRoleFor(role) {
  switch (String(role || "")) {
    case "headline":
    case "hero":
      return "textPrimary";
    case "tagline":
    case "audience":
    case "caption":
      return "textSecondary";
    case "details":
    case "header":
    case "footer":
      return "textSecondary";
    case "cta":
    case "button":
      return "ctaText";
    default:
      return "textPrimary";
  }
}

/**
 * The role a slot's own surface should paint with, when the region is a filled
 * container rather than bare canvas.
 *
 * @param {string} role
 * @returns {keyof ReturnType<typeof derivePaletteRoles>|null} null = no surface
 */
export function surfaceRoleFor(role) {
  switch (String(role || "")) {
    case "cta":
    case "button":
      return "ctaSurface";
    case "sections":
    case "details":
    case "audience":
      return "surface";
    default:
      return null;
  }
}

/**
 * Resolves a role name against a palette, deriving roles when the palette is
 * still the three-colour form (a saved project, a hand-written test fixture, or
 * a model answer that predates roles). Never returns undefined.
 */
export function paletteColor(palette, role, fallback = "#111111") {
  if (!palette) return fallback;
  const direct = palette[role];
  if (typeof direct === "string" && normRoleColor(direct)) return normRoleColor(direct);
  const derived = palette.roles && palette.roles[role];
  if (typeof derived === "string" && normRoleColor(derived)) return normRoleColor(derived);
  const full = derivePaletteRoles(palette);
  return full[role] || fallback;
}

/**
 * Region-level colour assignment, applied to a component's elements before
 * they reach the editor.
 *
 * This is NOT a replacement for L5 `correctColors()` — it is the cheap first
 * pass that makes the palette true at the moment a region lands. Text whose
 * fill is already a palette role is left alone (so a two-tone headline that
 * uses `accent` and `textPrimary` survives); text that invented a hue is
 * repainted with the role its element (or component) role asks for. Shapes are
 * left to L5, which measures contrast against the rendered backdrop.
 *
 * @param {Array} elements region elements
 * @param {string} componentRole the slot role (headline/details/cta/…)
 * @param {object} palette plan palette (roles present or derivable)
 * @returns {Array} same array when every text fill already uses a role
 */
export function applyRoleFills(elements, componentRole, palette) {
  if (!Array.isArray(elements) || !elements.length) return elements;
  const roles = ensurePaletteRoles(palette);
  const allowed = new Set(Object.values(roles).map(normRoleColor).filter(Boolean));
  const walk = (els) => {
    let changed = false;
    const out = els.map((el) => {
      if (!el || typeof el !== "object") return el;
      if (el.type === "group" && Array.isArray(el.children)) {
        const children = walk(el.children);
        if (children === el.children) return el;
        changed = true;
        return { ...el, children };
      }
      if (el.type !== "text" || typeof el.fill !== "string") return el;
      const n = normRoleColor(el.fill);
      if (n && allowed.has(n)) return el;
      const target = roles[textRoleFor(el.role || componentRole)] || roles.textPrimary;
      changed = true;
      return { ...el, fill: target };
    });
    return changed ? out : els;
  };
  return walk(elements);
}

/** The full role set for any palette shape (roles present, or base three). */
export function ensurePaletteRoles(palette) {
  if (!palette) return derivePaletteRoles({});
  const derived = derivePaletteRoles(palette);
  const out = { ...derived };
  for (const role of PALETTE_ROLES) {
    const given = palette[role];
    if (typeof given === "string" && normRoleColor(given)) out[role] = normRoleColor(given);
  }
  if (palette.roles && typeof palette.roles === "object") {
    for (const role of PALETTE_ROLES) {
      const given = palette.roles[role];
      if (typeof given === "string" && normRoleColor(given)) out[role] = normRoleColor(given);
    }
  }
  return out;
}

/** Compact one-line description for prompts (L4, L3 tuning). */
export function formatPaletteRoles(palette) {
  const r = ensurePaletteRoles(palette);
  return (
    `canvas ${r.background}, surface ${r.surface}, text ${r.textPrimary}, ` +
    `secondary text ${r.textSecondary}, accent ${r.accent} (text on accent ${r.onAccent}), ` +
    `CTA surface ${r.ctaSurface} with CTA text ${r.ctaText}, border ${r.border}, muted ${r.muted}`
  );
}
