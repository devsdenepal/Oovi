# Third-Party Notices

Oovi-authored source is licensed under the MIT License (see [LICENSE](LICENSE)). Third-party packages, model weights, assets, and services keep their own terms. This file is a practical summary, not legal advice; verify the linked licenses before redistribution.

## Models and model artifacts

| Artifact | Terms |
|---|---|
| Gemma 4 and Gemma 3 models served by Ollama | [Gemma Terms of Use](https://ai.google.dev/gemma/terms) |
| `model/oovi-gemma3-270m/` LoRA adapter | Inherits the Gemma Terms of Use from the base model `google/gemma-3-270m` |
| `@imgly/background-removal` model/runtime | AGPL-3.0; see the package `LICENSE.md` |
| Tesseract OCR language data (`tesseract.js`) | Apache-2.0 for the package; language data has its own upstream terms |

The adapter is a derivative of Gemma 3 270M. It is not a general-purpose model and is not relicensed under MIT.

## Runtime dependencies

| Package | Version | License |
|---|---|---|
| `@imgly/background-removal` | 1.7.0 | AGPL-3.0 |
| `bootstrap` | 5.3.8 | MIT |
| `dotenv` | 18.0.7 | BSD-2-Clause |
| `express` | 5.3.0 | MIT |
| `fabric` | 6.9.1 | MIT |
| `inherits` | 2.0.4 | ISC |
| `jspdf` | 4.2.1 | MIT |
| `pg` | 8.23.1 | MIT |
| `tesseract.js` | 7.0.0 | Apache-2.0 |
| `playwright` | 1.64.0 | Apache-2.0 (development) |
| `sass` | 1.106.1 | MIT (development) |
| `vite` | 6.4.3 | MIT (development) |

`@imgly/background-removal` is optional and lazy-loaded. It is used only when the user invokes background removal. If you distribute a bundled application that includes it, comply with the AGPL-3.0 or replace it with a differently licensed component.

## Services and assets

| Item | Terms / note |
|---|---|
| Unsplash API and photos | [Unsplash API Terms](https://unsplash.com/developers); photos are fetched at runtime, not committed |
| Demo walkthrough photo, ID `HyTwtsk8XqA` by Daniel Korpai | [Unsplash License](https://unsplash.com/license); used in the saved demo design, screenshots, and walkthrough video. Not part of the application runtime. |
| Font Awesome kit (`kit.fontawesome.com/1364c3c233.js`) | The kit's license depends on the Font Awesome plan that owns the kit; verify before redistribution |
| Mixkit sound effects used in the promo video | [Mixkit License](https://mixkit.co/license/); the promo is a documentation asset, not part of the application runtime |
| OpenAI-compatible mention in code comments | Refers to Ollama's compatibility endpoint; no OpenAI API is called |

## No closed AI providers

The product path does not call OpenAI, Anthropic, Google Gemini, Azure OpenAI, or any other closed AI API. The only model provider is a local Ollama server. Unsplash is a stock-photo service, not a generative model.

## Reporting a licensing issue

If you believe a file or asset is missing attribution or is incorrectly licensed, open an issue on the repository with the path and the relevant license. We will correct or remove it.
