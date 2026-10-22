# Oovi: AI Design Studio

Oovi turns natural-language prompts into **fully editable graphic designs**. Not flattened images. Every headline, shape, and illustration the AI produces remains a live object on a Fabric.js canvas: selectable, movable, resizable, and re-editable.

![Oovi editor generating a design](docs/screenshot.png)

**From prompt to composition plan to validated Design DSL to an editable Fabric.js canvas.**

## Features

- **AI generation that stays editable**: an architect planner produces a deliberate layout (palette, sections, boxes), then each component is generated as structured Design DSL or AI imagery. Nothing is ever baked into a single bitmap.
- **Home dashboard**: prompt-first hero, size presets, recent designs with thumbnails, rename, duplicate, trash with restore, and one-click open in a new tab.
- **Full editor**: select, drag, resize, rotate, inline text editing, multi-select, layers panel, context toolbar, and AI-assisted edits.
- **Reliable undo/redo**: post-state history where the current canvas is always on top; empty floors are no-ops and new edits clear the redo stack.
- **Imagery, query-driven**: AI-filled designs search Unsplash by a query grounded in the brief, and manual template previews use Unsplash placeholders — the generated image always follows the prompt, never a random asset.
- **A reusable decoration vocabulary**: Gemma picks from circles, arcs, stars, dots, grids, squiggles, underlines, corner brackets, ribbons, pills, dividers, small icons and background patterns. The renderer expands that choice into ordinary editable primitives, so decoration never becomes a flat image or free-form shape soup.
- **Background removal**: one-click subject isolation for local images.
- **Export**: PNG, JPG, SVG, and PDF.
- **Autosave + Postgres persistence**: designs save to a local Postgres database with debounced autosave and soft-delete trash.
- **Layout quality gate**: every generation is scored on coverage, balance, contrast, hierarchy, and hero presence, with findings reported in the assistant panel.
- **Offline mock mode**: `?mock=1` (or `VITE_MOCK_AI=1`) runs the full pipeline with zero network calls.

## Quickstart

**Prerequisites:** Node.js 18+, and PostgreSQL for design persistence.

```bash
npm install

# Terminal 1: API + persistence layer (http://localhost:3001)
npm run dev:api

# Terminal 2: editor UI (http://localhost:5173)
npm run dev
```

