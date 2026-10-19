/**
 * Runs the retrieval benchmark.
 *
 * Same reason as scripts/run-tests.mjs: the sources use extensionless ESM
 * imports, which Node's loader rejects but esbuild resolves. So bundle the
 * benchmark core, then hand it to node.
 *
 *   node scripts/benchmark-retrieval.mjs [--model nomic-embed-text]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "oovi-bench");
const esbuild = path.join(root, "node_modules", ".bin", "esbuild");
const outfile = path.join(outDir, "benchmark-core.mjs");

mkdirSync(outDir, { recursive: true });

const build = spawnSync(
  esbuild,
  [
    path.join("scripts", "benchmark-core.mjs"),
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
