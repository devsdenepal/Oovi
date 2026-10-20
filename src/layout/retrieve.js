/**
 * Template retrieval (Phase 3) — choose a layout by SIMILARITY, not by a
 * hand-maintained keyword list.
 *
 * Phase 2 asked L3 to pick from a fixed menu of every template and then tune
 * it. With ~30 templates that menu is itself most of a 1024-token batch, and a
 * flat list spends the model's attention on templates that cannot possibly
 * fit. Retrieval fixes both:
 *
 *   1. hard filters first — only templates whose declared size buckets include
 *      this canvas compete, so a story-shaped canvas never sees a banner;
 *   2. rank the survivors against the brief: BM25 over a per-template document
 *      (label, blurb, type, description, moods, tags, keywords, slot
 *      descriptions and example copy) by default; an embedder can be plugged
 *      in through the `ranker` option;
 *   3. score CONFIDENCE as the share of the brief's information the best
 *      template explains. A brief nothing matches (a niche theme, or a brief
 *      in another script whose tokens never appear in the corpus) scores ~0 and
 *      returns no candidates — the signal to fall back to the free-form L3
 *      instead of silently picking a wrong layout.
 *
 * BM25 is the default because it is free, synchronous and deterministic: no
 * model call, no tokens, no waiting. scripts/benchmark-retrieval.mjs measures
 * it against Ollama embeddings on this box before either is chosen for good.
 *
 * Pure functions: no network, no Fabric, so node tests and the browser share
 * one implementation.
 */

import { TEMPLATES, sizeClassOf, templateSlots } from "./templates";

/** BM25 saturation and length-normalisation constants (standard defaults). */
const K1 = 1.5;
const B = 0.75;

/** Words that carry no retrieval signal in a design brief. */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "your", "our", "their",
  "his", "her", "its", "but", "not", "are", "was", "were", "will", "would", "should", "could",
  "have", "has", "had", "been", "being", "about", "must", "include", "includes", "one", "two",
  "three", "very", "more", "most", "some", "any", "all", "each", "make", "made", "use", "used",
  "design", "designs", "poster", "brief", "content", "line", "lines", "text",
]);

/**
 * Below this share of the brief's information, no template really fits.
 *
 * Kept LOW on purpose, and the level is not what separates a match from a
 * non-match: coverage is a share, so a colourful brief ("Vibrant, festive
 * Diwali announcement poster") can carry three adjectives no layout vocabulary
 * contains and still be a perfect brief for `hero-split`. What the threshold
 * actually has to reject is a template that shares one accidental word with a
 * brief it does not fit — and a brief with no vocabulary overlap at all scores
 * exactly 0 whatever the threshold is (that is what the two negative controls
 * in the benchmark check, and they abstain at every value).
 */
export const DEFAULT_COVERAGE_THRESHOLD = 0.11;
/**
 * Largest weight one query term may carry in the coverage measure. A term the
 * corpus has never seen is the rarest of all, so without a cap one novel word
 * would dominate (see coverage() in createRanker).
 */
const COVERAGE_IDF_CAP = 2.5;
/** How many retained templates the choice prompt may see. */
export const RETRIEVAL_LIMIT = 3;

/**
 * How much an L1 scope field can move a template up or down the ranking.
 *
 * These are BIASES, never filters. A hard filter on `designType` would empty
 * the pool: template types (`poster`, `notice`, `menu`, `cover`) and design
 * types (`product-launch`, `social-post`, `schedule`) are different
 * vocabularies, and a brief can legitimately want a `notice` layout for a
 * `product-launch` request. A bias can only reorder templates that already
 * share vocabulary with the brief, so a wrong guess costs one rank, not a
 * wrong layout.
 */
const SCOPE_BOOST = { type: 0.22, composition: 0.3, industry: 0.12 };

/**
 * Template `type` values that a design type can reasonably use. This is a
 * preference list, not a taxonomy: the first entry is the best fit.
 */
const DESIGN_TYPE_HINTS = {
  poster: ["poster", "notice", "banner", "statement"],
  banner: ["banner", "poster", "cover"],
  "social-post": ["social", "poster", "statement", "product"],
  story: ["social", "poster", "cover"],
  cover: ["cover", "poster", "statement"],
  newsletter: ["newsletter", "poster", "listing"],
  notice: ["notice", "poster", "statement"],
  invitation: ["notice", "poster", "ticket", "quote"],
  certificate: ["certificate", "notice", "statement"],
  menu: ["menu", "listing", "product"],
  schedule: ["schedule", "listing", "timeline"],
  listing: ["listing", "schedule", "timeline", "menu"],
  "product-launch": ["product", "poster", "cover", "social"],
  gallery: ["gallery", "social", "cover"],
  quote: ["quote", "statement", "notice"],
  comparison: ["comparison", "listing", "menu"],
  team: ["roster", "gallery", "listing"],
  ticket: ["ticket", "notice", "poster"],
  map: ["map", "listing", "poster"],
  metrics: ["metrics", "listing", "poster"],
  statement: ["statement", "quote", "notice"],
};

