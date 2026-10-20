/**
 * Layered architect prompts (raw -> best).
 *
 * The generation pipeline is a cascade of small, single-purpose passes, so a
 * terse user request still lands a complete, on-palette design without the
 * user having to spell anything out:
 *
 *   L1 goal      raw prompt            -> a precise, expanded design goal
 *   L2 palette   goal                  -> {background, ink, accent, style}
 *   L3 skeleton  goal + palette        -> header/hero/sections/footer boxes
 *   L4 text      one skeleton region   -> DSL elements (architectPrompt.js)
 *   L5 color     rendered design       -> palette + contrast corrections
 *
 * Each layer receives only what it needs, so no single call has to be clever
 * and a weak answer in one layer cannot wreck the others. The JSON schemas
 * mirror the shape each layer's sanitizer accepts.
 */

export const GOAL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    subject: { type: "string" },
    audience: { type: "string" },
    purpose: { type: "string" },
    tone: { type: "string" },
    designType: { type: "string" },
    industry: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    composition: { type: "string" },
    mustInclude: { type: "array", items: { type: "string" } },
    avoid: { type: "array", items: { type: "string" } },
    style: { type: "string" },
  },
  required: [
    "summary", "subject", "audience", "purpose", "tone",
    "designType", "industry", "keywords", "composition",
    "mustInclude", "avoid", "style",
  ],
  additionalProperties: false,
};

export const PALETTE_SCHEMA = {
  type: "object",
  properties: {
    background: { type: "string" },
    ink: { type: "string" },
    accent: { type: "string" },
    style: { type: "string" },
  },
  required: ["background", "ink", "accent", "style"],
  additionalProperties: false,
};

export const SKELETON_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["dsl", "image"] },
          role: {
            type: "string",
            enum: ["header", "headline", "hero", "tagline", "details", "sections", "audience", "footer", "decoration"],
          },
          describe: { type: "string" },
          asset: { type: "string", enum: ["icon", "logo", "illustration", "photo", "none"] },
          box: {
            type: "object",
            properties: {
              x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
        },
        required: ["id", "kind", "role", "describe", "asset", "box"],
        additionalProperties: false,
      },
    },
  },
  required: ["components"],
  additionalProperties: false,
};

/**
 * The SHARED STATIC PREFIX.
 *
 * Prefill is the bottleneck on this machine (~10 tok/s measured), so a
 * 3.8k-token prompt costs ~6 minutes before a single token is generated.
 * Ollama reuses the KV cache for the longest common prefix across calls, so
 * every layer — L1 goal, L2 palette, L3 skeleton, L4 region — starts with
 * these exact bytes: the first call pays for them, every later call gets them
 * from cache. Two rules keep that true:
 *   1. Nothing variable lives here. No canvas size, palette, theme, ids or
 *      counters — those all go in the layer's [User] turn, which comes last.
 *   2. Every layer's system message must BEGIN with this string verbatim.
 * It carries the DSL contract plus one compact example, kept near 350 tokens.
 */
export const DESIGN_CORE = [
  "[System]",
  "You are the layout engine of a two-stage design pipeline. It turns a short brief into editable vector elements (never a flattened image). These rules hold for every design:",
  "- Every element is a JSON object with a unique lowercase id.",
  "- Text must contrast its own backing bar, not just the canvas.",
  "- Buy density with SIZE and grouping, not element count: a tall box wants larger type and more grouped rows; a thin bar wants a single line.",
  "- Copy is short: at most 6 words per text element.",
  '- Use only facts from the brief; never invent names, dates, venues or prices (write "TBA").',
  "- Colours are CSS hex strings.",
  "",
  "Element types (include every REQUIRED property; omit optional extras unless the theme needs them):",
  '- text: {id, type:"text", content, x, y, width, fontSize, fontWeight, fill} — content is a plain string; fontSize 12-120.',
  '- rectangle: {id, type:"rectangle", x, y, width, height, fill}',
  '- circle: {id, type:"circle", x, y, radius, fill}',
  '- line: {id, type:"line", x, y, x2, y2, stroke}',
  '- group: {id, type:"group", x, y, children:[...]} — nests one level; a group counts as ONE element.',
  "",
  "Optional properties (only when the theme calls for them):",
  '- gradient {type:"linear"|"radial", stops:[{offset, color}]}; stroke, strokeWidth (contrasting outline); angle (-8 to 8, stickers only); fontFamily, textAlign, lineHeight, charSpacing, cornerRadius, opacity.',
  "",
  "One compact finished example (a headline block):",
  '{"elements":[{"id":"headline-title","type":"text","content":"HACKTOBERFEST 2026","x":48,"y":120,"width":640,"fontSize":72,"fontWeight":700,"fill":"#FFFFFF"},{"id":"headline-rule","type":"rectangle","x":48,"y":216,"width":220,"height":8,"fill":"#FFC400"}]}',
  "",
  "Answer with ONE JSON object and nothing else: no Markdown, no fences, no commentary.",
].join("\n");

