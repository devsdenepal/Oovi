# DECISIONS.md — ambiguous calls during the Oovi evolution

Conservative option wins every tie. Newest entries first.

## Open-weight-only + on-device rung (user order: "only opensource models", "use ollama")
- Model choice is now a hard rule, not a preference: every rung runs an
  open-weight model — Groq gpt-oss-120b (Apache-2.0), Gemini gemma-4-31b-it,
  OpenRouter nemotron-3-super-120b-a12b:free, and on-device gpt-oss:20b.
  No closed/proprietary model is called anywhere in the pipeline.
- The unverifiable third-party gateway rung and its whole client path are
  DELETED, not just demoted: the direct fetch to that endpoint, its URL
  constants, the Vite and Vercel proxy rewrites, and the env vars that fed
  it are all gone. The server-side chain is now the only way out of the
  app, which makes "open-weight only" checkable rather than aspirational.
- Fixing that also removed a latent bug: the old client flag defaulted to
  that gateway, so an unset/other value put the unverifiable model FIRST
  and the chain second.
- Local rung = Ollama (user order, superseding the llama.cpp/8080 plan —
  no local code had been written yet, so nothing to unwind), OpenAI-compat
  /v1/chat/completions, OLLAMA_URL default http://127.0.0.1:11434.
- Position: LAST, as an offline fallback. Tie-break by this file's own rule
  ("conservative option wins every tie"): a 16GB-RAM CPU model generating a
  ~1200-token component can exceed the 165s chain deadline and the 180s
  client timeout, so local-first could hang generation on the machine it
  was added for. Last means it can never stall a run, and it is one env
  line to promote (`AI_CHAIN=ollama,...`).
- Cost of last: when cloud rungs work, the on-device model is never
  exercised. Accepted deliberately — capability + offline path over demo
  theatre.
- Reachability: 1.5s /api/tags health probe, so a down daemon is an instant
  fall-through instead of a dead 120s wait; connection errors are retryable
  and log as "[ai] chain ok/failed". No response_format passed (Ollama's
  structured-output support varies by version) — prompt discipline + the
  existing lenient repair handle it.
- Context: our plan prompt is ~3.8k tokens; Ollama defaults to n_ctx=2048,
  so the model would be silently truncated. Documented
  OLLAMA_CONTEXT_LENGTH=8192 rather than passing num_ctx (not part of the
  OpenAI-compat surface). Not machine-verifiable here: Ollama is not
  installed on this box (~/.ollama exists but holds no models, no binary,
  nothing on 11434) — the rung is proven to degrade gracefully, not to
  generate.
- Model pick: gpt-oss:20b (~12GB Q4) is the largest open-weight model that
  fits 16GB RAM with headroom, and it keeps the local family the same as
  rung 1 (gpt-oss), so prompt/JSON behaviour carries over.

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

## Server-side AI chain (user order): groq → gemini → openrouter-free
- Every /api/groq request walks providers in order (AI_CHAIN), first
  success wins; any failure (429/5xx/network/timeout/empty) advances.
  The 8000-TPM 429 storm that dropped headline/tagline/header is now
  absorbed by rung 2/3 instead of skipping components.
- Free-only: Groq gpt-oss-120b, Gemini gemma-4-31b-it, OpenRouter
  nvidia/nemotron-3-super-120b-a12b:free (the :free gpt-oss slug is dead;
  enumerated live free list + structured-output flags to pick it).
  gemma-4-26b-a4b-it answers under load but ignores JSON discipline
  (prose, not parseable) — rejected: a 200-with-garbage is worse than a
  retryable 503, because garbage parses nowhere and the chain can't
  recover. 31b's demand 503s are retryable → chain advances (~30s cost,
  bounded by the slow-verdict rule below).
- Retry policy: same-provider retry ONLY for cheap transient faults
  (network blips, fast 5xx < ~25s). 429s and slow verdicts advance
  immediately — a 500ms sleep won't clear a quota or demand spike.
- Gemini gets OpenAI-messages → systemInstruction/contents conversion +
  JSON mime (its responseSchema subset can't express our null-unions, so
  strict schemas stay Groq/OpenRouter-only; our lenient parser covers
  Gemini output). OpenRouter reuses the OpenAI shape incl. strict with a
  400→json_object downgrade, mirroring the client.
- Browser contract unchanged: one POST /api/groq, response gains
  `provider`/`attempts`; client logs which rung answered
  (`[ai] chain ok via openrouter …`). Keys server-only, never VITE_.
