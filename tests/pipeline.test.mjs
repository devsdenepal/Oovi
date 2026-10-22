/**
 * Pipeline regression: the sparse product announcement.
 *
 * The failure this pins is the one users actually reported: a terse brief
 * ("Ship faster with Acme") produced a headline in a field of empty containers.
 * The fix is structural | scope (L1) → palette roles (L2) → a template chosen
 * for the composition (L3) → content generated per assigned slot (L4) | and it
 * is deterministic up to L4, so all of it must be testable without a model.
 *
 * This test drives the same path the app drives, with `materializePlan` standing
 * in for the model's per-region copy (it fills every slot edge-to-edge, i.e.
 * worst case), and runs the result through the SAME quality gate the app uses.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { retrieveTemplates } from "../src/layout/retrieve";
import { getTemplate, instantiateTemplate } from "../src/layout/templates";
import { lookupPalette } from "../src/layout/palettes";
import {
  derivePaletteRoles,
  ensurePaletteRoles,
  applyRoleFills,
  textRoleFor,
} from "../src/layout/paletteRoles";
import { materializePlan } from "../src/layout/materialize";
import { contrastRatio, elementBoxes, evaluateDesign } from "../src/ai/quality";
import { correctColors } from "../src/ai/colorCorrect";
import { fitRegion } from "../src/layout/regionFit";

const CANVAS = { width: 1200, height: 630 };

/** The sparse product-announcement fixture, as L1 now returns it. */
export const SPARSE_PRODUCT_ANNOUNCEMENT = {
  summary: "Ship faster with Acme",
  subject: "Acme workflow assistant",
  purpose: "announce the product launch",
  audience: "busy product teams",
  tone: "confident and clean",
  designType: "product-launch",
  industry: "technology",
  keywords: ["product", "launch", "workflow", "assistant"],
  composition: "hero-right",
  mustInclude: ["product name", "one-line promise", "release date", "call to action"],
  avoid: ["invented pricing", "clutter"],
  style: "clean modern, crisp blue",
};

function runPipeline(goal, canvas = CANVAS) {
  const palette = lookupPalette(goal);
  assert.ok(palette, "L2 answers the fixture from the library (no model call)");
  const found = retrieveTemplates(goal, canvas);
  assert.equal(found.source, "retrieval", "L3 retrieves a template for the fixture");
  const template = getTemplate(found.candidates[0]);
  assert.ok(template, "the retrieved id resolves to a template");
  const built = instantiateTemplate(template, {}, canvas);
  assert.equal(built.ok, true, "the template instantiates");
  const design = materializePlan(built.components, canvas, palette);
  const report = evaluateDesign(design, {
    plannedIds: built.components.map((c) => c.id),
    renderedIds: built.components.map((c) => c.id),
    expectHero: built.components.some((c) => c.kind === "image"),
    components: built.components,
    palette,
  });
  return { palette, found, template, components: built.components, design, report };
}

test("the sparse product announcement becomes a complete composition", () => {
  const { palette, found, components, design, report } = runPipeline(SPARSE_PRODUCT_ANNOUNCEMENT);

  assert.ok(found.candidates.length >= 1 && found.candidates.length <= 3);
  assert.ok(found.coverage >= 0.12, `retrieval confidence ${found.coverage}`);

  // Every slot is authoritative and complete: id, role, geometry, type size,
  // copy limit and alignment all reach L4.
  for (const c of components) {
    assert.ok(c.id && typeof c.id === "string", "stable slot id");
    assert.ok(c.role && typeof c.role === "string", `${c.id}: role`);
    assert.ok(c.box && c.box.width > 0 && c.box.height > 0, `${c.id}: box`);
    if (c.kind !== "image" && c.role !== "decoration") {
      assert.ok(c.fontSize > 0, `${c.id}: fixed type size`);
      assert.ok(c.maxChars > 0, `${c.id}: copy limit`);
      assert.ok(["left", "center", "right"].includes(c.align), `${c.id}: alignment`);
    }
  }

  // No required region is empty, and every region owns real copy.
  assert.equal(report.issues.filter((i) => i.severity === "error").length, 0, JSON.stringify(report.issues));
  const empty = report.issues.filter((i) => i.code === "empty-section" || i.code === "empty-hero");
  assert.deepEqual(empty, [], "no planned region rendered empty");

  const texts = design.elements.filter((e) => e.type === "text");
  assert.ok(texts.length >= 3, `the design carries supporting content (${texts.length} text runs)`);
  assert.ok(texts.every((t) => String(t.content || "").trim().length > 0), "no blank copy runs");
  assert.ok(texts.some((t) => t.role === "headline"), "the composition has a headline");

  // The palette is the semantic role system, not three loose hexes.
  const roles = ensurePaletteRoles(palette);
  assert.ok(roles.ctaSurface && roles.ctaText && roles.surface && roles.border);
  assert.ok(contrastRatio(roles.textPrimary, roles.background) >= 4.5);
  assert.ok(contrastRatio(roles.textSecondary, roles.background) >= 4.5);
  assert.ok(contrastRatio(roles.ctaText, roles.ctaSurface) >= 4.5);
});

