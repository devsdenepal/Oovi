/**
 * The deterministic palette library must be safe to use WITHOUT a model call:
 * every entry has to clear the quality gate's contrast floor on its own, and
 * the lookup has to be stable and keyword-driven.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PALETTES, lookupPalette, paletteIsUsable } from "../src/layout/palettes";
import {
  PALETTE_ROLES,
  applyRoleFills,
  derivePaletteRoles,
  ensurePaletteRoles,
  formatPaletteRoles,
  textRoleFor,
} from "../src/layout/paletteRoles";
import { contrastRatio } from "../src/ai/quality";

test("every library palette derives a complete, readable role system", () => {
  for (const p of PALETTES) {
    const roles = derivePaletteRoles(p);
    for (const role of PALETTE_ROLES) {
      assert.match(roles[role], /^#[0-9A-Fa-f]{6}$/, `${p.id}: ${role} is a hex colour`);
    }
    const floor = (a, b, min, label) => {
      const ratio = contrastRatio(a, b);
      assert.ok(ratio !== null && ratio >= min, `${p.id}: ${label} ${ratio?.toFixed(2)} >= ${min}`);
    };
    floor(roles.textPrimary, roles.background, 4.5, "primary text on canvas");
    floor(roles.textPrimary, roles.surface, 4.5, "primary text on a card");
    floor(roles.textSecondary, roles.background, 4.5, "secondary text on canvas");
    floor(roles.ctaText, roles.ctaSurface, 4.5, "CTA label on the CTA surface");
    assert.notEqual(roles.surface.toUpperCase(), roles.background.toUpperCase(), `${p.id}: surface lifts off the canvas`);
    assert.notEqual(roles.border.toUpperCase(), roles.background.toUpperCase(), `${p.id}: border is visible`);
  }
});

test("roles are derived, not stored twice: base colours and roles agree", () => {
  const base = { background: "#FFFFFF", ink: "#111111", accent: "#E02020" };
  const once = derivePaletteRoles(base);
  const twice = ensurePaletteRoles({ ...base, roles: once });
  assert.deepEqual(twice, once, "re-deriving a role set is idempotent");
  assert.equal(once.textPrimary, "#111111");
  assert.equal(once.background, "#FFFFFF");
  const line = formatPaletteRoles(base);
  assert.ok(line.includes("secondary text #"), "prompt line names secondary text");
  assert.ok(line.includes("CTA surface #"), "prompt line names the CTA surface");
});

test("lookup answers industry-and-keyword briefs and returns roles", () => {
  const goal = {
    summary: "a new analytics product launch",
    subject: "analytics app",
    purpose: "announce the launch",
    keywords: ["product", "launch", "analytics"],
    designType: "product-launch",
    industry: "technology",
  };
  const found = lookupPalette(goal);
  assert.ok(found, "an industry + keyword brief answers from the library");
  assert.equal(found.id, "tech-blue");
  assert.ok(found.roles && found.roles.ctaSurface, "lookup returns the role set");

  const food = lookupPalette({
    summary: "autumn dinner menu",
    keywords: ["menu", "dishes", "autumn"],
    industry: "food and drink",
    designType: "menu",
  });
  assert.equal(food.id, "food-orange", "industry steers the palette");
});

test("region text is painted onto its semantic role", () => {
  const palette = { background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF" };
  const roles = derivePaletteRoles(palette);
  const elements = [
    { id: "h", type: "text", role: "headline", content: "Title", fill: "#FF0000" },
    { id: "s", type: "text", role: "tagline", content: "Sub", fill: "#FF00FF" },
    { id: "ok", type: "text", role: "details", content: "Fact", fill: roles.textPrimary },
  ];
  const out = applyRoleFills(elements, "details", palette);
  assert.equal(out[0].fill, roles.textPrimary, "a rogue headline becomes primary text");
  assert.equal(out[1].fill, roles.textSecondary, "a rogue tagline becomes secondary text");
  assert.equal(out[2].fill, roles.textPrimary, "an on-palette fill is untouched");
  assert.equal(textRoleFor("cta"), "ctaText");
  assert.equal(textRoleFor("footer"), "textSecondary");
  assert.equal(textRoleFor("attribution"), "textSecondary");
  assert.equal(textRoleFor("source"), "textSecondary");
});

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