/**
 * Template ids whose DEFAULT variant expresses a requested composition.
 * Kept as an explicit map rather than derived from geometry: "which layout is
 * centered" is a design judgement, and reading it from slot coordinates would
 * call a left-aligned rail centered whenever its box happens to be.
 */
const COMPOSITION_HINTS = {
  "hero-left": ["hero-split", "feature-cta", "sidebar-rail", "statement-split", "map-card", "three-band"],
  "hero-right": ["hero-split", "feature-cta", "sidebar-rail", "statement-split", "map-card", "three-band"],
  centered: ["centered-poster", "poster-rail", "statement-quote", "quote-card", "certificate", "banner-strip"],
  split: ["hero-split", "editorial-columns", "comparison", "event-listing", "sidebar-rail", "newsletter"],
  stacked: ["hero-top", "story-stack", "poster-rail", "social-post", "magazine-cover", "product-shelf"],
  grid: ["card-grid", "photo-grid", "team-roster", "product-shelf", "class-schedule", "editorial-columns"],
  banner: ["banner-strip", "three-band", "metrics-panel", "hero-top"],
  "type-only": ["centered-poster", "statement-quote", "poster-rail", "quote-card", "timeline", "agenda"],
};

/** Suffixes stripped by stem(), longest first. */
const SUFFIXES = ["ations", "ation", "ments", "ment", "ings", "ing", "ions", "ion", "ers", "er", "ed", "es", "s", "e", "r"];

/**
 * Tokenises a brief or a template document. Two normalisations matter here:
 *
 *   - a light suffix strip, so "donation"/"donate" and "opening"/"open" are the
 *     same term (a designer writes "blood donation drive", the corpus says
 *     "donate" — without this, coverage 0 and a needless fallback);
 *   - non-ASCII input (a brief written in another script) yields no tokens at
 *     all, which is exactly the "nothing matched" signal the caller needs —
 *     never a wrong match.
 */
export function stem(word) {
  // Longest suffix first, never strip a word below four characters, and re-run
  // once: "registration" -> "registr" -> "regist", which is the stem that
  // "register" already produces ("regist"). Without the second pass a brief
  // saying "registration" and a template saying "register" would not meet.
  let w = word;
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const suffix of SUFFIXES) {
      if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
        if (suffix === "s" && w.endsWith("ss")) continue;
        w = w.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return w;
}

/**
 * The words retrieval is allowed to reason about.
 *
 * Deliberately NOT `briefText()` — that is the prompt's own one-line brief and
 * includes `mustInclude`, the checklist of things that must appear in the copy.
 * Those are content requirements ("Event details (Date, Time, Venue TBA)",
 * "Office closing/wish"): no layout vocabulary will ever describe them, and
 * because coverage is a SHARE of the brief's terms they quietly sank every
 * score. The Diwali brief retrieved `hero-split` at 51% coverage in the
 * benchmark and abstained at 16% in the app — retrieval never fired in
 * production while the benchmark looked healthy, because the benchmark fed it a
 * hand-written `{summary, style}` object instead of a real L1 goal.
 *
 * What a layout CAN answer is what kind of design this is: its subject,
 * audience, purpose, tone and style.
 */
export function retrievalText(brief) {
  if (!brief) return "";
  const join = (v) => (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "");
  // summary + subject + purpose + keywords, and NOT tone/style/audience. Those
  // last three are generic design words ("festive", "warm", "clean modern",
  // "colleagues") that almost every template's blurb can claim, so they inflate
  // the denominator of the coverage share without discriminating between
  // layouts — including them dropped top-1 from 60 % to 35 % on the labelled
  // set. Style belongs to L2 (the palette), not to which layout to use.
  return [brief.summary, brief.subject, brief.purpose, join(brief.keywords)]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" ")
    .toLowerCase();
}

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(stem)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * The searchable document for one template.
 *
 * Deliberately built from CURATED metadata only — label, blurb, type,
 * description, moods, tags, keywords and the slot descriptions — and NOT from
 * the example copy. Examples are written to fit a slot, not to describe a
 * layout, and they leak their own domain: a class-schedule example that
 * mentions a yoga mat made "the mating habits of the glass frog" rank layout
 * #1 at 25% coverage. The examples are still used, one-shot, at L4; they are
 * just not retrieval evidence.
 */
