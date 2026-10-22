/**
 * Dataset builder | brief -> template + tuning, and slot spec -> copy.
 *
 * Runs the SAME prompt builders the app uses at inference time, so the static
 * prefix ([System] code rules) in every example is byte-identical to
 * production. Extensionless ESM sources are bundled with the esbuild that
 * ships with Vite, same as scripts/run-tests.mjs.
 *
 *   node scripts/make-dataset.mjs [--briefs 800] [--copy 900] [--out data]
 *
 * Writes data/template-copy.train.jsonl (90%), data/template-copy.eval.jsonl
 * (10%, split by brief group so a brief's records never straddle the split)
 * and data/template-copy.stats.json.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "oovi-dataset");
mkdirSync(outDir, { recursive: true });

const esbuild = path.join(root, "node_modules", ".bin", "esbuild");
const outfile = path.join(outDir, "make-dataset-core.mjs");

const build = spawnSync(
  esbuild,
  [
    path.join("scripts", "make-dataset-core.mjs"),
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
