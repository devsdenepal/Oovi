/**
 * The deterministic palette library must be safe to use WITHOUT a model call:
 * every entry has to clear the quality gate's contrast floor on its own, and
 * the lookup has to be stable and keyword-driven.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PALETTES, lookupPalette, paletteIsUsable } from "../src/layout/palettes";
import { contrastRatio } from "../src/ai/quality";

test("every library palette is readable by construction", () => {
  assert.ok(PALETTES.length >= 8, "a useful library");
  for (const p of PALETTES) {
    assert.match(p.background, /^#[0-9A-Fa-f]{6}$/, `${p.id}: hex background`);
    assert.match(p.ink, /^#[0-9A-Fa-f]{6}$/, `${p.id}: hex ink`);
    assert.match(p.accent, /^#[0-9A-Fa-f]{6}$/, `${p.id}: hex accent`);
    const ratio = contrastRatio(p.ink, p.background);
    assert.ok(ratio !== null && ratio >= 4.5, `${p.id}: ink/background contrast ${ratio} must be >= 4.5`);
    assert.ok(paletteIsUsable(p), `${p.id}: usable`);
    assert.ok(p.keywords.length > 0, `${p.id}: has keywords`);
    assert.ok(!("accent" in p) || p.accent.toUpperCase() !== p.ink.toUpperCase(), `${p.id}: accent is distinct from ink`);
  }
});

test("palette ids are unique", () => {
  assert.equal(new Set(PALETTES.map((p) => p.id)).size, PALETTES.length);
});

test("lookup is deterministic and matches by meaning", () => {
  const diwali = { summary: "Diwali celebration at the office", style: "warm festive", tone: "celebratory" };
  const a = lookupPalette(diwali);
  const b = lookupPalette(diwali);
  assert.deepEqual(a, b, "same goal -> same palette");
  assert.equal(a.id, "festive-warm");
  assert.equal(a.source, "library");

  assert.equal(lookupPalette({ summary: "a developer hackathon", style: "modern tech" }).id, "tech-blue");
  assert.equal(lookupPalette({ summary: "a wellness yoga workshop", style: "calm" }).id, "wellness-sage");
  assert.equal(lookupPalette({ summary: "quarterly earnings for investors", style: "corporate" }).id, "corporate-navy");
});

test("an unrecognised brief falls through to the model", () => {
  assert.equal(lookupPalette({ summary: "zq", style: "x" }), null);
  assert.equal(lookupPalette(null), null);
});

test("a style/tone word outweighs the same word buried in the body", () => {
  const weighted = lookupPalette({ summary: "neon lights", tone: "calm wellness" });
  assert.equal(weighted.id, "wellness-sage", "style/tone hits count double");
});
