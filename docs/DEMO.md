# Demo Guide

The ~100-second walkthrough is the primary submission demo. The 36-second product film is a visual trailer. Both are in this repository:

- [oovi-demo.mp4](oovi-demo.mp4) - ~100-second workflow walkthrough
- [oovi-promo.mp4](oovi-promo.mp4) - 36-second product film

The walkthrough is a real screen recording of the app running locally at 1920x1080. It opens a saved design, edits it by hand, previews it, and exports a PNG. The local model pipeline is introduced with an on-screen card; the recording does not wait through a full CPU generation. No hosted AI service is used.

## What the walkthrough shows

1. **The library:** a saved design and the prompt-first dashboard.
2. **The pipeline:** goal, palette, template, copy deck, regions, validation, quality, render - all local.
3. **The editor:** a design opens as a real, editable canvas.
4. **Layers:** text, shapes, and the photo are separate objects with their own properties.
5. **Manual editing:** select and move a headline, then undo; edit copy in place, then undo and redo.
6. **Preview and export:** inspect the clean design and export a PNG.

The walkthrough deliberately does not show a live generation or a successful AI patch. Full CPU generation takes minutes and the targeted assistant patch is not reliable enough on the smallest models; those limits are documented in [LIMITATIONS.md](LIMITATIONS.md). The promo trailer carries the AI-pipeline story visually.

## Run the demo locally

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Ollama
- Unsplash access key (optional, for photo regions)

### Setup

```bash
cp .env.example .env
# Edit .env:
#   OLLAMA_URL=http://127.0.0.1:11434
#   OLLAMA_MODEL=gemma4:e2b
#   AI_CHAIN=ollama
#   Postgres credentials
#   VITE_UNSPLASH_ACCESS_KEY=... (optional)

npm install
createdb oovi
ollama pull gemma4:e2b
node scripts/db-probe.mjs
```

### Start

```bash
# Terminal 1 - API and persistence
npm run dev:api

# Terminal 2 - UI
npm run dev
```

Open `http://localhost:5173`.

### Quick smoke check

```bash
curl http://localhost:3001/api/health
curl http://127.0.0.1:11434/api/tags
```

Both should return 200.

### Model-free UI check

Set `VITE_MOCK_AI=1` in `.env` and restart the dev server. This exercises the dashboard, editor, persistence, and export but does not call a model. It is clearly labeled as mock mode in the UI pipeline.

## Suggested live demo flow

1. Open the dashboard. Point out recent designs and the prompt-first hero.
2. Enter a brief such as:
   > A modern product announcement for our new AI assistant. Bold headline, deep indigo hero image, clean grid, subtle glow accents.
3. Choose `Facebook Post - 1200 x 630`.
4. Click **Generate design**.
5. While it runs, explain that the model is local, the API is same-origin, and each region is validated before it is painted.
6. When the design opens, select the headline and move or resize it.
7. Double-click the headline and edit the copy.
8. Open the Layers panel and show that text, image, and decoration primitives are separate objects.
9. Open the Layers panel and show that text, image, and decoration primitives are separate objects.
10. Edit the copy in place, then undo and redo.
11. Preview the design and export a PNG.
12. Open a terminal and run `ollama list` to show the local model.

If you want to test a live generation, click **Generate design** and expect several minutes on CPU. The UI streams progress. If you test the Assistant patch, expect occasional JSON-recovery failures on the smallest models; manual editing is the reliable path.

## Recording notes

- Record at 1920x1080, 30fps.
- Use captions, not a synthetic voice.
- Do not show `.env` values, database passwords, or private design content.
- Keep the approved 36-second trailer separate; do not re-render it for the demo.
- The walkthrough uses a saved design so the edit and export flow is deterministic.

## Reviewer checklist

- [ ] Dashboard opens and shows saved designs.
- [ ] A saved design opens as an editable canvas.
- [ ] Text, image, and decoration primitives are separate layers.
- [ ] Inline text editing, undo, and redo work.
- [ ] Preview shows the design without editor chrome.
- [ ] Export produces a usable PNG.
- [ ] `ollama list` shows the local open-weight models.
- [ ] No closed AI provider or hosted image generator is called.
