/**
 * Pipeline feature configuration.
 *
 * These are the knobs that are meant to be adjusted without touching prompts,
 * validators or the orchestrator. Change a value here, reload, and every layer
 * reads the same setting.
 *
 * Density:
 *   layout.gutters  — gap multiplier per named density (lower = tighter)
 *   layout.density  — the density new template builds start with
 *   layout.coverageTarget — minimum share of a reserved box L4 should fill
 *   decoration.*    — shape-count multiplier and default decoration density
 *
 * Copy:
 *   strictRepetition — reject a region that reuses another region's
 *                      distinctive words (greetings/brand sign-offs excepted)
 *   repairPasses     — 1 = first region repair only, 2 = one strict follow-up
 *   maxRegionRepairs — most regions regenerated per repair pass
 *   regenerateBadCopy — retry L4 when its copy fails validation instead of
 *                      dropping the text in the final sanitizer
 */

export const FEATURES = {
  layout: {
    density: "tight",
    coverageTarget: 0.8,
    gutters: { tight: 0.42, dense: 0.6, normal: 0.82, airy: 1.2 },
  },
  decoration: {
    density: "dense",
    fallbackDensity: "normal",
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
};