- SECURITY: Gemini + OpenRouter keys were pasted in chat (exposed) —
  rotate both when convenient. They live only in gitignored .env.
  Same standing reminder for the Groq key pasted earlier.

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

## Local llama server eliminated (user order)
- Killed all llama-server processes; deleted fetchLocalChat, the local
  rungs, think/timeoutMs plumbing, and local docs (.env.example,
  README). Provider order is now groq ↔ the hosted gateway only. Rung errors
  fixed too: non-retryable stops the chain but the PRIMARY error
  surfaces (previously a fallback's error masked it).
- Disk files under E:\oovi-local (bin + 2.4GB gguf) deliberately left
  in place — say the word and they're gone, no re-download otherwise.

## Groq strict schemas + crowded-plan replan (first live Groq poster)
- Groq strict rejects schemas whose properties aren't ALL required:
  every field is now required, optionals as null-unions, and the
  validator strips nulls before checking (false/0 preserved). Kills the
  400-then-downgrade round-trip on every component call.
- Reasoning effort wired end to end (plan medium, components low —
  verified accepted first): the main TPM lever on the 8K-tier key,
  alongside component maxTokens 2000→1200.
- Tidy displacement capped at 120px/object (overlap shoves only;
  edge slide-backs stay unbounded). Beyond the cap the pair is named
  unresolvable, not rearranged into new overlaps (+290px cascades seen).
- Mass overlap (≥5 error overlaps) replans once like underbuilt plans
  ("stagger boxes, bars behind their text"); sanitize warns when
  planned boxes already overlap (decoration exempt — bleed is legal).

## Groq GPT-OSS provider (server-side key, strict schemas)
- Model: openai/gpt-oss-120b first (500 tok/s, reasoning-grade plans),
  20b as the cheap alt. Both guarantee strict json_schema per Groq docs;
  plan uses a closed schema, components use anyOf-of-6 with automatic
  downgrade to json_object on 400 (nested groups can't recurse in strict
  mode). Repair loop stays as backstop either way.
- Key NEVER reaches the browser: new api/groq.js proxy (same shape as
  asset/photos, Vercel-compatible), GROQ_API_KEY in gitignored .env
  only, placeholder in .env.example. No temperature param (docs
  examples omit it; reasoning models are picky). max_completion_tokens
  caps spend (plan 4000, components 2000).
- Provider rungs: VITE_AI_PROVIDER=groq → groq, hosted gateway, local;
  local → local, hosted gateway; default unchanged (gateway, local) — no
  silent reroute. Fallback only on retryable; first error surfaces.
- Community backs the shape: constrained decoding kills malformed
  output at the token layer, but always validate client-side anyway
  (thinking models have shipped unconstrained replies with HTTP 200).

## Local fallback: llama.cpp + Qwen3-4B, hosted gateway stays primary
- User chose llama.cpp over Ollama for the box (7.9GB RAM, CPU-only,
  4 cores): no resident daemon, ~2.6GB mmap'd weight only, portable
  exe + gguf under E:\oovi-local (never in the repo). Community
  consensus backs it: Ollama IS llama.cpp underneath; same file + same
  settings run within noise, raw llama.cpp wins on control (context,
  slots, KV quant), Ollama on convenience.
- Model: Qwen3-4B Q4_K_M — the file the community benchmarks (single
  user competitive, Apache 2.0, strong instruction/JSON following).
  Server: `-c 4096 -np 3 -t 4` (small ctx for our short prompts, 3
  slots matching the fan-out, CPU threads = cores).
- Contract: responses go through the existing regexRepair + validate +
  correction loop unchanged (response_format json_object, not strict
  schema — escalate only if malformed rate demands it). Thinking:
  plan thinks, components get /no_think.
- Routing: VITE_AI_PROVIDER=local flips order; default keeps the hosted
  gateway first and falls back to local ONLY on retryable errors
  (network/timeout/5xx + provider-admitted success:false — 4xx config
  errors surface, never masked). No local server running = fast
  connection-refused, no hangs. Ops: never pipe a server through
  `Select-Object -First` (pipeline close kills it — learned the hard way).
- Measured CPU reality (4-core, Qwen3-4B Q4_K_M): prefill ~4 tok/s,
  gen ~3 tok/s. A 1K-token component prompt needs ~4 min before its
  first token — so local caps are per call type (plan 20 min thinking,
  components 10 min /no_think), not the 180s gateway cap. Full local
  poster ≈ 30–45 min: 5–10× slower than a healthy gateway, available
  when the gateway is down. Server slots sized to fit: -c 8192 -np 2
  (4096/slot covers plan prompt + thinking + output; 1536/slot
  truncated plans).

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
