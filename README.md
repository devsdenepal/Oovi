# Oovi: AI Design Studio

Oovi turns natural-language prompts into **fully editable graphic designs** | not flat images. Every headline, shape, and illustration stays a live Fabric.js object: selectable, movable, resizable, and re-editable.

![Oovi editor generating a design](docs/screenshot.png)

**Prompt → plan → validated Design DSL → editable canvas.**

## Quickstart

**Prerequisites:** Node.js 18+ and PostgreSQL.

```bash
cp .env.example .env   # set your local values
npm install
createdb oovi
node scripts/db-probe.mjs

# Terminal 1 | API + persistence (:3001)
npm run dev:api

# Terminal 2 | editor UI (:5173)
npm run dev
```

Open `http://localhost:5173`, describe a design, and it opens in the editor.

## Features

- **AI generation that stays editable.** A planner chooses a layout and palette; each region is filled with structured Design DSL. Nothing is baked into a bitmap.
- **Template-first pipeline.** A reusable layout library gives every design a collision-free structure, then the model tunes and fills it.
- **Home dashboard.** Prompt-first hero, size presets, recent designs, rename, duplicate, trash/restore, and open-in-new-tab.
- **Full editor.** Select, drag, resize, rotate, inline text editing, multi-select, layers, context toolbar, and AI-assisted edits.
- **Reliable history.** Post-state undo/redo; empty floors are no-ops and new edits clear redo.
- **Query-driven imagery.** Unsplash searches are grounded in the brief, so images follow the prompt instead of a random asset.
- **Closed decoration vocabulary.** The model picks circles, arcs, stars, dots, grids, squiggles, brackets, ribbons, pills, dividers, icons, or patterns; the renderer expands them into editable primitives.
- **Copy that cannot ship broken.** A single copy deck writes all regions first. Strict repetition and deterministic guards catch duplicates, instruction leakage, meta-copy, and ungrounded claims.
- **Quality + repair.** Generations are scored for coverage, balance, contrast, hierarchy, and hero presence; only failing regions are regenerated.
- **Export, persistence, offline mode.** PNG/JPG/SVG/PDF, Postgres autosave with soft-delete trash, and `?mock=1` for a network-free run.

## How it works

```text
Prompt
  > L1 goal        refine the brief                  src/ai/layerPrompt.js
  > L2 palette     choose a readable palette          src/ai/aiClient.js
  > L3 template    choose + tune a layout             src/ai/aiClient.js
  > L3c copy deck  write every region once            src/ai/copyPrompt.js
  > L4 regions     DSL + Unsplash per region          src/ai/architectPrompt.js
  > L5 color       palette + contrast repair          src/ai/colorCorrect.js
  > validate       structural checks                  src/design/designValidator.js
  > quality        non-mutating score                 src/ai/quality.js
  > render         editable Fabric objects            src/renderer/fabricRenderer.js
```

- **Streaming, not waiting.** `POST /api/ai` returns NDJSON progress events, so long local-model runs keep moving and the UI shows a live token count.
- **Per-region refinement.** Quality findings map back to the regions that own the offending elements. A region is regenerated atomically; a template-level problem re-tunes the same template instead of switching layouts.
- **Visible template while it fills.** The chosen layout appears immediately with sample copy and image placeholders. Each validated region replaces its sample in one undo step.
- **Copy is validated, never guessed.** Rejected deck lines get one focused repair pass. The final guard restores approved lines or drops unusable text; it does not inject generic fallback copy.

### Design DSL

The DSL is the contract between AI and canvas: plain JSON with a canvas and a flat element list.

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

Element types: `text`, `rectangle`, `circle`, `line`, `image`, `group`. Every Fabric object keeps its DSL `id` as `obj.designId`, so editing, history, and export round-trip through the same document.

Routes are hash-based: `#/` dashboard, `#/design/new` blank canvas, `#/design/<id>` saved design.

## Configuration

Copy `.env.example` to `.env`. Keys are server-only unless prefixed with `VITE_`.

