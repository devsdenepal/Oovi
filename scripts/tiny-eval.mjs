/**
 * Tiny-model eval | the three narrow pipeline calls through one model at a time.
 *
 * For each realistic brief it runs the SAME production prompt builders the app
 * uses (template choice, tuning patch, slot copy) with Ollama's schema-
 * constrained decoding, and reports valid JSON, sanitized output, template
 * match against a hand label, wall latency and Ollama's own prefill/eval token
 * counts.
 *
 * The sources use extensionless ESM imports, so bundle the core with the
 * esbuild that ships with Vite, then hand the bundle to node (same trick as
 * scripts/run-tests.mjs and scripts/benchmark-retrieval.mjs).
 *
 *   node scripts/tiny-eval.mjs --preflight
 *   node scripts/tiny-eval.mjs --model gemma3:270m
 *   node scripts/tiny-eval.mjs --model oovi-gemma3-270m:q8 --strict
 *   node scripts/tiny-eval.mjs            # all three: 270m, 1b, e2b
 *
 * Any Ollama tag works, including an imported GGUF. Flags: --model m |
 * --models a,b,c  --limit N  --only choice,tune,copy  --strict  --preflight.
 * Raw per-call rows land in node_modules/.cache/oovi-tinyEval/
 * results-<tag>[-strict].jsonl.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "oovi-tinyEval");
mkdirSync(outDir, { recursive: true });

const esbuild = path.join(root, "node_modules", ".bin", "esbuild");
const outfile = path.join(outDir, "tiny-eval-core.mjs");

const build = spawnSync(
  esbuild,
  [
    path.join("scripts", "tiny-eval-core.mjs"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    `--outfile=${outfile}`,
    "--log-level=warning",
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
