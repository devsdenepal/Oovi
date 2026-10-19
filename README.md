# Oovi: AI Design Studio

Oovi turns natural-language prompts into **fully editable graphic designs**. Not flattened images. Every headline, shape, and illustration the AI produces remains a live object on a Fabric.js canvas: selectable, movable, resizable, and re-editable.

![Oovi editor generating a design](docs/screenshot.png)

**From prompt to composition plan to validated Design DSL to an editable Fabric.js canvas.**

## Features

- **AI generation that stays editable**: an architect planner produces a deliberate layout (palette, sections, boxes), then each component is generated as structured Design DSL or AI imagery. Nothing is ever baked into a single bitmap.
- **Home dashboard**: prompt-first hero, size presets, recent designs with thumbnails, rename, duplicate, trash with restore, and one-click open in a new tab.
- **Full editor**: select, drag, resize, rotate, inline text editing, multi-select, layers panel, context toolbar, and AI-assisted edits.
- **Reliable undo/redo**: post-state history where the current canvas is always on top; empty floors are no-ops and new edits clear the redo stack.
- **Imagery, server-side**: AI illustrations via Pollinations and photo search via Unsplash, both proxied through the backend so API keys never reach the browser.
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
  > L3 skeleton      (header/hero/sections/footer boxes)  src/ai/architectPrompt.js
  > L4 add text      (per-region DSL  ·  Pollinations images)
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
  call; a whole replan is reserved for skeleton-level mass overlap.
- **The skeleton is visible while it fills in.** As soon as L3 lands, the
  planned regions are drawn on the canvas as a dashed wireframe (role label +
  box), and each box is retired the moment its real elements arrive. The
  guides carry no `designId` and are `excludeFromExport`, so they never enter
  the design, exports, patches, history or the quality gate — they exist only
  so the canvas is not blank for the minutes L4 takes.
- **Regions develop element by element.** A component's reply is streamed as
  token deltas, and each element is parsed out and painted the moment its
  closing brace arrives — so a region fills in progressively instead of
  popping in whole after minutes. When the call finishes, the provisional
  pieces are retracted and the validated set is applied as ONE undo step, so
  the final design is identical to the non-streamed result.

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

> The route is the only way out of the app: there is no client-side provider
> switch, so no call can bypass the on-device open-weight model. Changing the
> model means editing `api/_aiChain.js` (or `OLLAMA_MODEL`).

## Project structure

```text
src/
  ai/            layered pipeline (goal/palette/skeleton/text/color), client, prompts, mocks, quality gate
  app/           App.js: orchestration (generation, persistence, history, panels)
  components/    Dashboard, TopBar, InsertPanel, AssistantPanel, DebugTabs, …
  design/        DSL schema, validator, canvas presets, design types
  editor/        Fabric canvas wrapper, HistoryManager, layers, toolbar
  layout/        Layout engine, semantic validation, type scale
  reference/     Reference-image analysis (color, OCR, shapes, layout)
  renderer/      Design DSL ↔ Fabric.js (only place that touches Fabric)
  storage/       REST client for /api/designs
  ui/            Hash router, design shell, toasts, brand tokens
server/          Local API (stdlib node:http): designs CRUD, trash, asset/photo proxy
api/             Shared serverless handlers (Vercel + local server)
scripts/         Probe scripts per flow (db, api, history, quality, trash, …)
```

Supporting docs: `AGENT.md` (agent working agreement), `DESIGN.md` (visual identity + token rules), `DECISIONS.md` (decision log).

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

Vanilla JavaScript, [Fabric.js](https://fabricjs.com/) canvas, Vite build, Node.js stdlib HTTP API, PostgreSQL (`pg`), Pollinations + Unsplash for imagery, `@imgly/background-removal` and jsPDF loaded lazily. No frontend framework, no hidden dependencies.
