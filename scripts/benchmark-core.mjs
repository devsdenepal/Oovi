/**
 * Retrieval benchmark (Phase 3, step 2).
 *
 * Answers one question with numbers instead of opinion: on THIS CPU, is a
 * local embedding model worth it over BM25 for picking a template?
 *
 * It measures, over a hand-labelled set of realistic briefs:
 *   - top-1 and top-3 accuracy (does the correct layout make the shortlist?);
 *   - how often retrieval abstains (the brief reaches the free-form L3 — the
 *     slow path, so the abstain rate is a speed number, not just an accuracy
 *     number);
 *   - how often retrieval decides for free instead of asking the model;
 *   - for embeddings: batch embed latency and the top-1 cosine.
 *
 * The labels are a PRIMARY expected template plus a set of TOLERATED ones: two
 * designers can disagree in good faith about "summer camp registration", so
 * top-1 is scored against the primary and top-3 against the tolerated set.
 *
 * Template vectors are cached on disk under node_modules/.cache/oovi-embed so
 * a re-run costs one query embedding, not 30 document embeddings.
 *
 *   node scripts/benchmark-retrieval.mjs [--model nomic-embed-text]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEMPLATES } from "../src/layout/templates";
import { templatePool, templateDocument, retrieveTemplates } from "../src/layout/retrieve";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(root, "node_modules", ".cache", "oovi-embed");
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const SIZES = {
  wide: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  tall: { width: 1080, height: 1920 },
};

/** prompt, canvas shape, the template a designer would reach for, tolerated others */
const CASES = [
  ["Diwali festival poster for an office announcement", "wide", "hero-split", ["centered-poster", "three-band"]],
  ["birthday certificate for a ten year old", "square", "certificate", ["centered-poster"]],
  ["tech startup launch poster", "wide", "hero-split", ["three-band", "feature-cta"]],
  ["hackathon announcement for college students", "wide", "hero-split", ["three-band", "timeline"]],
  ["yoga workshop flyer for beginners", "square", "card-grid", ["sidebar-rail", "class-schedule"]],
  ["quarterly sales report cover with the key numbers", "wide", "metrics-panel", ["hero-top", "editorial-columns"]],
  ["summer camp registration poster", "square", "photo-grid", ["feature-cta", "hero-split"]],
  ["wedding invitation card", "square", "centered-poster", ["quote-card", "certificate"]],
  ["job opening notice for a graphic designer", "square", "centered-poster", ["sidebar-rail", "comparison"]],
  ["blood donation camp drive poster", "square", "feature-cta", ["hero-split", "poster-rail"]],
  ["music concert poster for a local band", "tall", "story-stack", ["poster-rail", "hero-split"]],
  ["restaurant menu with prices", "wide", "menu-sheet", ["card-grid"]],
  ["team offsite photo recap", "square", "photo-grid", ["team-roster", "story-stack"]],
  ["product sale offer post for Instagram", "square", "product-shelf", ["feature-cta"]],
  ["cybersecurity webinar invitation", "wide", "centered-poster", ["three-band", "hero-split"]],
  ["weekly class timetable for the studio", "square", "class-schedule", ["agenda", "timeline"]],
  ["store opening with directions to the venue", "square", "map-card", ["sidebar-rail"]],
  ["employee appreciation award citation", "wide", "certificate", ["centered-poster", "statement-split"]],
  ["annual report highlights for the board", "square", "metrics-panel", ["editorial-columns", "hero-top"]],
  ["weight loss programme before and after", "square", "comparison", ["product-shelf", "feature-cta"]],
  // Negative controls: nothing should match, so retrieval must abstain.
  ["the mating habits of the glass frog", "square", null, []],
  ["कर्मचारियों के लिए दीवाली पोस्टर", "square", null, []],
];

/**
 * A brief shaped like the one the pipeline actually passes: a REAL L1 goal.
 *
 * `mustInclude` is not decoration — a real goal always carries 3-7 content
 * requirements ("Event details (Date, Time, Venue TBA)", "Office closing/wish").
 * An earlier version of this harness omitted them, which made every score look
 * healthy while the app abstained on the same brief: the benchmark was measuring
 * an input shape production never sends.
 */
