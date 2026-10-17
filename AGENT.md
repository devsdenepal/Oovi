# AGENT.md — working in this repo

Vite + vanilla JS + Fabric.js. Prompt → Design JSON → validated → editable
canvas. No React. `npm run dev` (hot-reloads, :5173) + `npm run dev:api`
(:3001, stdlib node:http + Postgres); `npm run build` (must stay green).
AI goes through the same-origin `/api/groq` route, which walks the
server-side OPEN-WEIGHT chain (Groq gpt-oss-120b → Gemini Gemma 4 →
OpenRouter Nemotron → on-device Ollama). No closed model, ever.

## Layer map (respect it)
- `src/design` — schema, validator, size presets. Pure data + checks.
- `src/ai` — open-weight chain client, prompts, JSON repair. Knows the DSL only.
- `src/renderer` — the ONLY Fabric touchpoint besides `src/editor`.
  DSL ↔ Fabric objects, nothing else.
- `src/editor` — `Canvas` (orchestrates Fabric), `Toolbar` (properties),
  `LayersPanel`, `HistoryManager`. Never imports from `ai`.
- `src/components` — one vanilla class per panel, mounted by element id,
  behavior via constructor handlers. Never imports Fabric or `editor`.
- `src/app/App.js` — the sole orchestrator; the only module wiring AI +
  editor + components together.
- `src/ui` — chrome only (`tokens.css`, toasts, tabs, shell). Imports
  nothing from ai/editor/app. `src/ui/tokens.css` owns ALL brand values.

## Rules
1. UI components never call Fabric directly — go through editor methods.
2. Never flatten the design to an image; it stays editable objects.
3. Every canvas mutation goes through `_handleMutation()` (one history
   entry). No side-channel state changes.
4. All colors/fonts/spacing use `var(--oovi-*)` from `tokens.css`. No hex
   in CSS, no new deps without asking. No dark mode (explicitly out).
5. Keep the browser↔server contract: one `POST /api/groq`, OpenAI-style
   `messages` in / `{ text, provider }` out. Provider choice is server-side
   (`api/_aiChain.js`) and keys never reach the browser. Reference images
   stay client-side (analysis flattened to text).
6. Mounts live in `index.html`, wired in `main.js` → `App`. Don't rename
   a mount without updating all three.
7. Check `DECISIONS.md` before relitigating a call; append new ones.
   `DESIGN.md` documents visual-identity choices.
8. Verify with `npm run build` after every change chunk. Small diffs,
   existing-file edits over new files.
