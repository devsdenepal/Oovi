# DECISIONS.md — ambiguous calls during the Oovi evolution

Conservative option wins every tie. Newest entries first.

## Tiny models for the narrow layers — measured, not assumed

Direction: a cheap model may handle a narrow layer while the big model keeps
the heavy lift. Quality is unknown until measured, so the order is config →
eval → dataset → stop. Nothing is trained yet.

### Benchmark (this box: i5-2520M, CPU-only, Ollama 0.40.6)

| model | prefill tok/s | generation tok/s |
| --- | --- | --- |
| gemma4:e2b (4.6B Q4_K_M, current default) | 10.9 | 3.3 |
| gemma3:1b | 19.9 | 9.6 |
| gemma3:270m | 103 | 27.8 |

Wall time equals the sum of its parts (load + prefill + eval), so there is no
hidden stall to chase. At 3.3 tok/s a 1100-token component reply is ~5.5
minutes; the narrow layers answer in tens of tokens, which is exactly where a
small model can pay for itself.

### Per-layer model config (defaults unchanged)

`api/_aiChain.js` resolves the model per REQUEST NAME, because every pipeline
call already carries one:

- `oovi_template`, `oovi_tuning` → `OLLAMA_MODEL_TUNE`
- `oovi_component` → `OLLAMA_MODEL_COPY`
- `oovi_plan`, `oovi_skeleton` → `OLLAMA_MODEL_FALLBACK`
- `oovi_goal`, `oovi_palette` → `OLLAMA_MODEL`

Blank or unset falls back to `OLLAMA_MODEL`, so an existing `.env` behaves
exactly as before. `.env.example` documents the three vars. Options stay
identical per model (`think:false`, `keep_alive 30m`, `num_ctx 8192`,
`num_thread 2`, `temperature 0.2`, `draft_num_predict 0`). A model swap costs
~19-22s reload AND drops the prompt cache, so splitting layers only pays when
that call's prompt is small enough to earn the reload back.

### Eval harness (`scripts/tiny-eval.mjs`)

15 realistic briefs — product launch, Diwali office poster (Hindi summary),
autumn menu (Spanish), jazz calendar (Japanese), certificate, summer camp,
hackathon, wedding invitation, conference banner, pricing comparison,
fundraising metrics, newsletter, blood drive, theatre ticket, gallery social —
through the three narrow production calls: template choice, tuning patch and
slot copy. The prompts are built by the production builders and split into
system/user turns the same way `/api/ai` does; decoding is schema-constrained
and options are identical for every model. Per call it records valid JSON,
sanitized OK, template match against a hand label, wall latency and Ollama's
prefill/eval token counts.

The hand labels were checked BEFORE burning model time (`--preflight`): every
label is in retrieval's shortlist and every case is non-decisive, i.e. the
choice call is one production would actually make. Four briefs needed
vocabulary that matches the intended template (agenda, card-grid, banner-strip,
event-listing) — a reminder that retrieval, not the model, decides reachability
through the schema enum.

### Dataset (`scripts/make-dataset.mjs`, generated, nothing trained)

2,500 examples — 2,169 train / 331 eval (13.2%), split by brief group so one
brief's records never straddle the split:

- 800 template-choice: `prompt -> {template, why}`
- 800 tuning: `prompt -> {variant, density, hide, scale, align}`
- 900 slot copy: `prompt -> {elements:[text element]}`

All 30 templates appear in every task; 189 distinct copy slots. Languages:
62% English, 38% split across Hindi, Spanish, French, German, Japanese. All
five canvas shape classes. Prompts come from the production builders, so the
static prefix is byte-identical (verified against `TEMPLATE_RULES` and
`DESIGN_CORE` for all 2,500 records); targets re-sanitize unchanged, copy
targets pass `validateDesign`, no duplicate prompts, no train/eval group
overlap.

**Copy targets carry the brief's own facts.** Every brief now generates a
name, organiser, date, venue, booking link and item list; those values are
written into `mustInclude` (so they are literally in the production prompt)
and the copy target is built from them. The one-shot example still appears
in the prompt — with *different* facts — so the model must learn "write this
region from the brief", not "paraphrase the example". Verification requires
every copy target to contain a word from the prompt's fact lines and to stay
inside the region's `maxChars`; 900/900 pass both. Copy targets carry the
full closed `COMPONENTS_SCHEMA` shape (optionals as null), so completion-only
training matches what constrained decoding must emit. The two copy attempts
that could not fit a fact into their slot were dropped rather than trained as
nonsense (58 further attempts repeated an already-used prompt).

**Held-out occasions.** Ten archetypes are reserved for eval and never appear
in train: season preview, festival programme listing, festival ticket, cafe
menu, community gallery, three-step process, quarterly metrics, course
certificate, festival site map, weekend workshop timetable. They contribute
168 eval records across 50 groups; the remaining eval split is the usual
group-hash holdout. The 1-in-16 hash rate keeps the total at ~13% rather than
letting held-out themes push it to ~17%.

The dataset uses the production stack at a level the eval does not: retrieval
must contain the chosen template or the record is dropped (1 brief was), and
a documented doc-vocabulary boost was needed for 88 of 800 briefs — the same
bias the scope fields already apply in L3.

### Strict schemas for the tiny models (`--strict`)

The baseline eval exposed the failure mode clearly: 270m can choose a
template, but it invents tuning region ids (`region-1`, `region-2`) and its
copy call runs to the flat 800-token cap. The strict mode does not change
the prompt; it changes what the decoder is allowed to answer, per call:

- tuning region ids are an `enum` of the chosen template's actual slots, the
  variant is an enum of its variants, `hide` is limited to its optional
  slots, and `scale`/`align` cannot exceed the slot count;
- copy `elements` is bounded by the template's slot count, and text
  `content` is bounded by the slot's `maxChars` (`maxLength`);
- `num_predict` is derived from the slot budget instead of a flat 800
  (`140 + ~maxChars + slots*12` tokens, clamped 180–800).

This is a production-representable answer, not a trick: the same schema can
be built in `api/_aiChain.js` from the chosen template and region. It also
separates "the model needs training" from "the decoder was asked an
unanswerable question".

Writing schema-shaped targets exposed a live validator bug: a closed schema
emits `gradient: null`, but `validateDesign` treated the null as a malformed
gradient and rejected the region. The guard now ignores a null gradient
(`normalizeElement` already dropped nulls), so strict-schema copy can pass
validation instead of retrying forever.

### Colab notebook (`train/colab_lora.ipynb`)

Prepared, not run from this box. It reads the JSONL prompts verbatim (no
re-phrasing), splits `[System]`/`[User]` exactly like `src/ai/aiClient.js`,
trains LoRA (r=16, alpha=32, all linear projections) with completion-only
loss, merges, converts to GGUF Q8_0, and writes a Modelfile whose `TEMPLATE`
is the exact Go template captured from `ollama show gemma3:270m --modelfile`.
A parity cell asserts that HF's rendered chat prompt (with BOS) equals the
Ollama template's output, so training and serving see the same bytes. The
notebook is task-selectable (`TASKS = ("tune",)` etc.) for one adapter per
layer, and ends with the local `ollama create` and
`node scripts/tiny-eval.mjs --model <tag> --strict` commands.

`scripts/tiny-eval.mjs` now accepts any Ollama tag via `--model`/`--models`
(the imported GGUF included) and writes a separate results file per tag and
mode.

## On-device only: Ollama + Gemma (user order: "only opensource models", "use ollama")
- Provider choice is a hard rule, not a preference: every AI call runs an
  open-weight model served on-device by Ollama (the local Gemma model,
  `gemma4:e2b`). No cloud provider, no key, and no outbound AI traffic
  anywhere in the pipeline.
- Every other provider is DELETED, not just demoted: the cloud callers,
  their URL constants, model ids and key env vars, the client-side model
  hint, and the provider-specific probe scripts are all gone.
  `api/_aiChain.js` now holds exactly one provider.
- The unverifiable third-party gateway rung and its whole client path stay
  deleted, so the server route is the only way out of the app — which makes
  "open-weight only" checkable rather than aspirational.
