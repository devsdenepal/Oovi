/**
 * Deterministic design titles.
 *
 * The first pass of a design should never be called "Untitled design" when
 * the brief already contains a title. This is deliberately a formatter, not
 * another model call: it strips the instruction wrapper, takes the first
 * meaningful clause and title-cases it without destroying brand casing.
 */

const LEADING_INSTRUCTION =
  /^(?:please\s+)?(?:create|design|make|generate|build|produce|draft)\s+(?:me\s+)?(?:an|a|the)?\s*/i;
const LEADING_ARTICLE = /^(?:an|a|the)\s+/i;
const CLAUSE_BREAK =
  /[.!?;\n]|,\s+|\s+(?:for|with|that|to|featuring|about|from|in)\s+/i;
const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function titleCaseWord(word, index) {
  // Preserve words that already carry deliberate internal casing (iPhone,
  // Oovi, AI) instead of flattening them to a generic title.
  if (/[A-Z]/.test(word.slice(1))) return word;
  if (index > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * @param {string} prompt
 * @returns {string} a short, human-readable project title
 */
export function titleFromPrompt(prompt) {
  let text = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Untitled design";

  text = text.replace(LEADING_INSTRUCTION, "").replace(LEADING_ARTICLE, "");
  const clause = text.split(CLAUSE_BREAK)[0].trim();
  const words = clause.split(/\s+/).filter(Boolean).slice(0, 7);
  if (!words.length) return "Untitled design";

  const title = words.map(titleCaseWord).join(" ").replace(/\s+$/, "");
  return title.slice(0, 80) || "Untitled design";
}
