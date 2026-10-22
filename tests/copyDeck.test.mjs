import test from "node:test";
import assert from "node:assert/strict";

import {
  COPY_RULES,
  buildCopyPrompt,
  buildCopyRepairPrompt,
  copyDeckSchema,
  copyLineLimit,
} from "../src/ai/copyPrompt";
import { copyProblem, extractGreeting, extractOccasionTagline, findCopyRepetitions } from "../src/ai/copySanitize";
import { validateCopyDeck } from "../src/ai/aiClient";
import { normalizeElementRole, normalizeElementRoles } from "../src/ai/elementRoles";

const GOAL = {
  summary: "A festive greeting card wishing a Happy Diwali from Graphilla Technology.",
  subject: "Diwali greeting",
  designType: "poster",
  tone: ["warm", "elegant", "celebratory"],
  keywords: ["Diwali", "festive", "clients", "community"],
  mustInclude: ["greeting", "organiser signature"],
};

const CANVAS = { width: 1200, height: 630 };

const REGIONS = [
  {
    id: "headline-quote",
    role: "headline",
    kind: "dsl",
    describe: "the quotation itself",
    maxChars: 72,
  },
  {
    id: "tagline-attribution",
    role: "tagline",
    kind: "dsl",
    describe: "who said it",
    maxChars: 40,
  },
  {
    id: "footer-registration",
    role: "footer",
    kind: "dsl",
    describe: "registration link, organizer or partner line",
    maxChars: 70,
  },
];

test("the copy prompt names every text region and its budget", () => {
  const prompt = buildCopyPrompt(REGIONS, GOAL, "A Diwali card from Graphilla.", CANVAS);
  assert.ok(prompt.startsWith(COPY_RULES), "the static rules come first");
  for (const region of REGIONS) {
    assert.ok(prompt.includes(region.id), `${region.id} is in the prompt`);
  }
  assert.match(prompt, /at most 72 characters total/);
  assert.match(prompt, /Never describe the design/);
  assert.match(prompt, /A region described as "who said it"/);
  assert.match(prompt, /Occasion: Happy Diwali/);
  assert.match(prompt, /Festival of Lights/);
  assert.match(prompt, /recipient region names the person or audience/);
  assert.match(prompt, /the greeting itself \(Happy Diwali\)/);
  assert.match(prompt, /the sign-off from the organiser/);
});

test("the copy schema requires every region and bounds its line count", () => {
  const schema = copyDeckSchema(REGIONS);
  assert.deepEqual(schema.required, REGIONS.map((region) => region.id));
  assert.equal(schema.properties["headline-quote"].maxItems, copyLineLimit(REGIONS[0]));
  assert.equal(schema.additionalProperties, false);
  assert.equal(copyDeckSchema([]), null);
});

test("the repair prompt repeats only the rejected regions", () => {
  const rejected = [
    {
      component: REGIONS[2],
      lines: ["Available now"],
      reason: "claims availability not stated in the brief",
    },
  ];
  const prompt = buildCopyRepairPrompt([REGIONS[2]], GOAL, "A Diwali card.", rejected, CANVAS);
  assert.ok(prompt.startsWith(COPY_RULES));
  assert.match(prompt, /footer-registration/);
  assert.match(prompt, /claims availability/);
  assert.match(prompt, /Occasion: Happy Diwali/);
  assert.doesNotMatch(prompt, /headline-quote/);
});

test("strict repetition guard flags partial copies, not just exact duplicates", () => {
  const repeats = findCopyRepetitions(
    [
      { id: "headline-main", text: "New AI Assistant" },
      { id: "tagline-line", text: "New AI Assistant Product Launch" },
    ],
    { summary: "Launch a new AI assistant product.", subject: "AI assistant", keywords: [] },
    "",
  );
  assert.deepEqual([...repeats.keys()].sort(), ["headline-main", "tagline-line"]);
  assert.match(repeats.get("tagline-line")[0], /"assistant" from region "headline-main"/);
});

test("strict repetition guard allows stopwords and the greeting sign-off", () => {
  const repeats = findCopyRepetitions(
    [
      { id: "headline-main", text: "Happy Diwali" },
      { id: "footer-registration", text: "Happy Diwali from Graphilla Technology" },
    ],
    GOAL,
    "",
  );
  assert.equal(repeats.size, 0);
});

