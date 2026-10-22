/**
 * Pipeline feature configuration.
 *
 * These are the knobs that are meant to be adjusted without touching prompts,
 * validators or the orchestrator. Change a value here, reload, and every layer
 * reads the same setting.
 *
 * Density:
 *   layout.gutters  | gap multiplier per named density (lower = tighter)
 *   layout.density  | the density new template builds start with
 *   layout.coverageTarget | minimum share of a reserved box L4 should fill
 *   layout.regionFill | minimum rendered fill per role before a region is
 *                      treated as under-built (not a style preference)
 *   layout.densityRepair | re-tune the same template, then replace any
 *                      remaining sparse region with deterministic composition
 *   decoration.*    | shape-count multiplier, minimum pieces and density
 *
 * Copy:
 *   strictRepetition | reject a region that reuses another region's
 *                      distinctive words (greetings/brand sign-offs excepted)
 *   repairPasses     | number of focused copy-deck rewrite calls
 *   maxRegionRepairs | most regions regenerated per repair pass
 *   regenerateBadCopy | retry L4 when its copy fails validation instead of
 *                      dropping the text in the final sanitizer
 */

export const FEATURES = {
  ai: {
    // Three model calls per layer: the initial answer plus two corrections.
    // A region that exhausts them is a hard failure, never a placeholder.
    maxAttempts: 3,
  },
  layout: {
    density: "tight",
    coverageTarget: 0.8,
    gutters: { tight: 0.42, dense: 0.6, normal: 0.82, airy: 1.2 },
    // Display roles are allowed to breathe; information regions are not. A
    // details box holding one small line is the failure this catches.
    regionFill: {
      headline: 0.18,
      tagline: 0.1,
      header: 0.1,
      details: 0.22,
      sections: 0.2,
      audience: 0.2,
      body: 0.2,
      footer: 0.1,
      cta: 0.1,
      default: 0.15,
    },
    densityRepair: true,
    maxDensityRepairs: 1,
  },
  decoration: {
    density: "dense",
    fallbackDensity: "normal",
    minPieces: 8,
    maxPieces: 24,
    counts: { sparse: 0.8, normal: 1.15, dense: 1.6 },
    builders: {
      circles: { base: 5, min: 2, max: 8 },
      stars: { base: 4, min: 1, max: 7 },
      dots: { base: 12, min: 5, max: 28 },
      squiggles: { base: 3, min: 1, max: 4 },
      pills: { base: 4, min: 1, max: 5 },
      dividers: { base: 6, min: 3, max: 9 },
      icons: { base: 3, min: 1, max: 4 },
      backgroundPatterns: { base: 2, min: 1, max: 4 },
    },
  },
  copy: {
    strictRepetition: true,
    repairPasses: 2,
    maxRegionRepairs: 2,
    regenerateBadCopy: true,
  },
  // Design-scoped model memory. Versioned JSON keeps the store portable if a
  // different backend (IndexedDB, a semantic memory service) is added later.
  memory: {
    version: 1,
    maxEdits: 10,
    maxImages: 8,
    maxUsedWords: 120,
    maxLinesPerRegion: 12,
    maxLineChars: 240,
    promptChars: 3200,
    goalMemoryChars: 1400,
    assistantMemoryChars: 2200,
  },
};