Create the database once (defaults in `.env`, see [Configuration](#configuration)):

```bash
createdb oovi
node scripts/db-probe.mjs   # verifies schema + connectivity
```

Then open `http://localhost:5173`, describe a design on the home page, and it opens in the editor.

## How it works

```text
User prompt (as terse as you like)
  > L1 refine goal   (raw request -> explicit brief)      src/ai/layerPrompt.js
  > L2 palette       (one non-fading palette)             src/ai/aiClient.js
  > L3 template      (choose + tune a library template)   src/ai/aiClient.js
  > L3c copy deck    (one coherent deck for all regions) src/ai/copyPrompt.js
  > L4 add content   (per-region DSL · Unsplash search)   src/ai/architectPrompt.js
  > L5 color correct (palette + contrast repair)          src/ai/colorCorrect.js
  > validateDesign() (structural)                         src/design/designValidator.js
  > evaluateDesign() (quality report, non-mutating)       src/ai/quality.js
  > Fabric.js render (editable objects, history-tracked)  src/renderer/fabricRenderer.js
```

The cascade is what lets you type "birthday certificate" and still get a full,
on-palette layout: each layer refines the last, so no single call has to be
detailed. Cheap layers (L1, L2) and the deterministic L5 are skipped or
soft-failed independently, so a weak answer in one never breaks the rest.

A few properties make it survivable on a slow local model:

- **The response streams.** `POST /api/ai` answers with NDJSON
  (`{"t":"progress",…}` … `{"t":"done",…}`), not one buffered body, so bytes
  keep flowing for the whole multi-minute run — no hop can time it out — and
  the button shows a live token counter.
- **Refinement is per region.** When the quality gate complains, only the
  regions that own the offending elements are regenerated, each in its own
  call; a template-level problem re-tunes the SAME template instead of
  swapping in a different one.
- **The chosen template is visible while it fills in.** As soon as L3 lands,
  the template is rendered on the canvas with its sample copy and image
  placeholders, and each region is replaced by prompt-specific content the
  moment it is validated. A region that fails keeps the template sample, so
  the layout never develops holes. Sample ids are prefixed so they cannot
  collide with a model element that happens to use the same id.
- **Regions land as validated units.** A component's reply is parsed,
  color-repaired, validated, and swapped in as one undo step. With a template
  preview the sample stays visible until that swap, so the canvas never shows
  duplicate partial text; a failed region simply keeps its sample.
- **Copy is written once, before the regions are laid out.** L3c receives the
  refined brief and the tuned template's text regions and returns one copy
  deck. L4 then receives the approved lines verbatim and concentrates on
  geometry, colour and fit. If a line is rejected (instruction leakage,
  meta-copy such as "A festive greeting card…", a keyword-join tagline, an
  ungrounded "Available now", or the wrong attribution), one focused repair
  call rewrites only the failing regions. A final deterministic guard uses
  the approved line, then a greeting/occasion-aware line, so a bad region
  still cannot leak instruction text into the design. Template type is
  planned no smaller than 12px, the quality gate's readability floor, so
  utility labels stay legible at export.

- **Decoration is a closed vocabulary, not a shape prompt.** Decoration
  regions return one or two compact specs (`kind`, `variant`, `density`,
  `color`) instead of free-form coordinates. `src/layout/decorations.js`
  expands them into bounded rectangles, circles and line segments, all tagged
  `role: "decoration"` and painted from palette roles. The same builders drive
  the immediate template preview, manual template samples and saved-template
  materialization, so those paths cannot drift from live generation. L4 gets a
  short theme-grounded recommendation (for example, stars plus a small flower
  icon for a festival brief) while the full vocabulary remains available.

The **Design DSL** is the contract between AI and canvas: a plain-JSON document of canvas + elements:

```json
{
  "canvas": { "width": 1080, "height": 1080, "background": "#14101F" },
  "elements": [
    { "id": "headline", "type": "text", "role": "headline",
      "content": "Ship Something Spooky", "x": 64, "y": 100,
      "width": 560, "fontSize": 84, "fontWeight": 800, "fill": "#FFFFFF" },
    { "id": "hero", "type": "image", "role": "hero",
      "x": 700, "y": 80, "width": 440, "height": 440, "src": "…" }
  ]
}
```

Element types: `text`, `rectangle`, `circle`, `line`, `image`, `group`. Every rendered Fabric object keeps its DSL `id` as `obj.designId`, so AI edits, history snapshots, and export all round-trip through the same document.

Routes are hash-based: `#/` dashboard, `#/design/new` blank canvas, `#/design/<id>` saved design.

## Configuration

Copy `.env.example` to `.env`. Keys are **server-only** unless prefixed `VITE_`:

| Variable | Where | Purpose |
|---|---|---|
| `OLLAMA_URL` / `OLLAMA_MODEL` | Server only | On-device provider (Ollama serving the local Gemma model) |
| `OLLAMA_MODEL_TUNE` / `OLLAMA_MODEL_COPY_DECK` / `OLLAMA_MODEL_COPY` / `OLLAMA_MODEL_FALLBACK` | Server only | Optional per-layer model overrides; blank falls back to `OLLAMA_MODEL` |
| `POLLINATIONS_KEY` | Server only | AI image generation (`api/asset.js`) |
| `UNSPLASH_ACCESS_KEY` | Server only | Photo search (`api/photos.js`) |
| `PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE` | Server only | Postgres connection (`server/index.js`) |
| `VITE_MOCK_AI=1` | Browser | Offline mode, no network calls |

> Never put a secret in a `VITE_`-prefixed variable. Those are bundled into the client. The browser holds no image, AI, or database credentials.

### AI provider — on-device open weights

Every generation runs on an **open-weight model only**, served on-device by
[Ollama](https://ollama.com). A single POST to the same-origin `/api/ai`
route resolves the provider in [`api/_aiChain.js`](api/_aiChain.js); prompts
use strict JSON schemas and no key ever reaches the browser.

| Model | Host | Notes |
|---|---|---|
| `gemma4:e2b` | **Ollama (on-device)** | open weights, 131k context; no key, no outbound AI calls |

The provider is set by `AI_CHAIN` in `.env` (default `ollama`). A failure —
`5xx`, network, timeout, or empty reply — surfaces as an error; only cheap
transient faults (network blips, fast `5xx`) get one bounded same-provider
retry. `VITE_MOCK_AI=1` skips the network entirely.

Install ([Ollama](https://ollama.com)) and pull the model:

```bash
ollama pull gemma4:e2b
```

On CPU-only machines, the narrow layers can run a smaller quantized model
(for example `OLLAMA_MODEL=oovi-gemma3-270m:q8`) while
`OLLAMA_MODEL_FALLBACK=gemma4:e2b` handles L1/L2. The copy deck defaults to
`OLLAMA_MODEL`; set `OLLAMA_MODEL_COPY_DECK` only when testing a stronger
local model for that one call.

> The route is the only way out of the app: there is no client-side provider
> switch, so no call can bypass the on-device open-weight model. Changing the
> model means editing `api/_aiChain.js` (or `OLLAMA_MODEL`).

## Project structure

```text
src/
  ai/            layered pipeline (goal/palette/template/content/color), client, prompts, mocks, quality gate
  app/           App.js: orchestration (generation, persistence, history, panels)
  components/    Dashboard, TopBar, InsertPanel, AssistantPanel, DebugTabs, …
  design/        DSL schema, validator, canvas presets, design types
  editor/        Fabric canvas wrapper, HistoryManager, layers, toolbar
  layout/        Layout engine, semantic validation, type scale, decoration vocabulary
  reference/     Reference-image analysis (color, OCR, shapes, layout)
  renderer/      Design DSL ↔ Fabric.js (only place that touches Fabric)
  storage/       REST client for /api/designs
  ui/            Hash router, design shell, toasts, brand tokens
server/          Local API (stdlib node:http): designs CRUD, trash, asset/photo proxy
api/             Shared serverless handlers (Vercel + local server)
scripts/         Probe scripts per flow (db, api, history, quality, trash, …)
```

Supporting docs: `DESIGN.md` (visual identity + token rules).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server (`:5173`, proxies `/api` → `:3001`) |
| `npm run dev:api` | Local API + Postgres backend (`:3001`) |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |
| `node scripts/quality-check.mjs` | Quality-gate fixture suite |
| `node scripts/db-probe.mjs` | Database connectivity check |

## Tech stack

Vanilla JavaScript, [Fabric.js](https://fabricjs.com/) canvas, Vite build, Node.js stdlib HTTP API, PostgreSQL (`pg`), Unsplash for imagery, `@imgly/background-removal` and jsPDF loaded lazily. No frontend framework, no hidden dependencies.