test("copy-deck validation rejects a region that reuses another region's words", () => {
  const components = [
    { id: "headline-main", role: "headline", kind: "dsl", describe: "title", maxChars: 40 },
    { id: "tagline-line", role: "tagline", kind: "dsl", describe: "supporting line", maxChars: 60 },
  ];
  const rejected = validateCopyDeck(
    {
      "headline-main": ["New AI Assistant"],
      "tagline-line": ["New AI Assistant Product Launch"],
    },
    components,
    { summary: "Launch a new AI assistant product.", subject: "AI assistant", keywords: [] },
    "",
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].component.id, "tagline-line");
  assert.match(rejected[0].reason, /repeats "assistant"/);
});

test("copy-deck validation keeps a repeated greeting in the footer sign-off", () => {
  const components = [
    { id: "headline-main", role: "headline", kind: "dsl", describe: "title", maxChars: 40 },
    { id: "footer-registration", role: "footer", kind: "dsl", describe: "sign-off", maxChars: 70 },
  ];
  const rejected = validateCopyDeck(
    {
      "headline-main": ["Happy Diwali"],
      "footer-registration": ["Happy Diwali from Graphilla Technology"],
    },
    components,
    GOAL,
    "",
  );
  assert.equal(rejected.length, 0);
});

test("the repair prompt names accepted copy so the rewrite differs", () => {
  const rejected = [
    {
      component: REGIONS[2],
      lines: ["Available now"],
      reason: "claims availability not stated in the brief",
    },
  ];
  const prompt = buildCopyRepairPrompt(
    [REGIONS[2]],
    GOAL,
    "A Diwali card from Graphilla.",
    rejected,
    CANVAS,
    { "headline-quote": ["Happy Diwali"], "footer-registration": ["Available now"] },
  );
  assert.match(prompt, /Copy already accepted for other regions/);
  const block = prompt.split("Copy already accepted")[1].split("[User]")[0];
  assert.match(block, /headline-quote: "Happy Diwali"/);
  assert.doesNotMatch(block, /footer-registration/);
});

test("greeting extraction handles the Diwali brief", () => {
  assert.equal(extractGreeting(GOAL, ""), "Happy Diwali");
  assert.equal(
    extractGreeting({ summary: "Elegant and warm Diwali greeting card from Graphilla Technology." }, ""),
    "Happy Diwali",
  );
  assert.equal(
    extractOccasionTagline({ summary: "Elegant and warm Diwali greeting card from Graphilla Technology." }, ""),
    "Festival of Lights",
  );
});

test("copy validation rejects occasion-blind footer and attribution copy", () => {
  const footer = copyProblem(["Available now"], REGIONS[2], GOAL, "");
  assert.match(footer, /availability/);
  const attribution = copyProblem(["For clients and community · Hindi"], REGIONS[1], GOAL, "");
  assert.match(attribution, /attribution/);
  const meta = copyProblem(["A festive greeting card wishing a Happy Diwali"], REGIONS[0], GOAL, "");
  assert.match(meta, /describes the design/);
});

test("copy validation requires the occasion and rejects trailing tone words", () => {
  const warm = copyProblem(["Warm Wishes"], {
    id: "headline-main",
    role: "headline",
    kind: "dsl",
    describe: "the largest type on the canvas",
    maxChars: 40,
  }, GOAL, "");
  assert.match(warm, /name the occasion/);
  const toneTail = copyProblem(["Graphilla Technology Warm"], {
    id: "header-branding",
    role: "header",
    kind: "dsl",
    describe: "the awarding organization",
    maxChars: 30,
  }, GOAL, "");
  assert.match(toneTail, /tone word/);
  const source = copyProblem(
    ["Wishing you joy and light from Graphilla Technology."],
    {
      id: "details-source",
      role: "details",
      kind: "dsl",
      describe: "where it is from",
      maxChars: 70,
    },
    GOAL,
    "",
  );
  assert.equal(source, "");
  const label = copyProblem(["Diwali Greeting"], {
    id: "headline-main",
    role: "headline",
    kind: "dsl",
    describe: "the largest type on the canvas",
    maxChars: 40,
  }, GOAL, "");
  assert.match(label, /design type/);
});