const brief = (prompt) => ({
  summary: prompt,
  subject: prompt,
  purpose: "announce the event",
  audience: "colleagues and guests",
  tone: ["festive", "warm"],
  style: "clean modern",
  mustInclude: ["Event details (Date, Time, Venue TBA)", "Key highlights", "Closing line"],
});

function score(candidates, expected, tolerated) {
  return {
    top1: candidates[0] === expected,
    top3: candidates.slice(0, 3).some((id) => id === expected || tolerated.includes(id)),
  };
}

function summarize(rows) {
  const positive = rows.filter((r) => r.expected);
  const negative = rows.filter((r) => !r.expected);
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "n/a");
  return {
    top1: pct(positive.filter((r) => r.top1).length, positive.length),
    top3: pct(positive.filter((r) => r.top3).length, positive.length),
    abstained: pct(negative.filter((r) => r.abstained).length, negative.length),
    falseMatch: pct(negative.filter((r) => !r.abstained).length, negative.length),
    free: pct(positive.filter((r) => r.route === "free").length, positive.length),
    llm: pct(positive.filter((r) => r.route === "llm").length, positive.length),
  };
}

function report(title, rows, extra) {
  console.log(`\n=== ${title} ===`);
  console.log("prompt".padEnd(52), "shape".padEnd(8), "top-1", "shortlist".padEnd(42), "route");
  console.log("-".repeat(130));
  for (const r of rows) {
    const shown = r.shortlist.length
      ? r.shortlist
          .map((id, i) => (r.covers?.[i] !== undefined ? `${id} ${(r.covers[i] * 100).toFixed(0)}%` : id))
          .join(", ")
      : "—";
    console.log(
      r.prompt.slice(0, 50).padEnd(52),
      r.shape.padEnd(8),
      (r.expected ? (r.top1 ? "ok " : "MISS") : "n/a").padEnd(5),
      shown.slice(0, 40).padEnd(42),
      r.route,
    );
  }
  const s = summarize(rows);
  console.log("-".repeat(130));
  console.log(
    `top-1 ${s.top1}   top-3 ${s.top3}   abstained ${s.abstained}   false-match ${s.falseMatch}   ` +
      `decided free ${s.free}   asked the model ${s.llm}`,
  );
  if (extra) console.log(extra);
}

// --- BM25 -----------------------------------------------------------------

const bm25Rows = [];
for (const [prompt, shape, expected, tolerated] of CASES) {
  // A negative control gets only its own words: inventing an English `purpose`
  // for the Hindi brief would hand it English tokens and make the "no overlap"
  // control test nothing at all.
  const found = retrieveTemplates(expected ? brief(prompt) : { summary: prompt }, SIZES[shape], { limit: 3 });
  const shortlist = found.candidates;
  const route = found.source === "none" ? "abstain" : found.decisive ? "free" : "llm";
  bm25Rows.push({
    prompt,
    shape,
    expected,
    shortlist,
    covers: found.scored.map((s) => s.coverage),
    route,
    abstained: found.source === "none",
    ...score(shortlist, expected, tolerated),
  });
}
report("BM25 (default, zero tokens)", bm25Rows);

// --- embeddings -----------------------------------------------------------

/**
 * Embed a batch of texts. The corpus is sent in small chunks: a single request
 * carrying all ~30 template documents is one long prefill, and on this CPU it
 * outlives Node's default 5-minute header timeout (the first attempt died with
 * UND_ERR_HEADERS_TIMEOUT). Chunking also keeps the memory peak small.
 */
async function embed(texts, model, batch = 6) {
  const started = Date.now();
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: slice }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== slice.length) {
      throw new Error("embed: unexpected response shape");
    }
    out.push(...json.embeddings);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    process.stderr.write(`  embedded ${out.length}/${texts.length} documents in ${secs}s\n`);
  }
  return { vectors: out, ms: Date.now() - started };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Document vectors for one canvas pool, cached on disk per model + corpus. */
/**
 * Vectors for the WHOLE library, embedded once and cached on disk.
 *
 * The pool is a per-canvas subset of the same 30 documents, so embedding each
 * shape's pool separately would encode the same text up to five times — five
 * times the CPU on a box where a 30-document prefill takes minutes. One corpus
 * pass, then every case just looks its candidates up by id.
 */
