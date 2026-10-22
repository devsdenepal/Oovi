/**
 * Curated palette library (Phase 2D) | deterministic palette lookup.
 *
 * L2 used to cost a full model call (~88s measured on this box) to pick three
 * hex values. For the common briefs below that answer is knowable: match the
 * brief's words against this table and pick a palette that is already known to
 * clear the quality gate's 3:1 contrast floor. The model call stays as the
 * fallback for briefs the table does not recognise.
 *
 * Every entry is ink-on-background with a contrast ratio >= 4.5:1 by
 * construction (asserted in tests/palettes.test.mjs), so skipping the check
 * cannot produce fading text. Semantic roles (surface, CTA, border, …) are
 * derived from the three base colours by src/layout/paletteRoles.js, so the
 * table stays three values wide.
 */

import { contrastRatio } from "../ai/quality";
import { derivePaletteRoles } from "./paletteRoles";
// ^ the one pure helper layout borrows from src/ai: quality.js imports
//   nothing, so this cannot create a cycle.

/**
 * Each entry carries `industries` alongside `keywords`. Keywords match the
 * brief's wording; industries match L1's `industry` scope field, which is a
 * stable vocabulary ("technology", "food and drink") rather than free prose.
 * That matters for terse briefs: "Ship faster" says nothing a keyword list can
 * catch, but L1 will call it technology.
 */
