import test from "node:test";
import assert from "node:assert/strict";

import { extractBrand } from "../src/ai/copySanitize";
import { cleanImageSubject, imageQueryCandidates } from "../src/ai/imageSubject";
import { imagePlaceholderDataUrl } from "../src/layout/imagePlaceholder";
import { choosePhoto, orientationFor } from "../src/ai/unsplash";

test("brand identity comes from the model answer, not a name regex", () => {
  assert.equal(
    extractBrand({
      summary: "A hiring notice from AS Power Solution.",
      brand: "AS Power Solution",
    }),
    "AS Power Solution",
  );
  // A brand-shaped phrase in the summary is not promoted by the pipeline.
  assert.equal(
    extractBrand({
      summary: "A hiring notice from AS Power Solution.",
      brand: "",
    }),
    "",
  );
});

test("image subject is a structural hand-off of the model's scene", () => {
  assert.equal(
    cleanImageSubject("  engineers in safety helmets\nat a sunrise substation  "),
    "engineers in safety helmets at a sunrise substation",
  );
  assert.deepEqual(
    imageQueryCandidates(
      { imageSubject: "engineers in safety helmets at a sunrise substation" },
      "power company recruitment",
    ),
    [
      "engineers in safety helmets at a sunrise substation",
      "engineers safety helmets sunrise substation",
      "power company recruitment",
    ],
  );
  assert.deepEqual(imageQueryCandidates({}, "a short tuning query"), ["a short tuning query"]);
  assert.deepEqual(imageQueryCandidates({}, ""), []);
});

test("a long scene gets a compact query without the brand or grammar filler", () => {
  const queries = imageQueryCandidates({
    brand: "Graphilla",
    imageSubject:
      "travelers happily using a tablet displaying a graphilla interface with a stylized cityscape in the background",
    keywords: ["travel app", "itinerary", "cityscape"],
  });
  assert.equal(
    queries[0],
    "travelers happily using a tablet displaying a graphilla interface with a stylized cityscape in the background",
  );
  assert.equal(
    queries[1],
    "travelers happily tablet interface stylized cityscape background",
  );
  assert.ok(!/graphilla/i.test(queries[1]));
});

test("template sample artwork is palette-derived and keeps the semantic query", () => {
  const src = imagePlaceholderDataUrl({
    width: 480,
    height: 320,
    palette: { background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF" },
    query: "engineers at a substation",
    seed: "hero-artwork",
  });
  assert.match(src, /^data:image\/svg\+xml,/);
  const svg = decodeURIComponent(src.slice("data:image/svg+xml,".length));
  assert.match(svg, /<svg /);
  assert.match(svg, /engineers at a substation/);
  assert.match(svg, /#3D7BFF/i);
  assert.doesNotMatch(svg, /picsum|unsplash\.it/i);
});

test("orientation and photo choice follow the reserved box, deterministically", () => {
  assert.equal(orientationFor({ width: 900, height: 500 }), "landscape");
  assert.equal(orientationFor({ width: 500, height: 900 }), "portrait");
  assert.equal(orientationFor({ width: 600, height: 600 }), "squarish");
  assert.equal(orientationFor({ width: 0, height: 600 }), "");

  const photos = [
    { id: "wide", full: "wide.jpg", width: 2400, height: 900 },
    { id: "close", full: "close.jpg", width: 820, height: 600 },
    { id: "portrait", full: "portrait.jpg", width: 800, height: 1400 },
  ];
  assert.equal(choosePhoto(photos, { width: 800, height: 600 }).id, "close");
  assert.equal(choosePhoto([], { width: 800, height: 600 }), null);
});
