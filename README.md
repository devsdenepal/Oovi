# Oovi

AI-powered editable graphic design system. 

**Natural language prompt → Generative AI → Design JSON → validated → Fabric.js → fully editable canvas.**

No flattened image is ever generated. The AI produces a *structured design document*, and Fabric.js maintains an editable representation (click, drag, resize, rotate, double-click to edit text, delete, duplicate, undo/redo, multi-select, layers panel).

## Pipeline

```text
User prompt
  → Generative AI API (POST {AICONDUCTOR_URL}/generate)
  → Design JSON / Design DSL
  → validateDesign() (src/design/designValidator.js)
  → fabricRenderer.renderDesign() (src/renderer/fabricRenderer.js)
  → editable Fabric.js canvas
```

Modules are separated so the renderer can be swapped without touching the AI layer, and image-generation / design-memory features can be added later:

```text
src/
  ai/            aiClient.js, designPrompt.js
  design/        designSchema.js, designValidator.js, designTypes.js
  renderer/      fabricRenderer.js   (Design DSL <-> Fabric.js only)
  editor/        Canvas.js, LayersPanel.js, Toolbar.js, HistoryManager.js
  components/    PromptInput.js, GenerateButton.js
  app/           App.js             (wiring & pipeline orchestration)
```

## Setup

```bash
npm install
npm run dev          # http://localhost:5173
```

Configure the AI provider via `.env` (a working `.env` ships for the AI Conductor Vercel deployment; see `.env.example`):

```env
VITE_AICONDUCTOR_URL=https://aiconductor.vercel.app
VITE_AICONDUCTOR_TOKEN=your-token-here
VITE_AICONDUCTOR_MODEL=aiconductor
```

The AI Conductor contract (used by other projects like deepgyan) is:

```text
POST {URL}/generate
  headers: { "Content-Type": "application/json", "Authorization": "Bearer <token>" }
  body:    { "prompt": "[System]\n<layout-engine instructions>\n\n[User]\n<your request>" }
  returns: { "success": true, "text": "<model output>" }
```

> Note: for this demo the provider is called straight from the browser, so the token is visible to anyone opening the page. For anything beyond a local demo, proxy the call through a private backend (Vercel serverless function, etc.) and keep the token server-side.

## Example prompt (pre-filled)

```text
Create a modern product announcement for our new AI assistant. Include the
company name header, a bold headline, supporting body text, a decorative
rounded rectangle, and a footer with the website.
```

## Design JSON schema

The AI is told (see `src/ai/designPrompt.js`) to return only this shape:

```json
{
  "canvas": { "width": 1080, "height": 1080, "background": "#FFFFFF" },
  "elements": [
    {
      "id": "headline",
      "type": "text",
      "role": "headline",
      "content": "The Future Starts Now",
      "x": 80,
      "y": 220,
      "width": 850,
      "fontSize": 72,
      "fontWeight": 700,
      "fill": "#111111"
    },
    {
      "id": "shape",
      "type": "rectangle",
      "role": "decoration",
      "x": 760,
      "y": 350,
      "width": 220,
      "height": 220,
      "fill": "#222222",
      "cornerRadius": 20
    }
  ]
}
```

Element types supported by the renderer (extensible via the `createObject` switch):

```text
text       -> FabricText (editable)
rectangle  -> Rect
circle     -> Circle
line       -> Line
group      -> Group
```

Every rendered Fabric object keeps its DSL `id` as `obj.designId`.

## Editing

- **Click** to select · **drag** to move · **handles** to resize/rotate
- **Double-click** a text to edit it inline (or edit via the Properties panel)
- **Delete / Backspace** removes; **Ctrl+D** duplicates; **Shift+click** multi-select; **Ctrl+A** selects all
- **Ctrl+Z / Ctrl+Y** (or Ctrl+Shift+Z) undo/redo
- **Layers** panel clicks select the matching object (top-most first)
- **Properties** panel edits content, font size, weight, and color of the selection
- **JSON preview** shows the live Design DSL as you edit — no AI call needed

## Future-proofing

The boundaries are already in place for: image-generation APIs (extend `src/ai`), SVG/PSD import (new readers → Design DSL), brand kits (schema extension), design memory/RAG (persist/retrieve `Design` documents), templates, multiple canvas sizes, PNG/SVG/PDF export (renderer `canvasToDesign` / `canvas.toDataURL`), and AI *editing* commands (same pipeline, prompt = current design + edit instruction).
