/**
 * Curated palette library (Phase 2D) — deterministic palette lookup.
 *
 * L2 used to cost a full model call (~88s measured on this box) to pick three
 * hex values. For the common briefs below that answer is knowable: match the
 * brief's words against this table and pick a palette that is already known to
 * clear the quality gate's 3:1 contrast floor. The model call stays as the
 * fallback for briefs the table does not recognise.
 *
 * Every entry is ink-on-background with a contrast ratio >= 4.5:1 by
 * construction (asserted in tests/palettes.test.mjs), so skipping the check
 * cannot produce fading text.
 */

import { contrastRatio } from "../ai/quality";
// ^ the one pure helper layout borrows from src/ai: quality.js imports
//   nothing, so this cannot create a cycle.

export const PALETTES = Object.freeze([
  { id: "festive-warm", keywords: ["diwali", "festival", "celebration", "puja", "eid", "holi", "christmas", "navratri", "onam", "pongal", "carnival", "mela"], background: "#FFF8E1", ink: "#3E2723", accent: "#FF6D00", style: "warm festive, generous glow" },
  { id: "deep-night-neon", keywords: ["neon", "cyber", "esports", "retro", "pixel", "synth", "rave", "club", "arcade", "gaming", "lanparty"], background: "#0B0A1F", ink: "#EAFDFF", accent: "#FF2E88", style: "neon on near-black, high voltage" },
  { id: "corporate-navy", keywords: ["corporate", "business", "enterprise", "quarterly", "board", "finance", "investor", "annual report", "agm", "b2b", "strategy", "earnings"], background: "#F4F7FB", ink: "#0F2540", accent: "#1E88E5", style: "corporate editorial, quiet authority" },
  { id: "academic-ink", keywords: ["academic", "lecture", "seminar", "research", "thesis", "symposium", "university", "college", "exam", "faculty"], background: "#FBFAF7", ink: "#1B1B1B", accent: "#8C1D18", style: "academic print, serif restraint" },
  { id: "eco-green", keywords: ["environment", "climate", "sustainab", "garden", "organic", "plantation", "nature", "recycle", "forest", "green"], background: "#F1F8F1", ink: "#14301C", accent: "#2E7D32", style: "fresh organic, calm greens" },
  { id: "sport-energy", keywords: ["sport", "sports", "marathon", "run", "race", "tournament", "league", "cup", "fitness", "gym", "match", "athletic", "cricket", "football"], background: "#101418", ink: "#FFFFFF", accent: "#FFD400", style: "high-energy sport, bold contrast" },
  { id: "pastel-playful", keywords: ["kids", "school", "children", "birthday", "play", "summer", "camp", "carnival", "toddler", "nursery"], background: "#FFF6FB", ink: "#3A2E4A", accent: "#FF7BAC", style: "soft playful pastel" },
  { id: "luxe-gold", keywords: ["luxury", "gala", "award", "premium", "elegant", "wedding", "banquet", "blacktie", "reception", "anniversary"], background: "#0E0E10", ink: "#F6EFE6", accent: "#C9A24A", style: "luxe black and gold" },
  { id: "tech-blue", keywords: ["tech", "saas", "startup", "developer", "hackathon", "code", "data", "cloud", "product", "software", "api", "launch", "ai"], background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF", style: "modern tech, crisp blue" },
  { id: "civic-red", keywords: ["government", "civic", "municipal", "community", "public", "ngo", "drive", "campaign", "awareness", "election", "ward"], background: "#FFFFFF", ink: "#10233B", accent: "#C62828", style: "civic poster, clear authority" },
  { id: "wellness-sage", keywords: ["wellness", "yoga", "health", "clinic", "meditation", "therapy", "spa", "hospital", "mindful", "counselling"], background: "#F6F8F4", ink: "#24352C", accent: "#6F9B7A", style: "calm wellness, soft sage" },
  { id: "music-purple", keywords: ["music", "concert", "band", "dj", "gig", "album", "tour", "openmic", "orchestra"], background: "#140B2E", ink: "#F3ECFF", accent: "#A66BFF", style: "stage purple, night glow" },
  { id: "food-orange", keywords: ["food", "restaurant", "menu", "cafe", "bakery", "feast", "cuisine", "recipe", "brunch", "diner"], background: "#FFF7EF", ink: "#33231A", accent: "#E4572E", style: "appetising warm kitchen" },
  { id: "travel-teal", keywords: ["travel", "tour", "trip", "holiday", "adventure", "resort", "island", "mountain", "trek", "vacation", "itinerary"], background: "#F2FBFC", ink: "#123B42", accent: "#00A6A6", style: "breezy travel teal" },
  { id: "mono-editorial", keywords: ["minimal", "editorial", "portfolio", "studio", "brand", "identity", "magazine", "clean", "monochrome", "print"], background: "#FFFFFF", ink: "#111111", accent: "#E02020", style: "minimal editorial, one red accent" },
]);

function briefText(goal) {
  if (!goal) return "";
  return [goal.style, goal.tone, goal.summary, goal.subject, goal.purpose, ...(Array.isArray(goal.mustInclude) ? goal.mustInclude : [])]
    .filter((s) => typeof s === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Deterministic palette lookup. Scores each entry by keyword hits, weighting a
 * hit in the style/tone (what it LOOKS like) above a hit in the body (what it
 * is about). Returns null when nothing matches, so L2 falls back to the model.
 *
 * @param {{style?:string,tone?:string,summary?:string,subject?:string,purpose?:string,mustInclude?:string[]}} goal
 * @returns {{id:string,background:string,ink:string,accent:string,style:string,score:number,source:"library"}|null}
 */
export function lookupPalette(goal) {
  if (!goal) return null;
  const look = `${goal.style || ""} ${goal.tone || ""}`.toLowerCase();
  const body = briefText(goal);
  const scored = PALETTES.map((entry) => {
    let score = 0;
    for (const kw of entry.keywords) {
      if (look.includes(kw)) score += 2;
      else if (body.includes(kw)) score += 1;
    }
    return { entry, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  // A tie means the brief is ambiguous ("annual sports day" matches both a
  // corporate and a sports palette). Guessing silently is worse than paying
  // for the model call, so only a strict winner answers from the library.
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  const { entry } = scored[0];
  return {
    id: entry.id,
    background: entry.background,
    ink: entry.ink,
    accent: entry.accent,
    style: entry.style,
    score: scored[0].score,
    source: "library",
  };
}

/** Guard used by tests and the L2 caller: a library palette never fades. */
export function paletteIsUsable(palette, minRatio = 3) {
  if (!palette) return false;
  const ratio = contrastRatio(palette.ink, palette.background);
  return ratio !== null && ratio >= minRatio;
}
