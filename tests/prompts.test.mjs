/**
 * Prompt contract tests for the layered pipeline.
 *
 * Two rules are load-bearing on this hardware and are easy to break by
 * accident, so they are asserted here:
 *   1. L1-L4 all BEGIN with the byte-identical DESIGN_CORE prefix (that is the
 *      only reason Ollama's KV cache pays off across layers).
 *   2. The L3 template menu is byte-identical between the choice and tuning
 *      calls, and carries nothing variable.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DESIGN_CORE,
  GOAL_SCHEMA,
  buildGoalPrompt,
  buildPalettePrompt,
} from "../src/ai/layerPrompt";
import {
  TEMPLATE_RULES,
  buildTemplateChoicePrompt,
  buildTuningPrompt,
} from "../src/ai/templatePrompt";
import { buildComponentPrompt } from "../src/ai/architectPrompt";
import { buildPatchPrompt } from "../src/ai/patchPrompt";
import { getTemplate, TEMPLATE_IDS } from "../src/layout/templates";
import { derivePaletteRoles } from "../src/layout/paletteRoles";

const CANVAS = { width: 1200, height: 630 };
const GOAL = {
  summary: "a hackathon launch event",
  subject: "hackathon",
  brand: "DevFest",
  imageSubject: "developers building hardware at a crowded hackathon table",
  audience: "developers",
  purpose: "announce",
  tone: "energetic",
  mustInclude: ["event title and year", "date and venue"],
  avoid: ["invented names"],
  style: "modern tech",
};
const PALETTE = { background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF", style: "modern tech, crisp blue" };

test("L1 and L4 share the byte-identical static prefix", () => {
  const prompts = [
    buildGoalPrompt("a poster", CANVAS),
    buildComponentPrompt(
      { id: "headline-main", role: "headline", describe: "the title", box: { x: 0, y: 0, width: 500, height: 200 } },
      CANVAS,
      { palette: PALETTE, style: PALETTE.style, components: [] },
      GOAL,
    ),
  ];
  for (const prompt of prompts) {
    assert.ok(prompt.startsWith(`${DESIGN_CORE}\n\n`), "prompt begins with DESIGN_CORE verbatim");
  }
  assert.equal(DESIGN_CORE.length, prompts[1].slice(0, DESIGN_CORE.length).length, "no characters slip in");
});

test("L2 is deliberately short and shares no prefix", () => {
  const prompt = buildPalettePrompt(GOAL, CANVAS);
  assert.ok(!prompt.startsWith(DESIGN_CORE), "L2 must not pay for the shared prefix");
});

test("the L3 static rules are byte-identical across both calls and name no template", () => {
  for (const id of TEMPLATE_IDS) {
    assert.ok(!TEMPLATE_RULES.includes(id), `the static prefix must not name the template "${id}"`);
  }
  const choice = buildTemplateChoicePrompt(GOAL, PALETTE, CANVAS, ["hero-split", "feature-cta"]);
  const tuning = buildTuningPrompt(getTemplate("hero-split"), GOAL, PALETTE, CANVAS);
  assert.ok(choice.startsWith(TEMPLATE_RULES), "choice prompt starts with the rules");
  assert.ok(tuning.startsWith(TEMPLATE_RULES), "tuning prompt starts with the same rules");
  assert.equal(choice.slice(0, TEMPLATE_RULES.length), tuning.slice(0, TEMPLATE_RULES.length), "prefix identical");
});

test("variable data stays out of the static prefix", () => {
  const a = buildTemplateChoicePrompt(GOAL, PALETTE, { width: 1200, height: 630 }, ["hero-split"]);
  const b = buildTemplateChoicePrompt(GOAL, PALETTE, { width: 1080, height: 1920 }, ["story-stack"]);
  assert.equal(a.slice(0, TEMPLATE_RULES.length), b.slice(0, TEMPLATE_RULES.length), "canvas size is not in the prefix");
  assert.notEqual(a, b, "the tail does change");
});

test("the choice prompt shows only the retrieved shortlist, and shows it last", () => {
  const retrieved = ["menu-sheet", "card-grid", "neo-futurist-launch"];
  const prompt = buildTemplateChoicePrompt(GOAL, PALETTE, CANVAS, retrieved);
  for (const id of retrieved) assert.ok(prompt.includes(id), `${id} is offered`);
  for (const id of TEMPLATE_IDS) {
    if (retrieved.includes(id)) continue;
    assert.ok(!prompt.includes(`- ${id} (`), `${id} must not be offered`);
  }
  const candidatesAt = prompt.lastIndexOf("Candidates, best match first:");
  assert.ok(candidatesAt > prompt.indexOf("The brief:"), "the retrieved block comes after the brief");
  assert.ok(candidatesAt > prompt.lastIndexOf("Canvas:"), "…and after everything else variable");
  assert.ok(prompt.indexOf("- menu-sheet") > candidatesAt, "best match is listed first");
});

test("L4 receives the template's fixed box, type size and copy limit", () => {
  const component = {
    id: "headline-main",
    role: "headline",
    kind: "dsl",
    describe: "the main title and its year",
    box: { x: 64, y: 80, width: 640, height: 220 },
    fontSize: 54,
    maxChars: 40,
    align: "center",
  };
  const prompt = buildComponentPrompt(component, CANVAS, { palette: PALETTE, style: PALETTE.style, components: [component] }, GOAL);
  assert.match(prompt, /Reserved box: x=64 y=80 width=640 height=220/);
  assert.match(prompt, /54px/);
  assert.match(prompt, /at most 40 characters/);
  assert.match(prompt, /aligned center/);
  assert.match(prompt, /do not move or resize the region/, "the slot's box is authoritative");
  assert.match(prompt, /Colour for this region: textPrimary/, "the region is told its colour role");
});

test("L4 carries approved copy verbatim and tailors attribution regions", () => {
  const component = {
    id: "tagline-attribution",
    role: "tagline",
    kind: "dsl",
    describe: "who said it",
    box: { x: 64, y: 300, width: 600, height: 60 },
    fontSize: 22,
    maxChars: 40,
    copy: ["— Graphilla Technology"],
  };
  const prompt = buildComponentPrompt(
    component,
    CANVAS,
    { palette: PALETTE, style: PALETTE.style, components: [component] },
    GOAL,
  );
  assert.match(prompt, /Approved copy — use these exact lines/);
  assert.match(prompt, /1\. — Graphilla Technology/);
  assert.match(prompt, /Attribution: name the person or organisation/);
  assert.match(prompt, /Never an audience, language, date or keyword label/);
});

test("L4 forbids availability claims in a footer unless the brief says so", () => {
  const component = {
    id: "footer-registration",
    role: "footer",
    kind: "dsl",
    describe: "registration link, organizer or partner line",
    box: { x: 64, y: 520, width: 900, height: 60 },
    fontSize: 16,
    maxChars: 70,
    copy: ["Happy Diwali from Graphilla Technology"],
  };
  const prompt = buildComponentPrompt(
    component,
    CANVAS,
    { palette: PALETTE, style: PALETTE.style, components: [component] },
    GOAL,
  );
  assert.match(prompt, /Do not claim availability unless the brief says so/);
  assert.match(prompt, /Happy Diwali from Graphilla Technology/);
});

test("L4 hands the model the semantic palette roles, not just three hexes", () => {
  const component = {
    id: "cta-row",
    role: "cta",
    kind: "dsl",
    describe: "the registration call to action",
    box: { x: 64, y: 520, width: 500, height: 70 },
    fontSize: 24,
    align: "left",
  };
  const palette = { ...PALETTE, roles: derivePaletteRoles(PALETTE) };
  const prompt = buildComponentPrompt(component, CANVAS, { palette, style: palette.style, components: [component] }, GOAL);
  assert.match(prompt, /Palette roles —/);
  for (const role of ["surface", "secondary text", "CTA surface", "CTA text", "border"]) {
    assert.match(prompt, new RegExp(`${role} #`), `${role} reaches L4`);
  }
  assert.match(prompt, /Colour for this region: ctaText \(#0A1020\) on a ctaSurface block/);
  assert.match(prompt, /never invent a hue/i);
});

test("L1 asks for the scope fields L3 and L2 need", () => {
  const prompt = buildGoalPrompt("a product launch poster", CANVAS);
  for (const word of ["designType", "industry", "keywords", "composition", "brand", "imageSubject"]) {
    assert.ok(prompt.includes(word), `L1 prompt names ${word}`);
  }
  assert.ok(GOAL_SCHEMA.required.includes("designType"));
  assert.ok(GOAL_SCHEMA.required.includes("industry"));
  assert.ok(GOAL_SCHEMA.required.includes("keywords"));
  assert.ok(GOAL_SCHEMA.required.includes("composition"));
  assert.ok(GOAL_SCHEMA.required.includes("brand"));
  assert.ok(GOAL_SCHEMA.required.includes("imageSubject"));
});

test("L4 passes the raw request as the fact source, not a template example", () => {
  const component = {
    id: "headline-main",
    role: "headline",
    kind: "dsl",
    describe: "the main title and its year",
    box: { x: 64, y: 80, width: 640, height: 220 },
    fontSize: 54,
    maxChars: 40,
  };
  const prompt = buildComponentPrompt(
    component,
    CANVAS,
    { palette: PALETTE, style: PALETTE.style, components: [component], template: "hero-split" },
    GOAL,
    "When: Saturday 14 November 2026, 10:00–13:00",
  );
  assert.match(prompt, /Original request \(source of truth for concrete facts/);
  assert.match(prompt, /Saturday 14 November 2026/);
  assert.ok(!/Copy example for this region/.test(prompt));
});

test("L4 omits fixed-type lines when a region has no template type", () => {
  const component = {
    id: "headline",
    role: "headline",
    kind: "dsl",
    describe: "the title",
    box: { x: 48, y: 120, width: 640, height: 180 },
  };
  const prompt = buildComponentPrompt(component, CANVAS, { palette: PALETTE, style: PALETTE.style, components: [] }, GOAL);
  assert.ok(!/Copy limit/.test(prompt));
  assert.ok(!/Type: this region/.test(prompt));
  assert.ok(!/Copy example/.test(prompt));
});

test("L1 receives prior design memory but keeps the static prefix first", () => {
  const memory = JSON.stringify({
    brief: "A Diwali card from Graphilla Technology.",
    goal: { summary: "A warm Diwali greeting.", brand: "Graphilla Technology" },
    imageSubject: "diya lamps at dusk",
  });
  const prompt = buildGoalPrompt("make the greeting warmer", CANVAS, memory);
  assert.ok(prompt.startsWith(`${DESIGN_CORE}\n\n`), "memory never precedes the static core");
  assert.match(prompt, /Current design memory/);
  assert.match(prompt, /revision of the same design/);
  assert.match(prompt, /different brief, ignore the memory/);
  assert.ok(prompt.indexOf("Current design memory") < prompt.indexOf("[User]"));
  assert.ok(prompt.includes("diya lamps at dusk"));

  const fresh = buildGoalPrompt("a new product poster", CANVAS);
  assert.ok(!fresh.includes("Current design memory"));
});

test("assistant patches receive design memory only when it has content", () => {
  const design = {
    canvas: { width: 1200, height: 630 },
    elements: [{ id: "headline", type: "text", content: "Happy Diwali", x: 40, y: 40, width: 500, height: 100, fontSize: 48, fill: "#FFFFFF" }],
  };
  const memory = {
    brief: "A Diwali greeting for clients.",
    goal: { summary: "A warm Diwali card.", brand: "Graphilla Technology" },
    copy: { headline: ["Happy Diwali"] },
    usedWords: ["happy", "diwali"],
  };
  const withMemory = buildPatchPrompt("make it warmer", design, [], memory);
  assert.match(withMemory, /\[Design memory\]/);
  assert.match(withMemory, /Do not introduce a content word/);
  assert.ok(withMemory.includes("Graphilla Technology"));

  const empty = buildPatchPrompt("make it warmer", design);
  assert.ok(!empty.includes("[Design memory]"));
});