/** Renders a goal object as a compact, readable brief for later layers. */
export function formatGoal(goal) {
  if (!goal) return "";
  const list = (v) => (Array.isArray(v) && v.length ? v.join("; ") : "none");
  return [
    `Summary: ${goal.summary || goal.subject || "design"}`,
    goal.subject ? `Subject: ${goal.subject}` : "",
    goal.designType ? `Design type: ${goal.designType}` : "",
    goal.industry ? `Industry: ${goal.industry}` : "",
    Array.isArray(goal.keywords) && goal.keywords.length ? `Keywords: ${goal.keywords.join(", ")}` : "",
    goal.composition ? `Desired composition: ${goal.composition}` : "",
    goal.audience ? `Audience: ${goal.audience}` : "",
    goal.purpose ? `Purpose: ${goal.purpose}` : "",
    goal.tone ? `Tone: ${goal.tone}` : "",
    goal.style ? `Style: ${goal.style}` : "",
    `Must include: ${list(goal.mustInclude)}`,
    `Avoid: ${list(goal.avoid)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * L1 — Redefine the goal. Turns a rough request into an explicit brief:
 * what it is, who it is for, what must appear, and what to avoid. Facts that
 * cannot be known stay as TBA placeholders (never invented).
 */
export function buildGoalPrompt(userPrompt, canvas) {
  return [
    DESIGN_CORE,
    "",
    "Your task now: expand the user's rough, possibly terse request into an explicit design goal for the layout above — without changing what the thing IS.",
    "Goal rules:",
    "- Infer the audience, tone, visual style and the content blocks the design needs from what the request implies. A terse request is expected: fill it in.",
    "- NEVER invent verifiable facts — dates, times, venues, names, prices, sponsors, addresses. Those become obvious TBA placeholders the layout will show.",
    "- Keep it faithful: a certificate stays a certificate, a poster stays a poster. Refine the brief, do not redesign the subject.",
    '- designType is the FORMAT, exactly one of: poster, banner, social-post, story, cover, newsletter, notice, invitation, certificate, menu, schedule, listing, product-launch, gallery, quote, comparison, team, ticket, map, metrics, statement. Pick the closest even when the request is vague.',
    '- industry is the field the design belongs to, 1-3 words (e.g. "technology", "food and drink", "education", "health", "civic", "sports", "retail", "arts and culture", "finance"). Use "general" only when nothing applies.',
    '- keywords are 3-8 short retrieval terms naming the subject, occasion and audience (e.g. "diwali", "office celebration", "colleagues"). No design words like "modern" or "clean".',
    '- composition is the intended arrangement, exactly one of: hero-left, hero-right, centered, split, stacked, grid, banner, type-only. Use "hero-left"/"hero-right" when the request names a side or the subject is a product/object needing artwork; "centered" for formal notices and invitations; "split" for two equal halves; "grid" for several equal items; "banner" for wide strips; "type-only" when no artwork is wanted.',
    '- mustInclude lists the concrete content blocks the design needs (e.g. "event title and year", "date, time and venue", "three workshop highlights", "organizer footer"). 4 to 8 items.',
    '- avoid lists the obvious failure modes for this brief (e.g. "invented guest names", "cluttered centre", "low-contrast text"). 2 to 4 items.',
    '- style is a short visual-direction string (2 to 6 words), e.g. "warm editorial, generous whitespace".',
    'Return ONLY valid JSON: {"summary":"one-line refined goal","subject":"what it is","audience":"who it is for","purpose":"what it should achieve","tone":"e.g. celebratory, formal, playful","designType":"poster","industry":"technology","keywords":["..."],"composition":"hero-right","mustInclude":["..."],"avoid":["..."],"style":"..."}',
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height} pixels.`,
    userPrompt,
  ].join("\n");
}

