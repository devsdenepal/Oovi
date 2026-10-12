# DECISIONS.md — ambiguous calls during the Oovi evolution

Conservative option wins every tie. Newest entries first.

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