export function templateDocument(template) {
  const parts = [
    template.label,
    template.blurb,
    template.type,
    template.description,
    (template.mood || []).join(" "),
    (template.tags || []).join(" "),
    (template.keywords || []).join(" "),
  ];
  for (const slot of templateSlots(template)) {
    if (slot.role === "decoration" || slot.kind === "image") continue;
    parts.push(slot.id.replace(/-/g, " "), slot.describe || "");
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/**
 * The templates that could fit this canvas at all — the hard filter.
 * `extra` is where user-saved layouts join the library (same rules: they only
 * compete on canvases whose shape they were saved from).
 */
export function templatePool(canvas, type = null, extra = []) {
  const size = sizeClassOf(canvas);
  const all = extra && extra.length ? [...TEMPLATES, ...extra] : TEMPLATES;
  const pool = all.filter((t) => Array.isArray(t.sizes) && t.sizes.includes(size)).filter((t) => !type || t.type === type);
  return { size, pool };
}

/**
 * Builds a BM25 ranker plus the idf table the coverage score needs.
 * `rank(query)` returns [{index, score}] over the documents it was built with.
 * @param {string[]} documents
 */
export function createRanker(documents) {
  const tokenized = documents.map(tokenize);
  const N = Math.max(1, tokenized.length);
  const df = new Map();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) || 0) + 1);
  }
  const idf = (term) => Math.log(1 + (N - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
  const avgdl = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / N || 1;

  function rank(query) {
    return tokenized
      .map((tokens, index) => {
        const freqs = new Map();
        for (const term of tokens) freqs.set(term, (freqs.get(term) || 0) + 1);
        let score = 0;
        for (const term of query) {
          const f = freqs.get(term) || 0;
          if (!f) continue;
          score += idf(term) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * tokens.length) / avgdl)));
        }
        return { index, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  /**
   * Share of the query's information (idf-weighted) that a document contains.
   * Scale-free, so it means the same thing for a two-word and a forty-word
   * brief: 1 = the template's own vocabulary covers everything asked for.
   *
   * Weights are CAPPED. A term the corpus has never seen has the highest idf
   * of all (it is in no document), so uncapped it would dominate the measure
   * and a normal brief that happens to use one unusual word ("job opening…",
   * "…blood donation…") would abstain. Capping keeps the abstain signal where
   * it belongs: a brief whose vocabulary is *entirely* outside the corpus
   * still scores 0, because nothing is matched at all.
   */
  function coverage(query, document) {
    const terms = new Set(query);
    if (!terms.size) return 0;
    const present = new Set(tokenize(document));
    let matched = 0;
    let total = 0;
    for (const term of terms) {
      const weight = Math.min(idf(term), COVERAGE_IDF_CAP);
      total += weight;
      if (present.has(term)) matched += weight;
    }
    return total > 0 ? matched / total : 0;
  }

  return { rank, coverage, idf };
}

/**
 * The one place that turns a ranked list into a decision, so the pipeline and
 * the retrieval benchmark cannot drift apart:
 *
 *   - CANDIDATES are the templates that clear the threshold, capped at `limit`
 *     — not "the top three no matter what";
 *   - exactly one candidate -> taken for free (0 tokens);
 *   - two or three -> the model arbitrates the shortlist;
 *   - none -> the caller falls back to the free-form L3.
 *
 * The first version of this took the top hit whenever its coverage was high,
 * which quietly picked the `ticket` layout (64%) over `centered-poster` (36%)
 * for "wedding invitation card" — both genuinely share vocabulary, and the
 * right answer needs judgement, not a threshold. Being decisive is only safe
 * when there is nothing to decide between.
 *
 * @param {Array<{id:string,score:number,coverage:number}>} scored best-first
 */
export function selectFromScored(scored, options = {}) {
  const limit = options.limit ?? RETRIEVAL_LIMIT;
  const threshold = options.threshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const ranked = [...(scored || [])].sort(
    (a, b) => b.coverage - a.coverage || b.score - a.score || String(a.id).localeCompare(String(b.id)),
  );
  const passing = ranked.filter((s) => s.score > 0 && s.coverage >= threshold);
  if (!passing.length) {
    return { candidates: [], scored: ranked.slice(0, limit), coverage: ranked[0]?.coverage ?? 0, source: "none", decisive: null };
  }
  const top = passing.slice(0, limit);
  return {
    candidates: top.map((s) => s.id),
    scored: top,
    coverage: top[0].coverage,
    source: "retrieval",
    decisive: top.length === 1 ? top[0] : null,
  };
}

/**
 * Rank the templates that could fit this canvas against this brief with BM25,
 * then apply the L1 scope biases (design type, composition, industry).
 *
 * The bias is multiplicative on the BM25 score and capped, so it can only
 * reorder templates that already match the brief's vocabulary — it can never
 * lift a template the brief has nothing to do with. `scope` is reported per
 * candidate so a live run shows WHY a layout moved.
 *
 * @param {object} goal refined brief (summary/subject/tone/style/designType/industry/composition/keywords…)
 * @param {{width:number,height:number}} canvas
 * @param {{limit?:number, threshold?:number, type?:string, ranker?:object, extra?:Array}} [options]
 * @returns {{candidates:string[], scored:Array, coverage:number, source:"retrieval"|"none", decisive:object|null, size:string}}
 */
export function retrieveTemplates(goal, canvas, options = {}) {
  const { size, pool } = templatePool(canvas, options.type, options.extra);
  if (!pool.length) return { candidates: [], scored: [], coverage: 0, source: "none", decisive: null, size };

  const documents = pool.map(templateDocument);
  const query = tokenize(retrievalText(goal));
  const ranker = options.ranker || createRanker(documents);
  const ranked = ranker.rank(query, documents);
  const hints = scopeHints(goal);
  const scored = ranked
    .filter((r) => r && r.index >= 0 && r.index < pool.length)
    .map((r) => {
      const template = pool[r.index];
      const scope = scopeScore(template, hints);
      const base = Number(r.score) || 0;
      const rawCoverage =
        typeof r.coverage === "number"
          ? r.coverage
          : typeof ranker.coverage === "function"
            ? ranker.coverage(query, documents[r.index])
            : 0;
      // Scope raises the EFFECTIVE coverage, because coverage is what the
      // threshold and the ordering read. A brief with no vocabulary overlap
      // still has base === 0 at every threshold, so the abstain guarantee is
      // untouched — this only helps a template that already matched at least
      // one term.
      return {
        id: template.id,
        score: base * (1 + scope.total),
        baseScore: base,
        scope,
        coverage: Math.min(1, rawCoverage * (1 + scope.total)),
        baseCoverage: rawCoverage,
      };
    });

  return { ...selectFromScored(scored, options), size };
}

/**
 * Normalises the goal's scope fields into the shape the bias functions want.
 * Everything is optional: a hand-written brief or an old goal simply gets no
 * bias, which is exactly the pre-change behaviour.
 */
export function scopeHints(goal) {
  const industry = String(goal?.industry || "").toLowerCase().trim();
  return {
    designType: String(goal?.designType || "").toLowerCase().trim(),
    composition: String(goal?.composition || "").toLowerCase().trim(),
    industry: industry && industry !== "general" ? industry : "",
    keywords: (Array.isArray(goal?.keywords) ? goal.keywords : [])
      .map((k) => String(k || "").toLowerCase().trim())
      .filter(Boolean),
  };
}

/**
 * The bounded scope bias for one template.
 *
 * Each component is worth at most the weight in SCOPE_BOOST, and the total is
 * capped at 0.4 so scope can reorder a close race but never overturn a clear
 * vocabulary win. A template that already appears in the design type's
 * preference list gets the full type weight; one that merely shares the
 * industry gets a small nudge.
 */
export function scopeScore(template, hints) {
  let type = 0;
  let composition = 0;
  let industry = 0;
  if (hints.designType) {
    const preferred = DESIGN_TYPE_HINTS[hints.designType] || [];
    const at = preferred.indexOf(template.type);
    if (at === 0) type = SCOPE_BOOST.type;
    else if (at > 0) type = SCOPE_BOOST.type * (1 - at / (preferred.length + 1));
  }
  if (hints.composition) {
    const ids = COMPOSITION_HINTS[hints.composition] || [];
    if (ids.includes(template.id)) composition = SCOPE_BOOST.composition;
  }
  if (hints.industry) {
    // The template's own metadata names the industries it suits; `keywords`
    // carries the same signal for templates authored before this field.
    const words = [template.type, ...(template.keywords || []), ...(template.tags || [])].join(" ").toLowerCase();
    if (words.includes(hints.industry)) industry = SCOPE_BOOST.industry;
  }
  const total = Math.min(0.4, type + composition + industry);
  return { type, composition, industry, total };
}
