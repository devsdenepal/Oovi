import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeRegionCopy, regionCopyProblems } from "../src/ai/copySanitize";

const GOAL = {
  summary: "Launch a new AI assistant for teams.",
  subject: "AI assistant",
  designType: "product-launch",
  keywords: ["AI assistant", "automation", "teams"],
};

const text = (content) => ({
  id: "sample",
  type: "text",
  content,
  x: 0,
  y: 0,
  width: 400,
  fontSize: 20,
  fontWeight: 500,
  fill: "#FFFFFF",
});

const component = (overrides = {}) => ({
  id: "eyebrow",
  role: "tagline",
  maxChars: 35,
  describe: "Short uppercase category label",
  sample: "A NEW ERA BEGINS",
  ...overrides,
});

test("instruction leakage is dropped, never replaced with fallback copy", () => {
  const out = sanitizeRegionCopy(
    [text("One short supporting line (audience, price or what is included), not a repeat of the headline")],
    component(),
    GOAL,
  );
  assert.equal(out.length, 0);
});

test("an over-budget headline is dropped instead of truncated to the subject", () => {
  const out = sanitizeRegionCopy(
    [text("Launch our new AI assistant that automates repetitive team work")],
    component({ role: "headline", maxChars: 34, describe: "Large cinematic title", sample: "Beyond the ordinary" }),
    GOAL,
  );
  assert.equal(out.length, 0);
});

test("a template sample is dropped, not replaced", () => {
  const out = sanitizeRegionCopy(
    [text("Introducing the next generation of intelligent tools.")],
    component({
      role: "details",
      maxChars: 70,
      describe: "Concise explanation of the launch or experience",
      sample: "Introducing the next generation of intelligent tools.",
    }),
    GOAL,
  );
  assert.equal(out.length, 0);
});

test("short, valid copy is kept", () => {
  const out = sanitizeRegionCopy([text("Meet the AI assistant")], component(), GOAL);
  assert.equal(out[0].content, "Meet the AI assistant");
});

test("a footer without a link or date is dropped, not given a safe line", () => {
  const out = sanitizeRegionCopy(
    [text("Join us — Dark, confident product announcement")],
    component({ id: "footer", role: "footer", maxChars: 65, describe: "Website or launch date", sample: "" }),
    GOAL,
  );
  assert.equal(out.length, 0);
});

test("a CTA without an action is dropped, not given a generic action", () => {
  const out = sanitizeRegionCopy(
    [text("Dark, confident product announcement")],
    component({ id: "cta", role: "cta", maxChars: 35, describe: "Short call to action", sample: "" }),
    GOAL,
  );
  assert.equal(out.length, 0);
});

test("early access is never injected as fallback copy", () => {
  const out = sanitizeRegionCopy(
    [text("Dark, confident product announcement")],
    component({ id: "cta", role: "cta", maxChars: 35, describe: "Short call to action", sample: "" }),
    { ...GOAL, summary: "Open early access to the new AI assistant.", mustInclude: ["early access"] },
  );
  assert.equal(out.length, 0);
});

test("a generic audience label does not pass as a tagline", () => {
  const out = sanitizeRegionCopy([text("Team members")], component(), GOAL);
  assert.equal(out.length, 0);
});

test("a generic brand label is dropped, not replaced with the subject", () => {
  const out = sanitizeRegionCopy(
    [text("Team members")],
    component({ id: "brand", role: "header", maxChars: 32, describe: "Minimal brand or production label", sample: "NEPTECH LABS" }),
    GOAL,
  );
  assert.equal(out.length, 0);
});

const DIWALI = {
  summary: "A festive greeting card wishing a Happy Diwali from Graphilla Technology.",
  subject: "Diwali greeting",
  designType: "poster",
  keywords: ["Diwali", "festive", "clients", "community"],
  mustInclude: ["greeting", "organiser signature"],
};

test("a greeting-card footer with availability language is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("Available now")],
    component({
      id: "footer-registration",
      role: "footer",
      maxChars: 70,
      describe: "registration link, organizer or partner line",
      sample: "",
    }),
    DIWALI,
  );
  assert.equal(out.length, 0);
});

test("a keyword-join tagline is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("Diwali · Happy")],
    component({
      id: "tagline-line",
      role: "tagline",
      maxChars: 18,
      describe: "a short label, date or section, right-aligned",
      sample: "",
    }),
    DIWALI,
  );
  assert.equal(out.length, 0);
});

test("meta copy that describes the card is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("A festive greeting card wishing a Happy Diwali from Graphilla Technology")],
    component({
      id: "details-source-text",
      role: "details",
      maxChars: 70,
      describe: "the supporting facts: where it is from, or what to do next",
      sample: "",
    }),
    DIWALI,
  );
  assert.equal(out.length, 0);
});

test("an attribution naming the audience or language is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("For clients and community · Hindi")],
    component({
      id: "tagline-attribution-text",
      role: "tagline",
      maxChars: 40,
      describe: "who said it",
      sample: "",
    }),
    DIWALI,
  );
  assert.equal(out.length, 0);
});