- The AI route and its file were renamed so the endpoint no longer names a
  provider it does not use (now `api/ai.js` at `POST /api/ai`). Browser
  contract otherwise unchanged: one POST, OpenAI-style `messages` in /
  `{ text, provider }` out.
- Reachability: a 1.5s /api/tags health probe fails fast when the daemon is
  down instead of hanging to the 120s timeout; connection errors retry once.
  No response_format passed (Ollama's structured-output support varies by
  version) — prompt discipline + the existing lenient repair handle it.
- Context: the plan prompt is ~3.8k tokens; gemma4:e2b reports a 131k
  context, so no OLLAMA_CONTEXT_LENGTH override is needed.
- Model pick: whatever is installed on this machine (`gemma4:e2b`, 4.6B
  Q4_K_M) is what runs — no download step, fits comfortably in RAM.

## Bricked opens (user report): save accepted what open rejected — twice
- Bug 1, validator: save persists Fabric truth (group children in
  group-relative coords, routinely negative; objects dragged partially
  off-canvas with negative x/y) but open demanded every number >= 0.
  7 of 11 saved designs unopenable. Fix: positions (x/y/x2/y2) accept
  any finite number, top-level or nested; sizes stay >= 0. Same
  relaxation in patch.js update-props (nested moves + off-canvas nudges
  are legitimate). Rule kept where it protects: negative sizes, empty
  designs (AI must produce something; loadProject opens those blank).
- Bug 2, renderer (surfaced by the same design once validation passed):
  toFabricFill emitted "50%" STRINGS for percentage-unit Gradient
  coords, but Fabric 6 takes NUMBERS there (1 = 100% of bbox) — the
  strings reached createLinearGradient verbatim → non-finite → whole
  canvas render threw → same "Couldn't open project" toast. Fix:
  numeric clamped fractions. Plus a smoke test: toLive() the paint on
  a scratch context inside the existing try/catch, so ANY future
  gradient pathology (bad color, wild offset from legacy saves)
  degrades to the solid fill instead of bricking the open. Gradients
  were never render-verified before — first real gradient to reach the
  renderer was a legacy `coords:[...]`-array save.
- Proof: validate-saved.mjs (new, permanent — revalidates all DB
  designs), open-check.mjs (new, permanent — opens a design in the
  browser, asserts objects + no error toast), 3 validator fixtures in
  quality-check. All 4 bricked designs open (4/13/22/28 objects).

## Server-side AI gateway (user order): one route, on-device provider
- Every /api/ai request resolves its provider in api/_aiChain.js; the
  browser sends one normalized request and never learns how the model is
  hosted. There is no client-side provider switch.
- Retry policy: same-provider retry ONLY for cheap transient faults
  (network blips, fast 5xx < ~25s). A 429 or slow verdict stops
  immediately — a 500ms sleep won't clear a quota or demand spike.
- Strict json_schema is requested first; a 400 downgrades once to plain
  json_object, where the existing lenient repair loop takes over.
- Browser contract: POST /api/ai, OpenAI-style `messages` in, and the reply
  carries `provider`/`attempts`; the client logs which model answered
  (`[ai] ok via ollama …`). Nothing provider-specific is VITE_-prefixed.

## Perf/scale audit (user order): measure first, fix the hot spots
- History snapshotted the WHOLE canvas per keystroke (text:changed →
  full toObject+stringify into a 50-deep stack). Now trailing-800ms
  for typing only; discrete ops stay instant. Proven by type-check
  (5 keystrokes → 0 snapshots, then exactly 1; undo coherent).
- Every network fetch now has a cap: gateway 180s (existing),
  Pollinations backend 180s / direct 120s (new), image probe 30s (new,
  same fallback dims). Hangs become skips, never stalls.
- Deliberately NOT changed: pg pool default (10 fits single-user
  local), no clustering/rate-limit (local tool; reassess if multi-user),
  no image dedupe (seeds intentionally vary repeats), list LIMIT 100,
  manualChunks fabric + lazy bg-removal/jspdf/tesseract (23MB onnx wasm
  + duplicate ort chunks ship as lazy files, not initial bundle —
  dependency packaging, not worth fighting).
- Theory/gradient package (type scale, palette discipline, focal rules,
  gradient DSL) inspected and queued behind this audit, not dropped.

## Strict schemas + crowded-plan replan (first live poster)
- Strict json_schema rejects schemas whose properties aren't ALL required:
  every field is now required, optionals as null-unions, and the validator
  strips nulls before checking (false/0 preserved). Kills the
  400-then-downgrade round-trip on every component call.
- Reasoning effort wired end to end (plan medium, components low — verified
  accepted first), alongside component maxTokens 2000→1200.
- Tidy displacement capped at 120px/object (overlap shoves only; edge
  slide-backs stay unbounded). Beyond the cap the pair is named
  unresolvable, not rearranged into new overlaps (+290px cascades seen).
- Mass overlap (≥5 error overlaps) replans once like underbuilt plans
  ("stagger boxes, bars behind their text"); sanitize warns when planned
  boxes already overlap (decoration exempt — bleed is legal).
- Community backs the shape: constrained decoding kills malformed output at
  the token layer, but always validate client-side anyway (thinking models
  have shipped unconstrained replies with HTTP 200).

## Speed: 3-wide fan-out with 2s request gaps (supersedes half-parallel)
- Half-parallel burst-hung the gateway, so per user rule: max 3 concurrent
  tasks, consecutive request starts 2s apart (slot k starts at k*2s).
- Batch-apply left the canvas blank for 10+ minutes, so results now paint
  AS THEY LAND (apply runs inside the worker on settle). Final stacking
  still matches the plan exactly: each piece inserts at its plan-rank slot
  (op.at / addImageElement at-param, element-granular at+k), undo entries
  stay one-per-component.
- Logs everywhere per user request: gateway calls (host/model/chars/ms),
  plan + component summaries with attempts and timings, fan-out slot
  starts, fetch outcomes, pass quality, replan triggers, tidy moves.
- Sidebar overflow from the user's screenshot (cut slider label, buttons
  clipped at viewport bottom, rail reading as "cut"): measured idle layout
  fits, so the failures hit at generation tallness. Hardened the scroll
  chains instead of chasing one element — `.left-panels` and `.inspector`
  get the missing `min-height: 0` + internal scroll, range inputs get
  `min-width: 0` so the slider squeezes instead of the label clipping,
  prompt textarea + side blocks get `min-width: 0`, and `body` gets
  `overflow-x: clip` so no transient wide element can shift the grid.
  Tokens untouched; layout-only.
- Image path split into pure `_fetchImageComponent` + ordered add;
  `_generateImageComponent` removed (single caller, now dead).
- Gateway fetch capped at 180s via AbortSignal.timeout: hangs become
  quick per-component skips instead of stalling whole runs.
- Roles were silently dropped end-to-end (prompt demands them, model
  omits them, sanitize discarded even present ones): sanitize now
  preserves valid roles and infers the rest from the id, image-kind
  defaulting to hero.
- Correction retries only fix malformed model output, never dead
  networks: fetch failures in plan/component loops now throw immediately
  (one 180s cap max per call) instead of burning attempts × timeout on a
  hung gateway. Plan fallback chat line carries the failure reason.

## Density without noise (ChatGPT-vs-Oovi poster gap + overlap noise)
- User showed more content arriving as overlapping noise. Fix is NOT a
  bigger budget alone: collisions get a deterministic resolver,
  under-generation gets a bounded replan. Split by error code —
  sparse/missing/hero/headline → ONE replan with correction note;
  overlap/overflow → `Canvas.resolveCollisions()` (translation only,
  text moves, shapes/images treated as intentional layers, single
  history entry, unresolvable pairs reported for hand-fixing).
- Budget raised modestly, not maximally: 30→60 top-level elements,
  10→12 components, 1–6→1–8 per component, ≤2 images. Density is meant
  to live in GROUPS (cap counts top-level only; children validated but
  uncapped) — prompt now mandates one group per card/row.
