/**
 * Semantic image direction.
 *
 * The meaning of a picture is a model decision, not a keyword table. L1
 * returns `imageSubject` — a concrete scene derived from the brief — and the
 * image layer uses it as the search subject. This module only cleans the
 * hand-off; it does not maintain a vocabulary of approved visual nouns or
 * guess an industry from keywords.
 */

import { extractBrand, briefText } from "./copySanitize";

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Structural cleanup only. The model owns the semantics; the pipeline owns
 * JSON shape and length. Empty means L1 did not provide an understanding.
 */
export function cleanImageSubject(value) {
  const subject = normalize(value);
  if (!subject) return "";
  return subject.slice(0, 140).replace(/[\r\n]+/g, " ").trim();
}

/**
 * Ordered queries for one image region. The L1 understanding leads; a tuning
 * query is only used when L1 did not provide one. No prompt words are
 * substituted for a missing scene.
 */
export function imageQueryCandidates(goal = {}, tuningQuery = "") {
  return [cleanImageSubject(goal.imageSubject), cleanImageSubject(tuningQuery)].filter(
    (query, index, list) => query && list.indexOf(query) === index,
  );
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