async function cachedCorpus(model) {
  const docs = TEMPLATES.map(templateDocument);
  const hash = createHash("sha1").update(model).update(docs.join("\u0000")).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, `${model.replace(/[^a-z0-9._-]/gi, "_")}-${hash}.json`);
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(cached.vectors) && cached.vectors.length === docs.length) {
      return { map: new Map(TEMPLATES.map((t, i) => [t.id, cached.vectors[i]])), cached: true, ms: 0 };
    }
  } catch {
    /* no cache yet */
  }
  const { vectors, ms } = await embed(docs, model);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ model, hash, vectors }));
  return { map: new Map(TEMPLATES.map((t, i) => [t.id, vectors[i]])), cached: false, ms };
}

async function embeddingBenchmark() {
  // Opt-in. The corpus pass is minutes of CPU on this box (measured: ~17s per
  // document), and running it because someone asked for a BM25 report would
  // look like a hang. BM25 is the shipped ranker; this section exists to
  // re-open the comparison if the hardware ever changes.
  if (!process.argv.includes("--embed")) {
    console.log(
      `\n=== embeddings (${MODEL}) ===\n` +
        `SKIPPED: pass --embed to run the comparison. Measured on this CPU: ~17s per document to build ` +
        `the vector corpus (~8.5 min for ${TEMPLATES.length}), ~0.9s per brief to embed.`,
    );
    return;
  }
  let available = false;
  try {
    const probe = await fetch(`${OLLAMA}/api/tags`);
    const tags = await probe.json();
    available = (tags.models || []).some((m) => m.name === MODEL || m.name.startsWith(`${MODEL}:`));
  } catch {
    available = false;
  }
  if (!available) {
    console.log(`\n=== embeddings (${MODEL}) ===\nSKIPPED: ${MODEL} is not installed locally. Run: ollama pull ${MODEL}`);
    return;
  }

  const rows = [];
  let embedMs = 0;
  const top1Cosines = [];
  const controlCosines = [];
  const shapes = new Set();
  const corpus = await cachedCorpus(MODEL);
  console.log(
    corpus.cached
      ? `corpus vectors: ${corpus.map.size} loaded from ${CACHE_DIR} (0s)`
      : `corpus vectors: ${corpus.map.size} embedded in ${(corpus.ms / 1000).toFixed(0)}s (cached for next run)`,
  );

  for (const [prompt, shape, expected, tolerated] of CASES) {
    const canvas = SIZES[shape];
    const { pool } = templatePool(canvas);
    shapes.add(shape);
    const vectors = pool.map((t) => corpus.map.get(t.id));
    if (vectors.some((v) => !v)) throw new Error(`no cached vector for a ${shape} candidate`);
    const { vectors: qv, ms } = await embed([brief(prompt).summary + " " + (brief(prompt).style || "")], MODEL);
    embedMs += ms;

    const scored = vectors.map((v, i) => {
      const cos = cosine(qv[0], v);
      return { id: pool[i].id, score: cos, coverage: (cos + 1) / 2, cos };
    });
    scored.sort((a, b) => b.score - a.score);
    const shortlist = scored.slice(0, 3).map((s) => s.id);
    const top1Cos = scored[0].cos;
    if (expected) top1Cosines.push(top1Cos);
    else controlCosines.push(top1Cos);
    rows.push({
      prompt,
      shape,
      expected,
      shortlist,
      route: `mirror ${top1Cos.toFixed(2)}`,
      abstained: false,
      ...score(shortlist, expected, tolerated),
    });
  }

  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  report(
    `embeddings (${MODEL}, ${corpus.map.size} docs x ${shapes.size} shapes)`,
    rows.map((r) => ({ ...r, route: r.route })),
    `mean top-1 cosine: matches ${mean(top1Cosines).toFixed(3)}, non-matches ${mean(controlCosines).toFixed(3)} | ` +
      `embed latency: ${(embedMs / CASES.length).toFixed(0)} ms per brief, ` +
      `${(corpus.ms / 1000).toFixed(0)}s corpus once (${corpus.cached ? "disk cache" : "live"})`,
  );
}

await embeddingBenchmark();
console.log(`\nLibrary: ${TEMPLATES.length} templates. Template vectors cached under ${path.relative(root, CACHE_DIR)}.`);
