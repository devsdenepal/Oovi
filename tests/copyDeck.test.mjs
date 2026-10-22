import test from "node:test";
import assert from "node:assert/strict";

import {
  COPY_RULES,
  COPY_REPAIR_RULES,
  buildCopyPrompt,
  buildCopyRepairPrompt,
  copyDeckSchema,
  copyLineLimit,
} from "../src/ai/copyPrompt";
import {
  collectTextElements,
  copyProblem,
  extractGreeting,
  extractOccasionTagline,
  findCopyRepetitions,
  findTextRepetitionsForChanged,
  textElementsUnder,
} from "../src/ai/copySanitize";
import { planCopyDeck, validateCopyDeck } from "../src/ai/aiClient";
import { normalizeElementRole, normalizeElementRoles } from "../src/ai/elementRoles";

const GOAL = {
  summary: "A festive greeting card wishing a Happy Diwali from Graphilla Technology.",
  subject: "Diwali greeting",
  brand: "Graphilla Technology",
  imageSubject: "diya lamps glowing on a rangoli at dusk",
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
  assert.ok(prompt.startsWith(COPY_REPAIR_RULES));
  assert.ok(COPY_REPAIR_RULES.length < COPY_RULES.length);
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
  assert.match(repeats.get("tagline-line")[0], /assistant/);
});

test("strict repetition guard still allows grammatical stopwords", () => {
  const repeats = findCopyRepetitions(
    [
      { id: "headline-main", text: "The launch is here" },
      { id: "tagline-line", text: "The team is ready" },
    ],
    GOAL,
    "",
  );
  assert.equal(repeats.size, 0);
});

test("strict repetition guard rejects a repeated greeting", () => {
  const repeats = findCopyRepetitions(
    [
      { id: "headline-main", text: "Happy Diwali" },
      { id: "footer-registration", text: "Happy Diwali from Graphilla Technology" },
    ],
    GOAL,
    "",
  );
  assert.deepEqual([...repeats.keys()].sort(), ["footer-registration", "headline-main"]);
  assert.match(repeats.get("footer-registration")[0], /repeats .* from region "headline-main"/);
});

test("strict repetition guard rejects the same brand in two regions", () => {
  const repeats = findCopyRepetitions(
    [
      { id: "header-branding", text: "AS Power Solution" },
      { id: "headline-main", text: "Careers at AS Power Solution" },
    ],
    { summary: "A hiring notice.", brand: "AS Power Solution" },
    "",
  );
  assert.deepEqual([...repeats.keys()].sort(), ["header-branding", "headline-main"]);
  assert.match(repeats.get("header-branding")[0], /"power"|"solution"/);
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
  assert.match(rejected[0].reason, /assistant/);
});

test("copy-deck validation rejects a repeated greeting in the footer sign-off", () => {
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
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].component.id, "footer-registration");
  assert.match(rejected[0].reason, /repeats/);
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
    describe: "what is being awarded | the largest type on the canvas",
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
    describe: "what is being awarded | the largest type on the canvas",
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
  assert.equal(copyProblem(["| Graphilla Technology"], REGIONS[1], GOAL, ""), "");
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

test("assistant edits are checked against every other rendered text", () => {
  const design = {
    elements: [
      { id: "headline", type: "text", content: "Happy Diwali" },
      { id: "footer", type: "text", content: "Happy Diwali from Graphilla" },
    ],
  };
  const changed = findTextRepetitionsForChanged(design, ["footer"]);
  assert.equal(changed.size, 2);
  assert.match(changed.get("footer")[0], /happy|diwali/i);
});

test("assistant repetition ignores untouched legacy duplicates", () => {
  const design = {
    elements: [
      { id: "headline", type: "text", content: "Happy Diwali" },
      { id: "tagline", type: "text", content: "Happy Diwali" },
      { id: "cta", type: "text", content: "Join the celebration" },
    ],
  };
  assert.equal(findTextRepetitionsForChanged(design, ["cta"]).size, 0);
  assert.ok(findTextRepetitionsForChanged(design, ["tagline"]).size > 0);
});

test("assistant repetition walks group children", () => {
  const design = {
    elements: [
      { id: "headline", type: "text", content: "Graphilla Technology" },
      {
        id: "footer-group",
        type: "group",
        children: [{ id: "footer-text", type: "text", content: "Graphilla Technology" }],
      },
    ],
  };
  const changed = findTextRepetitionsForChanged(design, ["footer-group"]);
  assert.equal(changed.size, 2);
  assert.ok(changed.has("footer-text"));
});

test("region ownership and text collection see nested groups", () => {
  const design = {
    elements: [
      { id: "headline", type: "text", content: "Happy Diwali" },
      {
        id: "details-group",
        type: "group",
        children: [
          { id: "details-a", type: "text", content: "Lights and joy" },
          {
            id: "details-inner",
            type: "group",
            children: [{ id: "details-b", type: "text", content: "Warm wishes" }],
          },
        ],
      },
    ],
  };
  const all = collectTextElements(design.elements);
  assert.deepEqual(all.map((entry) => entry.id), ["headline", "details-a", "details-b"]);
  const details = textElementsUnder(design, ["details-group"]);
  assert.deepEqual(details.map((entry) => entry.id), ["details-a", "details-b"]);
});

test("content adjectives are part of the repetition ledger", () => {
  const repeats = findCopyRepetitions(
    [
      { id: "headline", text: "New AI assistant" },
      { id: "tagline", text: "New workflow tool" },
    ],
    GOAL,
    "",
  );
  assert.deepEqual([...repeats.keys()].sort(), ["headline", "tagline"]);
  assert.match(repeats.get("headline")[0], /"new"/);
});