- Renderer could already do more than the prompt advertised (rect stroke,
  text charSpacing, angle). Validator allowlist keeps those fields, so
  the fix advertises them: text stroke/strokeWidth/angle/fontFamily in
  the Types line, outline rule (stroke = background, ≈fontSize/10,
  paintFirst in renderer), multicolor headlines as adjacent runs,
  monospace stack for pixel themes. No gradient support added —
  reference poster is flat colors + outline; gradients were a red herring.
- `window.__oovi` probe handle was found MISSING (old probes ran
  vacuous on `?.` chains). Restored DEV-only in main.js, verified
  stripped from the prod bundle. Probe scripts take OOVI_PORT (5173 is
  taken by another project on this machine).

## Live-fire review fixes (sparse/left-bunched/hallucinated poster)
- Balance is measured, not assumed: inked-mass left/right ratio <0.35
  (at ≥25% coverage) warns. Theme can't ride DSL shapes, so textured
  styles now FORCE hero + one decoration to image kind with the style
  baked into describe. Facts rule: model must use request facts only,
  "TBA" placeholders instead of inventions (not programmatically
  verifiable — stated limit).
- Placeholders caught structurally: per-component box fill <15% warns
  (thin) or nothing-inside warns (empty); hero-role boxes <15% canvas
  warn regardless of kind. Header >60% of headline warns.
- Gate stays report-only (spec forbids touching intent); no auto-fix
  pass exists by decision, not omission.

## AI design quality (composition planning + gate)
- Root cause of sparse posters: the planner optimized for nothing (no
  sections, density, hierarchy, or theme channel) and nothing evaluated
  the result. Fixed the process: section checklist (adapted, never
  padded), hero minimums, coverage/headline/contrast rules, theme string
  propagated to every component + image describe, roles with floors
  (headline size, details size), sibling boxes for alignment context.
- Quality gate REPORTS only (`src/ai/quality.js`, pure + node-tested):
  no auto-mutation, per spec — intentional overlap/bleed/asymmetry
  preserved (only text-on-text, out-of-canvas text, tiny type and
  failing contrast are errors). Score = 100 - 12*errors - 4*warns.
- Group-child coords assume group-relative storage (true after renderer
  round-trips; AI-fresh groups conventionally use 0,0 origins).
- Probes needed re-routing after hash navigation landed (scripts open
  `#/design/new`; dashboard probes use `#/`).

## Trash instead of hard delete
- Dashboard delete is soft (`deleted_at`); Trash section restores,
  destroys forever, or empties. Duplicate ignores trashed rows.
- Skew learned the hard way: my first probe wiped 2 live user rows with
  hard DELETEs. Probes now scope every destructive step to titled rows
  they created. No autosave window: persists debounce at 2.5s (Canva-like
  cadence); navigating away sooner can lose the tail — accepted, no
  beacon hack (sendBeacon is POST-only, doesn't fit PUT).

## UI polish pass (no new features)
- Workspace-dark vs no-dark-mode rule: dark *mode* (full theme) stays
  out; the dark dotted canvas surround is one documented surface token
  (`--oovi-workspace`), which obeys rule 4's actual intent (single token
  source, no hex). Proceeded without asking on that reading.
- Clear uses native `confirm()` (matches the Regenerate precedent); both
  yield to the Goal 5 custom dialog.
- Rail labels: Insert / AI / Layers / Pipeline — single-word consistency,
  full "Pipeline", 68px buttons, accent bar + soft bg selected state.
- Insert shortcuts T/R/O/L/P (+ Photo button fills the orphan 6th cell):
  guarded against typing fields, modifiers, and preview mode. Fabric's
  hidden textarea counts as a field, so mid-edit typing is safe.
- Selection paint mirrors `--oovi-brand` as JS hex: the Fabric API cannot
  read CSS vars, and per-object options beat prototype mutation.
- One accent family: Bootstrap `.btn-primary` re-themed to brand indigo
  via `--bs-btn-*` vars (Export/Generate/Apply/Send agree with the logo's
  indigo stop). Default element color already was brand.
- Partial-failure honesty kept: zero-applied architect runs error instead
  of succeeding (prior fix).

## Unsplash photo search (Insert panel)
- Access key client-side (public-by-design, rate-limited); secret never
  stored (OAuth unused — app id likewise unused). Verified live: 12
  results, JPEG dataURL insert, "Photo by X on Unsplash" credit in chat.
- Terms: download tracking fires best-effort on insert, utm rides on
  URLs, credit is always surfaced. Fetch-to-dataURL first (no taint);
  hotlink fallback warns like architect assets.

## Pollinations key → backend (per direction)
- `api/asset.js` (Vercel function) holds `POLLINATIONS_KEY` server-side
  and returns image bytes as dataURL. Browser flow: backend → keyless
  direct fetch → hotlink, each degrading visibly. The `VITE_` key line
  was scrubbed from `.env`; set the non-VITE var in the Vercel
  dashboard (dev falls back to keyless until deployed).
- `nologo` only activates server-side with a key (it errors keyless).

## Architect box bug (live-fire find)
- The sanitizer kept boxes for image components only, but the component
  prompt reads `box.x` for every kind — all 5 real DSL components died
  with `undefined.x` while reporting success. Fixed: boxes mandatory for
  all components (prompt says MUST; sanitizer backstops DSL with a full-
  canvas box + warning), plus honest end counts (`Built x/y, z pieces`;
  total failure is now an error, not a success).

## Architected generation (plan + chunked components)
- Generate (no-reference path) is now: 1 plan call (palette + routed
  components with fixed boxes) then per-component builds streaming onto
  the canvas — DSL text/shapes through the existing validated pipeline,
  icons/logos/photos through Pollinations (turbo, direct browser calls
  like ../genai, optional VITE_POLLINATIONS_KEY as ?key=).
- Images fetch to dataURL (never taints, export-safe); hotlink fallback
  only on CORS failure with an explicit export warning. Seed random per
  asset. Boxes clamped 32..1024px, max 10 components.
- Plan failure falls back to one-shot direct generation (old path kept).
  Reference path untouched. Each component = one undo entry.
- Mock covers plan/components/assets offline (?mock=1 / VITE_MOCK_AI).
- fabric traps hit during this work (all verified against the installed
  6.9 package, never memory): no bringForward family, no obj.remove(),
  insertAt(index, obj) — index FIRST (a swapped call silently corrupts
  the object stack). Hydrate now rejects render-less resolves.

## Export formats + preview backdrop
- Export is a topbar menu (PNG/JPG/SVG/PDF), no dialog yet (Goal 6 adds
  scale/transparent-background/progress). Filenames slugified from the
  doc title. Empty canvas exports nothing (toast instead).
- jsPDF over hand-rolled PDF (user-approved dep): lazy `import()` so its
  ~390KB + html2canvas/purify side-chunks load only on PDF export.
  Initial bundle untouched. Verified in-browser: all four downloads
  fire with correct magic bytes (%PDF, PNG, JFIF, XML).
- JPG has no alpha: safe today because backgrounds are always opaque.
  Transparent PNG/export dialog stays Goal 6.
- Preview backdrop is flat page-bg (`--oovi-bg`), not the dark dotted
  workspace — verified computed `rgb(238,240,244)` with chrome hidden.

## Zoom containment (Playwright-verified)
- Root cause of container growth: Bootstrap's row `flex-wrap` let the
  flex line size to content instead of stretching columns. Fixed with
  `nowrap` + explicit stretch on desktop; the height chain is now
  flex-driven (percentages resolved to auto against flex-grown parents).
- Frame is a fixed scroll viewport (`safe center`: small artboards
  centered, oversized fully scrollable — `margin:auto` clipped scroll
  tops). `fitToContainer` measures the frame box minus real padding.
- Below 992px the canvas card pins to 70vh so zoom scrolls internally.
- Proof: `scripts/zoom-probe.mjs` (kept for the test phase) asserts
  row/frame heights stay fixed across Fit/91%/114%/100% at 1440×900.

