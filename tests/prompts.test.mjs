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
  buildGoalPrompt,
  buildPalettePrompt,
  buildSkeletonPrompt,
} from "../src/ai/layerPrompt";
import {
  TEMPLATE_RULES,
  buildTemplateChoicePrompt,
  buildTuningPrompt,
} from "../src/ai/templatePrompt";
import { buildComponentPrompt } from "../src/ai/architectPrompt";
import { getTemplate, TEMPLATE_IDS } from "../src/layout/templates";

const CANVAS = { width: 1200, height: 630 };
const GOAL = {
  summary: "a hackathon launch event",
  subject: "hackathon",
  audience: "developers",
  purpose: "announce",
  tone: "energetic",
  mustInclude: ["event title and year", "date and venue"],
  avoid: ["invented names"],
  style: "modern tech",
};
const PALETTE = { background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF", style: "modern tech, crisp blue" };

test("L1-L4 share the byte-identical static prefix", () => {
  const prompts = [
    buildGoalPrompt("a poster", CANVAS),
    buildSkeletonPrompt(GOAL, PALETTE, CANVAS),
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
  const retrieved = ["menu-sheet", "card-grid", "product-shelf"];
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
  assert.match(prompt, /Reserved box: x=64 y=80 width=640 height=220\./);
  assert.match(prompt, /54px/);
  assert.match(prompt, /at most 40 characters/);
  assert.match(prompt, /aligned center/);
});

test("L4 gives a template region a worked copy example", () => {
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
  );
  assert.match(prompt, /Copy example for this region/);
});

test("L4 omits the fixed-type lines for a free-form skeleton region", () => {
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
