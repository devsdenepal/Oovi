/**
 * Per-design memory contract.
 *
 * The rendered design is the source of truth. These tests pin the migration,
 * copy-ledger sync, prompt projection and persist dedupe so a future backend
 * can replace Postgres without changing what the model sees.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DESIGN_MEMORY_VERSION,
  createDesignMemory,
  emptyDesignMemory,
  hasDesignMemory,
  memoryForPrompt,
  memoryPersistKey,
  migrateDesignMemory,
  normalizeDesignMemory,
  recordMemoryEdit,
  syncMemoryCopy,
} from "../src/memory/designMemory";
import { FEATURES } from "../src/config/features";

const GOAL = {
  summary: "A Diwali card for clients of Graphilla Technology.",
  subject: "Diwali greeting",
  brand: "Graphilla Technology",
  audience: "clients and community",
  purpose: "celebrate the festival",
  tone: "warm and elegant",
  designType: "greeting-card",
  industry: "technology",
  keywords: ["Diwali", "lights", "clients"],
  composition: "centered",
  imageSubject: "diya lamps glowing on a rangoli at dusk",
  mustInclude: ["greeting", "organiser signature"],
  avoid: ["invented dates"],
  style: "warm editorial",
};

const PALETTE = {
  id: "festival-warm",
  name: "Festival Warm",
  style: "warm editorial",
  background: "#1A0B08",
  ink: "#FFF4E6",
  accent: "#F5A623",
};

const PLAN = {
  template: "festival-card",
  tuning: { variant: "centered", density: "tight", tuning: { scale: 1 } },
  palette: PALETTE,
  components: [
    { id: "headline-main", kind: "dsl", role: "headline", describe: "the greeting" },
    { id: "details-block", kind: "dsl", role: "details", describe: "the supporting lines" },
  ],
};

const DESIGN = {
  canvas: { width: 1200, height: 630, background: "#1A0B08" },
  elements: [
    { id: "headline-main-text", type: "text", content: "Happy Diwali", role: "headline" },
    {
      id: "details-block-group",
      type: "group",
      children: [
        { id: "details-block-line", type: "text", content: "Diya lights glow", role: "details" },
      ],
    },
    { id: "manual-note", type: "text", content: "Graphilla Technology", role: "brand" },
  ],
};

test("memory normalizes a legacy row through the versioned migration", () => {
  const migrated = migrateDesignMemory({
    version: 0,
    scope: { summary: "old goal", brand: "Old Brand" },
    used_words: ["Legacy", "Word"],
    template: "festival-card",
    assets: [{ region: "hero", query: "diya lamps", source: "unsplash" }],
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(migrated.version, 1);
  assert.equal(migrated.goal.summary, "old goal");
  assert.equal(migrated.template.id, "festival-card");
  assert.deepEqual(migrated.images, [{ region: "hero", query: "diya lamps", source: "unsplash" }]);

  const memory = normalizeDesignMemory(migrated);
  assert.equal(memory.version, DESIGN_MEMORY_VERSION);
  assert.equal(memory.brief, "");
  assert.equal(memory.goal.brand, "Old Brand");
  assert.deepEqual(memory.usedWords, ["legacy", "word"]);
});

test("a newer memory row keeps known fields instead of being discarded", () => {
  const future = normalizeDesignMemory({
    version: DESIGN_MEMORY_VERSION + 1,
    brief: "future brief",
    goal: { summary: "future goal", brand: "Future" },
    unknownField: { nested: true },
  });
  assert.equal(future.brief, "future brief");
  assert.equal(future.goal.summary, "future goal");
  assert.equal(future.goal.brand, "Future");
});

test("invalid memory becomes empty memory, never a guessed row", () => {
  const invalid = normalizeDesignMemory("{not json");
  assert.equal(invalid.brief, "");
  assert.deepEqual(invalid.usedWords, []);
  assert.deepEqual(invalid.goal, {});
  assert.equal(hasDesignMemory(invalid), false);
  assert.equal(hasDesignMemory(normalizeDesignMemory(null)), false);
  assert.equal(hasDesignMemory({ brief: "a real brief" }), true);
  assert.equal(hasDesignMemory({ usedWords: ["unique"] }), true);
});

test("the copy ledger is recomputed from rendered text, including groups", () => {
  const base = normalizeDesignMemory({
    brief: "a Diwali card",
    goal: GOAL,
    template: { id: PLAN.template },
    regions: {
      "headline-main": { kind: "dsl", role: "headline", elementIds: ["headline-main-text"] },
      "details-block": { kind: "dsl", role: "details", elementIds: ["details-block-group"] },
    },
  });
  const synced = syncMemoryCopy(base, DESIGN);

  assert.deepEqual(synced.copy["headline-main"], ["Happy Diwali"]);
  assert.deepEqual(synced.copy["details-block"], ["Diya lights glow"]);
  assert.deepEqual(synced.copy["manual-manual-note"], ["Graphilla Technology"]);
  assert.equal(synced.regions["headline-main"].text, "Happy Diwali");
  assert.equal(synced.regions["details-block"].text, "Diya lights glow");

  for (const word of ["happy", "diwali", "diya", "lights", "glow", "graphilla", "technology"]) {
    assert.ok(synced.usedWords.includes(word), `usedWords includes ${word}`);
  }
  assert.ok(!synced.usedWords.includes("the"), "stopwords stay out of the ledger");
});

test("the copy ledger follows the rendered content and is stable when unchanged", () => {
  const base = normalizeDesignMemory({
    regions: {
      "headline-main": { kind: "dsl", role: "headline", elementIds: ["headline-main-text"] },
    },
  });
  const first = syncMemoryCopy(base, DESIGN);
  const again = syncMemoryCopy(first, DESIGN);
  assert.equal(again.updatedAt, first.updatedAt, "unchanged design does not churn the timestamp");

  const changed = {
    ...DESIGN,
    elements: DESIGN.elements.map((element) =>
      element.id === "headline-main-text" ? { ...element, content: "Happy Diwali lights" } : element,
    ),
  };
  const next = syncMemoryCopy(first, changed);
  assert.deepEqual(next.copy["headline-main"], ["Happy Diwali lights"]);
  assert.ok(next.usedWords.includes("lights"));
  assert.notEqual(next.updatedAt, first.updatedAt);
});

test("createDesignMemory captures plan, images, quality and approved copy", () => {
  const memory = createDesignMemory({
    brief: "A Diwali card for clients of Graphilla Technology.",
    goal: GOAL,
    plan: PLAN,
    design: DESIGN,
    regions: new Map([
      ["headline-main", { count: 1, ids: ["headline-main-text"] }],
      ["details-block", { count: 1, ids: ["details-block-group"] }],
    ]),
    images: [{ region: "hero", query: "diya lamps at dusk", source: "unsplash", photographer: "A. Photographer" }],
    quality: { score: 93, issues: [{ severity: "warning", code: "spacing", message: "small gap" }] },
  });

  assert.equal(memory.version, DESIGN_MEMORY_VERSION);
  assert.equal(memory.template.id, "festival-card");
  assert.equal(memory.template.variant, "centered");
  assert.equal(memory.palette.name, "Festival Warm");
  assert.equal(memory.images.length, 1);
  assert.equal(memory.images[0].photographer, "A. Photographer");
  assert.equal(memory.quality.score, 93);
  assert.deepEqual(memory.copy["headline-main"], ["Happy Diwali"]);
});

test("memory edits are bounded and preserve the newest request", () => {
  let memory = emptyDesignMemory();
  for (let i = 0; i < FEATURES.memory.maxEdits + 5; i++) {
    memory = recordMemoryEdit(memory, {
      request: `edit request ${i}`,
      source: "assistant",
      changedIds: [`element-${i}`],
    });
  }
  assert.equal(memory.edits.length, FEATURES.memory.maxEdits);
  assert.equal(memory.edits[memory.edits.length - 1].request, "edit request 14");
  assert.deepEqual(memory.edits[memory.edits.length - 1].changedIds, ["element-14"]);
});

test("memoryForPrompt is bounded, parseable JSON and contains no geometry", () => {
  const memory = createDesignMemory({
    brief: "A very long brief ".repeat(100),
    goal: GOAL,
    plan: PLAN,
    design: DESIGN,
    regions: new Map([
      ["headline-main", { count: 1, ids: ["headline-main-text"] }],
      ["details-block", { count: 1, ids: ["details-block-group"] }],
    ]),
    quality: { score: 80, issues: [] },
  });

  for (const limit of [FEATURES.memory.promptChars, 400, 120, 2]) {
    const prompt = memoryForPrompt(memory, limit);
    assert.ok(prompt.length <= Math.max(limit, 2), `prompt respects ${limit}`);
    assert.doesNotThrow(() => JSON.parse(prompt), `prompt is valid JSON at ${limit}`);
    assert.ok(!prompt.includes("\"elements\""), "no full element list");
    assert.ok(!prompt.includes("\"box\""), "no geometry boxes");
  }
});

test("persist dedupe ignores timestamps but notices content changes", () => {
  const memory = normalizeDesignMemory({ brief: "a card", goal: GOAL });
  const same = { ...memory, updatedAt: "2026-01-02T00:00:00.000Z" };
  const changed = { ...memory, brief: "another card" };
  assert.equal(memoryPersistKey(memory), memoryPersistKey(same));
  assert.notEqual(memoryPersistKey(memory), memoryPersistKey(changed));
});