## Goal 3 — layers first-class
- `visible`/`locked` are sparse DSL fields (present only when
  non-default), applied in `commonOptions`, exported in `objectToDsl`,
  kept by normalize. This retro-fixes the Goal 1 lock caveat: lock now
  survives round-trips, undo, and can be enforced by Goal 4 patches.
- Grouping is manual (`new Group` + remove/add; ungroup via
  `group.remove` which bakes parent transforms into children) because
  fabric 6.9 dropped `toGroup`/`toActiveSelection` (probed + source-read
  in `dist/src/shapes/Group.mjs`: constructor relativizes via layout
  manager, so visuals survive the swap).
- Reorder is top-level only (nested order lives with the group), drop
  position from cursor half, single history entry, selection restored.
- Rename auto-suffixes on collision (ids are patch/layer identity).
  Inline input commits on Enter/blur, cancels on Escape.
- Previews are live-prop swatches (fill glyph, image thumb from dataURL),
  not rasterized thumbnails — zero render cost.

## Double-click for text
- Empty-canvas double-click drops a 48px text box starting at the cursor
  and enters edit mode at once. Object double-clicks untouched (fabric
  inline edit). Default ink `#1b2030` (readable on light artboards),
  not the insert accent. Positioning uses holder-rect math, not fabric
  pointer APIs.

## Goal 2 gaps (filled, cheapest scalable option each)
- **Text stroke:** free — Fabric strokes text natively and the editor
  switch already applied stroke generically; only the panel hid it.
- **Text width:** renderer now uses `Textbox` (wrap width is real) instead
  of `FabricText` (width was cosmetic). Width row enabled for text.
  RISK: AI layouts assumed single-line overflow; long copy now wraps and
  can grow downward into neighbors. Undoable per design; watch Pipeline
  warnings after regenerating old prompts.
- **Images:** new `image` DSL type (id/x/y/width/height/src) end to end —
  schema, validator, renderer placeholder + async hydrate, layers icon,
  panel section, local-file upload (dataURL: no canvas taint, export
  safe). No URL paste (taint would break PNG export). Async arrivals are
  extra history entries, not merged. AI *may* now emit `image` (prompt
  derives types from schema); guessed URLs keep the dashed placeholder.
- **Round-trip holes closed:** `fontFamily`/`charSpacing`/`src` added to
  validator normalize + `objectToDsl` (edits previously silently dropped
  on JSON export). `stroke`/`strokeWidth`/`rx` were already covered.
- **fabric 6.9 has no bringForward/sendToFront** (verified against the
  installed package): `orderActive` reorders via remove + insertAt under
  `suppressHistory`, one entry, selection restored.

## Goal 2 — adaptive properties (in progress: editor + panel done)
- `setActiveProperty` covers x/y/width/height/radius/angle/opacity, all
  text fields (content, family, size, weight, align, line height,
  charSpacing in 1/1000 em), fill/stroke/strokeWidth, cornerRadius.
  Coerced + clamped; one history entry via `_handleMutation` (same path
  as canvas edits). Text has no width row (FabricText is content-driven).
- Align (6, canvas-relative, whole multi-selection moves as one block),
  distribute (outermost fixed, needs 3+, deltas assume an unscaled
  selection container), layer order (front/forward/backward/back) — all
  undoable single entries.
- No `image` section: the Design schema has no image element type, so
  nothing to adapt to (not faked). Text stroke omitted (Fabric supports
  it, but it muddies body copy; reconsider if asked).

## Brand tokens (pre-Goal-2)
- One rulebook: `src/ui/tokens.css` owns color/type/spacing/radius/
  elevation/motion/z. `style.css` consumes vars (old `--studio-*` kept as
  aliases); all hex/font/z literals migrated by script and verified by
  grep + build. No dark mode — dropped per explicit direction.
- Spacing/radius literals not mass-migrated (touch ~50 positional rules
  for zero visual change); tokens defined and mandatory for new code,
  migration logged for Goal 8. Same for 3 dead selectors + `z-index: 5`.
- Logo keeps its gradient (brand mark, not chrome) against the
  no-heavy-gradient rule.

## Goal 1 — editor chrome (canvas focus)
- **Save status without the Goal 7 project store:** dirty-flag + debounced
  localStorage draft (`oovi.draft.v1`, `{title, design, savedAt}`).
  Boot never auto-loads the draft (that is Goal 5/7 recovery UI). Goal 7
  upgrades the backend to IndexedDB projects; the status contract
  (`saved`/`saving`/`unsaved`) stays the same.
- **Zoom model:** `fit` (default, never upscales — old behavior) vs absolute
  scale 20–300%. `100%` = true pixels even if it overflows (scrolls).
  `+/-` steps ×1.25 from the current effective scale. Mode survives
  Generate/resize; window resize only re-fits in `fit` mode.
- **Lock is Fabric-level only for now:** `lockMovement*/lockRotation/
  lockScaling*` + `hasControls=false`, one history entry. It does NOT
  survive Design-JSON round-trips (`locked` is not a schema field) and is
  not yet enforced in AI patches (Goal 4) or shown in Layers (Goal 3).
- **Clear Canvas kept as a small header button** until Goal 5 adds the
  confirmation dialog. Regenerate stays in the AI dock (Goal 4 moves it
  into the assistant with confirmation).
- **Inner list scrolls kept** (layers list, JSON, pipeline tabs get
  max-height + own scroll). "No nested scrollbars" is enforced at layout
  level: each of the 3 columns scrolls exactly once.
- **UI label floor 12px** (`.panel-title` 11.5→12px, canvas hints/statuses
  11→12px). Smaller mono readouts (JSON 11px, debug 10.5px) stay — they
  are code, not UI labels.
- **Topbar tabs kept as view shortcuts** (Design→Insert tab, Code→Developer
  disclosure, Pipeline→Pipeline tab) instead of removed, to preserve the
  existing Code/Pipeline reachability.
- **Layered generation, not one-shot planning:** the architect pass is split
  into L1 goal (raw prompt -> explicit brief), L2 palette (guaranteed
  non-fading contrast), L3 skeleton (boxes/roles only), then L4 per-region
  text and L5 deterministic colour correction. Each layer is small and
  soft-fails on its own, so a terse prompt still lands a complete design and
  no single model answer can wreck the run.
- **Refinement is per region, not a whole replan:** the quality gate's
  complaints are mapped back to the regions that own the offending element
  ids, and only those regions are regenerated — each in its own call. A
  whole replan is kept ONLY for mass overlap (>=5 collisions) or complaints
  with no owning region, because those are skeleton-level, not region-level.
- **`/api/ai` streams NDJSON; no WebSocket:** on-device runs take minutes and
  a single silent HTTP response is exactly what idle timeouts kill. The
  response is a progress stream (`{"t":"progress"}…` then `{"t":"done"}`),
  which keeps bytes flowing at every hop and drives live UI progress. A
  WebSocket was rejected: it will not run on the Vercel serverless target and
  adds a dependency, and it solves the same idle-time problem no better.
- **Provider POST over core `http.request`, not global fetch:** undici (Node
  fetch) defaults to a 300s headers/body timeout. With `OLLAMA_NUM_PARALLEL=1`
  a queued request receives no bytes until the generation ahead finishes, so
  undici killed it at ~300s with "fetch failed". Core http has no such
  default, so only our own budget applies. Components also build serially:
  fanning out against one slot only queues (and times out) without being
  faster.
- **Skeleton is drawn as a non-design wireframe, not left blank:** on a local
  model the skeleton layer can finish minutes before the first region renders,
  so the canvas showed nothing while "progress" ticked. showSkeletonGuides()
  paints one dashed box + role label per planned region the instant L3 lands,
  and each guide is retired (clearGuideFor) as its real elements arrive. The
  guides carry NO `designId` and set `excludeFromExport`, which is what makes
  them safe: canvasToDesign() skips them (never in the design/export/patches/
  quality gate) and fabric's toObject() filters them out of EVERY history
  snapshot (dist `objects: this._objects.filter(o => !o.excludeFromExport)`),
  so undo/redo can never resurrect a phantom wireframe. They are also
  selectable:false/evented:false and hidden from the layers panel and the
  collision resolver, and applyPatchOps offsets plan-rank inserts by
  guideCount() so the guides stay pinned below all real content.
