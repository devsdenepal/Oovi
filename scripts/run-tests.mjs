/**
 * Test runner.
 *
 * The repo has no test toolchain and its sources use extensionless ESM
 * imports (`import { x } from "./typeScale"`), which Node's ESM loader
 * rejects but Vite/esbuild resolve. Rather than change every import, bundle
 * each tests/*.test.mjs with the esbuild that ships with Vite, then hand the
 * bundles to node's built-in test runner.
 *
 *   npm test
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "oovi-tests");
const esbuild = path.join(root, "node_modules", ".bin", "esbuild");

const testsDir = path.join(root, "tests");
let files;
try {
  files = readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs"));
} catch {
  console.error(`No tests directory at ${testsDir}`);
  process.exit(1);
}
if (!files.length) {
  console.error("No tests/*.test.mjs files found.");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const bundled = [];
for (const file of files) {
  const outfile = path.join(outDir, file);
  const result = spawnSync(
    esbuild,
    [
      path.join("tests", file),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      `--outfile=${outfile}`,
      "--log-level=warning",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  bundled.push(outfile);
}

const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...bundled], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
