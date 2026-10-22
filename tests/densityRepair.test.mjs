import test from "node:test";
import assert from "node:assert/strict";

import { FEATURES } from "../src/config/features";
import { derivePaletteRoles } from "../src/layout/paletteRoles";
import { buildDensityRepair } from "../src/layout/densityRepair";
import { elementBoxes, evaluateDesign } from "../src/ai/quality";
import { validateDesign } from "../src/design/designValidator";

const CANVAS = { width: 1200, height: 700 };
const PALETTE = {
  background: "#0A1020",
  ink: "#E8F0FF",
  accent: "#3D7BFF",
  roles: derivePaletteRoles({ background: "#0A1020", ink: "#E8F0FF", accent: "#3D7BFF" }),
};

const PLAN = {
  palette: PALETTE,
  components: [
    {
      id: "details-main",
      role: "details",
      kind: "dsl",
      box: { x: 80, y: 400, width: 500, height: 140 },
    },
    {
      id: "decoration-accent",
      role: "decoration",
      kind: "dsl",
      box: { x: 760, y: 80, width: 300, height: 400 },
    },
  ],
};

const DESIGN = {
  canvas: { width: CANVAS.width, height: CANVAS.height, background: PALETTE.background },
  elements: [
    {
      id: "details-main-text",
      type: "text",
      role: "details",
      x: 96,
      y: 420,
      width: 460,
      content: "For job seekers",
      fontSize: 14,
      fontWeight: 500,
      fill: PALETTE.ink,
    },
    {
      id: "decoration-accent-dot",
      type: "circle",
      role: "decoration",
      x: 900,
      y: 200,
      radius: 6,
      fill: PALETTE.accent,
    },
  ],
};

test("a thin text box gets a deterministic frame, rail and marks", () => {
  const metrics = {
    regionFills: [{ id: "details-main", role: "details", fill: 0.06 }],
    decorationPieces: 1,
  };
  const repair = buildDensityRepair({ metrics, issues: [] }, PLAN, PALETTE, CANVAS, DESIGN);
  assert.ok(repair.behind.length >= 5, "the details card gets real composition");
  assert.ok(
    1 + repair.behind.length + repair.front.length >= FEATURES.decoration.minPieces,
    "the decoration floor is met",
  );
  assert.ok(repair.notes.some((note) => note.includes("details-main")));

  const ids = [...repair.behind, ...repair.front].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length, "repair ids are unique");
  for (const element of repair.behind) {
    const box = elementBoxes([element])[0].box;
    assert.ok(box.x >= PLAN.components[0].box.x - 1, `${element.id}: inside the left edge`);
    assert.ok(box.x + box.w <= PLAN.components[0].box.x + PLAN.components[0].box.width + 1, `${element.id}: inside the right edge`);
  }

  const merged = { ...DESIGN, elements: [...DESIGN.elements, ...repair.behind, ...repair.front] };
  const check = validateDesign(merged);
  assert.equal(check.ok, true, check.errors?.join("; "));
  const report = evaluateDesign(merged, { components: PLAN.components, palette: PALETTE });
  assert.equal(
    report.issues.filter((issue) => issue.code === "thin-section" && issue.message.includes("details-main")).length,
    0,
    "the rendered fill no longer reads as a hollow box",
  );
  assert.ok(
    report.metrics.decorationPieces >= FEATURES.decoration.minPieces,
    `decoration pieces ${report.metrics.decorationPieces} reach the dense floor`,
  );
});

test("a dense region and a full decoration layer are left untouched", () => {
  const metrics = {
    regionFills: [{ id: "details-main", role: "details", fill: FEATURES.layout.regionFill.details + 0.2 }],
    decorationPieces: FEATURES.decoration.minPieces,
  };
  const repair = buildDensityRepair({ metrics, issues: [] }, PLAN, PALETTE, CANVAS, DESIGN);
  assert.deepEqual(repair.behind, []);
  assert.deepEqual(repair.front, []);
});
