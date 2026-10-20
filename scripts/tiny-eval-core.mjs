/**
 * Tiny-model eval core (bundled by scripts/tiny-eval.mjs).
 *
 * Design notes that matter for the numbers:
 *   - The prompt text is BUILT BY THE PRODUCTION BUILDERS. Nothing is
 *     re-phrased here, so prefill tokens are the tokens the app really pays.
 *   - Messages are split exactly like src/ai/aiClient.js does it
 *     (static [System] prefix -> system turn, [User] -> user turn).
 *   - Ollama options are identical for every model: num_ctx 8192, num_thread
 *     2, temperature 0.2, draft_num_predict 0, think:false, keep_alive 30m.
 *     Per-call num_predict mirrors the production maxTokens ask.
 *   - Calls are serial: OLLAMA_NUM_PARALLEL=1 on this box, so parallel calls
 *     would only measure queueing.
 *
 * Flags: --model m | --models a,b,c   --limit N   --only choice,tune,copy
 *        --strict    tuning ids enumerated from the chosen template, copy
 *                    maxItems/maxLength bounded by the slot, num_predict
 *                    derived from the slot budget (before/after comparison)
 *        --preflight no model calls
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveTemplates, RETRIEVAL_LIMIT } from "../src/layout/retrieve";
import {
  getTemplate,
  instantiateTemplate,
  sanitizeTuning,
  templateSlots,
  TEMPLATE_IDS,
} from "../src/layout/templates";
import { buildTemplateChoicePrompt, buildTuningPrompt, templateChoiceSchema, TUNING_SCHEMA } from "../src/ai/templatePrompt";
import { buildComponentPrompt } from "../src/ai/architectPrompt";
import { lookupPalette } from "../src/layout/palettes";
import { ensurePaletteRoles } from "../src/layout/paletteRoles";
import { validateDesign } from "../src/design/designValidator";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
  return fallback;
};
const PREFLIGHT = argv.includes("--preflight");
const STRICT = argv.includes("--strict");
const LIMIT = Number(flag("limit", "0")) || 0;
const MODELS = String(flag("models", flag("model", "gemma3:270m,gemma3:1b,gemma4:e2b")))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ONLY = new Set(String(flag("only", "choice,tune,copy")).split(",").map((s) => s.trim()).filter(Boolean));

const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
// One results file per model, so a long run can be reported incrementally.
const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const outFileFor = (model) =>
  path.join(OUT_DIR, `results-${model.replace(/[^a-z0-9]+/gi, "_")}${STRICT ? "-strict" : ""}.jsonl`);
const rows = [];

const DEFAULT_PALETTE = {
  background: "#FFFFFF",
  ink: "#111111",
  accent: "#E02020",
  style: "clean modern",
};

// ---------------------------------------------------------------------------
// The briefs. 15 realistic prompts: product, culture, food, civic, education,
// events, formal invitations, metrics, a niche ticket and a social post.
// Three of them are non-English on the brief side (the model-facing summary),
// which is where language actually reaches these calls.
// ---------------------------------------------------------------------------

const CASES = [
  {
    id: "pulseboard-launch",
    prompt: "Poster for the launch of PulseBoard, our new analytics app",
    canvas: { width: 1200, height: 630 },
    expect: "feature-cta",
    tolerated: ["hero-split", "statement-split"],
    goal: {
      summary: "Product launch poster for PulseBoard, a new analytics app",
      subject: "PulseBoard analytics app launch",
      audience: "product teams and startup founders",
      purpose: "announce the launch and drive sign-ups",
      tone: "confident, modern",
      designType: "product-launch",
      industry: "technology",
      keywords: ["pulseboard", "analytics", "app launch", "dashboard", "product", "startup", "software"],
      composition: "hero-left",
      mustInclude: ["app name and tagline", "launch date", "three key benefits", "sign-up call to action"],
      avoid: ["invented pricing", "cluttered centre", "low-contrast text"],
      style: "modern tech, crisp blue",
    },
  },
  {
    id: "diwali-office",
    prompt: "दिवाली उत्सव पोस्टर — ऑफिस के कर्मचारियों के लिए",
    canvas: { width: 1200, height: 630 },
    expect: "centered-poster",
    tolerated: ["poster-rail", "statement-quote"],
    goal: {
      summary: "दिवाली उत्सव पोस्टर — ऑफिस के कर्मचारियों के लिए",
      subject: "Diwali celebration at the office",
      audience: "office colleagues and staff",
      purpose: "invite everyone to the office Diwali celebration",
      tone: "festive and warm",
      designType: "poster",
      industry: "community",
      keywords: ["diwali", "office celebration", "colleagues", "festival", "lamp", "party"],
      composition: "centered",
      mustInclude: ["event title", "date and time", "venue", "rsvp line"],
      avoid: ["invented guest names", "cluttered centre"],
      style: "warm festive",
    },
  },
  {
    id: "autumn-menu",
    prompt: "Carta de menú de otoño para el restaurante del barrio",
    canvas: { width: 1200, height: 630 },
    expect: "menu-sheet",
    tolerated: ["card-grid", "event-listing"],
    goal: {
      summary: "Carta de menú de otoño para el restaurante del barrio",
      subject: "Autumn dinner menu",
      audience: "diners at the neighbourhood restaurant",
      purpose: "show the seasonal dishes",
      tone: "warm, appetising",
      designType: "menu",
      industry: "food and drink",
      keywords: ["menu", "autumn", "restaurant", "dinner", "seasonal", "courses", "food"],
      composition: "stacked",
      mustInclude: ["restaurant name", "three course sections", "prices as TBA"],
      avoid: ["invented prices", "tiny text"],
      style: "appetising warm kitchen",
    },
  },
  {
    id: "jazz-calendar",
    prompt: "ジャズクラブの月間カレンダー",
    canvas: { width: 1200, height: 630 },
    expect: "agenda",
    tolerated: ["event-listing", "class-schedule"],
    goal: {
      summary: "ジャズクラブの月間カレンダー",
      subject: "Monthly jazz club calendar",
      audience: "club regulars and jazz fans",
      purpose: "list the month's gigs",
      tone: "cool, nocturnal",
      designType: "schedule",
      industry: "music",
      keywords: ["jazz", "club", "calendar", "gig", "concert", "lineup", "monthly", "timed rows", "programme", "entries", "times"],
      composition: "stacked",
      mustInclude: ["month header", "date rows", "band names"],
      avoid: ["invented band names"],
      style: "stage purple",
    },
  },
  {
    id: "volunteer-certificate",
    prompt: "Certificate of appreciation for our volunteer firefighters",
    canvas: { width: 1200, height: 630 },
    expect: "certificate",
    tolerated: ["centered-poster", "statement-quote"],
    goal: {
      summary: "Certificate of appreciation for volunteer firefighters",
      subject: "Certificate of appreciation",
      audience: "volunteer firefighters being recognised",
      purpose: "recognise service formally",
      tone: "formal, grateful",
      designType: "certificate",
      industry: "civic",
      keywords: ["certificate", "appreciation", "volunteer", "award", "service", "firefighters", "recognition"],
      composition: "centered",
      mustInclude: ["recipient name placeholder", "award title", "date", "signature line"],
      avoid: ["invented names"],
      style: "formal civic print",
    },
  },
  {
    id: "summer-camp",
    prompt: "Summer camp registration flyer for kids",
    canvas: { width: 1200, height: 630 },
    expect: "card-grid",
    tolerated: ["event-listing", "poster-rail"],
    goal: {
      summary: "Summer camp registration flyer for children",
      subject: "Summer camp registration",
      audience: "parents of 7-12 year olds",
      purpose: "get registrations",
      tone: "playful, friendly",
      designType: "notice",
      industry: "education",
      keywords: ["summer", "camp", "kids", "registration", "activities", "children", "school", "grid", "cards", "content cards"],
      composition: "grid",
      mustInclude: ["camp name", "date range", "activity highlights", "registration link"],
      avoid: ["scary imagery", "invented fees"],
      style: "soft playful pastel",
    },
  },
  {
    id: "hackathon-launch",
    prompt: "Launch event for a weekend hackathon for college students",
    canvas: { width: 1200, height: 800 },
    expect: "event-listing",
    tolerated: ["agenda", "class-schedule", "poster-rail"],
    goal: {
      summary: "Hackathon launch event for college students",
      subject: "College hackathon",
      audience: "undergraduate developers",
      purpose: "drive registrations",
      tone: "energetic, technical",
      designType: "listing",
      industry: "technology",
      keywords: ["hackathon", "college", "developers", "code", "workshop", "registration", "weekend", "students", "when where facts", "programme"],
      composition: "split",
      mustInclude: ["event title and year", "date and venue", "schedule rows", "registration link"],
      avoid: ["invented sponsors"],
      style: "modern tech, crisp blue",
    },
  },
  {
    id: "wedding-invitation",
    prompt: "Wedding invitation with calligraphy, formal and romantic",
    canvas: { width: 1080, height: 1350 },
    expect: "centered-poster",
    tolerated: ["statement-quote", "certificate"],
    goal: {
      summary: "Wedding invitation with calligraphy, formal and romantic",
      subject: "Wedding invitation",
      audience: "invited family and friends",
      purpose: "invite guests with date and venue",
      tone: "formal, romantic",
      designType: "invitation",
      industry: "events",
      keywords: ["wedding", "invitation", "ceremony", "reception", "rsvp", "bride", "groom"],
      composition: "centered",
      mustInclude: ["couple names", "ceremony date", "venue", "rsvp line"],
      avoid: ["cluttered centre", "invented addresses"],
      style: "elegant, calligraphic",
    },
  },
  {
    id: "tech-conference-banner",
    prompt: "Banner for a tech conference with the speaker lineup",
    canvas: { width: 1200, height: 630 },
    expect: "banner-strip",
    tolerated: ["hero-split", "three-band"],
    goal: {
      summary: "Banner for a tech conference with the speaker lineup",
      subject: "Tech conference banner",
      audience: "developers and engineering managers",
      purpose: "announce the conference and speakers",
      tone: "bold, professional",
      designType: "banner",
      industry: "technology",
      keywords: ["conference", "speakers", "keynote", "summit", "lineup", "tech", "agenda", "banner", "wide headline", "detail row", "three-up"],
      composition: "banner",
      mustInclude: ["conference name", "dates", "three speaker names", "venue"],
      avoid: ["invented speaker names"],
      style: "modern tech, crisp blue",
    },
  },
  {
    id: "pricing-comparison",
    prompt: "Comparison graphic of our pricing against two alternatives",
    canvas: { width: 1200, height: 630 },
    expect: "comparison",
    tolerated: ["product-shelf", "metrics-panel"],
    goal: {
      summary: "Comparison graphic of our pricing against two alternatives",
      subject: "Pricing comparison",
      audience: "buyers evaluating tools",
      purpose: "show where we win",
      tone: "clear, confident",
      designType: "comparison",
      industry: "technology",
      keywords: ["pricing", "comparison", "plans", "features", "alternative", "saas", "versus"],
      composition: "split",
      mustInclude: ["three plan columns", "feature rows", "call to action"],
      avoid: ["invented prices"],
      style: "minimal editorial, one red accent",
    },
  },
  {
    id: "fundraising-metrics",
    prompt: "Fundraising results panel with three headline figures",
    canvas: { width: 1200, height: 630 },
    expect: "metrics-panel",
    tolerated: ["statement-split", "comparison"],
    goal: {
      summary: "Fundraising results panel with three headline figures",
      subject: "Fundraising results",
      audience: "donors and board members",
      purpose: "show impact at a glance",
      tone: "proud, factual",
      designType: "metrics",
      industry: "nonprofit",
      keywords: ["funds", "raised", "donors", "total", "results", "impact", "report"],
      composition: "stacked",
      mustInclude: ["three figures", "one note per figure", "campaign name"],
      avoid: ["invented amounts"],
      style: "clean editorial, quiet authority",
    },
  },
  {
    id: "studio-newsletter",
    prompt: "Monthly newsletter cover for the studio collective",
    canvas: { width: 1200, height: 630 },
    expect: "newsletter",
    tolerated: ["editorial-columns", "hero-top"],
    goal: {
      summary: "Monthly newsletter cover for the studio collective",
      subject: "Monthly newsletter",
      audience: "members of the collective",
      purpose: "round up the month's news",
      tone: "friendly, editorial",
      designType: "newsletter",
      industry: "publishing",
      keywords: ["newsletter", "monthly", "roundup", "issues", "updates", "columns", "subscribe"],
      composition: "stacked",
      mustInclude: ["issue number", "three story teasers", "subscribe line"],
      avoid: ["dense paragraphs"],
      style: "minimal editorial, one red accent",
    },
  },
  {
    id: "blood-donation",
    prompt: "Blood donation drive poster for the community centre",
    canvas: { width: 1200, height: 630 },
    expect: "statement-split",
    tolerated: ["poster-rail", "hero-split"],
    goal: {
      summary: "Blood donation drive poster for the community centre",
      subject: "Blood donation drive",
      audience: "local residents",
      purpose: "get people to donate",
      tone: "urgent but warm",
      designType: "poster",
      industry: "civic",
      keywords: ["blood", "donation", "drive", "community", "donate", "centre", "health", "statement", "beside", "image", "split"],
      composition: "split",
      mustInclude: ["drive dates", "venue", "eligibility line", "registration link"],
      avoid: ["graphic imagery", "invented medical claims"],
      style: "civic poster, clear authority",
    },
  },
  {
    id: "theatre-ticket",
    prompt: "Ticket for the autumn play at our community theatre",
    canvas: { width: 1200, height: 630 },
    expect: "ticket",
    tolerated: ["banner-strip", "event-listing"],
    goal: {
      summary: "Ticket for the autumn play at the community theatre",
      subject: "Theatre ticket",
      audience: "season ticket holders and guests",
      purpose: "admit one to the autumn play",
      tone: "playful, theatrical",
      designType: "ticket",
      industry: "arts and culture",
      keywords: ["ticket", "theatre", "play", "autumn", "performance", "admission", "seat"],
      composition: "split",
      mustInclude: ["play title", "performance date", "seat and price placeholders", "venue"],
      avoid: ["invented seat numbers"],
      style: "stage purple, night glow",
    },
  },
  {
    id: "gallery-social",
    prompt: "Square social post announcing our gallery opening",
    canvas: { width: 1080, height: 1080 },
    expect: "story-stack",
    tolerated: ["social-post", "hero-top"],
    goal: {
      summary: "Square social post announcing our gallery opening",
      subject: "Gallery opening",
      audience: "followers and local art lovers",
      purpose: "announce the opening night",
      tone: "bold, inviting",
      designType: "social-post",
      industry: "arts and culture",
      keywords: ["gallery", "opening", "art", "exhibition", "social", "square", "night"],
      composition: "stacked",
      mustInclude: ["exhibition title", "opening date and time", "venue", "artist names"],
      avoid: ["tiny text", "cluttered centre"],
      style: "minimal editorial, one red accent",
    },
  },
];

if (LIMIT > 0) CASES.length = Math.min(LIMIT, CASES.length);

// ---------------------------------------------------------------------------
// Ollama plumbing
// ---------------------------------------------------------------------------

/** Same split the browser client does before POST /api/ai. */
function splitPrompt(full) {
  const lines = String(full || "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "[User]");
  if (at === -1) return { system: "", user: String(full || "") };
  const sys = lines.slice(0, at).filter((l) => l.trim() !== "[System]");
  return { system: sys.join("\n").trim(), user: lines.slice(at + 1).join("\n").trim() };
}

async function ollamaChat({ model, prompt, schema, numPredict }) {
  const { system, user } = splitPrompt(prompt);
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      think: false,
      keep_alive: "30m",
      ...(schema ? { format: schema } : {}),
      options: {
        num_ctx: 8192,
        num_thread: 2,
        num_predict: numPredict,
        temperature: 0.2,
        draft_num_predict: 0,
      },
    }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`ollama ${res.status}: ${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let last = null;
  let chunks = 0;
  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (obj.error) throw new Error(String(obj.error));
    if (obj.done) {
      last = obj;
      return;
    }
    const piece = obj.message?.content;
    if (piece) {
      text += piece;
      chunks++;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      consume(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  consume(buffer);
  const wallMs = Date.now() - t0;
  return {
    text,
    wallMs,
    chunks,
    loadMs: (last?.load_duration ?? 0) / 1e6,
    prefillTok: last?.prompt_eval_count ?? null,
    prefillMs: (last?.prompt_eval_duration ?? 0) / 1e6,
    evalTok: last?.eval_count ?? null,
    evalMs: (last?.eval_duration ?? 0) / 1e6,
  };
}

// ---------------------------------------------------------------------------
// Per-call checks
// ---------------------------------------------------------------------------

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function paletteFor(goal) {
  const found = lookupPalette(goal) || DEFAULT_PALETTE;
  return {
    background: found.background,
    ink: found.ink,
    accent: found.accent,
    style: found.style || DEFAULT_PALETTE.style,
    roles: ensurePaletteRoles(found),
  };
}

function evaluateChoice(parsed) {
  if (!parsed || typeof parsed !== "object" || typeof parsed.template !== "string") {
    return { san: false, match: false, detail: "no template id" };
  }
  const picked = parsed.template;
  const san = TEMPLATE_IDS.includes(picked);
  return { san, picked, detail: san ? picked : `unknown:${picked}` };
}

function evaluateTuning(parsed, template) {
  if (!parsed || typeof parsed !== "object") return { san: false, detail: "unparsable" };
  const variants = new Set((template.variants || []).map((v) => v.id));
  const slots = templateSlots(template);
  const slotIds = new Set(slots.map((s) => s.id));
  const optional = new Set(slots.filter((s) => s.optional).map((s) => s.id));
  const list = (v) => (Array.isArray(v) ? v : []);
  const badHide = list(parsed.hide).filter((id) => !optional.has(id));
  const badScale = list(parsed.scale).filter((e) => !e || !slotIds.has(e.id)).map((e) => e?.id ?? "?");
  const badAlign = list(parsed.align).filter((e) => !e || !slotIds.has(e.id)).map((e) => e?.id ?? "?");
  const hideOk = badHide.length === 0;
  const scaleOk = badScale.length === 0;
  const alignOk = badAlign.length === 0;
  const variantOk = variants.has(parsed.variant);
  const densityOk = ["tight", "normal", "airy"].includes(parsed.density);
  const sanitized = sanitizeTuning(parsed, template);
  const san = variantOk && densityOk && hideOk && scaleOk && alignOk && sanitized.variant === parsed.variant;
  return {
    san,
    detail:
      `v=${parsed.variant} d=${parsed.density} hide=${list(parsed.hide).length} scale=${list(parsed.scale).length} align=${list(parsed.align).length}` +
      (badHide.length ? ` badHide=${badHide.slice(0, 3).join(",")}` : "") +
      (badScale.length ? ` badScale=${badScale.slice(0, 3).join(",")}` : "") +
      (badAlign.length ? ` badAlign=${badAlign.slice(0, 3).join(",")}` : "") +
      (!variantOk ? " badVariant" : "") +
      (!densityOk ? " badDensity" : ""),
  };
}

function evaluateCopy(parsed, canvas) {
  const elements = Array.isArray(parsed?.elements) ? parsed.elements : null;
  if (!elements) return { san: false, match: false, detail: "no elements[]" };
  let check;
  try {
    check = validateDesign({ canvas, elements });
  } catch (error) {
    return { san: false, match: false, detail: `validator threw: ${String(error.message).slice(0, 60)}` };
  }
  const texts = elements.filter((e) => e && e.type === "text" && String(e.content || "").trim().length);
  return {
    san: !!check.ok,
    match: !!check.ok && texts.length > 0,
    detail: `els=${elements.length} text=${texts.length}${check.ok ? "" : ` err=${(check.errors?.[0] || "").slice(0, 60)}`}`,
  };
}

// ---------------------------------------------------------------------------
// One case, three calls
// ---------------------------------------------------------------------------

function copyComponent(components) {
  const text = components.filter((c) => c.kind !== "image" && c.role !== "decoration" && c.fontSize > 0);
  return text.find((c) => c.role === "headline") || text[0] || components[0];
}

async function runCase(model, c) {
  const goal = c.goal;
  const canvas = c.canvas;
  const palette = paletteFor(goal);
  const found = retrieveTemplates(goal, canvas, { limit: RETRIEVAL_LIMIT });
  const base = { model, case: c.id, prompt: c.prompt, canvas: `${canvas.width}x${canvas.height}`, strict: STRICT };

  const record = (call, out, extra = {}) => {
    const row = { ...base, call, ...out, ...extra };
    rows.push(row);
    if (!PREFLIGHT) {
      const bits = [
        `[${model}] ${call.padEnd(6)} ${c.id.padEnd(20)}`,
        `wall=${(out.wallMs / 1000).toFixed(1)}s`,
        `prefill=${out.prefillTok ?? "?"}tok/${((out.prefillMs || 0) / 1000).toFixed(1)}s`,
        `eval=${out.evalTok ?? "?"}tok/${((out.evalMs || 0) / 1000).toFixed(1)}s`,
        `ok=${out.valid ? "Y" : "N"} san=${out.san ? "Y" : "N"}${out.match != null ? ` match=${out.match ? "Y" : "N"}` : ""}`,
        out.detail ? `(${out.detail})` : "",
      ];
      console.log(bits.join(" "));
    }
  };

  // --- choice -------------------------------------------------------------
  if (ONLY.has("choice")) {
    const prompt = buildTemplateChoicePrompt(goal, palette, canvas, found.scored);
    const schema = templateChoiceSchema(found.candidates);
    if (PREFLIGHT) {
      const retrPick = found.decisive?.id || (found.candidates.length === 1 ? found.candidates[0] : null);
      console.log(
        `  ${c.id.padEnd(20)} canvas=${base.canvas} expect=${c.expect} inShortlist=${found.candidates.includes(c.expect) ? "Y" : "N"} ` +
          `cands=${found.candidates.join(",") || "(none)"} retrieval=${retrPick || "ask"} coverage=${(found.coverage || 0).toFixed(2)} chars=${prompt.length}`,
      );
      if (!found.candidates.length) console.log(`    ! no candidates: the choice call cannot be made for ${c.id}`);
    } else if (!found.candidates.length) {
      record("choice", { valid: false, san: false, match: false, wallMs: 0, prefillTok: 0, prefillMs: 0, evalTok: 0, evalMs: 0, detail: "no candidates (abstain)" });
    } else {
      try {
        const out = await ollamaChat({ model, prompt, schema, numPredict: 220 });
        const parsed = parseJson(out.text);
        const ev = evaluateChoice(parsed);
        const picked = ev.picked || "";
        const match = picked === c.expect || c.tolerated.includes(picked);
        record("choice", { valid: !!parsed, san: ev.san, match, picked, ...out, ...ev, detail: `pick=${picked || "?"} expect=${c.expect}` });
      } catch (error) {
        record("choice", { valid: false, san: false, match: false, wallMs: 0, prefillTok: null, prefillMs: 0, evalTok: null, evalMs: 0, detail: `error: ${error.message.slice(0, 120)}` });
      }
    }
  }

  // --- tuning -------------------------------------------------------------
  const template = getTemplate(c.expect);
  if (ONLY.has("tune") && template) {
    const prompt = buildTuningPrompt(template, goal, palette, canvas);
    if (PREFLIGHT) {
      const slots = templateSlots(template);
      console.log(
        `  ${c.id.padEnd(20)} tune=${template.id} variants=${(template.variants || []).map((v) => v.id).join("/")} ` +
          `slots=${slots.map((s) => s.id + (s.optional ? "?" : "")).join(",")} chars=${prompt.length}`,
      );
    } else {
      try {
        const out = await ollamaChat({
          model,
          prompt,
          schema: STRICT ? strictTuningSchema(template) : TUNING_SCHEMA,
          numPredict: 320,
        });
        const parsed = parseJson(out.text);
        const ev = evaluateTuning(parsed, template);
        record("tune", { valid: !!parsed, san: ev.san, match: null, ...out, ...ev, detail: ev.detail });
      } catch (error) {
        record("tune", { valid: false, san: false, match: null, wallMs: 0, prefillTok: null, prefillMs: 0, evalTok: null, evalMs: 0, detail: `error: ${error.message.slice(0, 120)}` });
      }
    }
  }

  // --- slot copy ----------------------------------------------------------
  if (ONLY.has("copy") && template) {
    const built = instantiateTemplate(template, null, canvas);
    if (!built.ok) {
      if (PREFLIGHT) console.log(`  ${c.id.padEnd(20)} copy skipped: ${built.reason}`);
    } else {
      const plan = {
        palette: { ...palette, roles: palette.roles },
        style: palette.style,
        template: template.id,
        components: built.components,
      };
      const component = copyComponent(built.components);
      const prompt = buildComponentPrompt(component, canvas, plan, goal);
      if (PREFLIGHT) {
        console.log(
          `  ${c.id.padEnd(20)} copy slot=${component.id} role=${component.role} box=${component.box.width}x${component.box.height} ` +
            `maxChars=${component.maxChars} fontSize=${component.fontSize} chars=${prompt.length}`,
        );
      } else {
        try {
          const maxItems = built.components.length;
          const out = await ollamaChat({
            model,
            prompt,
            schema: STRICT ? strictCopySchema(component, maxItems) : COPY_SCHEMA,
            numPredict: STRICT ? copyBudgetTokens(component, maxItems) : 800,
          });
          const parsed = parseJson(out.text);
          const ev = evaluateCopy(parsed, canvas);
          record("copy", { valid: !!parsed, san: ev.san, match: ev.match, ...out, ...ev, detail: `slot=${component.id} ${ev.detail}` });
        } catch (error) {
          record("copy", { valid: false, san: false, match: false, wallMs: 0, prefillTok: null, prefillMs: 0, evalTok: null, evalMs: 0, detail: `error: ${error.message.slice(0, 120)}` });
        }
      }
    }
  }
}

// A compact but strict element schema: same shape family as the production
// COMPONENTS_SCHEMA (id + optional styling fields + one variant's props).
const OPT = {
  role: { type: ["string", "null"] },
  stroke: { type: ["string", "null"] },
  strokeWidth: { type: ["number", "null"] },
  angle: { type: ["number", "null"] },
  opacity: { type: ["number", "null"] },
};
const variant = (extra) => {
  const properties = { id: { type: "string" }, ...OPT, ...extra };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
};
const TEXT_VAR = variant({
  type: { type: "string", enum: ["text"] },
  content: { type: "string" },
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  fontSize: { type: "number" },
  fontWeight: { type: "number" },
  fill: { type: "string" },
  textAlign: { type: ["string", "null"] },
  lineHeight: { type: ["number", "null"] },
  fontFamily: { type: ["string", "null"] },
});
const RECT_VAR = variant({
  type: { type: "string", enum: ["rectangle"] },
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" },
  fill: { type: "string" },
  cornerRadius: { type: ["number", "null"] },
});
const CIRCLE_VAR = variant({
  type: { type: "string", enum: ["circle"] },
  x: { type: "number" },
  y: { type: "number" },
  radius: { type: "number" },
  fill: { type: "string" },
});
const LINE_VAR = variant({
  type: { type: "string", enum: ["line"] },
  x: { type: "number" },
  y: { type: "number" },
  x2: { type: "number" },
  y2: { type: "number" },
});
const GROUP_VAR = variant({
  type: { type: "string", enum: ["group"] },
  x: { type: "number" },
  y: { type: "number" },
  children: { type: "array", items: { anyOf: [TEXT_VAR, RECT_VAR, CIRCLE_VAR, LINE_VAR] } },
});
const COPY_SCHEMA = {
  type: "object",
  properties: { elements: { type: "array", items: { anyOf: [TEXT_VAR, RECT_VAR, CIRCLE_VAR, LINE_VAR, GROUP_VAR] } } },
  required: ["elements"],
  additionalProperties: false,
};

/**
 * Strict schemas (--strict). The baseline constrains SYNTAX and broad shape;
 * these also constrain the ANSWER to things this template can actually use:
 *   - tuning ids become enums of the chosen template's real slot names, so a
 *     model cannot answer "region-1" (the failure the 270m eval exposed);
 *   - copy is bounded by the template's slot count and the slot's maxChars;
 *   - num_predict is derived from that budget instead of the flat 800.
 */
function strictTuningSchema(template) {
  const slots = templateSlots(template);
  const ids = slots.map((s) => s.id);
  const optional = slots.filter((s) => s.optional).map((s) => s.id);
  const variants = (template.variants || []).map((v) => v.id);
  const idEnum = { type: "string", enum: ids };
  return {
    type: "object",
    properties: {
      variant: { type: "string", enum: variants },
      density: { type: "string", enum: ["tight", "normal", "airy"] },
      hide: optional.length
        ? { type: "array", maxItems: optional.length, items: { type: "string", enum: optional } }
        : { type: "array", maxItems: 0, items: { type: "string" } },
      scale: {
        type: "array",
        maxItems: ids.length,
        items: {
          type: "object",
          properties: { id: idEnum, factor: { type: "number" } },
          required: ["id", "factor"],
          additionalProperties: false,
        },
      },
      align: {
        type: "array",
        maxItems: ids.length,
        items: {
          type: "object",
          properties: { id: idEnum, value: { type: "string", enum: ["left", "center", "right"] } },
          required: ["id", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["variant", "density", "hide", "scale", "align"],
    additionalProperties: false,
  };
}

function strictCopySchema(component, maxItems) {
  const maxChars = component.maxChars > 0 ? component.maxChars : 0;
  const text = maxChars
    ? { ...TEXT_VAR, properties: { ...TEXT_VAR.properties, content: { type: "string", maxLength: maxChars } } }
    : TEXT_VAR;
  // Groups are one level deep, so bound their children too; otherwise a
  // model could put an over-long text run inside a group and dodge maxLength.
  const group = {
    ...GROUP_VAR,
    properties: {
      ...GROUP_VAR.properties,
      children: { type: "array", maxItems, items: { anyOf: [text, RECT_VAR, CIRCLE_VAR, LINE_VAR] } },
    },
  };
  return {
    type: "object",
    properties: {
      elements: {
        type: "array",
        maxItems,
        items: { anyOf: [text, RECT_VAR, CIRCLE_VAR, LINE_VAR, group] },
      },
    },
    required: ["elements"],
    additionalProperties: false,
  };
}

/** Output budget for one region: its copy limit + its element upper bound. */
function copyBudgetTokens(component, maxItems) {
  const contentTokens = Math.ceil((component.maxChars || 60) / 3);
  return Math.max(180, Math.min(800, 140 + contentTokens * 3 + maxItems * 12));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmtS = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const fmtN = (n) => (n == null ? "—" : String(n));
const rate = (list, key) => {
  const real = list.filter((r) => !String(r.detail || "").startsWith("error:"));
  if (!real.length) return "—";
  return `${real.filter((r) => r[key]).length}/${real.length}`;
};
const mean = (list, key) => {
  const vals = list.map((r) => r[key]).filter((v) => typeof v === "number" && v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

function report(model) {
  const all = rows.filter((r) => r.model === model);
  for (const call of ["choice", "tune", "copy"]) {
    const list = all.filter((r) => r.call === call);
    if (!list.length) continue;
    console.log(`\n=== ${model} — ${call} ===`);
    console.log(
      "case | valid | san | match | wall | prefill tok | prefill s | eval tok | eval s | detail",
    );
    for (const r of list) {
      console.log(
        [
          r.case,
          r.valid ? "Y" : "N",
          r.san ? "Y" : "N",
          r.match == null ? "—" : r.match ? "Y" : "N",
          fmtS(r.wallMs),
          fmtN(r.prefillTok),
          r.prefillMs ? (r.prefillMs / 1000).toFixed(1) : "—",
          fmtN(r.evalTok),
          r.evalMs ? (r.evalMs / 1000).toFixed(1) : "—",
          r.detail || "",
        ].join(" | "),
      );
    }
  }
}

function summary() {
  console.log("\n=== comparison ===");
  console.log("model | choice wall | choice valid | choice match | tune wall | tune san | copy wall | copy san | prefill tok/s | eval tok/s");
  for (const model of MODELS) {
    const all = rows.filter((r) => r.model === model);
    if (!all.length) continue;
    const cell = (call, key) => {
      const list = all.filter((r) => r.call === call);
      return { list, key };
    };
    const wallOf = (call) => {
      const list = all.filter((r) => r.call === call);
      return fmtS(mean(list, "wallMs"));
    };
    const prefillRate = (() => {
      const list = all.filter((r) => (r.prefillTok || 0) > 0 && (r.prefillMs || 0) > 0);
      if (!list.length) return "—";
      const tok = list.reduce((s, r) => s + r.prefillTok, 0);
      const ms = list.reduce((s, r) => s + r.prefillMs, 0);
      return `${(tok / (ms / 1000)).toFixed(1)}`;
    })();
    const evalRate = (() => {
      const list = all.filter((r) => (r.evalTok || 0) > 0 && (r.evalMs || 0) > 0);
      if (!list.length) return "—";
      const tok = list.reduce((s, r) => s + r.evalTok, 0);
      const ms = list.reduce((s, r) => s + r.evalMs, 0);
      return `${(tok / (ms / 1000)).toFixed(1)}`;
    })();
    const choice = all.filter((r) => r.call === "choice");
    const tune = all.filter((r) => r.call === "tune");
    const copy = all.filter((r) => r.call === "copy");
    console.log(
      [
        model,
        wallOf("choice"),
        rate(choice, "valid"),
        rate(choice, "match"),
        wallOf("tune"),
        rate(tune, "san"),
        wallOf("copy"),
        rate(copy, "san"),
        prefillRate,
        evalRate,
      ].join(" | "),
    );
  }
}

async function main() {
  const banner = PREFLIGHT ? "PREFLIGHT (no model calls)" : `models: ${MODELS.join(", ")}`;
  console.log(`tiny-eval — ${CASES.length} briefs — ${banner}`);
  console.log(`ollama: ${OLLAMA}\n`);

  if (PREFLIGHT) {
    for (const c of CASES) await runCase("preflight", c);
    return;
  }

  for (const model of MODELS) {
    console.log(`\n########## ${model} ##########`);
    for (const c of CASES) {
      await runCase(model, c);
    }
    report(model);
    writeFileSync(outFileFor(model), rows.filter((r) => r.model === model).map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  summary();
  console.log(`\nraw rows: ${MODELS.map(outFileFor).join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
