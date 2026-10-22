/**
 * Region retry budget.
 *
 * A failed region gets another model call, but only until the configured
 * three-call budget is spent. This is a behavior test, not just a config
 * assertion: the model is mocked with a stream that never yields usable JSON.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { componentDesign } from "../src/ai/aiClient";
import { FEATURES } from "../src/config/features";

const CANVAS = { width: 1200, height: 630 };
const COMPONENT = {
  id: "headline-main",
  kind: "dsl",
  role: "headline",
  describe: "the main title",
  box: { x: 64, y: 80, width: 640, height: 220 },
  fontSize: 54,
  maxChars: 40,
};
const PLAN = {
  palette: { background: "#FFFFFF", ink: "#111111", accent: "#FF5500" },
  style: "clean modern",
  components: [COMPONENT],
};
const GOAL = {
  summary: "A product launch poster for Acme.",
  subject: "Acme workspace",
  brand: "Acme",
  audience: "product teams",
  purpose: "announce a launch",
  tone: "confident",
  designType: "poster",
  industry: "technology",
  keywords: ["launch", "workspace"],
  imageSubject: "a tidy desk with a laptop at sunrise",
};

function streamedText(text) {
  return new Response(`${JSON.stringify({ t: "done", text, provider: "test" })}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

test("a region that never produces usable JSON stops after three calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return streamedText("this is not JSON");
  };
  try {
    await assert.rejects(
      () => componentDesign(COMPONENT, CANVAS, PLAN, GOAL),
      /Component "headline-main" failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, FEATURES.ai.maxAttempts);
  assert.equal(FEATURES.ai.maxAttempts, 3);
});

test("a transport failure gets the same three-call budget, then blocks", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("ollama restarted");
  };
  try {
    await assert.rejects(
      () => componentDesign(COMPONENT, CANVAS, PLAN, GOAL),
      /failed after 3 calls/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, FEATURES.ai.maxAttempts);
});
