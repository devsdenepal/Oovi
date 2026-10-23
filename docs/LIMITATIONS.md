# Limitations and Future Work

Oovi is a finished challenge build, not a production design platform. These are the limits we know about, followed by the work we would do next.

## Model and performance

- **CPU inference is slow.** A full multi-region design can take minutes. The UI streams progress and paints regions as they land, but it is not instant.
- **One Ollama slot.** Region calls run serially. Parallel calls would queue at the model and can time out before receiving bytes.
- **Model quality varies.** The 270M LoRA adapter handles narrow JSON layers; the larger Gemma model handles open-ended planning and copy. The adapter's published smoke evaluation is limited and is not a claim about full-design quality.
- **Prompt sensitivity.** Ambiguous briefs can produce generic copy or a less suitable template. The goal layer and copy guards reduce this, but they do not eliminate it.
- **Reference mode uses a direct whole-design path.** It is less structured than the architected template path and depends more heavily on the model.

## Design and editing

- **Curated templates.** Layouts are selected from a fixed library. There is no arbitrary layout synthesis.
- **Assistant patch reliability.** The targeted assistant edit can fail to return recoverable JSON on small CPU models and then asks for a more specific retry. Manual editing is the reliable path and is what the walkthrough demonstrates.
- **The walkthrough uses a saved design.** It does not wait through a full CPU generation; the pipeline card explains the model chain and the promo trailer carries the AI story.
- **Closed decoration vocabulary.** The model can choose from a known set of shapes and patterns. It cannot draw arbitrary vector illustrations.
- **Image regions are stock photography or placeholders.** The submitted build has no generated-image path. An Unsplash outage or missing key degrades an image region to a placeholder.
- **No CMYK or print-production pipeline.** Export is RGB PNG/JPG/SVG/PDF.
- **Font availability affects export fidelity.** A missing system font can change line breaks and spacing.
- **Mobile editing is limited.** The editor is responsive, but precise multi-object editing is designed for a desktop pointer.

## Product and deployment

- **Postgres is required for persistence.** There is no embedded database or browser-only storage mode.
- **No authentication or multi-user workspaces.** The app assumes a single local operator.
- **No real-time collaboration.** There is no CRDT, presence, or conflict resolution.
- **No public hosted AI demo.** Real generation requires a machine running Ollama. The repository ships a recorded walkthrough and local setup instead of a cloud GPU deployment.
- **No billing, quotas, or abuse controls.** The local model is not exposed as a public inference service.

## Accessibility and localization

- **English-first interface and copy.** Nepali language generation and UI localization are not implemented.
- **Canvas accessibility is incomplete.** Design objects are not fully exposed as an accessible document tree, and there is no comprehensive screen-reader workflow.
- **No automated accessibility audit.** Keyboard shortcuts exist, but a full WCAG pass is still needed.

## Evaluation

- **No large public benchmark.** The test suite covers validators, copy guards, layout behavior, and fixtures. It is not a human-rated design-quality benchmark.
- **Quality scoring is heuristic.** `evaluateDesign()` measures geometric and contrast properties; it does not measure taste, brand fit, or cultural context.
- **The adapter's training data is synthetic.** The dataset is reproducible from the seed, but it is not a broad sample of real design briefs.

## Future work

1. **Local image generation.** Add an optional open-weight image model (for example a local diffusion server) so image regions do not depend on Unsplash.
2. **Stronger evaluation.** Build a human-rated benchmark for hierarchy, copy quality, and editability across design types.
3. **Better adapter training.** Expand the dataset, evaluate on held-out briefs, and publish per-layer success rates.
4. **Authentication and workspaces.** Add accounts, teams, roles, and per-workspace libraries.
5. **Real-time collaboration.** Move the design document to a CRDT and add presence and conflict handling.
6. **Nepali and multilingual design.** Add language-aware prompts, fonts, copy fitting, and UI localization.
7. **Accessibility.** Expose a semantic layer tree, alt text, focus order, and a WCAG audit.
8. **Print workflow.** Add CMYK export, bleed, and PDF/X profiles.
9. **Template marketplace.** Let users save, share, and import templates with versioning.
10. **Batch generation.** Generate campaign variants from one brief with shared brand constraints.
11. **Plugin API.** Let external tools provide templates, palettes, photo sources, or exporters.
12. **Hosted demo option.** Provide a documented, opt-in deployment path for a hosted open-weight inference provider, without making it the default.

## Known trade-offs

- **Template-first is a constraint and a feature.** It makes CPU generation tractable and keeps layouts collision-free, but it limits novelty.
- **Validation is strict.** Some creative layouts are rejected or normalized. The validator favors readable, renderable designs over maximum model freedom.
- **Local-first is slower but independent.** There is no paid API, no model key, and no vendor lock-in, at the cost of local compute.
- **The adapter is narrow by design.** It is a small, inspectable artifact, not a general-purpose model.
