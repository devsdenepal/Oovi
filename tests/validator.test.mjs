/**
 * Validator regressions exposed by strict-schema outputs.
 *
 * A closed JSON schema must list every optional property in `required`, so
 * providers emit `null` for unused ones. `normalizeElement` already drops
 * those nulls; validation must not reject the response before it gets there.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateDesign } from "../src/design/designValidator";

const canvas = { width: 1200, height: 630 };
const text = {
  id: "headline-main-text",
  type: "text",
  content: "Open House",
  x: 10,
  y: 10,
  width: 400,
  fontSize: 40,
  fontWeight: 700,
  fill: "#111111",
};

test("a null gradient from strict decoding is ignored", () => {
  const result = validateDesign({ canvas, elements: [{ ...text, gradient: null }] });
  assert.equal(result.ok, true);
  assert.equal("gradient" in result.design.elements[0], false);
});

test("a malformed non-null gradient is still rejected", () => {
  const result = validateDesign({ canvas, elements: [{ ...text, gradient: { type: "linear" } }] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /gradient/);
});
