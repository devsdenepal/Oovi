/**
 * Decoration system contract.
 *
 * Gemma chooses a compact spec from a closed vocabulary; the layout layer
 * expands it into ordinary, editable DSL primitives. These tests protect the
 * two halves of that bargain: every advertised kind/variant must produce a
 * valid bounded layer, and the prompt/schema must offer exactly that
 * vocabulary.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DECORATION_KINDS,
  DECORATION_KIND_IDS,
  DECORATION_SPEC_SCHEMA,
  DECORATION_VOCABULARY,
  MAX_DECORATION_PIECES,
  buildDecorations,
  defaultDecorationSpecs,
  normalizeDecorationSpec,
  normalizeDecorationSpecs,
  recommendDecorationSpecs,
} from "../src/layout/decorations";
import { elementBoxes } from "../src/ai/quality";
import { validateDesign } from "../src/design/designValidator";
import { derivePaletteRoles } from "../src/layout/paletteRoles";
import { buildComponentPrompt } from "../src/ai/architectPrompt";
import { getTemplate } from "../src/layout/templates";
import { sampleDesignForTemplate } from "../src/layout/templateSample";

const PALETTE = {
  background: "#0A1020",
  ink: "#E8F0FF",
  accent: "#3D7BFF",
  roles: derivePaletteRoles({ background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF" }),
};
const CANVAS = { width: 1200, height: 630 };
const BOXES = [
  { x: 40, y: 500, width: 1120, height: 120 },
  { x: 40, y: 40, width: 320, height: 320 },
  { x: 40, y: 40, width: 180, height: 360 },
  { x: 40, y: 40, width: 200, height: 24 },
];

function assertInside(elements, box, label) {
  for (const item of elementBoxes(elements)) {
    assert.ok(item.box.x >= box.x - 2, `${label}/${item.id}: left ${item.box.x} < ${box.x}`);
    assert.ok(item.box.y >= box.y - 2, `${label}/${item.id}: top ${item.box.y} < ${box.y}`);
    assert.ok(
      item.box.x + item.box.w <= box.x + box.width + 2,
      `${label}/${item.id}: right ${item.box.x + item.box.w} > ${box.x + box.width}`,
    );
    assert.ok(
      item.box.y + item.box.h <= box.y + box.height + 2,
      `${label}/${item.id}: bottom ${item.box.y + item.box.h} > ${box.y + box.height}`,
    );
  }
}

test("every advertised decoration kind and variant builds a valid bounded layer", () => {
  assert.equal(DECORATION_KIND_IDS.length, 13, "the vocabulary is complete");
  for (const definition of DECORATION_KINDS) {
    assert.ok(definition.label && definition.summary, `${definition.id}: documented`);
    assert.ok(definition.variants.length >= 1, `${definition.id}: has variants`);
    for (const variant of definition.variants) {
      const spec = normalizeDecorationSpec({
        kind: definition.id,
        variant,
        density: "dense",
        color: "accent",
      });
      assert.ok(spec, `${definition.id}/${variant}: spec normalises`);
      for (const box of BOXES) {
        const elements = buildDecorations([spec], box, PALETTE, { prefix: "deco" });
        const label = `${definition.id}/${variant} ${box.width}x${box.height}`;
        assert.ok(elements.length > 0, `${label}: produces shapes`);
        assert.ok(elements.length <= MAX_DECORATION_PIECES, `${label}: stays inside the piece budget`);
        assert.equal(new Set(elements.map((item) => item.id)).size, elements.length, `${label}: ids are unique`);
        for (const item of elements) assert.equal(item.role, "decoration", `${label}: ${item.id} is decoration`);
        const check = validateDesign({ canvas: CANVAS, elements });
        assert.equal(check.ok, true, `${label}: ${check.ok ? "" : check.errors.slice(0, 3).join("; ")}`);
        assertInside(elements, box, label);
      }
    }
  }
});

test("decoration expansion is deterministic and palette-bound", () => {
  const spec = [
    { kind: "stars", variant: "scatter", density: "normal", color: "accent" },
    { kind: "corner-brackets", variant: "corners", density: "normal", color: "secondary" },
  ];
  const a = buildDecorations(spec, BOXES[1], PALETTE, { prefix: "same" });
  const b = buildDecorations(spec, BOXES[1], PALETTE, { prefix: "same" });
  assert.deepEqual(a, b, "same spec -> same primitives");
  assert.ok(a.length <= MAX_DECORATION_PIECES, "combined specs respect the total budget");
  const fills = new Set(a.map((item) => item.fill || item.stroke).filter(Boolean));
  const roles = new Set(Object.values(PALETTE.roles));
  for (const fill of fills) assert.ok(roles.has(fill), `paint "${fill}" comes from the palette`);
  assert.ok(a.some((item) => item.id.includes("stars")), "star family is visible in ids");
  assert.ok(a.some((item) => item.id.includes("corner-brackets")), "bracket family is visible in ids");
});

test("star sparkles are closed four-point shapes, not bare plus ticks", () => {
  const elements = buildDecorations(
    [{ kind: "stars", variant: "scatter", density: "normal", color: "accent" }],
    BOXES[1],
    PALETTE,
    { prefix: "stars" },
  );
  const sparkles = elements.filter((item) => item.id.includes("-spark-"));
  assert.ok(sparkles.length >= 8, "at least one full star is emitted");
  assert.equal(sparkles.length % 8, 0, "each star is eight connected segments");
  assert.ok(
    sparkles.some((item) => item.x2 < item.x || item.y2 < item.y),
    "the shape exercises left/up segments that the line renderer must keep",
  );
});

test("incomplete or aliased specs are repaired, unknown kinds are refused", () => {
  assert.deepEqual(normalizeDecorationSpec({ kind: "corner brackets" }), {
    kind: "corner-brackets",
    variant: "corners",
    density: "normal",
    color: "accent",
  });
  assert.equal(normalizeDecorationSpec({ kind: "sparkle" }).kind, "stars");
  assert.equal(normalizeDecorationSpec({ kind: "background pattern", density: "loud", color: "hot pink" }).density, "normal");
  assert.equal(normalizeDecorationSpec({ kind: "not-a-real-shape" }), null);
  assert.deepEqual(normalizeDecorationSpecs("small icons").map((item) => item.kind), ["icons"]);
  assert.equal(normalizeDecorationSpecs([{ kind: "dots" }, { kind: "stars" }, { kind: "arcs" }]).length, 2, "at most two families");
});

test("defaults infer a sensible family from the region description", () => {
  const cases = [
    ["decoration-accent", "theme shapes and accents scattered along the bottom edge", "dots"],
    ["decoration-stars", "festive star sparkles", "stars"],
    ["decoration-corner", "crop corner brackets", "corner-brackets"],
    ["decoration-grid", "background dot grid texture", "background-patterns"],
    ["decoration-ribbon", "ribbon banner", "ribbons"],
    ["decoration-icons", "small icon accents", "icons"],
  ];
  for (const [id, describe, expected] of cases) {
    assert.equal(defaultDecorationSpecs({ id, describe, box: { width: 200, height: 40 } })[0].kind, expected, `${id} -> ${expected}`);
  }
});

test("art direction recommends a theme-grounded family instead of always dots", () => {
  const festive = recommendDecorationSpecs({
    component: { id: "decoration-accent", describe: "theme shapes along the bottom edge", box: { width: 1000, height: 240 } },
    plan: { style: "warm festive editorial" },
    goal: { summary: "a Diwali greeting for clients", subject: "Diwali", tone: "celebratory" },
    rawPrompt: "marigold, diya glow, rangoli",
  });
  assert.deepEqual(festive.map((item) => item.kind), ["stars", "icons"]);
  assert.equal(festive[1].variant, "flower");

  const divider = recommendDecorationSpecs({
    component: { id: "footer-rule", describe: "Fine divider separating announcement and footer", box: { width: 952, height: 8 } },
    plan: { style: "corporate, clean" },
  });
  assert.deepEqual(divider.map((item) => item.kind), ["dividers"]);

  const tech = recommendDecorationSpecs({
    component: { id: "decoration-accent", describe: "theme shapes along the bottom edge", box: { width: 1000, height: 240 } },
    plan: { style: "futurist pixel-art launch" },
  });
  assert.deepEqual(tech.map((item) => item.kind), ["grids", "arcs"]);
});

test("the L4 decoration prompt and schema offer the full vocabulary", () => {
  assert.equal(DECORATION_SPEC_SCHEMA.properties.kind.enum.length, DECORATION_KIND_IDS.length, "schema enum is complete");
  for (const definition of DECORATION_KINDS) {
    assert.ok(DECORATION_VOCABULARY.includes(definition.id), `${definition.id} is in the prompt vocabulary`);
    for (const variant of definition.variants) {
      assert.ok(DECORATION_VOCABULARY.includes(variant), `${definition.id}/${variant} is in the prompt vocabulary`);
    }
  }
  const component = {
    id: "decoration-accent",
    role: "decoration",
    kind: "dsl",
    describe: "theme shapes along the bottom edge",
    box: { x: 40, y: 500, width: 1120, height: 100 },
  };
  const prompt = buildComponentPrompt(
    component,
    CANVAS,
    { palette: PALETTE, style: "festive modern", components: [component] },
  );
  assert.match(prompt, /Decoration vocabulary/);
  assert.match(prompt, /"decorations"/);
  assert.match(prompt, /"kind":"stars"/);
  assert.match(prompt, /"kind":"icons"/);
  assert.match(prompt, /Never add text/);
  for (const definition of DECORATION_KINDS) assert.ok(prompt.includes(definition.id), `${definition.id} reaches L4`);

  const textPrompt = buildComponentPrompt(
    { ...component, id: "headline-main", role: "headline", describe: "the title" },
    CANVAS,
    { palette: PALETTE, style: "festive modern", components: [] },
  );
  assert.ok(!textPrompt.includes("Decoration vocabulary"), "text regions do not pay for the decoration vocabulary");
});

test("template samples use the vocabulary instead of a single placeholder slab", () => {
  const template = getTemplate("hero-split");
  const sample = sampleDesignForTemplate(template, CANVAS, PALETTE);
  assert.ok(sample.ok, sample.reason);
  const decorations = sample.design.elements.filter((element) => element.role === "decoration");
  assert.ok(decorations.length > 1, "the decoration region expands into multiple marks");
  assert.ok(
    decorations.some((element) => element.id.includes("stars")),
    "the sample follows the template's festive art direction instead of one universal bar",
  );
  assert.ok(decorations.every((element) => element.type !== "text"), "no copy leaks into the decoration layer");
  assert.equal(new Set(sample.design.elements.map((element) => element.id)).size, sample.design.elements.length);
  const check = validateDesign(sample.design);
  assert.equal(check.ok, true, check.ok ? "" : check.errors.slice(0, 3).join("; "));
});