export const PALETTES = Object.freeze([
  { id: "festive-warm", keywords: ["diwali", "festival", "celebration", "puja", "eid", "holi", "christmas", "navratri", "onam", "pongal", "carnival", "mela"], industries: ["arts and culture", "nonprofit", "community"], background: "#FFF8E1", ink: "#3E2723", accent: "#FF6D00", style: "warm festive, generous glow" },
  { id: "deep-night-neon", keywords: ["neon", "cyber", "esports", "retro", "pixel", "synth", "rave", "club", "arcade", "gaming", "lanparty"], industries: ["gaming", "entertainment", "technology"], background: "#0B0A1F", ink: "#EAFDFF", accent: "#FF2E88", style: "neon on near-black, high voltage" },
  { id: "corporate-navy", keywords: ["corporate", "business", "enterprise", "quarterly", "board", "finance", "investor", "annual report", "agm", "b2b", "strategy", "earnings"], industries: ["finance", "business", "consulting", "technology"], background: "#F4F7FB", ink: "#0F2540", accent: "#1E88E5", style: "corporate editorial, quiet authority" },
  { id: "academic-ink", keywords: ["academic", "lecture", "seminar", "research", "thesis", "symposium", "university", "college", "exam", "faculty"], industries: ["education", "research", "publishing"], background: "#FBFAF7", ink: "#1B1B1B", accent: "#8C1D18", style: "academic print, serif restraint" },
  { id: "eco-green", keywords: ["environment", "climate", "sustainab", "garden", "organic", "plantation", "nature", "recycle", "forest", "green"], industries: ["environment", "agriculture", "nonprofit"], background: "#F1F8F1", ink: "#14301C", accent: "#2E7D32", style: "fresh organic, calm greens" },
  { id: "sport-energy", keywords: ["sport", "sports", "marathon", "run", "race", "tournament", "league", "cup", "fitness", "gym", "match", "athletic", "cricket", "football"], industries: ["sports", "fitness", "health"], background: "#101418", ink: "#FFFFFF", accent: "#FFD400", style: "high-energy sport, bold contrast" },
  { id: "pastel-playful", keywords: ["kids", "school", "children", "birthday", "play", "summer", "camp", "carnival", "toddler", "nursery"], industries: ["education", "children", "events"], background: "#FFF6FB", ink: "#3A2E4A", accent: "#FF7BAC", style: "soft playful pastel" },
  { id: "luxe-gold", keywords: ["luxury", "gala", "award", "premium", "elegant", "wedding", "banquet", "blacktie", "reception", "anniversary"], industries: ["luxury", "hospitality", "events", "arts and culture"], background: "#0E0E10", ink: "#F6EFE6", accent: "#C9A24A", style: "luxe black and gold" },
  { id: "tech-blue", keywords: ["tech", "saas", "startup", "developer", "hackathon", "code", "data", "cloud", "product", "software", "api", "launch", "ai"], industries: ["technology", "software", "startup"], background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF", style: "modern tech, crisp blue" },
  { id: "civic-red", keywords: ["government", "civic", "municipal", "community", "public", "ngo", "drive", "campaign", "awareness", "election", "ward"], industries: ["civic", "government", "nonprofit", "community"], background: "#FFFFFF", ink: "#10233B", accent: "#C62828", style: "civic poster, clear authority" },
  { id: "wellness-sage", keywords: ["wellness", "yoga", "health", "clinic", "meditation", "therapy", "spa", "hospital", "mindful", "counselling"], industries: ["health", "wellness", "hospitality"], background: "#F6F8F4", ink: "#24352C", accent: "#6F9B7A", style: "calm wellness, soft sage" },
  { id: "music-purple", keywords: ["music", "concert", "band", "dj", "gig", "album", "tour", "openmic", "orchestra"], industries: ["music", "entertainment", "arts and culture"], background: "#140B2E", ink: "#F3ECFF", accent: "#A66BFF", style: "stage purple, night glow" },
  { id: "food-orange", keywords: ["food", "restaurant", "menu", "cafe", "bakery", "feast", "cuisine", "recipe", "brunch", "diner"], industries: ["food and drink", "hospitality", "retail"], background: "#FFF7EF", ink: "#33231A", accent: "#E4572E", style: "appetising warm kitchen" },
  { id: "travel-teal", keywords: ["travel", "tour", "trip", "holiday", "adventure", "resort", "island", "mountain", "trek", "vacation", "itinerary"], industries: ["travel", "tourism", "hospitality"], background: "#F2FBFC", ink: "#123B42", accent: "#00A6A6", style: "breezy travel teal" },
  { id: "mono-editorial", keywords: ["minimal", "editorial", "portfolio", "studio", "brand", "identity", "magazine", "clean", "monochrome", "print"], industries: ["design", "publishing", "arts and culture", "architecture"], background: "#FFFFFF", ink: "#111111", accent: "#E02020", style: "minimal editorial, one red accent" },
]);

/** Canonical form of an industry label, for comparing L1's answer to the table. */
function normIndustry(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when the goal's industry names (or is named by) a table industry. */
function industryMatches(goalIndustry, entryIndustries) {
  const g = normIndustry(goalIndustry);
  if (!g || g === "general") return false;
  return (entryIndustries || []).some((i) => {
    const e = normIndustry(i);
    return e === g || g.includes(e) || e.includes(g);
  });
}

function briefText(goal) {
  if (!goal) return "";
  return [goal.style, goal.tone, goal.summary, goal.subject, goal.purpose, ...(Array.isArray(goal.mustInclude) ? goal.mustInclude : [])]
    .filter((s) => typeof s === "string")
    .join(" ")
    .toLowerCase();
}

/** The retrieval words a palette should be matched against. */
function paletteText(goal) {
  if (!goal) return "";
  const keywords = Array.isArray(goal.keywords) ? goal.keywords : [];
  return [goal.style, goal.tone, goal.summary, goal.subject, goal.purpose, goal.designType, ...keywords]
    .filter((s) => typeof s === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Deterministic palette lookup.
 *
 * Scoring, highest wins:
 *   - an `industry` match is worth 3 (the strongest, most stable signal);
 *   - a keyword hit in style/tone (what it LOOKS like) is worth 2;
 *   - a keyword hit anywhere else in the brief is worth 1.
 *
 * Returns null when nothing matches, or when two palettes tie, so L2 falls back
 * to the model rather than guessing between two equally plausible looks.
 *
 * @param {{style?:string,tone?:string,summary?:string,subject?:string,purpose?:string,designType?:string,industry?:string,keywords?:string[],mustInclude?:string[]}} goal
 * @returns {{id:string,background:string,ink:string,accent:string,roles:object,style:string,score:number,source:"library"}|null}
 */
export function lookupPalette(goal) {
  if (!goal) return null;
  const look = `${goal.style || ""} ${goal.tone || ""}`.toLowerCase();
  const body = `${briefText(goal)} ${paletteText(goal)}`;
  const scored = PALETTES.map((entry) => {
    let score = 0;
    if (industryMatches(goal.industry, entry.industries)) score += 3;
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
  const roles = derivePaletteRoles(entry);
  return {
    id: entry.id,
    background: entry.background,
    ink: entry.ink,
    accent: entry.accent,
    roles,
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
