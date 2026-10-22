import assert from "node:assert/strict";
import test from "node:test";
import { titleFromPrompt } from "../src/ui/designTitle.js";
import { formatForCanvas } from "../src/ui/designMeta.js";

test("dashboard titles strip the instruction wrapper and keep the subject", () => {
  assert.equal(
    titleFromPrompt("Create a Hacktoberfest 2026 banner for our developer community"),
    "Hacktoberfest 2026 Banner",
  );
  assert.equal(
    titleFromPrompt("A product announcement for our AI assistant"),
    "Product Announcement",
  );
  assert.equal(titleFromPrompt("Please design a poster"), "Poster");
  assert.equal(titleFromPrompt(""), "Untitled design");
});

test("dashboard titles preserve brand casing and stop at the first clause", () => {
  assert.equal(
    titleFromPrompt("Make an iPhone launch story with a clean layout"),
    "iPhone Launch Story",
  );
  assert.equal(
    titleFromPrompt("Design an AI workshop invitation for students"),
    "AI Workshop Invitation",
  );
});

test("saved canvas dimensions map to familiar output formats", () => {
  assert.equal(formatForCanvas(1200, 630), "Feed");
  assert.equal(formatForCanvas(1080, 1080), "Square");
  assert.equal(formatForCanvas(1080, 1350), "Portrait");
  assert.equal(formatForCanvas(1080, 1920), "Story");
  assert.equal(formatForCanvas(1200, 675), "Banner");
  assert.equal(formatForCanvas(2480, 3508), "A4");
});

test("unknown canvas dimensions fall back by ratio without inventing a format", () => {
  assert.equal(formatForCanvas("1600", "900"), "Banner");
  assert.equal(formatForCanvas(1200, 1200), "Square");
  assert.equal(formatForCanvas(800, 1000), "Portrait");
  assert.equal(formatForCanvas(1000, 800), "Custom");
  assert.equal(formatForCanvas(0, 630), "");
  assert.equal(formatForCanvas("wide", 630), "");
});