test("approved copy wins over the generic fallback", () => {
  const out = sanitizeRegionCopy(
    [text("For clients and community · Hindi")],
    component({
      id: "tagline-attribution-text",
      role: "tagline",
      maxChars: 40,
      describe: "who said it",
      sample: "",
      copy: ["— Graphilla Technology"],
    }),
    DIWALI,
  );
  assert.equal(out[0].content, "— Graphilla Technology");
});

const DIWALI_BARE = {
  summary: "Elegant and warm Diwali greeting card from Graphilla Technology.",
  subject: "Diwali greeting card",
  designType: "poster",
  keywords: ["Diwali", "clients", "community"],
};

test("a headline that is only the brand is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("Graphilla Technology")],
    component({
      id: "headline-main",
      role: "headline",
      maxChars: 40,
      describe: "what is being awarded — the largest type on the canvas",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(out.length, 0);
});

test("a recipient naming the design type is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("Diwali Greeting Card")],
    component({
      id: "sections-recipient",
      role: "sections",
      maxChars: 40,
      describe: "the recipient's name",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(out.length, 0);
});

test("a production note never survives as the details copy", () => {
  const out = sanitizeRegionCopy(
    [text("Every text at least 16px")],
    component({
      id: "details-statement",
      role: "details",
      maxChars: 80,
      describe: "the citation: what it is awarded for",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(out.length, 0);
});

test("a design-label tagline is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("Diwali Greeting")],
    component({
      id: "tagline-line",
      role: "tagline",
      maxChars: 18,
      describe: "the date of award, short",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(out.length, 0);
});

test("a placeholder footer is dropped", () => {
  const out = sanitizeRegionCopy(
    [text("Details TBA")],
    component({
      id: "footer-registration",
      role: "footer",
      maxChars: 70,
      describe: "the signatory, reference or verification line",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(out.length, 0);
});

test("L4 cannot add a brand to an approved headline", () => {
  const out = sanitizeRegionCopy(
    [text("Graphilla Technology — Happy Diwali")],
    component({
      id: "headline-main",
      role: "headline",
      maxChars: 40,
      describe: "what is being awarded — the largest type on the canvas",
      sample: "",
      copy: ["Happy Diwali"],
    }),
    DIWALI_BARE,
  );
  assert.equal(out[0].content, "Happy Diwali");
});

test("L4 cannot prefix an approved recipient line", () => {
  const out = sanitizeRegionCopy(
    [text("1. To our clients and community")],
    component({
      id: "sections-recipient",
      role: "sections",
      maxChars: 40,
      describe: "the recipient's name",
      sample: "",
      copy: ["To our clients and community"],
    }),
    DIWALI_BARE,
  );
  assert.equal(out[0].content, "To our clients and community");
});

test("an approved multi-line deck may stay in one text element", () => {
  const out = sanitizeRegionCopy(
    [text("Festival of Lights\nHappy Diwali")],
    component({
      id: "sections-list",
      role: "sections",
      maxChars: 40,
      describe: "list",
      sample: "",
      copy: ["Festival of Lights", "Happy Diwali"],
    }),
    DIWALI_BARE,
  );
  assert.equal(out[0].content, "Festival of Lights\nHappy Diwali");
});

test("invented dates and placeholder names never survive", () => {
  const date = sanitizeRegionCopy(
    [text("January 1st, 2024")],
    component({
      id: "tagline-line",
      role: "tagline",
      maxChars: 18,
      describe: "the date of award, short",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(date.length, 0);

  const recipient = sanitizeRegionCopy(
    [text("Client X")],
    component({
      id: "sections-recipient",
      role: "sections",
      maxChars: 40,
      describe: "the recipient's name",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(recipient.length, 0);
});

test("certificate language is dropped in a greeting card", () => {
  const out = sanitizeRegionCopy(
    [text("Awarded for innovative data analytics solutions")],
    component({
      id: "details-statement",
      role: "details",
      maxChars: 80,
      describe: "the citation: what it is awarded for",
      sample: "",
    }),
    DIWALI_BARE,
  );
  assert.equal(out.length, 0);
});

test("dropping invalid copy keeps the rest of the region intact", () => {
  const shape = {
    id: "sample-bg",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    fill: "#111111",
  };
  const out = sanitizeRegionCopy([shape, text("Team members"), text("Meet the AI assistant")], component(), GOAL);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "sample-bg");
  assert.equal(out[1].content, "Meet the AI assistant");
});

test("regionCopyProblems reports the line L4 must regenerate", () => {
  const problems = regionCopyProblems(
    [text("One short supporting line (audience, price or what is included), not a repeat of the headline")],
    component({ maxChars: 160 }),
    GOAL,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /instruction leakage/);
  assert.match(problems[0].content, /One short supporting line/);
});

test("regionCopyProblems accepts a restorable approved deck line", () => {
  const problems = regionCopyProblems(
    [text("For clients and community · Hindi")],
    component({
      id: "tagline-attribution-text",
      role: "tagline",
      maxChars: 40,
      describe: "who said it",
      sample: "",
      copy: ["— Graphilla Technology"],
    }),
    DIWALI,
  );
  assert.equal(problems.length, 0);
});