| Variable | Scope | Purpose |
|---|---|---|
| `OLLAMA_URL` / `OLLAMA_MODEL` | Server | Local Ollama endpoint and default model |
| `OLLAMA_MODEL_TUNE` / `OLLAMA_MODEL_COPY_DECK` / `OLLAMA_MODEL_COPY` / `OLLAMA_MODEL_FALLBACK` | Server | Optional per-layer model overrides; blank falls back to `OLLAMA_MODEL` |
| `AI_CHAIN` | Server | Provider chain; `ollama` is the only supported provider |
| `POLLINATIONS_KEY` | Server | Optional AI image generation (`api/asset.js`) |
| `VITE_UNSPLASH_ACCESS_KEY` | Browser | Unsplash photo search (public, rate-limited) |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | Server | Postgres connection (`server/index.js`) |
| `VITE_MOCK_AI=1` | Browser | Offline mode with no network calls |

> Never put a secret in a `VITE_`-prefixed variable; those values are bundled into the client.

### Feature config

Density and copy behavior live in one place: [`src/config/features.js`](src/config/features.js).

```js
export const FEATURES = {
  layout: {
    density: "tight",              // tight | dense | normal | airy
    coverageTarget: 0.8,           // share of each reserved box L4 should fill
    gutters: { tight: 0.42, dense: 0.6, normal: 0.82, airy: 1.2 },
  },
  decoration: {
    density: "dense",              // sparse | normal | dense
    maxPieces: 24,
    counts: { sparse: 0.8, normal: 1.15, dense: 1.6 },
    builders: { /* base/min/max per shape family */ },
  },
  copy: {
    strictRepetition: true,        // reject cross-region word reuse
    repairPasses: 2,               // 1 = first repair only, 2 = strict follow-up
    maxRegionRepairs: 2,
    regenerateBadCopy: true,       // retry L4 instead of dropping the line
  },
};
```

Change a value, reload, and every layer reads the same setting. No prompt or validator edits required.

### AI provider

Generation runs on **open-weight models only**, served locally by [Ollama](https://ollama.com). The browser calls the same-origin `/api/ai` route; prompts use strict JSON schemas and no AI key reaches the client.

```bash
ollama pull gemma4:e2b
```

Set `OLLAMA_MODEL` to whichever local model you run. On CPU-only machines, the narrow layers can use a smaller quantized model (for example `oovi-gemma3-270m:q8`) while a larger model handles the broader layers. The copy deck defaults to `OLLAMA_MODEL`; set `OLLAMA_MODEL_COPY_DECK` only when testing a stronger model for that one call.

## Project structure

```text
src/
  ai/            layered pipeline, prompts, client, mocks, quality gate
  app/           App.js orchestration (generation, persistence, history, panels)
  components/    Dashboard, TopBar, InsertPanel, AssistantPanel, DebugTabs, …
  config/        Central feature config (density, decoration, copy rules)
  design/        DSL schema, validator, canvas presets, design types
  editor/        Fabric canvas wrapper, history, layers, toolbar
  layout/        Templates, layout engine, type scale, palettes, decorations
  reference/     Reference-image analysis (color, OCR, shapes, layout)
  renderer/      Design DSL ↔ Fabric.js (the only Fabric touchpoint)
  storage/       REST client for /api/designs
  ui/            Hash router, shell, toasts, brand tokens
server/          Local API (stdlib node:http): designs CRUD, trash, asset/photo proxy
api/             Shared serverless handlers (Vercel + local server)
scripts/         Probe scripts (db, api, history, quality, trash, …)
tests/           Node test suites, run through the Vite bundler
```

Supporting docs: `DESIGN.md` (visual identity and tokens).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server (`:5173`, proxies `/api` → `:3001`) |
| `npm run dev:api` | Local API + Postgres backend (`:3001`) |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |
| `npm test` | Run the full test suite |
| `node scripts/quality-check.mjs` | Quality-gate fixture suite |
| `node scripts/db-probe.mjs` | Database connectivity check |

## Tech stack

Vanilla JavaScript, [Fabric.js](https://fabricjs.com/), Vite, Node.js stdlib HTTP, PostgreSQL (`pg`), Unsplash for imagery, lazy-loaded `@imgly/background-removal` and jsPDF. No frontend framework, no hidden dependencies.
