# oovi-gemma3-270m

LoRA adapter for the three narrow JSON layers in Oovi's local AI pipeline:

| layer | task | output |
| --- | --- | --- |
| `oovi_template` | pick one template from a retrieved shortlist | `{"template": "<id>"}` |
| `oovi_tuning` | choose a variant and bounded region patches | `{"variant", "density", "hide", "scale", "align"}` |
| `oovi_component` | fill one region's copy as design elements | `{"elements": [...]}` |

It is not a general chat model. Prompts are the production prompts built by
`src/ai/templatePrompt.js` and `src/ai/architectPrompt.js`; a bare question
will produce poor or empty output.

## Files

- `adapter_model.safetensors` — LoRA weights (15 MB).
- `adapter_config.json` — PEFT config: rank 16, alpha 32, dropout 0.05,
  q/k/v/o/gate/up/down projections.
- `Modelfile` — Ollama definition (Gemma chat template, 8192 context,
  temperature 0.2, top_p 0.95, top_k 64).
- `chat_template.jinja` — the chat template from the merged export.
- `checksums.txt` — SHA-256 of the adapter and the Q8_0 GGUF.

## Training

- Base: `google/gemma-3-270m` (recorded in `adapter_config.json`).
  The Colab notebook currently sets `BASE_MODEL` to
  `google/gemma-3-270m-it`; keep the two aligned when retraining.
- Adapter: LoRA r=16, alpha=32, dropout=0.05, completion-only loss.
- 2,169 training records from `scripts/make-dataset.mjs` (seed `20261019`),
  3 epochs, LR 2e-4, batch 4 × grad-accum 4, max sequence 2048.
- Dataset: 800 briefs → 2,500 records (choice/tune/copy), 30/30 templates,
  189 copy slots, 168 held-out eval records. Regenerate with:
  `node scripts/make-dataset.mjs` (the generated `data/` tree is not committed).
- Notebook: `train/colab_lora.ipynb` — encodes the exact production prompt
  strings, trains the adapter, merges, converts to GGUF Q8_0, and writes the
  Modelfile.

## Serving

The committed files are the adapter, not the merged model or GGUF. To rebuild
the served tag:

```bash
# 1. Train/merge/convert (Colab, GPU) — writes adapter/, merged/, gguf/
#    Open train/colab_lora.ipynb and run all cells.

# 2. Quantize is already done by the notebook (Q8_0). Put the GGUF next to
#    a Modelfile whose FROM points at it, then:
ollama create oovi-gemma3-270m:q8 -f Modelfile

# 3. Verify the served template and context:
ollama show oovi-gemma3-270m:q8 --modelfile
```

The app selects it in `.env`:

```dotenv
OLLAMA_MODEL=oovi-gemma3-270m:q8
```

The free-form `oovi_plan` / `oovi_skeleton` layers were not part of the
training data; keep a larger fallback model there if open-ended generation
matters (`OLLAMA_MODEL_FALLBACK`).

## Evaluation

Strict-schema smoke eval on three briefs (choice / tune / copy = 9 calls):
choice 2/3 matched, tuning 3/3 sanitized, copy 1/3 valid. That is a smoke
check, not a quality claim. The full 15-brief benchmark was stopped early.
See the eval harness
(`node scripts/tiny-eval.mjs --model oovi-gemma3-270m:q8 --strict`).

## License

Inherits the Gemma Terms of Use from the base model. The adapter is a
derivative of `google/gemma-3-270m`; review those terms before redistribution.
