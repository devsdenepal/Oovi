/**
 * Deterministic artwork for an initial template sample.
 *
 * Used only when a template is first placed on the canvas, before AI
 * generation replaces its regions. It is never used as a fallback for an AI
 * image region: those require a real Unsplash result and fail closed when one
 * is unavailable. The semantic query stays in the SVG title so the sample
 * remains identifiable.
 */

import { ensurePaletteRoles } from "./paletteRoles";

function hashSeed(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

/**
 * @param {{width?:number,height?:number,palette?:object,query?:string,seed?:string}} options
 * @returns {string} data URL
 */
export function imagePlaceholderDataUrl({ width = 800, height = 600, palette = {}, query = "", seed = "" } = {}) {
  const w = Math.max(1, Math.round(Number(width) || 800));
  const h = Math.max(1, Math.round(Number(height) || 600));
  const roles = ensurePaletteRoles(palette || {});
  const random = seeded(`${seed}|${query}|${w}x${h}`);
  const short = Math.max(1, Math.min(w, h));
  const minX = Math.round(w * 0.08);
  const maxX = Math.round(w * 0.92);
  const minY = Math.round(h * 0.08);
  const maxY = Math.round(h * 0.92);
  const pick = (min, max) => min + random() * (max - min);

  // A deliberately quiet abstract landscape: horizon, sun/disc, field lines
  // and a few foreground marks. It reads as art direction rather than a
  // missing image, and it inherits the design palette.
  const horizon = Math.round(h * (0.58 + random() * 0.16));
  const discR = Math.round(short * (0.1 + random() * 0.08));
  const discX = Math.round(pick(minX + discR, maxX - discR));
  const discY = Math.round(pick(minY + discR, Math.max(minY + discR, horizon - discR * 0.6)));
  const lines = Array.from({ length: 5 }, (_, index) => {
    const y = Math.round(horizon + (h - horizon) * (0.12 + index * 0.17));
    const dash = Math.round(short * (0.02 + random() * 0.035));
    const stroke = index % 2 === 0 ? roles.muted : roles.accent;
    const opacity = (0.18 + random() * 0.25).toFixed(2);
    return `<line x1="${minX}" y1="${y}" x2="${maxX}" y2="${y}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="${dash} ${Math.round(dash * 1.8)}" opacity="${opacity}"/>`;
  }).join("");
  const marks = Array.from({ length: 7 }, (_, index) => {
    const r = Math.max(1, Math.round(short * (0.008 + random() * 0.02)));
    const x = Math.round(pick(minX, maxX));
    const y = Math.round(pick(minY, maxY));
    const fill = index % 3 === 0 ? roles.accent : roles.ink;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="${(0.12 + random() * 0.22).toFixed(2)}"/>`;
  }).join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(query || "template sample artwork")}">` +
    `<title>${escapeXml(query || "template sample artwork")}</title>` +
    `<defs>` +
    `<linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${roles.background}"/>` +
    `<stop offset="0.55" stop-color="${roles.surface}"/>` +
    `<stop offset="1" stop-color="${roles.background}"/>` +
    `</linearGradient>` +
    `<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${roles.surface}" stop-opacity="0.9"/>` +
    `<stop offset="1" stop-color="${roles.background}" stop-opacity="0.98"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    `<circle cx="${discX}" cy="${discY}" r="${discR}" fill="${roles.accent}" opacity="0.82"/>` +
    `<circle cx="${discX}" cy="${discY}" r="${Math.round(discR * 0.72)}" fill="${roles.background}" opacity="0.18"/>` +
    `<rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#ground)"/>` +
    `<path d="M0 ${horizon} Q ${Math.round(w * 0.3)} ${Math.round(horizon - short * 0.12)} ${Math.round(w * 0.62)} ${horizon} T ${w} ${Math.round(horizon - short * 0.04)}" fill="none" stroke="${roles.ink}" stroke-width="2" opacity="0.18"/>` +
    lines +
    marks +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="${roles.border}" stroke-width="1" opacity="0.5"/>` +
    `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
