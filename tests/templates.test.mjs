/**
 * Template conformance: the node test the Phase 2 design asked for.
 *
 * Every template × every variant × every platform preset is instantiated,
 * materialised into a real pixel design, and run through the SAME quality gate
 * the app uses (src/ai/quality.js). A template that can collide, overflow or
 * fade fails here rather than in the browser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TEMPLATES,
  TEMPLATE_IDS,
  allTemplateVariants,
  instantiateTemplate,
  sanitizeTuning,
  sizeClassOf,
  templateSlots,
  templateExample,
} from "../src/layout/templates";
import { retrieveTemplates, templatePool, DEFAULT_COVERAGE_THRESHOLD } from "../src/layout/retrieve";
import { templateFromDesign, templateFromRecord, templateToRecord, validateTemplate } from "../src/layout/saveAsTemplate";
import { elementBoxes, evaluateDesign } from "../src/ai/quality";
import { salvageElements } from "../src/ai/aiClient";
import { fitElementsToBox, fitRegion } from "../src/layout/regionFit";
import { DESIGN_PRESETS } from "../src/design/presets";

const SAMPLE_PALETTES = [
  { background: "#0B0A1F", ink: "#EAFDFF", accent: "#FF2E88" }, // dark
  { background: "#FFFFFF", ink: "#111111", accent: "#E02020" }, // light
];

/** Renders an instantiated plan into the pixel design the gate consumes. */
function materialize(components, canvas, palette) {
  const elements = [];
  for (const c of components) {
    const box = c.box;
    if (c.kind === "image") {
      elements.push({
        id: `${c.id}-img`,
        type: "image",
        role: c.role,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
      continue;
    }
    if (c.role === "decoration") {
      // L4 scatters small shapes inside a decoration reservation, not a slab.
      const dots = 8;
      const radius = Math.max(3, Math.floor(box.height / 4));
      for (let i = 0; i < dots; i++) {
        const cx = box.x + ((i + 0.5) / dots) * box.width;
        elements.push({
          id: `${c.id}-dot-${i}`,
          type: "circle",
          role: "decoration",
          x: Math.round(cx - radius),
          y: Math.round(box.y + box.height / 2 - radius),
          radius,
          fill: palette.accent,
        });
      }
      continue;
    }
    // Text that exactly fills its slot: as many whole lines as the box holds.
    const fontSize = c.fontSize || 24;
    const perLine = Math.max(2, Math.floor(box.width / (fontSize * 0.55)));
    const lines = Math.max(1, Math.floor(box.height / (fontSize * 1.2)));
    const cap = c.maxChars > 0 ? Math.min(c.maxChars, perLine * lines) : perLine * lines;
    const length = Math.max(2, cap);
    elements.push({
      id: `${c.id}-text`,
      type: "text",
      role: c.role,
      content: "Aa".repeat(Math.ceil(length / 2)).slice(0, length),
      x: box.x,
      y: box.y,
      width: box.width,
      fontSize,
      fontWeight: 600,
      lineHeight: 1.2,
      fill: palette.ink,
    });
  }
  return { canvas: { ...canvas, background: palette.background }, elements };
}

function overlaps(a, b) {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0;
}

test("every template is well formed", () => {
  assert.ok(TEMPLATES.length >= 28 && TEMPLATES.length <= 34, `${TEMPLATES.length} templates in the library`);
  assert.equal(new Set(TEMPLATE_IDS).size, TEMPLATE_IDS.length, "template ids are unique");
  for (const t of TEMPLATES) {
    assert.ok(t.variants.length >= 2 && t.variants.length <= 3, `${t.id}: 2-3 variants`);
    assert.ok(t.sizes.length > 0, `${t.id}: declares at least one size class`);
    assert.ok(t.keywords.length > 0, `${t.id}: has keywords for the pre-filter`);
    for (const variant of t.variants) {
      const slots = t.build(variant.id, 0.025);
      const ids = slots.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, `${t.id}/${variant.id}: slot ids unique`);
      assert.ok(slots.some((s) => s.role === "headline"), `${t.id}/${variant.id}: has a headline`);
      for (const s of slots) {
        assert.ok(s.box.x >= 0 && s.box.y >= 0, `${t.id}/${variant.id}/${s.id}: in canvas`);
        assert.ok(s.box.x + s.box.w <= 1.0000001, `${t.id}/${variant.id}/${s.id}: width fits`);
        assert.ok(s.box.y + s.box.h <= 1.0000001, `${t.id}/${variant.id}/${s.id}: height fits`);
      }
    }
  }
});

test("every template carries retrieval metadata", () => {
  for (const t of TEMPLATES) {
    assert.ok(t.type && typeof t.type === "string", `${t.id}: has a type`);
    assert.ok(Array.isArray(t.mood) && t.mood.length > 0, `${t.id}: has moods`);
    assert.ok(["airy", "normal", "dense"].includes(t.density), `${t.id}: density is a known value`);
    assert.ok(Array.isArray(t.tags) && t.tags.length >= 2, `${t.id}: has tags`);
    assert.ok((t.description || "").length >= 60, `${t.id}: has a searchable description`);
  }
});

test("every text slot has example copy that fits its own limit", () => {
  for (const t of TEMPLATES) {
    for (const slot of templateSlots(t)) {
      if (slot.kind === "image" || slot.role === "decoration" || !(slot.maxChars > 0)) continue;
      const examples = t.examples?.[slot.id];
      assert.ok(Array.isArray(examples) && examples.length >= 2, `${t.id}/${slot.id}: at least two examples`);
      for (const example of examples) {
        assert.equal(typeof example, "string", `${t.id}/${slot.id}: example is a string`);
        assert.ok(example.trim().length > 0, `${t.id}/${slot.id}: example is not empty`);
        assert.ok(
          example.length <= slot.maxChars,
          `${t.id}/${slot.id}: example is ${example.length} chars, limit is ${slot.maxChars} — "${example}"`,
        );
      }
    }
  }
});

test("the example picker is deterministic and brief-aware", () => {
  const a = templateExample("hero-split", "headline-main", { summary: "diwali celebration" });
  const b = templateExample("hero-split", "headline-main", { summary: "diwali celebration" });
  assert.equal(a, b, "same brief, same example");
  assert.equal(templateExample("hero-split", "not-a-slot", {}), "", "unknown slot yields nothing");
  assert.equal(templateExample("no-such-template", "headline-main", {}), "", "unknown template yields nothing");
});

test("decoration never overlaps a content slot (so it can never be a text bed)", () => {
  for (const t of TEMPLATES) {
    for (const variant of t.variants) {
      const slots = t.build(variant.id, 0.025);
      const decor = slots.filter((s) => s.role === "decoration");
      const content = slots.filter((s) => s.role !== "decoration");
      for (const d of decor) {
        for (const c of content) {
          assert.ok(
            !overlaps(
              { x: d.box.x, y: d.box.y, width: d.box.w, height: d.box.h },
              { x: c.box.x, y: c.box.y, width: c.box.w, height: c.box.h },
            ),
            `${t.id}/${variant.id}: ${d.id} overlaps ${c.id}`,
          );
        }
      }
    }
  }
});

test("every template/variant/preset instantiates collision-free", () => {
  for (const preset of DESIGN_PRESETS) {
    const canvas = { width: preset.width, height: preset.height };
    const size = sizeClassOf(canvas);
    for (const { template, variant } of allTemplateVariants()) {
      if (!template.sizes.includes(size)) continue;
      const built = instantiateTemplate(template, { variant: variant.id }, canvas);
      assert.equal(built.ok, true, `${template.id}/${variant.id} @${preset.id}: ${built.reason || "ok"}`);
      const boxes = built.components.map((c) => c.box);
      for (const box of boxes) {
        assert.ok(box.x >= 0 && box.y >= 0, `${template.id}@${preset.id}: box inside canvas`);
        assert.ok(box.x + box.width <= canvas.width, `${template.id}@${preset.id}: box width inside`);
        assert.ok(box.y + box.height <= canvas.height, `${template.id}@${preset.id}: box height inside`);
        assert.ok(box.width > 0 && box.height > 0, `${template.id}@${preset.id}: box has area`);
      }
      const content = built.components.filter((c) => c.role !== "decoration");
      for (let i = 0; i < content.length; i++) {
        for (let j = i + 1; j < content.length; j++) {
          assert.ok(
            !overlaps(content[i].box, content[j].box),
            `${template.id}/${variant.id}@${preset.id}: ${content[i].id} overlaps ${content[j].id}`,
          );
        }
      }
    }
  }
});

test("every template/variant/preset passes the real quality gate", () => {
  for (const palette of SAMPLE_PALETTES) {
    for (const preset of DESIGN_PRESETS) {
      const canvas = { width: preset.width, height: preset.height };
      const size = sizeClassOf(canvas);
      for (const { template, variant } of allTemplateVariants()) {
        if (!template.sizes.includes(size)) continue;
        const built = instantiateTemplate(template, { variant: variant.id }, canvas);
        assert.equal(built.ok, true);
        const design = materialize(built.components, canvas, palette);
        const report = evaluateDesign(design, {
          palette,
          expectHero: built.components.some((c) => c.kind === "image"),
        });
        const errors = report.issues.filter((i) => i.severity === "error");
        assert.deepEqual(
          errors,
          [],
          `${template.id}/${variant.id} @${preset.id}: ${errors.map((e) => `${e.code}: ${e.message}`).join(" | ")}`,
        );
      }
    }
  }
});

test("tuning stays inside the bounded vocabulary", () => {
  const template = TEMPLATES.find((t) => t.id === "hero-split");
  const sanitized = sanitizeTuning(
    {
      variant: "hero-left",
      density: "airy",
      hide: ["header-branding", "headline-main", "not-a-slot"],
      scale: [{ id: "headline-main", factor: 9 }, { id: "ghost", factor: 1.2 }],
      align: [{ id: "headline-main", value: "bogus" }, { id: "tagline-line", value: "right" }],
      box: { x: 0, y: 0, width: 1, height: 1 },
    },
    template,
  );
  assert.equal(sanitized.variant, "hero-left");
  assert.equal(sanitized.density, "airy");
  // header-branding is optional (hideable); headline-main is not.
  assert.deepEqual(sanitized.hide, ["header-branding"]);
  // scale is clamped and unknown ids dropped.
  assert.equal(sanitized.scale["headline-main"], 1.25);
  assert.equal(sanitized.scale.ghost, undefined);
  // invalid alignment dropped, valid one kept.
  assert.equal(sanitized.align["headline-main"], undefined);
  assert.equal(sanitized.align["tagline-line"], "right");
  // boxes are never read from the model.
  assert.equal(sanitized.box, undefined);
});

test("tuning cannot break collision-freedom", () => {
  const canvas = { width: 1200, height: 630 };
  const heavy = {
    density: "tight",
    scale: [
      { id: "hero-visual", factor: 1.25 },
      { id: "headline-main", factor: 1.25 },
      { id: "details-info", factor: 1.25 },
    ],
  };
  for (const { template, variant } of allTemplateVariants()) {
    if (!template.sizes.includes(sizeClassOf(canvas))) continue;
    const built = instantiateTemplate(template, { ...heavy, variant: variant.id }, canvas);
    assert.equal(built.ok, true, `${template.id}/${variant.id}: ${built.reason || "ok"}`);
    const content = built.components.filter((c) => c.role !== "decoration");
    for (let i = 0; i < content.length; i++) {
      for (let j = i + 1; j < content.length; j++) {
        assert.ok(!overlaps(content[i].box, content[j].box), `${template.id}/${variant.id}: collision after tuning`);
      }
    }
  }
});

test("retrieval is deterministic, shape-aware and never invents a template", () => {
  const wide = { width: 1200, height: 630 };
  const tall = { width: 1080, height: 1920 };
  const brief = { summary: "a hackathon launch event", style: "modern tech", tone: "energetic" };
  const a = retrieveTemplates(brief, wide, { limit: 3 });
  const b = retrieveTemplates(brief, wide, { limit: 3 });
  assert.deepEqual(a.candidates, b.candidates, "same brief + canvas gives the same shortlist");
  assert.ok(a.candidates.length > 0 && a.candidates.length <= 3, "shortlist is non-empty and capped at 3");
  assert.ok(a.candidates.includes("hero-split"), `a hackathon launch reaches hero-split (got ${a.candidates})`);
  for (const id of a.candidates) {
    const t = TEMPLATES.find((x) => x.id === id);
    assert.ok(t.sizes.includes("wide"), `${id} suits a wide canvas`);
  }
  // A canvas a template does not declare must never be offered for it.
  for (const id of retrieveTemplates({ summary: "a banner for a website", style: "clean" }, wide).candidates) {
    assert.ok(TEMPLATES.find((x) => x.id === id).sizes.includes("wide"));
  }
  for (const id of retrieveTemplates({ summary: "a story about a journey", style: "warm" }, tall).candidates) {
    assert.ok(TEMPLATES.find((x) => x.id === id).sizes.includes("tall"), `${id} suits a tall canvas`);
  }
});

test("retrieval abstains instead of guessing at an unmatchable brief", () => {
  const canvas = { width: 1080, height: 1080 };
  // A brief whose vocabulary appears nowhere in the corpus, and one in another
  // script: both must abstain so the caller falls back to the free-form L3.
  const niche = retrieveTemplates({ summary: "xyzzy plugh frobnicate quux", tone: "zzz" }, canvas);
  assert.equal(niche.source, "none", "an unmatchable brief abstains");
  assert.deepEqual(niche.candidates, [], "…and offers no candidates");
  const other = retrieveTemplates({ summary: "कर्मचारियों के लिए दीवाली पोस्टर" }, canvas);
  assert.equal(other.source, "none", "a non-Latin brief abstains");
  // A normal brief does not.
  const good = retrieveTemplates({ summary: "a team offsite announcement for the office" }, canvas);
  assert.equal(good.source, "retrieval");
  assert.ok(good.coverage >= DEFAULT_COVERAGE_THRESHOLD);
});


test("unknown templates and bad canvases are refused, not guessed", () => {
  assert.equal(instantiateTemplate("no-such-template", {}, { width: 1200, height: 630 }).ok, false);
  assert.equal(instantiateTemplate("hero-split", {}, { width: 0, height: 0 }).ok, false);
});

test("a finished design saves as a template and survives the round trip", () => {
  // Step 5 of the Phase 3 design: any layout the user ends up with can become a
  // reusable template. The conversion must read the RENDERED design and the
  // result must clear the same gate every hand-written template clears, or be
  // refused with a reason.
  const canvas = { width: 1080, height: 1080 };
  const palette = SAMPLE_PALETTES[1];
  const built = instantiateTemplate("hero-split", { density: "normal" }, canvas);
  assert.equal(built.ok, true);
  const design = materialize(built.components, canvas, palette);

  const saved = templateFromDesign(design, { label: "Office offsite recap", keywords: ["offsite", "recap"] });
  assert.equal(saved.ok, true, saved.reason);
  const template = saved.template;
  assert.ok(template.saved, "a saved template is marked as such");
  assert.deepEqual(template.sizes, [sizeClassOf(canvas)], "it competes only on canvases it was saved from");
  assert.ok(template.build("as-saved", 0.025).length >= 3, "it keeps its regions");
  for (const slot of template.build("as-saved", 0.025)) {
    assert.ok(slot.box.w > 0 && slot.box.h > 0 && slot.box.x >= 0 && slot.box.y >= 0, `${slot.id} has a real box`);
    assert.ok(slot.box.x + slot.box.w <= 1.001 && slot.box.y + slot.box.h <= 1.001, `${slot.id} stays on the canvas`);
  }

  // Storage is plain data: the record must rehydrate into a template that still
  // instantiates and still passes the gate.
  const rehydrated = templateFromRecord(JSON.parse(JSON.stringify(templateToRecord(template))));
  assert.ok(rehydrated, "the record rehydrates");
  assert.equal(rehydrated.id, template.id);
  const recheck = validateTemplate(rehydrated, canvas, palette);
  assert.equal(recheck.ok, true, recheck.reason);

  // …and it joins the library: retrieval sees it as a candidate for its own shape.
  const pooled = templatePool(canvas, null, [rehydrated]).pool.map((t) => t.id);
  assert.ok(pooled.includes(template.id), "a saved template is in the pool for its own canvas");
  const found = retrieveTemplates({ summary: "office offsite recap", keywords: ["offsite"] }, canvas, { extra: [rehydrated] });
  assert.ok(found.candidates.length <= 3, "the shortlist stays capped");

  // A two-region design is not a layout.
  const thin = templateFromDesign({ canvas, elements: design.elements.slice(0, 1) });
  assert.equal(thin.ok, false);
});

test("retrieval reads a real L1 goal, not a hand-made brief", () => {
  // The bug this pins: `retrieveTemplates` used to cover the prompt's whole
  // brief text, `mustInclude` included. A real goal carries content
  // requirements no layout vocabulary can describe ("Event details (Date, Time,
  // Venue TBA)"), so every score was diluted and the Diwali brief — 51 % in the
  // benchmark — abstained at 16 % in the app. Retrieval never fired in
  // production while the benchmark looked healthy.
  const goal = {
    summary: "Vibrant, festive Diwali announcement poster",
    subject: "Diwali poster for office announcement",
    purpose: "announce the office Diwali celebration",
    audience: "colleagues and guests",
    tone: ["festive", "warm"],
    style: "clean modern",
    mustInclude: ["Main Diwali greeting", "Event details (Date, Time, Venue TBA)", "Key celebration highlights", "Office closing/wish"],
  };
  const canvas = { width: 1200, height: 630 };
  const found = retrieveTemplates(goal, canvas);
  assert.equal(found.source, "retrieval", "a real goal retrieves rather than abstaining");
  assert.ok(found.candidates.length > 0 && found.candidates.length <= 3);
  assert.ok(found.coverage >= DEFAULT_COVERAGE_THRESHOLD, `coverage ${found.coverage}`);

  // Content requirements must not change the ranking: they describe copy, not
  // the layout.
  const withMore = retrieveTemplates({ ...goal, mustInclude: [...goal.mustInclude, "Sponsor logos", "QR code to rsvp"] }, canvas);
  assert.deepEqual(withMore.candidates, found.candidates, "mustInclude does not steer layout choice");
});

test("a region that renders outside its reserved box is fitted back into it", () => {
  // Live numbers from the Diwali poster: the plan reserved 1072x144 at (64,232)
  // for a 20px tagline, and the model returned 120px type whose rendered extent
  // was ~4x the reservation (and, for the headline region, outside the canvas).
  const tagline = { id: "tagline-line", role: "tagline", box: { x: 64, y: 232, width: 1072, height: 144 }, fontSize: 20 };
  const spilled = [
    { id: "tagline-text", type: "text", role: "tagline", x: 64, y: 232, width: 1064, fontSize: 120, content: "Celebrate the Festival of Lights together!" },
  ];
  const before = elementBoxes(spilled)[0].box;
  assert.ok(before.h > tagline.box.height + 2, "the fixture really does overflow");

  const { elements: fitted, notes } = fitRegion(spilled, tagline);
  const after = elementBoxes(fitted)[0].box;
  assert.ok(fitted[0].fontSize <= Math.round(20 * 1.15), `type capped (got ${fitted[0].fontSize})`);
  assert.ok(after.y >= tagline.box.y - 2 && after.y + after.h <= tagline.box.y + tagline.box.height + 2, "renders inside the reserved box");
  assert.ok(after.x >= tagline.box.x - 2 && after.x + after.w <= tagline.box.x + tagline.box.width + 2, "and inside it horizontally");
  assert.ok(notes.length > 0, "a correction is never silent");

  // A region that already fits is returned untouched — same array, no work.
  const fine = [{ id: "a", type: "text", role: "tagline", x: 64, y: 240, width: 1064, fontSize: 20, content: "Happy Diwali" }];
  assert.equal(fitRegion(fine, tagline).elements, fine, "no correction when nothing overflows");

  // Geometric overflow that is not a type problem: a 2000px-wide bar in a
  // 1072px box is scaled, and the composition keeps its proportions.
  const wide = [{ id: "bar", type: "rectangle", role: "details", x: 64, y: 400, width: 2000, height: 100 }];
  const scaled = fitRegion(wide, { id: "details", box: { x: 64, y: 392, width: 1072, height: 120 }, fontSize: 0 }).elements;
  const scaledBox = elementBoxes(scaled)[0].box;
  assert.ok(scaledBox.w <= 1072 + 4 && scaledBox.h <= 120 + 4, "scaled inside the box");
  assert.ok(Math.abs(scaledBox.w / scaledBox.h - 20) < 0.2, "aspect preserved");

  // Never enlarges: a small region in a big box is left alone (under-fill is
  // the gate's business, not the fitter's).
  const small = [{ id: "s", type: "rectangle", role: "details", x: 100, y: 400, width: 80, height: 40 }];
  assert.equal(fitRegion(small, { id: "d", box: { x: 64, y: 392, width: 1072, height: 120 }, fontSize: 0 }).elements, small);
});

test("a region with one bad element is salvaged, not thrown away", () => {
  // Live symptom: elements stream onto the canvas, then the region's whole set
  // fails validation, so they are retracted and the region is left empty —
  // which the gate then reads as `empty-section` and regenerates (~250s). If
  // only one piece is at fault, keep the rest.
  const canvas = { width: 1200, height: 630 };
  const text = (id, content) => ({
    id,
    type: "text",
    content,
    x: 64,
    y: 400,
    width: 300,
    fontSize: 20,
    fontWeight: 400,
    fill: "#111111",
  });
  const good = [text("d-when", "Friday, 7pm"), text("d-where", "Main hall")];
  // Genuinely invalid: the DSL has no such element type (the validator accepts
  // any finite position, so "off canvas" alone would still pass).
  const bad = { ...text("d-oops", "broken"), type: "blob" };
  const parsed = { elements: [...good, bad] };
  const kept = salvageElements(parsed, canvas);
  assert.equal(kept.length, 2, "the valid pieces survive");
  assert.ok(kept.every((e) => e.id !== "d-oops"), "the offender is dropped");
  assert.deepEqual(salvageElements({ elements: [] }, canvas), [], "nothing to salvage");
  assert.deepEqual(salvageElements(null, canvas), [], "a missing parse salvages nothing");
  assert.deepEqual(salvageElements({ elements: [null, "x", 7] }, canvas), [], "junk salvages nothing");
});

test("scope fields bias layout choice without filtering the pool", () => {
  const canvas = { width: 1200, height: 630 };
  const base = {
    summary: "a new analytics app",
    subject: "analytics app",
    purpose: "announce the launch",
    keywords: ["product", "launch", "analytics"],
  };
  const plain = retrieveTemplates(base, canvas);
  const scoped = retrieveTemplates({ ...base, designType: "product-launch", composition: "hero-right" }, canvas);
  assert.equal(plain.source, "retrieval");
  assert.equal(scoped.source, "retrieval", "scope never empties a retrievable pool");
  const top = scoped.scored[0];
  assert.ok(top.scope.type > 0, "the design type contributed a bias");
  assert.ok(top.scope.composition > 0, "the requested composition contributed a bias");
  assert.ok(top.coverage >= top.baseCoverage, "a bias can only raise effective coverage");
  assert.ok(top.scope.total <= 0.4, "the bias is bounded, not a hard filter");

  // A wrong scope can reorder templates, never rescue an unrelated brief.
  const nonsense = retrieveTemplates(
    { summary: "xyzzy plugh frobnicate quux", designType: "menu", composition: "grid" },
    canvas,
  );
  assert.equal(nonsense.source, "none", "scope does not manufacture a match");
});

test("a region that fits its slot but is drawn off it is translated into the slot", () => {
  const box = { x: 64, y: 64, width: 400, height: 100 };
  const elements = [
    { id: "t", type: "text", content: "A single line", x: 900, y: 400, width: 200, fontSize: 20, fill: "#111111" },
  ];
  const fitted = fitElementsToBox(elements, box);
  const b = elementBoxes(fitted)[0].box;
  assert.ok(b.x >= box.x - 1, `x ${b.x} >= ${box.x}`);
  assert.ok(b.y >= box.y - 1, `y ${b.y} >= ${box.y}`);
  assert.ok(b.x + b.w <= box.x + box.width + 1, `right edge ${b.x + b.w} <= ${box.x + box.width}`);
  assert.ok(b.y + b.h <= box.y + box.height + 1, `bottom edge ${b.y + b.h} <= ${box.y + box.height}`);
});