test("ordinary title-case hiring copy is not treated as an invented name", () => {
  const tagline = {
    id: "announcement-label",
    role: "tagline",
    kind: "dsl",
    describe: "Announcement category",
    maxChars: 35,
  };
  const goal = {
    summary: "A hiring notice from a power company.",
    brand: "Northwind Power",
    designType: "poster",
    mustInclude: ["company name", "hiring headline", "apply action"],
  };
  assert.equal(copyProblem(["New Team Members Wanted"], tagline, goal, ""), "");
  assert.equal(copyProblem(["Hiring Now"], tagline, goal, ""), "");
});

test("CTA validation accepts apply as an action verb", () => {
  const cta = {
    id: "cta",
    role: "cta",
    kind: "dsl",
    describe: "Action relevant to the announcement",
    maxChars: 45,
  };
  assert.equal(copyProblem(["Apply Now"], cta, { summary: "A hiring notice." }, ""), "");
});

test("copy prompt derives reserved brand words from the goal, not a hardcoded brand", () => {
  const components = [
    { id: "brand", role: "header", kind: "dsl", describe: "Company identity", maxChars: 45 },
    { id: "headline", role: "headline", kind: "dsl", describe: "Main announcement", maxChars: 55 },
  ];
  const one = buildCopyPrompt(
    components,
    { summary: "A hiring notice.", brand: "Northwind Labs", designType: "poster" },
    "",
    CANVAS,
  );
  const two = buildCopyPrompt(
    components,
    { summary: "A hiring notice.", brand: "Contoso Health", designType: "poster" },
    "",
    CANVAS,
  );
  assert.match(one, /Reserved brand words/);
  assert.match(one, /"northwind"/);
  assert.match(one, /"labs"/);
  assert.doesNotMatch(one, /contoso/);
  assert.match(two, /"contoso"/);
  assert.doesNotMatch(two, /northwind/);
});

test("a complete hiring deck passes without weakening repetition or facts", () => {
  const components = [
    { id: "brand", role: "header", kind: "dsl", describe: "Company identity", maxChars: 45 },
    { id: "announcement-label", role: "tagline", kind: "dsl", describe: "Announcement category", maxChars: 35 },
    { id: "headline", role: "headline", kind: "dsl", describe: "Main announcement", maxChars: 55 },
    { id: "supporting-copy", role: "details", kind: "dsl", describe: "Short explanatory message", maxChars: 100 },
    { id: "cta", role: "cta", kind: "dsl", describe: "Action relevant to the announcement", maxChars: 45 },
    { id: "contact-footer", role: "footer", kind: "dsl", describe: "Website and social media details", maxChars: 100 },
  ];
  const goal = {
    summary: "A hiring notice from Northwind Labs.",
    brand: "Northwind Labs",
    designType: "poster",
    mustInclude: ["company name", "hiring headline", "apply action"],
  };
  const copies = {
    brand: ["Northwind Labs"],
    "announcement-label": ["Hiring Now"],
    headline: ["Join Our Team"],
    "supporting-copy": ["Build a brighter future"],
    cta: ["Apply Today"],
    "contact-footer": ["Visit our website"],
  };
  assert.deepEqual(validateCopyDeck(copies, components, goal, ""), []);
});

test("the schema can cap a repair to the rejected line count", () => {
  const schema = copyDeckSchema([REGIONS[0]], { "headline-quote": 1 });
  assert.equal(schema.properties["headline-quote"].maxItems, 1);
  assert.equal(schema.properties["headline-quote"].items.maxLength, 72);
  assert.equal(copyLineLimit({ ...REGIONS[0], maxChars: 33 }), 1);
  assert.equal(copyLineLimit({ ...REGIONS[0], role: "details", maxChars: 100 }), 1);
  assert.equal(copyLineLimit({ ...REGIONS[0], role: "details", maxChars: 220 }), 3);
  assert.equal(copyLineLimit({ ...REGIONS[0], role: "details", maxChars: 420 }), 4);
});

test("repair prompts keep line count, total budget and accepted words explicit", () => {
  const region = {
    id: "supporting-copy",
    role: "details",
    kind: "dsl",
    describe: "Short explanatory message",
    maxChars: 100,
  };
  const rejected = [
    { component: region, lines: ["Northwind Power is hiring", "Join our team"], reason: "repeats brand words" },
  ];
  const prompt = buildCopyRepairPrompt(
    [region],
    { summary: "A hiring notice from Northwind Power.", brand: "Northwind Power" },
    "",
    rejected,
    CANVAS,
    { brand: ["Northwind Power"], headline: ["Build reliable energy"] },
  );
  assert.match(prompt, /at most 1 line\b/);
  assert.match(prompt, /100 characters total across all lines/);
  assert.match(prompt, /HARD: none of these words may appear/);
  assert.match(prompt, /northwind/);
});

test("planCopyDeck seeds the brand region from the brief, not the model", async () => {
  const brand = {
    id: "header-branding",
    role: "header",
    kind: "dsl",
    describe: "organizer or event kicker, one short line",
    maxChars: 45,
  };
  const headline = {
    id: "headline",
    role: "headline",
    kind: "dsl",
    describe: "Main announcement",
    maxChars: 55,
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const text = JSON.stringify({ headline: ["Join our team"] });
    return new Response(`${JSON.stringify({ t: "done", text, provider: "test" })}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
  try {
    const result = await planCopyDeck(
      [brand, headline],
      { summary: "A hiring notice from Northwind Labs.", brand: "Northwind Labs", designType: "poster" },
      CANVAS,
      "A hiring notice from Northwind Labs.",
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].schema.required, ["headline"]);
    assert.deepEqual(result.copies["header-branding"], ["Northwind Labs"]);
    assert.deepEqual(result.copies.headline, ["Join our team"]);
    assert.equal(result.source, "ai");
    assert.equal(result.unresolved.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