test("copy validation rejects brand-only headlines and design labels", () => {
  const headline = {
    id: "headline-main",
    role: "headline",
    kind: "dsl",
    describe: "what is being awarded — the largest type on the canvas",
    maxChars: 40,
  };
  assert.match(copyProblem(["Graphilla Technology"], headline, GOAL, ""), /occasion|greeting/);
  const tagline = {
    id: "tagline-line",
    role: "tagline",
    kind: "dsl",
    describe: "the date of award, short",
    maxChars: 18,
  };
  assert.match(copyProblem(["Diwali Greeting"], tagline, GOAL, ""), /design type/);
  const recipient = {
    id: "sections-recipient",
    role: "sections",
    kind: "dsl",
    describe: "the recipient's name",
    maxChars: 40,
  };
  assert.match(copyProblem(["Diwali Greeting Card"], recipient, GOAL, ""), /recipient/);
  const details = {
    id: "details-statement",
    role: "details",
    kind: "dsl",
    describe: "the citation: what it is awarded for",
    maxChars: 80,
  };
  assert.match(copyProblem(["Every text at least 16px"], details, GOAL, ""), /instruction/);
});

test("copy validation rejects invented dates, names and certificate language", () => {
  const tagline = {
    id: "tagline-line",
    role: "tagline",
    kind: "dsl",
    describe: "the date of award, short",
    maxChars: 18,
  };
  const recipient = {
    id: "sections-recipient",
    role: "sections",
    kind: "dsl",
    describe: "the recipient's name",
    maxChars: 40,
  };
  const details = {
    id: "details-statement",
    role: "details",
    kind: "dsl",
    describe: "the citation: what it is awarded for",
    maxChars: 80,
  };
  assert.match(copyProblem(["January 1st, 2024"], tagline, GOAL, ""), /date/);
  assert.match(copyProblem(["Alex Johnson"], tagline, GOAL, ""), /invented name/);
  assert.match(copyProblem(["Client X"], recipient, GOAL, ""), /placeholder/);
  assert.match(
    copyProblem(["Awarded for innovative data analytics solutions"], details, GOAL, ""),
    /certificate/,
  );
});

test("copy validation accepts a coherent Diwali deck", () => {
  const headline = {
    id: "headline-main",
    role: "headline",
    kind: "dsl",
    describe: "what is being awarded — the largest type on the canvas",
    maxChars: 40,
  };
  const tagline = {
    id: "tagline-line",
    role: "tagline",
    kind: "dsl",
    describe: "the date of award, short",
    maxChars: 18,
  };
  const recipient = {
    id: "sections-recipient",
    role: "sections",
    kind: "dsl",
    describe: "the recipient's name",
    maxChars: 40,
  };
  const details = {
    id: "details-statement",
    role: "details",
    kind: "dsl",
    describe: "the citation: what it is awarded for",
    maxChars: 80,
  };
  assert.equal(copyProblem(["Happy Diwali"], headline, GOAL, ""), "");
  assert.equal(copyProblem(["Festival of Lights"], tagline, GOAL, ""), "");
  assert.equal(copyProblem(["To our clients and community"], recipient, GOAL, ""), "");
  assert.equal(copyProblem(["Wishing you light, joy, and prosperity this Diwali."], details, GOAL, ""), "");
});

test("copy validation accepts the expected Diwali lines", () => {
  assert.equal(copyProblem(["Happy Diwali"], REGIONS[0], GOAL, ""), "");
  assert.equal(copyProblem(["— Graphilla Technology"], REGIONS[1], GOAL, ""), "");
  assert.equal(copyProblem(["Happy Diwali from Graphilla Technology"], REGIONS[2], GOAL, ""), "");
});

test("unknown element roles are replaced by the owning region", () => {
  assert.equal(normalizeElementRole("hidden", "footer"), "footer");
  assert.equal(normalizeElementRole("", "headline"), "headline");
  assert.equal(normalizeElementRole("subtitle", "details"), "tagline");
  assert.equal(normalizeElementRole("label", "sections"), "label");
});

test("role normalisation walks group children", () => {
  const elements = [
    {
      id: "group",
      type: "group",
      x: 0,
      y: 0,
      children: [
        { id: "child", type: "text", role: "hidden", content: "Hello" },
        { id: "valid", type: "text", role: "label", content: "Label" },
      ],
    },
  ];
  const out = normalizeElementRoles(elements, "footer");
  assert.equal(out[0].children[0].role, "footer");
  assert.equal(out[0].children[1].role, "label");
});
