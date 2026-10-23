# AI Usage Disclosure

Oovi uses AI as part of its core product logic. The model does not write a chat reply that is shown to the user. It produces structured design data that is parsed, validated, scored, repaired, and rendered into editable objects.

This document names the exact files and functions involved. Line numbers are intentionally omitted because they move; the function names are stable.

## Models

| Role | Model | Runtime | License |
|---|---|---|---|
| Default planning and generation | `gemma4:e2b` | Local Ollama | Gemma Terms of Use |
| Narrow-layer adapter | `oovi-gemma3-270m:q8` | Local Ollama | Gemma Terms of Use, inherited from `google/gemma-3-270m` |
| Smaller fallback layers | `gemma3:1b`, `gemma3:270m` | Local Ollama | Gemma Terms of Use |
| Background removal | `@imgly/background-removal` | Local ONNX in the browser | AGPL-3.0 |
| Reference OCR | Tesseract.js | Local in the browser | Apache-2.0 |

The default model is configured by `OLLAMA_MODEL`. Optional per-layer overrides are `OLLAMA_MODEL_TUNE`, `OLLAMA_MODEL_COPY_DECK`, `OLLAMA_MODEL_COPY`, and `OLLAMA_MODEL_FALLBACK`. `AI_CHAIN` supports only `ollama`.

The committed adapter in `model/oovi-gemma3-270m/` is a LoRA adapter for three narrow JSON layers: template choice, bounded template tuning, and one-region copy fills. It is not a general chat model. The larger Gemma model handles open-ended planning and copy.

## Provider and gateway

| File | Function | What it does |
|---|---|---|
| `api/_aiChain.js` | `callOllama()` | Sends chat messages to Ollama's native `/api/chat` endpoint, reads the NDJSON stream, and returns `{ text, model, usage }`. |
| `api/_aiChain.js` | `runChain()` | Runs the configured provider chain. `ollama` is the only registered provider. |
| `api/ai.js` | `streamChain()` | Same-origin gateway for streaming AI requests. Emits `start`, `progress`, `delta`, `done`, and `error` NDJSON events. |
| `api/ai.js` | `handler()` | HTTP entry point for `POST /api/ai`. Validates the request and returns either JSON or an NDJSON stream. |

No AI key is required for Ollama, and no provider-specific key reaches the browser.

## Design pipeline

| File | Function(s) | AI output | Consumed by |
|---|---|---|---|
| `src/ai/aiClient.js` | `refineGoal()` | Structured goal and audience fields | Palette and template planners |
| `src/ai/aiClient.js` | `planPalette()` | Palette roles and colors | Template tuning and the renderer |
| `src/ai/aiClient.js` | `chooseTemplate()` / `planTemplate()` | Template id and bounded tuning | Layout instantiation |
| `src/ai/aiClient.js` | `planTemplateTuning()` | Variant, density, hide/scale/align patches | `instantiateTemplate()` and the layout engine |
| `src/ai/aiClient.js` | `planCopyDeck()` | One copy line per text region | `validateCopyDeck()` and region generation |
| `src/ai/aiClient.js` | `validateCopyDeck()` | Deterministic validation result | Copy repair and region generation |
| `src/ai/aiClient.js` | `componentDesign()` | Design DSL elements for one region | Region validation and the renderer |
| `src/ai/aiClient.js` | `generateDesign()` | Validated Design DSL | `App.startGeneration()` and the canvas |
| `src/ai/aiClient.js` | `generatePatch()` | Validated patch operations | `App.onAssistantSend()` and `CanvasEditor.applyPatchOps()` |
| `src/ai/aiClient.js` | `fetchAiChat()` | Raw model text | `regexRepairJson()` and the layer parsers |

Prompt builders live in:

- `src/ai/layerPrompt.js` - goal and palette
- `src/ai/templatePrompt.js` - template choice and tuning
- `src/ai/copyPrompt.js` - copy deck and copy repair
- `src/ai/architectPrompt.js` - design plan and region DSL
- `src/ai/designPrompt.js` - legacy whole-design path
- `src/ai/patchPrompt.js` - assistant patch edits
- `src/ai/semanticPrompt.js` - reference-guided designs

JSON recovery and streaming helpers:

- `src/ai/aiClient.js` - `regexRepairJson()`, `parseJsonLenient()`
- `src/ai/streamJson.js` - `createElementScanner()`
- `src/ai/patch.js` - `validatePatch()`

## Validation and quality gates

| File | Function | What it does |
|---|---|---|
| `src/design/designValidator.js` | `validateDesign()` | Structural and semantic validation of the Design DSL. Rejects invalid elements and normalizes valid ones. |
| `src/ai/quality.js` | `evaluateDesign()` | Non-mutating quality score for coverage, balance, contrast, hierarchy, and hero presence. |
| `src/ai/quality.js` | `contrastRatio()`, `textBox()`, `elementBoxes()` | Pure helpers used by the quality gate. |
| `src/ai/copySanitize.js` | `sanitizeRegionCopy()`, `copyProblem()`, `findCopyRepetitions()` | Deterministic copy guards. |
| `src/ai/colorCorrect.js` | `correctColors()` | Deterministic palette and contrast repair. |

The quality gate reports issues; it does not silently mutate the design. `App` maps findings back to regions and asks the AI to repair only those regions.

## Rendering and application

| File | Function | What it does |
|---|---|---|
| `src/app/App.js` | generation flow | Calls `generateDesign()`, applies `validateDesign()` as a safety net, and loads the result into the editor. |
| `src/app/App.js` | `onAssistantSend()` | Calls `generatePatch()` and applies only validated patch operations. |
| `src/renderer/fabricRenderer.js` | `renderDesign()` | Consumes the validated DSL and creates editable Fabric.js objects. |
| `src/renderer/fabricRenderer.js` | `createDesignObject()`, `createText()`, `createRectangle()`, `createCircle()`, `createLine()`, `createGroup()` | Per-element Fabric constructors. |
| `src/renderer/fabricRenderer.js` | `hydrateImages()` | Resolves image sources into Fabric image objects. |
| `src/editor/Canvas.js` | `applyPatchOps()` | Applies validated patch operations to live objects. |
| `src/editor/Canvas.js` | `removeBackgroundActive()` | Runs the local `@imgly/background-removal` model on the active image. |
| `src/reference/ocr/ocrProvider.js` | `recognizeText()` | Runs local Tesseract OCR for optional reference-image analysis. |

Every rendered object keeps its DSL `id` as `obj.designId`, so edits and exports continue to use the same document.

## What is not AI

- **Unsplash** (`api/photos.js`, `src/ai/unsplash.js`) is a stock-photo search API. It is not a generative model.
- **Fabric.js** is the canvas renderer. It is not an AI system.
- **Postgres** stores designs and thumbnails. It is not an AI system.
- **`src/ai/mockProvider.js`** returns canned data for offline UI work and tests. It does not call a model.

## Core-test evidence

If the AI calls are removed, Oovi can still open a saved design and edit it, but it cannot perform its defining task: turn a new natural-language brief into a new design. The product's generation path depends on AI output being parsed into Design DSL, validated, and rendered. The AI is not a decorative chat feature.

## Reproducing the disclosure

- Provider code: `api/_aiChain.js`, `api/ai.js`
- Pipeline: `src/ai/aiClient.js` and the prompt modules under `src/ai/`
- Validators: `src/design/designValidator.js`, `src/ai/quality.js`
- Rendering: `src/renderer/fabricRenderer.js`
- Adapter: `model/oovi-gemma3-270m/README.md`
- Model terms: [THIRD_PARTY.md](../THIRD_PARTY.md)