- **Components develop in chunks off the token stream:** waiting for a whole
  region (minutes on CPU) before painting made 4/5 look frozen. The server now
  forwards raw tokens as `{"t":"delta"}` (opt-in per request via `delta:true`,
  so goal/palette/skeleton calls stay lean) and `createElementScanner()`
  (src/ai/streamJson.js) extracts each element as its closing brace arrives —
  a resumable, string-aware brace matcher that ignores partial objects. The
  canvas paints them immediately via applyPatchOps(ops, {history:false,
  quiet:true}) so streaming never floods undo or steals the selection; when
  the call returns, the provisional ids are retracted and the validated set is
  applied normally (one undo step per component). Net effect: an identical
  final design, but it visibly builds itself.
- **Streaming preview is not authoritative:** only the validated set is kept,
  because the model's partial JSON is unvalidated (unclamped coordinates, off-
  palette fills, the occasional malformed object). Tracking ids optimistically
  (and treating "remove missing id" as a no-op) means a rejected partial
  cannot leak into the finished design.

## On-device tuning — measured findings and the shared prompt prefix

Measured on this box (i5-2520M, 2 physical cores, AVX only, CPU-only, Ollama
0.40.6, `-np 1`, flash-attn + q8_0 KV, `keep_alive 30m`):

- **Prefill is the bottleneck, not generation.** Reading a 651-token prompt
  took 64.7s (**10.1 tok/s**); generation runs at **2.73 tok/s**. A 3.8k-token
  plan prompt therefore costs ~6 minutes before one token is emitted. Every
  decision below follows from that ratio.
- **`e2b` thinks silently unless told not to.** A ~30-token answer cost 425
  generated tokens with thinking on; `think:false` produced 9. Verified with a
  direct `/api/chat` call that `think:false` is the right field name in 0.40.6
  (hidden reasoning was ~2 min per call).
- **Prefix caching partly works and is worth engineering for.** Changing only
  the last line left 2048 of 3106 prompt tokens cached (a multiple of 1024, the
  batch size). Uncached tokens cost ~0.12s each.
- **A differing load-time option forces a reload.** Sending `num_thread:2` to a
  resident model cost `load_duration` 19-22s — and a reload also discards the
  prefix cache.
- **Token caps do not bind**, so `num_predict` is a truncation guard only.
- **`num_thread=2` beats 3** here (prefill 10.1 vs 9.6 tok/s, generation 2.73
  vs 2.62) — the box has 2 physical cores.
- `gemma3:1b` prefills ~2x faster but produced a degenerate answer (one colour
  three times), so it is not a drop-in replacement. Unresolved: a 4m05 total
  against 2m14 prefill + 5s generation — suspected draft-model re-reading of
  the uncached prompt.

### What changed in Phase 1

- **`api/_aiChain.js`:** every call now sends `think:false`, `keep_alive:"30m"`
  and ONE byte-identical `options` object (`num_ctx:8192`, `num_thread:2`,
  `temperature:0.2`, `num_predict:1100`). `num_predict` is fixed precisely so
  no per-layer value can trigger a reload. `format` is wired from the schema
  the client already sends (the schema object, or Ollama's plain `"json"` for
  the lenient fallback), with `OLLAMA_FORMAT=0` to disable it. Every call logs
  Ollama's own `load_duration`, `prompt_eval_count`, `prompt_eval_cached_count`,
  `prompt_eval_duration`, `eval_count`, `eval_duration`, `total_duration`.
- **`src/ai/layerPrompt.js`:** new exported `DESIGN_CORE` — one static block
  (DSL contract, rules, one compact example, ~476 tokens) that L1-L4 all begin
  with verbatim. Nothing variable lives in it: canvas, palette, theme, ids and
  the brief moved to each layer's `[User]` turn, which now comes last. L3's
  ~3.8k-token prose checklist collapsed into one roles line plus an example, so
  no interpolation remains in the prefix.
- **`src/ai/architectPrompt.js`:** L4 reuses `DESIGN_CORE` and orders its user
  turn constant-within-design first (canvas, palette, theme, brief) and
  region-specific last, so a warmed prefix covers the most tokens. This also
  fixes a real defect: the component prompt had no `[User]` marker, so it was
  sent as a single system-role message (`messages=1`) with the literal text
  `[System]` inside it.
- **`src/app/App.js`:** regions generate in priority order (headline, hero,
  image, rest, decoration) while still inserting at their plan rank, so the
  first meaningful element lands in ~2 minutes instead of ~9.
- **Trade-off accepted (and later corrected):** L1-L3 initially carried ~476
  tokens of DSL context they do not strictly need, on the theory that it is
  paid once and cached thereafter. The first full run disproved the caching
  half of that (below), so L2's short prompt was restored.

### Prefix reuse needs a context checkpoint (measured correction)

The first full run showed the shared prefix is **not** free. Ollama's log:

```
forcing full prompt re-processing due to lack of cache data
(likely due to SWA or hybrid/recurrent memory)
created context checkpoint 1 of 32 (pos_min = 0, pos_max = 824, n_tokens = 825)
```

For this SWA/hybrid model llama.cpp can only reuse KV state up to a **context
checkpoint**. The prompt is processed in `n_batch` blocks (1024 here, per
`-b 1024 -ub 1024`), and a sub-1024-token prompt is a single block whose only
checkpoint sits near its end. A 479-token shared prefix is therefore smaller
than any checkpoint and can never be reused:

- identical prompt -> `prefill=829tok(cached 828)/0.4s` — a 77s saving
- shared 479-token prefix, different tail -> `prefill=795tok(cached 0)/73.4s`

So a shared prefix only pays for itself once the COMMON region is at least one
batch (>=1024 tokens) long; below that it is pure added prefill. Consequence on
L2: palette regressed 35s -> 88s, so its short prompt was restored. This also
explains the earlier "changing only the last line gave 2048 of 3106 cached":
3106 tokens spans three batches, so a checkpoint at 2048 was available.

### Speculative decoding: what the 105s wall-clock gap actually is (measured)

The full-pipeline verification run (1690s wall, 9 calls) settled this. The
draft model is baked into the model file, not a flag:

```
ollama show gemma4:e2b --modelfile
  FROM  sha256-6dd7ac24…            (main, 4.6B)
  DRAFT sha256-dd57b3b7…            (the speculative draft)
  PARAMETER draft_num_predict 3
ps -> llama-server … --spec-type draft-mtp --spec-draft-n-max 3
                      --spec-draft-backend-sampling --spec-draft-model <blob>
```