test("the same slot set renders differently for a different composition request", () => {
  const hero = getTemplate("hero-split");
  assert.ok(hero, "hero-split exists");
  const left = instantiateTemplate(hero, { variant: "hero-left" }, CANVAS);
  const right = instantiateTemplate(hero, { variant: "hero-right" }, CANVAS);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  const art = (built) => built.components.find((c) => c.kind === "image");
  assert.ok(art(left) && art(right), "both variants keep artwork");
  assert.ok(
    art(left).box.x < art(right).box.x,
    `artwork moves side (${art(left).box.x} vs ${art(right).box.x})`,
  );

  // Header/logo side is a tuning decision over an existing slot, not a new
  // template: the same slot can be aligned to the opposite edge.
  const mirrored = instantiateTemplate(
    hero,
    { variant: "hero-right", align: [{ id: "header-branding", value: "right" }] },
    CANVAS,
  );
  assert.equal(mirrored.ok, true);
  const header = mirrored.components.find((c) => c.id === "header-branding");
  assert.equal(header.align, "right", "the header follows the tuned alignment");
});

test("palette roles reach the rendered elements before correction", () => {
  const { palette, components, design } = runPipeline(SPARSE_PRODUCT_ANNOUNCEMENT);
  const roles = ensurePaletteRoles(palette);
  const allowed = new Set(Object.values(roles));

  // The role assignment is deterministic and applies to model output too: a
  // chromatic fill that is not a palette role is repainted with its role.
  const forged = [
    { id: "x", type: "text", role: "headline", content: "Title", fill: "#FF0000", x: 0, y: 0, width: 400, fontSize: 40 },
    { id: "y", type: "text", role: "tagline", content: "Sub", fill: "#00FF00", x: 0, y: 60, width: 400, fontSize: 18 },
  ];
  const painted = applyRoleFills(forged, "headline", palette);
  assert.equal(painted[0].fill, roles.textPrimary);
  assert.equal(painted[1].fill, roles.textSecondary);
  assert.equal(roles[textRoleFor("headline")], roles.textPrimary);

  // The materialised worst-case design already uses roles only.
  const textFills = design.elements.filter((e) => e.type === "text").map((e) => e.fill.toUpperCase());
  for (const fill of textFills) assert.ok(allowed.has(fill), `${fill} is a palette role`);

  // …so L5 has nothing to re-ink: its notes are advisory, not corrections.
  const corrected = correctColors(design, palette);
  const reInks = corrected.ops.filter((op) => op.props && op.props.fill);
  assert.equal(reInks.length, 0, `L5 should not need to repair role-coloured copy (${JSON.stringify(corrected.notes)})`);
  assert.ok(components.length > 0);
});

test("L5 remains a safety net: an invisible headline and a rogue shape are repaired", () => {
  const palette = lookupPalette(SPARSE_PRODUCT_ANNOUNCEMENT);
  const roles = ensurePaletteRoles(palette);
  const design = {
    canvas: { width: 800, height: 600, background: palette.background },
    elements: [
      { id: "invisible", type: "text", role: "headline", content: "Ship faster", x: 60, y: 80, width: 500, fontSize: 48, fill: palette.background },
      { id: "rogue", type: "rectangle", x: 60, y: 300, width: 300, height: 80, fill: "#FF00FF" },
      { id: "cta", type: "text", role: "cta", content: "Start free", x: 80, y: 320, width: 240, fontSize: 24, fill: roles.ctaText },
    ],
  };
  const { ops } = correctColors(design, palette);
  const byId = new Map(ops.map((op) => [op.id, op.props]));
  const roleSet = new Set(Object.values(roles).map((c) => c.toUpperCase()));
  const headlineFill = byId.get("invisible")?.fill;
  assert.ok(headlineFill, "the invisible headline is re-inked");
  assert.ok(roleSet.has(headlineFill.toUpperCase()), `${headlineFill} is a palette role`);
  assert.ok(contrastRatio(headlineFill, palette.background) >= 4.5, "and it is readable");
  const shapeFill = byId.get("rogue")?.fill;
  assert.ok(shapeFill, "the rogue shape is snapped");
  assert.ok(roleSet.has(shapeFill.toUpperCase()), `${shapeFill} is a palette role`);
  assert.equal(byId.has("cta"), false, "correctly role-painted CTA text is left alone");
});

test("content is fitted into the slot it was generated for", () => {
  const { components } = runPipeline(SPARSE_PRODUCT_ANNOUNCEMENT);
  const slot = components.find((c) => c.kind !== "image" && c.role !== "decoration");
  const spilled = [
    { id: `${slot.id}-text`, type: "text", role: slot.role, content: "Oversized copy", x: 0, y: 0, width: slot.box.width * 3, fontSize: Math.round(slot.fontSize * 3), fill: "#FFFFFF" },
  ];
  const { elements } = fitRegion(spilled, slot);
  const box = elementBoxes(elements)[0].box;
  assert.ok(box.x >= slot.box.x - 1 && box.y >= slot.box.y - 1, `starts inside ${slot.id}`);
  assert.ok(box.x + box.w <= slot.box.x + slot.box.width + 1, `ends inside ${slot.id}`);
  assert.ok(elements[0].fontSize <= Math.round(slot.fontSize * 1.35), "type is capped to the slot's size");
});
