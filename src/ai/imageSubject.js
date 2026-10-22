/**
 * Semantic image direction.
 *
 * The meaning of a picture is a model decision, not a keyword table. L1
 * returns `imageSubject` | a concrete scene derived from the brief | and the
 * image layer uses it as the search subject. This module only cleans the
 * hand-off and derives shorter search variants; it does not maintain a
 * vocabulary of approved visual nouns or guess an industry from keywords.
 */

import { extractBrand, briefText } from "./copySanitize";

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// Grammar-only search filler. Content words stay in the query.
const QUERY_STOPWORDS = new Set(
  (
    "a an the and or but nor for from in on at of to by with without as is are was were be been being " +
    "this that these those into over under using displaying showing featuring"
  ).split(" "),
);

/**
 * Structural cleanup only. The model owns the semantics; the pipeline owns
 * JSON shape and length. Empty means L1 did not provide an understanding.
 */
export function cleanImageSubject(value) {
  const subject = normalize(value);
  if (!subject) return "";
  return subject.slice(0, 140).replace(/[\r\n]+/g, " ").trim();
}

function queryTokens(value, brand = "") {
  const brandWords = new Set(
    normalize(brand)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  return normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 2 && !QUERY_STOPWORDS.has(word) && !brandWords.has(word),
    );
}

/** Compact visual query, without the brand name or grammar filler. */
function compactQuery(value, brand = "", maxWords = 8) {
  const words = [...new Set(queryTokens(value, brand))];
  return words.slice(0, maxWords).join(" ");
}

/**
 * Ordered queries for one image region. The full L1 understanding leads; for
 * a long scene, a compact content-word query follows because Unsplash often
 * returns nothing for a whole sentence. A tuning query is used when L1 did
 * not provide one, and the model's keywords give one last search refinement.
 * No prompt words are substituted for a missing scene.
 */
export function imageQueryCandidates(goal = {}, tuningQuery = "") {
  const brand = extractBrand(goal);
  const out = [];
  const add = (value) => {
    const query = cleanImageSubject(value);
    if (query && !out.includes(query)) out.push(query);
  };
  const addCompact = (value) => {
    const full = cleanImageSubject(value);
    if (!full) return;
    if (full.split(/\s+/).length <= 6) return;
    const compact = compactQuery(full, brand);
    if (compact && compact !== full && !out.includes(compact)) out.push(compact);
  };

  add(goal.imageSubject);
  addCompact(goal.imageSubject);
  add(tuningQuery);
  addCompact(tuningQuery);

  const keywords = Array.isArray(goal.keywords)
    ? goal.keywords.map(normalize).filter(Boolean)
    : [];
  if (keywords.length) {
    const keywordQuery = compactQuery(
      [goal.imageSubject, ...keywords].filter(Boolean).join(" "),
      brand,
    );
    if (keywordQuery && !out.includes(keywordQuery)) out.push(keywordQuery);
  }
  return out;
}

/** Readable one-line summary for logs and the assistant panel. */
export function describeImageSubject(goal = {}) {
  return cleanImageSubject(goal.imageSubject);
}

/** Kept for prompt diagnostics: the semantic brief is model-authored. */
export function imageSubjectSourceText(goal = {}, rawPrompt = "") {
  return [cleanImageSubject(goal.imageSubject), extractBrand(goal), briefText(goal, rawPrompt)]
    .filter(Boolean)
    .join(" | ");
}