**The switch** (no server edit needed): send `"options":{"draft_num_predict":0}`
— the official Modelfile reference says "set to 0 to disable speculative
drafting", and ollama#18517's answer is exactly that one line. Server-wide
alternative: `LLAMA_ARG_SPEC_TYPE` in the service env (ollama#17016). It is a
load-time option, so it costs one reload and must then be identical on every
call. `gemma3:1b` has no `DRAFT` line, which makes it the control case.

**But the gap is not "the draft re-reads the uncached prompt".** Per-call rows:

| call | prefill | cached | prefill s | eval | eval s | total | wall |
|---|---|---|---|---|---|---|---|
| L1 goal (cold) | 829 | 0 | 83.4 | 114 | 50.6 | 134.0 | 134.0 |
| L1 goal (warm) | 829 | 828 | 0.4 | 120 | 56.8 | 57.1 | 57.1 |
| L2 palette | 795 | 0 | 73.4 | 38 | 14.8 | 88.3 | 88.3 |
| L3 skeleton | 1164 | 0 | 107.8 | 339 | 105.3 | 213.1 | **318.0** |
| L4 headline | 1002 | 139 | 113.8 | 343 | 130.7 | 244.5 | 244.5 |
| L4 header | 998 | 783 | 28.1 | 333 | 118.9 | 147.0 | 147.0 |
| L4 details | 990 | 783 | 29.6 | 577 | 181.6 | 211.3 | 211.3 |
| L4 sections | 986 | 783 | 24.1 | 846 | 252.9 | 277.0 | 277.0 |
| L4 decoration | 987 | 782 | 24.1 | 1072 | 322.1 | 346.2 | 346.2 |

Two corrections to the earlier theory:

1. **`cached = 0` does not cause the gap.** L1-cold and L2 both cached 0 and
   both have `wall == total`. Only L3 differs.
2. **The gap is a mid-generation stall, and it is invisible in every Ollama
   counter.** L3's own log shows generation running at ~3.5 tok/s, then
   `n_gen = 243` at 10:28:30 and `n_gen = 253` at 10:30:20 — ten tokens in 110
   seconds — then straight back to 3.5 tok/s. `total_duration` (213.1s) equals
   prefill + eval and simply does not include that stall, so it is not prefill
   and not eval; nothing at all is logged while it runs. The draft model's own
   `dur(b,g,a)` statistics do not account for it either.

   The one thing L3 has that no other call has: a prompt **over 1024 tokens**
   (1164), i.e. more than one ubatch at `-ub 1024` — the only multi-ubatch
   prompt of the run. So the working rule is "keep every prompt inside one
   batch", which the ≤1000-token shared prefix already does for L4.

**Prefix reuse works well between consecutive same-layer calls** (783 of 998
tokens for L4 #2-#5, ~78%, prefill 28s instead of 114s). It does not work
across different layers, which is why the shared prefix on L1-L3 buys nothing:
the common region is smaller than one checkpoint. L4-to-L4 is where it pays.

Net effect on the run: the whole 6-region design took 1690s (28 min) against a
baseline of L1 120 + L2 35 + L3 294 + 6x L4 (121-334) ≈ 25-40 min. L4 dominates
and L4 is generation-bound (846-1072 eval tokens on the content-heavy regions),
so the remaining wins are upstream: fewer/shorter prompts, and not generating
regions the design does not need.

## Phase 2 — templates replace free-form L3 (user-approved direction)

L3 asked the model for free-form boxes: a 1.16k-token prompt costing 107s of
prefill (318s wall here) whose boxes then had to be *checked*, with the plan
re-asked whenever they collided. Phase 2 trades that for a bounded vocabulary.

- **`src/layout/templates.js`** — 10 templates x 2 variants, each declaring
  named slots `{id, role, box, optional, size, maxChars, describe}`. Every slot
  is a sub-rectangle of ONE partitioned frame (`MARGIN 5.5%`, `GUTTER 2.5%`), so
  boxes cannot overlap by construction. Decoration is a strip on the canvas
  edge, outside the frame, so it can never become a text's contrast bed.
  `instantiateTemplate()` is deterministic: fractions -> 8px-grid-snapped px,
  font sizes taken from the existing type scale, `maxChars` derived from the
  real box and font size. It returns `ok:false` on any collision or
  under-coverage, which is exactly what triggers the free-form fallback.
- **L3 is two small steps** (`src/ai/templatePrompt.js`): (a) choose a template
  — the keyword/size pre-filter answers it with **zero tokens** unless the
  shortlist is genuinely ambiguous; (b) a tuning patch limited to variant,
  show/hide optional slots, +-25% type, alignment and density. `sanitizeTuning`
  drops unknown keys, clamps numbers, refuses to hide a non-optional slot, and
  never reads a box (boxes are never accepted from the model). Both prompts
  begin with the byte-identical `TEMPLATE_MENU`, so the second call reuses the
  first one's prefix.
- **L4** now receives the slot's fixed box, its type size and its copy limit.
- **The full free-form L3 is kept as the fallback** whenever no template suits
  the canvas shape, the model names an unknown template, or instantiation
  fails. Nothing in the build loop, wireframe, quality gate or collision tidy
  changed: a template plan is the same `{palette, style, components[]}` shape.
- **`src/layout/palettes.js`** — 15 curated palettes, every one >= 4.5:1 ink on
  background, matched by brief keywords (style/tone hits weigh double). A match
  removes the L2 model call entirely.
- **`src/layout/grid.js`** — 8px grid snap + type-scale snap. The template's own
  size comes FROM the scale; the model's bounded tune is a real multiplier on
  top (snapping the tuned value back onto the scale would make a +12% headline
  a no-op).

### Verification

`npm test` is new: it bundles `tests/*.test.mjs` with the esbuild Vite already
ships (the sources use extensionless ESM imports, which node cannot load
directly) and runs node's built-in test runner. 19 tests, including the one the
plan asked for — **every template x variant x platform preset x {light, dark}
palette is materialised into a real pixel design and run through the app's own
quality gate** (`src/ai/quality.js`): zero errors, no text-on-text overlap, the
coverage and headline floors met. Also asserted: decoration never overlaps a
content slot, tuning cannot break collision-freedom, the L3 menu is
byte-identical across both calls and contains nothing variable, and L1-L4 still
share the `DESIGN_CORE` prefix verbatim.

`npm run build` stays green.

## Phase 3 — retrieval-chosen layouts (30 templates, BM25 + embedding benchmark)

### What the library is now

The static template menu is gone. `TEMPLATE_RULES` (byte-identical, names no
template) is still the prompt prefix; the candidates are appended LAST as
variable data, and they are no longer "all 30" but the handful that actually
match the brief.

- **30 templates**, each with retrieval metadata (type, sizes, moods, tags,
  keywords, a one-line blurb) and, per text slot, 2-3 example strings written to
  fit that slot's own `maxChars`.
- Every template x variant x preset x palette still materialises into a real
  design and is run through the app's own quality gate: **zero errors**. That
  gate caught two real bugs in the new geometry (`timeline` and
  `class-schedule` painted only 14% of a 16:9 canvas — small body type over
  three columns reads empty; both now use display/subtitle sizes).
- **Where the example copy is used matters.** Examples are L4 one-shots (the
  region gets "here is a line that was written for this box"). They are NOT
  retrieval evidence: `templateDocument()` indexes curated metadata + slot
  descriptions only. When examples were indexed, a class-schedule example
  mentioning a yoga mat made "the mating habits of the glass frog" rank a layout
  #1 at 25 % coverage. Curated metadata keeps the abstain signal honest.

### The ranking decision (measured, not assumed)

`scripts/benchmark-retrieval.mjs` runs 21 labelled briefs (19 real briefs +
2 negative controls: a nonsense subject and a Hindi brief) over both rankers.
The runner-up/abstain policy lives in ONE function (`selectFromScored`) so the
benchmark and the pipeline cannot drift apart.

**BM25 (zero tokens, no model): top-1 60 %, top-3 95 %, abstained 100 %,
false-match 0 %.** Both negative controls abstain; no brief with a real subject
is ever matched to a layout at random.

Three findings worth keeping:

1. **Coverage, not raw BM25 score, decides.** "Wedding invitation card" put
   `ticket` first on BM25 score (its description mentions invitations with a
   stub); ranked by idf-weighted *coverage* — the share of the brief's terms a
   template actually explains — the list is `ticket` 64 %, `centered-poster`
   36 %, `card-grid` 28 %. Same top-1/top-3 totals on the labelled set, but the
   ordering now agrees with the number that decides abstention, and one real
   case is fixed.
2. **A term the corpus has never seen must not dominate.** Uncapped idf, "job
   opening notice for a graphic designer" abstained because the rare words
   (`job`, `graphic`) outweighed the matched ones. Coverage weights are capped
   at 2.5, which leaves the intended signal intact: a brief whose vocabulary is
   *entirely* outside the library still scores 0 and abstains.
3. **Light stemming is load-bearing.** A designer writes "blood donation
   drive" and "summer camp registration"; the corpus says "donate" and
   "register". Longest-suffix strip (never below 4 characters, re-run once for
   `registration -> registr -> regist`) made both match without inventing
   matches on the controls.

**The model still chooses when there is a choice.** The shortlist is the
templates that clear the coverage threshold, capped at 3 — not "the top three
regardless". Exactly one survivor is taken for free; two or three go to the
model. The first version trusted any hit above 50 % coverage, which silently
picked `ticket` over `centered-poster` for a wedding invitation. Being decisive
is only safe when there is nothing to decide between: on this set that is 15 %
of briefs, and the other 80 % pay one ~60 s call to arbitrate. Worth it — a
wrong layout is invisible until the user notices, while 60 s is on the clock.

### Cost

The prompt is smaller than the static menu it replaces (3 candidates with their
slot descriptions, not 30), which is the lever that matters on a box where a
call is prefill-dominated. Per-layer timings and the Phase 2 comparison are in
the section above; the retrieval stage itself adds no model call and no
measurable time (BM25 over 30 documents is sub-millisecond).

### The ranker: BM25, and why the embedding half was cut short

The plan was to benchmark BM25 against an Ollama embedding model on this box
and choose on evidence. Both were built (`scripts/benchmark-retrieval.mjs` runs
either; `nomic-embed-text` was pulled), and the measurement that decided it was
the corpus pass:

| | BM25 | embeddings |
|---|---|---|
| index the 30-template library | < 1 ms | **101 s for the first 6 documents** (measured, `nomic-embed-text`, `-t 2`, CPU) |
| full 30-document corpus | — | ~17 s per document → **~8.5 min**, once, then cached |
| per brief | < 1 ms | ~0.9 s (single short text, model resident) |
| accuracy on the labelled set | top-1 60 %, top-3 95 %, abstain 100 % | **not measured — stopped at 18/30 documents** |

The corpus pass was killed at 18/30 to give the machine to the end-to-end run.
That is not a hidden compromise: 8.5 minutes to index 30 short documents makes
the embedding path unusable as a startup step on this hardware, and every
"Save as template" would invalidate the cache and pay it again. A ranker that
costs 8.5 minutes to become available cannot be the ranker for a product whose
whole point is working offline on a slow box. **BM25 it is**, at zero tokens and
sub-millisecond latency, with 95 % top-3 coverage on the labelled set — and the
model arbitrates the shortlist, so a wrong top-1 is not a wrong design.

If the machine changes, the comparison is one command away.

### Correction to Phase 1: there is no 1024-token prompt ceiling

Phase 1 recorded a ~105 s wall-clock stall mid-generation after a 1024-token
prompt and treated "keep every prompt inside one batch" as a rule. Re-measured
on an identical 1144-token prompt, four ways (draft off/on × cold/warm):
`wall == total` in all four runs, worst generation gap 2.5 s, no stall. The
stall was a one-off, not a property of long prompts — so the rule is retired and
retrieval is free to build a prompt of whatever length the candidates need.

The same four runs measured speculative drafting rather than assumed it:

| draft | prefill | generation | tok/s |
|---|---|---|---|
| off, cold | 124.3 s | 337 tok / 94.4 s | **3.57** |
| off, warm | 0.3 s (cached) | 335 tok / 92.3 s | **3.63** |
| on, cold | 160.5 s | 388 tok / 136.7 s | 2.84 |
| on, warm | 0.4 s (cached) | 332 tok / 118.1 s | 2.81 |

Drafting is a 22 % net loss on this CPU plus 36 s of extra prefill, and it
changed the answer length for the same prompt. `draft_num_predict: 0` is now
pinned in the one shared options object (`api/_aiChain.js`); it is a load-time
option, accepted (the reload is visible in `load_duration`), and applied once.

### The benchmark was measuring an input shape production never sends

The retrieval benchmark fed `retrieveTemplates({summary, style})` — a brief
written by hand in the harness. The pipeline feeds the **L1 goal**: summary,
subject, purpose, audience, tone, style and `mustInclude` (3-7 content
requirements such as "Event details (Date, Time, Venue TBA)").

`mustInclude` items are copy requirements. No layout vocabulary will ever
describe them, and because coverage is a SHARE of the brief's terms, they
diluted every score. The same Diwali brief that retrieved `hero-split` at 51 %
in the benchmark abstained at 16 % in the app — **retrieval never fired in
production while the benchmark reported healthy numbers.** Found on the first
live end-to-end run, which is the only reason it was found at all.

Three fixes, all in `src/layout/retrieve.js`:

- **`retrievalText()`** replaces `briefText()` as the query: summary, subject,
  purpose and keywords — not tone/style/audience. Those are the generic design
  words ("festive", "warm", "clean modern") that nearly every template's blurb
  can claim; including them took top-1 from 60 % to 35 % because they inflate
  the denominator without discriminating between layouts. Style is L2's job.
- **Threshold 0.11, not 0.22.** Coverage is a share, so a colourful brief can
  carry three adjectives no layout contains and still be a perfect brief. What
  the threshold must reject is one accidental shared word; a brief with no
  vocabulary overlap scores exactly 0 at any threshold (both negative controls
  abstain at every value). The last 0.01 admits near matches (the tutorial
  thumbnail retrieved `sidebar-rail` at 0.113) that are still better than a
  free-form skeleton on the small model.
- **`ment`/`ments` stemming.** "announcement" and "announce" did not share a
  stem, so a goal saying "announce the celebration" missed every template whose
  keyword is "announcement".

The harness now builds the realistic goal shape (`subject`, `purpose`,
`audience`, `tone`, `mustInclude`), and `tests/templates.test.mjs` pins it: a
real L1 goal must retrieve, and adding `mustInclude` items must not change the
ranking. Negative controls get only their own words — inventing an English
`purpose` for the Hindi brief would give it English tokens and make the control
test nothing.

**Result on the labelled set (21 briefs, 2 negative controls, realistic goals):
top-1 55 %, top-3 100 %, abstained 100 %, false-match 0 %.** Every labelled
brief has the right layout inside the shortlist the model sees; both controls
abstain. The cost is that the shortlist is usually 2-3 candidates, so the model
arbitrates almost every time (~60-70 s) instead of taking a free pick — a
deliberate trade, since a wrong layout is invisible and a slow call is not.

### The defect the end-to-end run found: regions spilling out of their boxes

The first live run of the full pipeline (Diwali, 1200x630, `poster-rail`) came
back with a region rendering ~4x its reservation and three elements rendering
outside the canvas:

```
L4 headline-main: 2 elements 258.4s  spill=2 fill=0.49
L4 tagline-line:  1 element  117.8s  spill=1 fill=3.89
CHECKS overflow=3 outsideCanvas=3
```

`fill=3.89` is the tell: the tagline slot reserved 1072x144 at 20px, and the
model returned 120px type — the rendered extent is ~4x the box, which is also
what put elements off the canvas. Nothing caught it: `validateDesign` checks
each element's DECLARED box against the canvas, not the extent its type paints,
and the quality gate's per-component pass looks for under-filled sections,
never for overflow.

Fixed in `src/layout/regionFit.js`, applied to every L4 result in
`componentDesign` before the elements reach the editor:

1. type is capped at the size the template fixed (the prompt already asks for
   this — "the template fixed the box, so keep the type at this size" — this
   makes it true, with 15 % tolerance so a deliberate micro-hierarchy survives);
2. if the region still renders outside the reservation, the whole region is
   scaled about the box origin, uniformly, so an icon keeps its place beside its
   label.

It never enlarges: a region that renders *smaller* than its box is an under-fill,
which the gate already reports — blowing it up would hide that signal. Every
correction is logged (`[ai] region <id>: type capped at 23px`), so a fix is
never silent. Unit-tested against the live numbers (the 120px-in-a-20px-slot
case reproduces exactly) and against a purely geometric overflow.

Cost of the alternative: catching this with the model instead would be the
per-region repair loop, one more full L4 call (~250s) per offending region,
which this avoids entirely.

## Elements appeared, then vanished in a cycle (post-build churn)

Reported from a live run: elements land on the canvas, then disappear, repeat.
Two causes, both in the region pipeline — not the save/persist path, which was
the first suspicion (that path only writes localStorage and the library; it
never reloads the canvas).

### 1. Region refinement fired on cosmetic warnings

`flagRegions()` in `App.js` decided which regions to regenerate from a set that
included warning codes as well as errors. Regeneration is the most expensive
action in the app (~250 s per region on this box) and it begins by *removing the
region's elements* — so any region carrying `thin-section`, `alignment`,
`spacing`, `typography` or `palette` was deleted and redrawn, up to four regions
per build, while the user watched their finished design come apart.

The refinement set is now `empty-section` + `missing` (plus every error,
unchanged). Those two warnings genuinely mean "this region did not render what
was planned". The rest are taste, and two are already handled elsewhere:
`contrast` by L5's deterministic re-ink, `tiny-text`/`thin-section` by the gate's
report. Dropping `thin-section` matters most: it is a *style* observation, and it
was the trigger in the live run.

### 2. A region with one bad element threw away the whole region

If all `MAX_ATTEMPTS` failed validation, `componentDesign` threw. The caller then
retracted the streamed elements — the ones the user had already watched arrive —
leaving an empty reservation, which the gate reads as `empty-section`, which
triggered regeneration: the same elements cycling in and out.

Now the last parsed attempt is salvaged before giving up: each element is
validated on its own and the valid ones are kept (`source: "salvage"`, logged
with `kept=N/total`). Partial content beats a hole; the gate still evaluates the
region as a whole, so a genuinely broken region is still reported. Covered by a
unit test (valid pieces survive, the invalid one is dropped, junk yields nothing).

Together these remove the cycle without weakening the gate: errors still refine,
and a region that paints nothing still gets its retry.

## Template-guided generation: scope, semantic roles, composition-aware L3

The pipeline already had six stages on paper; the audit found four of them
(layout selection, per-region content, rendering, validation) genuinely built,
and two missing in substance: L1 could not say what KIND of design it was, and
a palette was still three loose hexes that L4 was free to ignore. That is why a
terse product announcement came out as a headline in a field of containers: the
layout had slots, but nothing told L4 what each slot was FOR beyond a role name,
and nothing stopped it painting whatever it liked.

### L1 scope is now explicit

`GOAL_SCHEMA` gains four required fields, snapshotted onto a small closed
vocabulary in `sanitizeGoal`:

- `designType` — the FORMAT (poster, product-launch, social-post, menu, …);
- `industry` — the field, used by L2 (layout vocabulary does not carry it);
- `keywords` — 3-8 retrieval terms;
- `composition` — hero-left / hero-right / centered / split / stacked / grid /
  banner / type-only.

Terse briefs are the point: "Ship faster with Acme" now resolves to
`product-launch / technology / hero-right` before L3 sees it. A missing field
is inferred (`inferDesignType`) so a hand-written goal or an old model answer
degrades instead of breaking.

### A palette is a role system, not three colours

`src/layout/paletteRoles.js` derives ten roles from the existing three base
colours: background, surface, textPrimary, textSecondary, accent, onAccent,
ctaSurface, ctaText, border, muted. Derived, not hand-authored: 15 palettes ×
10 roles is 150 values nobody maintains, and a derived role is guaranteed to be
readable against its own backdrop. Tests assert the floors on every library
palette (primary and secondary text ≥ 4.5:1, CTA label on CTA surface ≥ 4.5:1)
and the derivation is idempotent, so re-deriving a plan palette is free.

The role set travels with the plan (`planPaletteObject`), is named in the L4
prompt, and is what L5 and the gate read. `applyRoleFills` repaints a region's
text that invented a hue with the role its element (or slot) asks for; text
already on a role is untouched, so a two-tone headline using accent + primary
survives. `correctColors()` remains the safety net — it sees artwork and local
backdrops — but it is no longer the mechanism that makes a design on-palette.
The old three-colour discipline check in `evaluateDesign` flagged legitimate
`surface`/`ctaSurface` fills as rogue; it now accepts every role.

### L3 biases, never filters, on scope

`retrieveTemplates` adds a bounded scope bias on top of BM25 coverage:
+0.22 design type (best fit; decreasing for a secondary fit), +0.30 requested
composition, +0.12 industry, capped at 0.40 total. Crucially this multiplies
EFFECTIVE coverage while the abstain guarantee still reads base coverage and a
non-zero BM25 score, so:

- a matching design type can lift a close candidate over the 0.11 threshold;
- a brief with no shared vocabulary still abstains (`base === 0`);
- a wrong scope guess can reorder candidates but cannot invent a layout.

Composition maps to existing variants, not new templates: the tuning prompt is
told the desired arrangement and the variant list, and alignment tuning can
mirror a header/logo or move a footer. The sparse fixture retrieves hero-split
and instantiates it as a complete announcement.

Fixed while testing variants: `hero-split` had its two variant labels inverted
(`hero-left` built artwork on the right). Both variants now mean what they say;
a test asserts the artwork actually moves side.

### L4 fills assigned slots, it does not place them

`Plan.components` comes from `instantiateTemplate` and is authoritative. The
prompt now states the reserved box is authoritative (do not move or resize the
region), names the region's colour role, and includes alignment even when the
free-form path has no fixed type size. Layout slots are generated one call per
region, serially — unchanged.

`fitElementsToBox` had a gap: a region SMALLER than its box but drawn off it
kept `scale = 1` and was returned unchanged, so a model that ignored x/y could
paint outside its slot and only trip `empty-section` later. It now translates
such a region into the box. Scale still never enlarges, so an under-fill is
still reported rather than hidden.

### Quality gate: composition, not just geometry

New deterministic checks, all measured on rendered extents:

- `empty-hero` (error) — a hero region that rendered nothing is a failed focal
  point, not a cosmetic warning. Added to `REFINE_CODES`; other empty regions
  stay warnings so a sparse brief does not trigger regeneration.
- `support` (warn) — a headline with no tagline/facts/sections/CTA behind it:
  the "headline in a field of containers" shape.
- `role-content` (warn) — a `sections` region holding fewer than two lines.
- `copy-length` (warn) — copy past 1.4× the slot's limit.
- palette discipline now accepts the full role set (and is therefore stricter
  about genuinely rogue hues than the old neutral loophole).

Warnings still do not trigger refinement; only errors plus
`empty-section`/`missing`/`empty-hero` do.

### Verification

42 tests pass (`npm test`) and the build is clean. New coverage:

- `tests/pipeline.test.mjs` drives scope → palette roles → retrieval →
  instantiation → worst-case content (`materializePlan`) → the real gate for the
  sparse product announcement, and asserts no empty regions, supporting copy,
  role-only fills, and that L5 has nothing to re-ink.
- `tests/palettes.test.mjs` asserts every palette's role system and the
  industry/keyword lookup.
- `tests/templates.test.mjs` asserts scope biases reorder without filtering,
  abstention survives a wrong scope, and an off-slot region is translated in.
- `scripts/quality-check.mjs` grows the same sparse product-announcement
  regression, no model calls.

### Facts survive the cascade

L1 deliberately turns concrete facts into content labels ("date and time",
"venue address"). That is useful for planning, but L4 never saw the original
request, so q8 filled slots with the labels, repeated the venue, or copied a
template example. The raw request now travels to `componentDesign` as
`opts.rawPrompt` and is included in the region prompt as the source of truth
for dates, times, venues, prices and links. The goal remains the design intent;
the request is the factual record.

Template examples were removed from the L4 prompt. They were useful for the
offline benchmark, but on this model they are copied verbatim: a pottery brief
returned "HACKTOBERFEST 2026" and "Kestrel Studio · Free". The slot
description, copy limit and budget are enough register anchoring.

Explicit layout cues are honoured before retrieval: "facts rail"/"poster rail"
selects `poster-rail`, "sidebar rail" selects `sidebar-rail`, "hero split"
selects `hero-split`, and "team roster" selects `team-roster` when the canvas
shape fits. Roster templates are otherwise rejected unless the brief has an
explicit people/team signal, because their portrait/name slots turn a workshop
brief into three empty "Workshop title" cards.

A template build that fails only the global headline check now refines the
headline region in place instead of replanning the whole canvas through the
free-form skeleton. That replan cost ~3.5 minutes per attempt and then rebuilt
every region with the slow fallback copy model.