/**
 * L2 — Color palette. One deliberate palette, chosen for strong
 * background/ink contrast (no fading) with a single rationed accent.
 */
export function buildPalettePrompt(goal, canvas) {
  // Short and self-contained on purpose: the palette answer is ~35 tokens and
  // this call shares nothing reusable with L1 (see DESIGN_CORE's note on
  // context checkpoints), so a shared prefix here is pure added prefill.
  return [
    "[System]",
    "You are a color director. Choose ONE palette for this design.",
    `Canvas: ${canvas.width}x${canvas.height} pixels.`,
    "The brief:",
    formatGoal(goal),
    "Rules:",
    "- background and ink MUST contrast strongly (aim for 7:1 or higher) so no text ever fades into its backdrop. Pick dark-on-light or light-on-dark deliberately.",
    "- accent is ONE vivid hue used sparingly (60-30-10: background dominates, ink carries body, accent is rationed).",
    "- All three are CSS hex colors (e.g. #14101F).",
    "- style is a short visual-direction string (2 to 6 words) that matches the tone above.",
    "Return ONLY valid JSON:",
    `{"background":"#......","ink":"#......","accent":"#......","style":"..."}`,
    "No Markdown, no fences, no commentary.",
    "",
    "[User]",
    goal?.summary || "Design a striking layout.",
  ].join("\n");
}

/**
 * L3 — Raw layout skeleton. Boxes, roles and what each region will HOLD —
 * no final copy (that is L4). This is the structural spine of the design.
 * The prose checklist that used to live here is folded into one roles line
 * plus the example, so the layer-specific part stays a few hundred tokens and
 * the shared prefix above it stays cacheable.
 */
export function buildSkeletonPrompt(goal, palette, canvas) {
  const w = canvas.width;
  const h = canvas.height;
  return [
    DESIGN_CORE,
    "",
    "Your task now: produce the SKELETON of ONE design — its ordered regions, each with a reserved box. Do NOT write the final copy; say what each region will hold and let the next pass fill it.",
    "Skeleton rules:",
    "- 6 to 12 regions. Together their boxes must cover most of the canvas — a half-empty canvas is a failed skeleton.",
    "- Order: header at the top, footer at the bottom, headline above the tagline, sections in the middle. Align to shared left/right edges.",
    "- Boxes must NOT overlap (decoration excepted, and it sits behind).",
    "- Headline is the largest region and at least 6% of canvas height. Header stays a small kicker.",
    "- ONE hero region only, at least 35% of canvas width, focal mass near the third-lines, never a thumbnail.",
    "- Roles: header (identity/kicker), headline (dominant title), hero (one focal image), tagline (supporting line), details (date/time/venue), sections (activities/benefits, grouped), audience, footer (organizer/partners/registration), decoration (theme shapes, behind, may bleed). Include only the regions the brief has content for — never pad.",
    '- "describe" is the content requirement for that region, NOT the finished string, e.g. "event title and year, huge, two lines".',
    '- kind "dsl" for text, rectangles, circles and lines; kind "image" ONLY for icons, logos, illustrations or photos (at most 2). For "dsl" set asset "none"; for "image" set asset icon|logo|illustration|photo.',
    "Example:",
    '{"components":[{"id":"headline","kind":"dsl","role":"headline","describe":"event title and year, huge, two lines","asset":"none","box":{"x":48,"y":120,"width":640,"height":180}},{"id":"hero-art","kind":"image","role":"hero","asset":"illustration","describe":"focal artwork for the theme","box":{"x":730,"y":300,"width":400,"height":400}}]}',
    "",
    "[User]",
    `Canvas: ${w}x${h} pixels. All boxes must fit inside it (x>=0, y>=0, x+width<=${w}, y+height<=${h}).`,
    `Palette: background ${palette.background}, ink ${palette.ink}, accent ${palette.accent}. Theme: ${palette.style || "clean modern"}.`,
    "The brief:",
    formatGoal(goal),
  ].join("\n");
}
