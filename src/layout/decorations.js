/**
 * Decoration vocabulary and deterministic vector builders.
 *
 * Gemma should not have to invent "a squiggle" as pixel coordinates on every
 * call. It picks a kind, a variant, a density and a palette role from this
 * closed vocabulary; the builders below expand that compact decision into
 * ordinary Design DSL primitives (rectangles, circles and lines). Those
 * primitives are editable like every other element, need no new renderer
 * type, and cannot smuggle text or arbitrary colours into a decoration layer.
 *
 * The builders are pure, deterministic and bounded. A decoration region never
 * consumes the whole element budget, and repeating the same spec produces the
 * same shapes (important for template previews and save-as-template).
 */

import { ensurePaletteRoles } from "./paletteRoles";

export const DECORATION_DENSITIES = ["sparse", "normal", "dense"];
export const DECORATION_COLOR_ROLES = ["accent", "ink", "secondary", "muted"];

export const DECORATION_KINDS = [
  {
    id: "circles",
    label: "Circles",
    variants: ["cluster", "row", "halo"],
    summary: "filled discs, concentric halos and playful clusters",
  },
  {
    id: "arcs",
    label: "Arcs",
    variants: ["sweep", "corner", "orbit"],
    summary: "open curved sweeps and partial rings, drawn as fine segmented strokes",
  },
  {
    id: "stars",
    label: "Stars",
    variants: ["scatter", "sparkle", "outline"],
    summary: "four-point sparkles and outlined five-point stars",
  },
  {
    id: "dots",
    label: "Dots",
    variants: ["scatter", "grid", "wave"],
    summary: "small accent dots, either scattered, gridded or flowing",
  },
  {
    id: "grids",
    label: "Grids",
    variants: ["lines", "frame"],
    summary: "thin technical grid lines or a clean corner frame",
  },
  {
    id: "squiggles",
    label: "Squiggles",
    variants: ["single", "stack"],
    summary: "hand-drawn wave lines for energy and rhythm",
  },
  {
    id: "underlines",
    label: "Underlines",
    variants: ["single", "double"],
    summary: "loose marker-style rules that can sit under a headline or label",
  },
  {
    id: "corner-brackets",
    label: "Corner brackets",
    variants: ["corners", "edges"],
    summary: "L-shaped crop marks that frame a region without closing it in",
  },
  {
    id: "ribbons",
    label: "Ribbons",
    variants: ["banner", "folded"],
    summary: "short banner shapes and folded ribbon tails",
  },
  {
    id: "pills",
    label: "Pills",
    variants: ["row", "stack"],
    summary: "soft capsule badges with restrained fills and outlines",
  },
  {
    id: "dividers",
    label: "Dividers",
    variants: ["rule", "diamond", "dots"],
    summary: "thin separators with a small centred detail",
  },
  {
    id: "icons",
    label: "Small icons",
    variants: ["sparkle", "star", "sun", "plus", "check", "arrow", "diamond", "flower", "bolt"],
    summary: "tiny vector glyphs drawn from the same palette as the layout",
  },
  {
    id: "background-patterns",
    label: "Background patterns",
    variants: ["dot-grid", "diagonal", "waves", "crosshatch", "rays"],
    summary: "low-contrast repeating texture that sits behind content",
  },
];

export const DECORATION_KIND_IDS = DECORATION_KINDS.map((item) => item.id);
export const DECORATION_BY_ID = Object.fromEntries(DECORATION_KINDS.map((item) => [item.id, item]));

/** Maximum primitives a single decoration region may add. */
export const MAX_DECORATION_PIECES = 24;

/**
 * Compact, stable text for the L4 prompt. It is deliberately outside
 * DESIGN_CORE: text regions should not pay the token cost of a vocabulary
 * they cannot use.
 */
export const DECORATION_VOCABULARY = DECORATION_KINDS.map(
  (item) => `- ${item.id}: ${item.variants.join(", ")}`,
).join("\n");

/**
 * JSON schema for one decoration spec. The schema lives here so the prompt,
 * the AI client and the tests all validate against the same vocabulary.
 */
export const DECORATION_SPEC_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: DECORATION_KIND_IDS },
    variant: { type: "string" },
    density: { type: "string", enum: DECORATION_DENSITIES },
    color: { type: "string", enum: DECORATION_COLOR_ROLES },
  },
  required: ["kind", "density", "color"],
  additionalProperties: false,
};

export const DECORATIONS_SCHEMA = {
  type: "array",
  maxItems: 2,
  items: DECORATION_SPEC_SCHEMA,
};

const DENSITY = { sparse: 0.8, normal: 1.15, dense: 1.6 };
const ALIASES = {
  circle: "circles",
  arc: "arcs",
  star: "stars",
  sparkle: "stars",
  sparkles: "stars",
  dot: "dots",
  grid: "grids",
  squiggle: "squiggles",
  underline: "underlines",
  "corner-bracket": "corner-brackets",
  bracket: "corner-brackets",
  brackets: "corner-brackets",
  ribbon: "ribbons",
  pill: "pills",
  divider: "dividers",
  icon: "icons",
  "small-icon": "icons",
  "small-icons": "icons",
  "background-pattern": "background-patterns",
  "background-patterns": "background-patterns",
  pattern: "background-patterns",
  patterns: "background-patterns",
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value) => Math.round(Number.isFinite(Number(value)) ? Number(value) : 0);

function normaliseKind(value) {
  const key = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z-]/g, "");
  if (!key) return "";
  if (DECORATION_BY_ID[key]) return key;
  return ALIASES[key] || "";
}

function normaliseVariant(value, definition) {
  const key = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, "-");
  return definition.variants.includes(key) ? key : definition.variants[0];
}

/**
 * Validate and canonicalise one model-authored decoration spec. Invalid or
 * partial specs are repaired to safe defaults; unknown kinds return null so a
 * caller can fall back to the region's deterministic default.
 */
export function normalizeDecorationSpec(raw, fallbackKind = "dots") {
  const value = raw && typeof raw === "object" ? raw : { kind: raw };
  const kind = normaliseKind(value.kind || value.type || value.name || fallbackKind);
  const definition = DECORATION_BY_ID[kind];
  if (!definition) return null;
  const density = DECORATION_DENSITIES.includes(String(value.density || "").toLowerCase())
    ? String(value.density).toLowerCase()
    : "normal";
  const rawColor = String(value.color || "").toLowerCase();
  const color =
    rawColor === "textprimary" || rawColor === "text-primary" || rawColor === "primary"
      ? "ink"
      : rawColor === "textsecondary" || rawColor === "text-secondary"
        ? "secondary"
        : DECORATION_COLOR_ROLES.includes(rawColor)
          ? rawColor
          : "accent";
  return {
    kind,
    variant: normaliseVariant(value.variant || value.style, definition),
    density,
    color,
  };
}

/** Accept one spec, an array, or a loose model value; return at most two. */
export function normalizeDecorationSpecs(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [raw]
      : raw && typeof raw === "object"
        ? [raw]
        : [];
  return list.map((item) => normalizeDecorationSpec(item)).filter(Boolean).slice(0, 2);
}

function inferKind(component = {}) {
  const text = `${component.id || ""} ${component.describe || ""}`.toLowerCase();
  if (/ribbon|banner/.test(text)) return "ribbons";
  if (/corner|bracket|frame|crop/.test(text)) return "corner-brackets";
  if (/underline|marker|swoosh/.test(text)) return "underlines";
  if (/divider|separator/.test(text)) return "dividers";
  if (/star|spark|celebrat|festive|diwali|holiday|christmas|new year|confetti/.test(text)) return "stars";
  if (/squiggle|wave|hand.?drawn/.test(text)) return "squiggles";
  if (/arc|curve|orbit|halo/.test(text)) return "arcs";
  if (/pill|badge|chip|tag/.test(text)) return "pills";
  if (/icon|glyph|symbol/.test(text)) return "icons";
  if (/grid|pattern|texture|dot|checker/.test(text)) return "background-patterns";
  if (/circle|round|disc/.test(text)) return "circles";
  return "dots";
}

/**
 * Deterministic default for a decorative region. Template previews use this
 * immediately (before any model call), and it is also the safety net when a
 * decoration response is unusable.
 */
export function defaultDecorationSpecs(component = {}) {
  const supplied = normalizeDecorationSpecs(component.decorations || component.decoration);
  if (supplied.length) return supplied;
  const kind = inferKind(component);
  const definition = DECORATION_BY_ID[kind];
  const box = component.box || {};
  const small = Number(box.height) > 0 && Number(box.height) < 30;
  return [
    {
      kind,
      variant: definition.variants[0],
      density: small ? "normal" : "dense",
      color: "accent",
    },
  ];
}

const SPECIFIC_DECORATION = /\b(ribbon|banner|corner|bracket|frame|underline|marker|swoosh|divider|separator|star|spark|festive|holiday|confetti|squiggle|wave|arc|curve|orbit|halo|pill|badge|chip|tag|icon|glyph|symbol|grid|pattern|texture|dot|circle|disc)\b/;

const RECOMMENDATION_RULES = [
  {
    test: /diwali|tihar|dashain|festival|festive|holiday|christmas|new year|celebration|birthday|party|wedding|marigold|rangoli|mandala/,
    kinds: [
      ["stars", "scatter"],
      ["icons", "flower"],
    ],
  },
  {
    test: /kid|playful|fun|whimsical|craft|hand.?drawn|zine|comic/,
    kinds: [
      ["squiggles", "stack"],
      ["stars", "sparkle"],
    ],
  },
  {
    test: /tech|startup|hackathon|developer|futur|cyber|pixel|digital|data|software/,
    kinds: [
      ["grids", "lines"],
      ["arcs", "sweep"],
    ],
  },
  {
    test: /luxury|elegant|editorial|fashion|beauty|wellness|serene|minimal|spa/,
    kinds: [
      ["underlines", "single"],
      ["circles", "halo"],
    ],
  },
  {
    test: /corporate|business|finance|professional|announcement|report|institutional/,
    kinds: [
      ["dividers", "rule"],
      ["corner-brackets", "corners"],
    ],
  },
  {
    test: /sale|offer|promo|discount|launch|deal|shop/,
    kinds: [
      ["ribbons", "banner"],
      ["stars", "scatter"],
    ],
  },
  {
    test: /music|art|gallery|photo|creative|culture|cinema/,
    kinds: [
      ["arcs", "sweep"],
      ["dots", "wave"],
    ],
  },
];

function contextText({ component, plan, goal, rawPrompt } = {}) {
  const goalBits = goal
    ? [
        goal.summary,
        goal.subject,
        goal.tone,
        goal.style,
        goal.purpose,
        goal.industry,
        ...(Array.isArray(goal.keywords) ? goal.keywords : []),
      ]
    : [];
  const planBits = plan ? [plan.style] : [];
  return [component?.id, component?.describe, ...planBits, ...goalBits, rawPrompt]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function recommendedSpecs(list) {
  return list.slice(0, 2).map(([kind, variant], index) => {
    const definition = DECORATION_BY_ID[kind];
    return {
      kind,
      variant: definition.variants.includes(variant) ? variant : definition.variants[0],
      density: index === 0 ? "dense" : "normal",
      color: index === 0 ? "accent" : "secondary",
    };
  });
}

/**
 * Art direction for the L4 prompt: a short, theme-grounded shortlist. The
 * model still makes the final choice, but q8 otherwise anchors on the first
 * example and paints every design with the same dots.
 */
export function recommendDecorationSpecs(context = {}) {
  const { component = {} } = context;
  const text = contextText(context);
  const declared = `${component.id || ""} ${component.describe || ""}`;
  const specific = SPECIFIC_DECORATION.test(declared.toLowerCase());
  const inferred = specific ? inferKind(component) : "";
  const thin = Number(component.box?.height) > 0 && Number(component.box.height) < 80;
  const themed = RECOMMENDATION_RULES.find((rule) => rule.test.test(text));

  if (specific && thin) {
    return recommendedSpecs([[inferred, DECORATION_BY_ID[inferred].variants[0]]]);
  }
  if (specific && themed && themed.kinds[0][0] === inferred) {
    return recommendedSpecs(themed.kinds);
  }
  if (specific && inferred) {
    return recommendedSpecs([[inferred, DECORATION_BY_ID[inferred].variants[0]]]);
  }
  if (themed) {
    return recommendedSpecs(themed.kinds);
  }
  return recommendedSpecs(thin ? [["stars", "scatter"]] : [["stars", "scatter"], ["dots", "scatter"]]);
}

function colorSet(palette, color) {
  const roles = ensurePaletteRoles(palette || {});
  const requested =
    color === "ink"
      ? roles.textPrimary
      : color === "secondary"
        ? roles.textSecondary
        : color === "muted"
          ? roles.muted
          : roles.accent;
  return {
    main: requested || roles.accent,
    accent: roles.accent,
    ink: roles.textPrimary,
    secondary: roles.textSecondary,
    muted: roles.muted,
    background: roles.background,
  };
}

function hashSeed(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pane(box, ratio = 0.04) {
  const w = Math.max(1, Number(box.width) || 0);
  const h = Math.max(1, Number(box.height) || 0);
  const pad = Math.max(1, Math.round(Math.min(w, h) * ratio));
  return {
    x: Number(box.x) + pad,
    y: Number(box.y) + pad,
    w: Math.max(1, w - pad * 2),
    h: Math.max(1, h - pad * 2),
  };
}

function fitCircle(area, cx, cy, radius) {
  const r = Math.max(1, Math.min(radius, area.w / 2, area.h / 2));
  return {
    cx: clamp(cx, area.x + r, area.x + area.w - r),
    cy: clamp(cy, area.y + r, area.y + area.h - r),
    r,
  };
}

function makeCollector(limit) {
  const items = [];
  const add = (element) => {
    if (!element || items.length >= limit) return false;
    items.push(element);
    return true;
  };
  // Builders read `add.count` to stop multi-piece motifs at the region
  // budget. Keep that counter on the function so callers cannot pass the
  // collector itself and accidentally bypass the bound.
  Object.defineProperty(add, "count", { get: () => items.length });
  return { items, add, get count() { return items.length; } };
}

function rect(id, x, y, width, height, fill, extra = {}) {
  return {
    id,
    type: "rectangle",
    role: "decoration",
    x: round(x),
    y: round(y),
    width: Math.max(1, round(width)),
    height: Math.max(1, round(height)),
    fill,
    ...extra,
  };
}

function circle(id, cx, cy, radius, fill, extra = {}) {
  const r = Math.max(1, radius);
  return {
    id,
    type: "circle",
    role: "decoration",
    x: round(cx - r),
    y: round(cy - r),
    radius: Math.max(1, round(r)),
    fill,
    ...extra,
  };
}

function line(id, x1, y1, x2, y2, stroke, strokeWidth = 2, extra = {}) {
  return {
    id,
    type: "line",
    role: "decoration",
    x: round(x1),
    y: round(y1),
    x2: round(x2),
    y2: round(y2),
    stroke,
    strokeWidth: Math.max(1, Math.round(strokeWidth)),
    ...extra,
  };
}

function clipSegment(x1, y1, x2, y2, box) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - box.x, box.x + box.w - x1, y1 - box.y, box.y + box.h - y1];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  if (t0 > t1) return null;
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function addLine(base, index, x1, y1, x2, y2, stroke, width, add, extra = {}) {
  add(line(`${base}-line-${index}`, x1, y1, x2, y2, stroke, width, extra));
}

function polyline(base, points, stroke, width, add, extra = {}, offset = 0) {
  for (let i = 1; i < points.length; i++) {
    addLine(
      base,
      offset + i - 1,
      points[i - 1][0],
      points[i - 1][1],
      points[i][0],
      points[i][1],
      stroke,
      width,
      add,
      extra,
    );
  }
}

function starPoints(cx, cy, radius, points = 5, inner = 0.44, rotation = -Math.PI / 2) {
  const out = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? radius : radius * inner;
    const angle = rotation + (i * Math.PI) / points;
    out.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  out.push(out[0]);
  return out;
}

function sparkle(base, cx, cy, radius, stroke, width, add, opacity = 0.9) {
  const arms = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  arms.forEach(([dx, dy], i) => {
    addLine(
      base,
      i,
      cx,
      cy,
      cx + dx * radius,
      cy + dy * radius,
      stroke,
      width,
      add,
      { opacity },
    );
  });
}

/* ------------------------------------------------------------------ kinds */

function buildCircles({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.06);
  const min = Math.min(area.w, area.h);
  const count = clamp(Math.round(5 * DENSITY[spec.density]), 2, 8);
  const radius = clamp(min * (spec.variant === "halo" ? 0.3 : 0.2), 2, 58);
  const rng = seeded(`${base}:circles`);

  if (spec.variant === "halo") {
    add(
      circle(`${base}-halo`, area.x + area.w * 0.5, area.y + area.h * 0.5, radius, colors.background, {
        stroke: colors.main,
        strokeWidth: Math.max(2, Math.round(radius * 0.09)),
        opacity: 0.95,
      }),
    );
    add(
      circle(`${base}-core`, area.x + area.w * 0.5, area.y + area.h * 0.5, radius * 0.36, colors.main, {
        opacity: 0.9,
      }),
    );
    return;
  }

  const row = spec.variant === "row" || area.w > area.h * 4;
  for (let i = 0; i < count && add.count < limit; i++) {
    const t = (i + 0.5) / count;
    const r = radius * (row ? 0.7 + rng() * 0.55 : 0.55 + rng() * 0.9);
    const cx = row
      ? area.x + area.w * t
      : area.x + area.w * (0.12 + rng() * 0.76);
    const cy = row
      ? area.y + area.h * (0.42 + rng() * 0.16)
      : area.y + area.h * (0.14 + rng() * 0.72);
    const fitted = fitCircle(area, cx, cy, r);
    add(circle(`${base}-${i}`, fitted.cx, fitted.cy, fitted.r, i % 3 === 1 ? colors.secondary : colors.main, {
      opacity: i % 3 === 2 ? 0.45 : 0.88,
    }));
    if (i === 0 && count > 2 && add.count < limit) {
      const detail = fitCircle(area, fitted.cx + fitted.r * 0.35, fitted.cy - fitted.r * 0.3, fitted.r * 0.28);
      add(circle(`${base}-detail`, detail.cx, detail.cy, detail.r, colors.ink, { opacity: 0.55 }));
    }
  }
}

function buildArcs({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.05);
  const min = Math.min(area.w, area.h);
  const center =
    spec.variant === "corner"
      ? { x: area.x + area.w * 0.18, y: area.y + area.h * 0.2 }
      : spec.variant === "orbit"
        ? { x: area.x + area.w * 0.5, y: area.y + area.h * 0.5 }
        : { x: area.x + area.w * 0.3, y: area.y + area.h * 0.55 };
  // An arc can only be as large as the nearest edge of its centre, otherwise
  // a tall box sends the sweep outside the reserved strip.
  const reach = Math.min(
    center.x - area.x,
    area.x + area.w - center.x,
    center.y - area.y,
    area.y + area.h - center.y,
  );
  const radius = clamp(Math.min(min * 0.42, reach * 0.96), 2, Math.max(2, min * 0.7));
  const width = clamp(min * 0.035, 1.5, 6);
  const start = spec.variant === "corner" ? 0 : spec.variant === "orbit" ? 200 : -65;
  const end = spec.variant === "corner" ? 90 : spec.variant === "orbit" ? 340 : 65;
  const segments = clamp(Math.round(Math.abs(end - start) / 12), 6, 14);
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const angle = ((start + ((end - start) * i) / segments) * Math.PI) / 180;
    points.push([center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius]);
  }
  polyline(`${base}-arc`, points, colors.main, width, add, { opacity: 0.82 });

  if (spec.density !== "sparse" && add.count < limit) {
    const r2 = radius * 0.72;
    const points2 = [];
    for (let i = 0; i <= segments; i++) {
      const angle = ((start + 18 + ((end - start) * i) / segments) * Math.PI) / 180;
      points2.push([center.x + Math.cos(angle) * r2, center.y + Math.sin(angle) * r2]);
    }
    polyline(`${base}-arc-2`, points2, colors.secondary, Math.max(1, width * 0.65), add, {
      opacity: 0.55,
    });
  }
}

function buildStars({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.06);
  const min = Math.min(area.w, area.h);
  const radius = clamp(min * 0.22, 2.5, 30);
  const width = clamp(min * 0.032, 1.4, 4);
  const rng = seeded(`${base}:stars`);

  if (spec.variant === "outline") {
    const big = clamp(min * 0.34, 7, 54);
    const points = starPoints(area.x + area.w * 0.5, area.y + area.h * 0.5, big);
    polyline(`${base}-star`, points, colors.main, width, add, { opacity: 0.9 });
    return;
  }

  // A four-point star reads as a star at decoration scale; four bare arms
  // read as a plus sign. Each star is a closed eight-segment polyline, so the
  // piece budget is spent on shape rather than on a dense field of ticks.
  const count = clamp(Math.round(4 * DENSITY[spec.density]), 1, 7);
  for (let i = 0; i < count && add.count + 8 <= limit; i++) {
    const cx = area.x + area.w * (0.12 + rng() * 0.76);
    const cy = area.y + area.h * (0.14 + rng() * 0.72);
    const r = radius * (0.72 + rng() * 0.6);
    const fitted = fitCircle(area, cx, cy, r);
    const points = starPoints(fitted.cx, fitted.cy, fitted.r, 4, 0.36);
    polyline(
      `${base}-spark-${i}`,
      points,
      i % 2 ? colors.secondary : colors.main,
      width,
      add,
      { opacity: 0.88 },
    );
  }
}

function buildDots({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.035);
  const min = Math.min(area.w, area.h);
  const spacing = clamp(Math.max(min * 0.18, 6), 6, 44);
  const radius = clamp(spacing * 0.12, 1.2, 5.2);
  const areaScale = clamp(Math.sqrt((area.w * area.h) / (420 * 260)), 0.8, 1.7);
  const target = clamp(Math.round(12 * DENSITY[spec.density] * areaScale), 5, 28);
  const rng = seeded(`${base}:dots`);

  if (spec.variant === "grid") {
    const cols = clamp(Math.floor(area.w / Math.max(1, spacing * 0.9)), 2, 7);
    const rows = clamp(Math.floor(area.h / Math.max(1, spacing * 0.9)), 1, 4);
    for (let row = 0; row < rows && add.count < limit; row++) {
      for (let col = 0; col < cols && add.count < limit; col++) {
        add(circle(
          `${base}-dot-${row}-${col}`,
          area.x + ((col + 0.5) / cols) * area.w,
          area.y + ((row + 0.5) / rows) * area.h,
          radius,
          colors.main,
          { opacity: 0.55 },
        ));
      }
    }
    return;
  }

  for (let i = 0; i < target && add.count < limit; i++) {
    const t = (i + 0.5) / target;
    const cx = area.x + area.w * (spec.variant === "wave" ? t : 0.04 + rng() * 0.92);
    const cy =
      spec.variant === "wave"
        ? area.y + area.h * (0.5 + Math.sin(t * Math.PI * 3) * 0.24)
        : area.y + area.h * (0.08 + rng() * 0.84);
    const fitted = fitCircle(area, cx, cy, radius * (0.7 + rng() * 0.7));
    add(circle(
      `${base}-dot-${i}`,
      fitted.cx,
      fitted.cy,
      fitted.r,
      i % 4 === 0 ? colors.secondary : colors.main,
      { opacity: i % 4 === 0 ? 0.5 : 0.8 },
    ));
  }
}

function buildGrids({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.03);
  const min = Math.min(area.w, area.h);
  const width = clamp(min * 0.012, 0.75, 2);
  if (spec.variant === "frame") {
    const inset = clamp(min * 0.06, 1, 8);
    const points = [
      [area.x + inset, area.y + inset],
      [area.x + area.w - inset, area.y + inset],
      [area.x + area.w - inset, area.y + area.h - inset],
      [area.x + inset, area.y + area.h - inset],
      [area.x + inset, area.y + inset],
    ];
    polyline(`${base}-frame`, points, colors.main, width, add, { opacity: 0.38 });
    return;
  }

  const step = clamp(min / 5, 10, 72);
  const cols = clamp(Math.floor(area.w / step), 1, 8);
  const rows = clamp(Math.floor(area.h / step), 1, 5);
  let n = 0;
  for (let col = 1; col < cols; col++) {
    if (add.count >= limit) return;
    addLine(`${base}-v`, n++, area.x + (col / cols) * area.w, area.y, area.x + (col / cols) * area.w, area.y + area.h, colors.main, width, add, { opacity: 0.25 });
  }
  for (let row = 1; row < rows; row++) {
    if (add.count >= limit) return;
    addLine(`${base}-h`, n++, area.x, area.y + (row / rows) * area.h, area.x + area.w, area.y + (row / rows) * area.h, colors.main, width, add, { opacity: 0.25 });
  }
  if (add.count < limit) {
    addLine(`${base}-base`, n, area.x, area.y + area.h, area.x + area.w, area.y + area.h, colors.secondary, width, add, { opacity: 0.35 });
  }
}

function buildSquiggles({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.06);
  const rows = spec.variant === "stack" ? clamp(Math.round(3 * DENSITY[spec.density]), 1, 4) : 1;
  const amp = clamp(area.h * 0.16, 1.5, 12);
  const segments = clamp(Math.round(area.w / 38), 5, 12);
  const width = clamp(Math.min(area.w, area.h) * 0.03, 1.4, 4);
  let lineIndex = 0;

  for (let row = 0; row < rows; row++) {
    const baseline = area.y + area.h * ((row + 1) / (rows + 1));
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const x = area.x + (i / segments) * area.w;
      const wave = Math.sin((i / segments) * Math.PI * 3.2 + row * 0.8) * amp;
      points.push([x, baseline + wave]);
    }
    for (let i = 1; i < points.length && add.count < limit; i++) {
      addLine(
        `${base}-wave-${row}`,
        lineIndex++,
        points[i - 1][0],
        points[i - 1][1],
        points[i][0],
        points[i][1],
        row % 2 ? colors.secondary : colors.main,
        width,
        add,
        { opacity: 0.8 },
      );
    }
  }
}

function buildUnderlines({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.05);
  const rows = spec.variant === "double" ? 2 : 1;
  const width = clamp(Math.min(area.w, area.h) * 0.035, 1.5, 4);
  const amp = clamp(area.h * 0.06, 0.8, 5);
  const segments = clamp(Math.round(area.w / 42), 4, 10);
  let n = 0;

  for (let row = 0; row < rows; row++) {
    const startX = area.x + area.w * (row === 0 ? 0.12 : 0.2);
    const endX = area.x + area.w * (row === 0 ? 0.88 : 0.7);
    const y = area.y + area.h * (row === 0 ? 0.7 : 0.84);
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      points.push([startX + (endX - startX) * t, y + Math.sin(t * Math.PI * 2.4) * amp]);
    }
    for (let i = 1; i < points.length && add.count < limit; i++) {
      addLine(
        `${base}-rule-${row}`,
        n++,
        points[i - 1][0],
        points[i - 1][1],
        points[i][0],
        points[i][1],
        row === 0 ? colors.main : colors.secondary,
        row === 0 ? width : Math.max(1, width * 0.6),
        add,
        { opacity: row === 0 ? 0.9 : 0.55 },
      );
    }
  }
}

function buildCornerBrackets({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.03);
  const min = Math.min(area.w, area.h);
  const len = clamp(min * 0.34, 5, 48);
  const inset = Math.max(1, Math.min(area.w, area.h) * 0.04);
  const width = clamp(min * 0.04, 1.5, 5);
  const corners = [
    [area.x + inset, area.y + inset, 1, 1],
    [area.x + area.w - inset, area.y + inset, -1, 1],
    [area.x + inset, area.y + area.h - inset, 1, -1],
    [area.x + area.w - inset, area.y + area.h - inset, -1, -1],
  ];
  const chosen =
    spec.variant === "edges" || area.w > area.h * 5
      ? [corners[0], corners[1]]
      : corners;
  let n = 0;
  for (const [x, y, dx, dy] of chosen) {
    if (add.count >= limit) return;
    addLine(`${base}-x`, n++, x, y, x + len * dx, y, colors.main, width, add, { opacity: 0.85 });
    if (add.count >= limit) return;
    addLine(`${base}-y`, n++, x, y, x, y + len * dy, colors.main, width, add, { opacity: 0.85 });
  }
}

function buildRibbons({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.06);
  const bandH = clamp(area.h * 0.46, 4, 46);
  const bandW = clamp(area.w * 0.62, 12, area.w);
  const x = area.x + (area.w - bandW) / 2;
  const y = area.y + (area.h - bandH) / 2;
  const tailW = clamp(area.w * 0.08, 3, 34);
  const tailH = bandH * 0.72;
  const folded = spec.variant === "folded";

  if (folded) {
    add(rect(`${base}-tail-left`, x - tailW * 0.6, y + bandH * 0.15, tailW, tailH, colors.secondary, {
      opacity: 0.72,
      cornerRadius: Math.max(1, tailH * 0.12),
    }));
    add(rect(`${base}-tail-right`, x + bandW - tailW * 0.4, y + bandH * 0.15, tailW, tailH, colors.secondary, {
      opacity: 0.72,
      cornerRadius: Math.max(1, tailH * 0.12),
    }));
  }
  add(rect(`${base}-band`, x, y, bandW, bandH, colors.main, {
    opacity: 0.92,
    cornerRadius: Math.max(1, Math.min(bandH * 0.18, 4)),
  }));
  if (add.count < limit) {
    addLine(
      `${base}-fold-line`,
      0,
      x + tailW * 0.1,
      y + bandH * 0.18,
      x + tailW * 0.1,
      y + bandH * 0.82,
      colors.ink,
      Math.max(1, bandH * 0.06),
      add,
      { opacity: 0.3 },
    );
  }
}

function buildPills({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.05);
  const stack = spec.variant === "stack" || area.h > area.w * 1.8;
  const count = clamp(Math.round(4 * DENSITY[spec.density]), 1, 5);
  const slotW = stack ? area.w : area.w / count;
  const slotH = stack ? area.h / count : area.h;
  for (let i = 0; i < count && add.count < limit; i++) {
    const w = stack ? area.w * (0.45 + (i % 2) * 0.32) : slotW * 0.78;
    const h = clamp(slotH * (stack ? 0.42 : 0.38), 3, 26);
    const x = stack ? area.x + area.w * 0.06 : area.x + slotW * i + (slotW - w) / 2;
    const y = stack ? area.y + slotH * i + (slotH - h) / 2 : area.y + (area.h - h) / 2;
    add(rect(`${base}-pill-${i}`, x, y, w, h, i === 0 ? colors.main : colors.background, {
      opacity: i === 0 ? 0.28 : 1,
      stroke: colors.main,
      strokeWidth: Math.max(1, Math.min(2, h * 0.1)),
      cornerRadius: h / 2,
    }));
  }
}

function buildDividers({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.04);
  const y = area.y + area.h * 0.5;
  const width = clamp(Math.min(area.w, area.h) * 0.04, 1.2, 3);
  const left = area.x + area.w * 0.1;
  const right = area.x + area.w * 0.9;
  const middle = (left + right) / 2;

  if (spec.variant === "dots") {
    const count = clamp(Math.round(6 * DENSITY[spec.density]), 3, 9);
    for (let i = 0; i < count && add.count < limit; i++) {
      const t = (i + 0.5) / count;
      add(circle(`${base}-dot-${i}`, left + (right - left) * t, y, i === Math.floor(count / 2) ? 3 : 1.7, colors.main, { opacity: 0.75 }));
    }
    return;
  }

  addLine(`${base}-rule`, 0, left, y, right, y, colors.main, width, add, { opacity: 0.72 });
  if (spec.variant === "diamond") {
    const r = clamp(area.h * 0.22, 3, 10);
    const points = [
      [middle, y - r],
      [middle + r, y],
      [middle, y + r],
      [middle - r, y],
      [middle, y - r],
    ];
    polyline(`${base}-diamond`, points, colors.accent, Math.max(1, width * 0.9), add, { opacity: 0.95 });
  } else if (add.count < limit) {
    add(circle(`${base}-centre`, middle, y, 2, colors.accent, { opacity: 0.95 }));
  }
}

function glyphSparkle(base, cx, cy, r, colors, add, limit) {
  sparkle(base, cx, cy, r, colors.main, Math.max(1.2, r * 0.12), add, 0.92);
}

function glyphStar(base, cx, cy, r, colors, add) {
  const points = starPoints(cx, cy, r, 5, 0.44);
  polyline(base, points, colors.main, Math.max(1.2, r * 0.1), add, { opacity: 0.92 });
}

function glyphSun(base, cx, cy, r, colors, add, limit) {
  add(circle(`${base}-core`, cx, cy, r * 0.3, colors.main, { opacity: 0.92 }));
  for (let i = 0; i < 8; i++) {
    if (add.count >= limit) return;
    const angle = (i * Math.PI) / 4;
    addLine(
      `${base}-ray`,
      i,
      cx + Math.cos(angle) * r * 0.48,
      cy + Math.sin(angle) * r * 0.48,
      cx + Math.cos(angle) * r,
      cy + Math.sin(angle) * r,
      colors.main,
      Math.max(1.2, r * 0.08),
      add,
      { opacity: 0.85 },
    );
  }
}

function glyphPlus(base, cx, cy, r, colors, add) {
  addLine(`${base}-v`, 0, cx, cy - r, cx, cy + r, colors.main, Math.max(1.4, r * 0.16), add, { opacity: 0.9 });
  addLine(`${base}-h`, 0, cx - r, cy, cx + r, cy, colors.main, Math.max(1.4, r * 0.16), add, { opacity: 0.9 });
}

function glyphCheck(base, cx, cy, r, colors, add) {
  const width = Math.max(1.5, r * 0.16);
  addLine(`${base}-a`, 0, cx - r * 0.8, cy, cx - r * 0.1, cy + r * 0.65, colors.main, width, add, { opacity: 0.92 });
  addLine(`${base}-b`, 0, cx - r * 0.1, cy + r * 0.65, cx + r * 0.9, cy - r * 0.7, colors.main, width, add, { opacity: 0.92 });
}

function glyphArrow(base, cx, cy, r, colors, add) {
  const width = Math.max(1.4, r * 0.14);
  addLine(`${base}-shaft`, 0, cx - r * 0.9, cy, cx + r * 0.8, cy, colors.main, width, add, { opacity: 0.9 });
  addLine(`${base}-head-a`, 0, cx + r * 0.25, cy - r * 0.6, cx + r * 0.85, cy, colors.main, width, add, { opacity: 0.9 });
  addLine(`${base}-head-b`, 0, cx + r * 0.25, cy + r * 0.6, cx + r * 0.85, cy, colors.main, width, add, { opacity: 0.9 });
}

function glyphDiamond(base, cx, cy, r, colors, add) {
  const points = [
    [cx, cy - r],
    [cx + r * 0.75, cy],
    [cx, cy + r],
    [cx - r * 0.75, cy],
    [cx, cy - r],
  ];
  polyline(base, points, colors.main, Math.max(1.3, r * 0.13), add, { opacity: 0.92 });
}

function glyphFlower(base, cx, cy, r, colors, add) {
  add(circle(`${base}-centre`, cx, cy, r * 0.24, colors.accent, { opacity: 0.95 }));
  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI * 2) / 5 - Math.PI / 2;
    add(circle(
      `${base}-petal-${i}`,
      cx + Math.cos(angle) * r * 0.48,
      cy + Math.sin(angle) * r * 0.48,
      r * 0.3,
      colors.main,
      { opacity: 0.72 },
    ));
  }
}

function glyphBolt(base, cx, cy, r, colors, add) {
  const points = [
    [cx + r * 0.18, cy - r],
    [cx - r * 0.55, cy + r * 0.08],
    [cx + r * 0.02, cy + r * 0.08],
    [cx - r * 0.2, cy + r],
    [cx + r * 0.62, cy - r * 0.12],
    [cx + r * 0.05, cy - r * 0.12],
    [cx + r * 0.18, cy - r],
  ];
  polyline(base, points, colors.main, Math.max(1.2, r * 0.11), add, { opacity: 0.9 });
}

const GLYPHS = {
  sparkle: glyphSparkle,
  star: glyphStar,
  sun: glyphSun,
  plus: glyphPlus,
  check: glyphCheck,
  arrow: glyphArrow,
  diamond: glyphDiamond,
  flower: glyphFlower,
  bolt: glyphBolt,
};

function buildIcons({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.08);
  const glyph = GLYPHS[spec.variant] ? spec.variant : "sparkle";
  const complex = glyph === "sun" || glyph === "star" || glyph === "flower";
  const count = complex ? 1 : clamp(Math.round(3 * DENSITY[spec.density]), 1, 4);
  const slot = area.w / count;
  const radius = Math.max(1, Math.min(30, Math.min(slot * 0.34, area.h * 0.34)));
  for (let i = 0; i < count && add.count < limit; i++) {
    const cx = count === 1 ? area.x + area.w * 0.5 : area.x + slot * (i + 0.5);
    const cy = area.y + area.h * 0.5;
    GLYPHS[glyph](`${base}-${glyph}-${i}`, cx, cy, radius, colors, add, limit);
  }
}

function buildBackgroundPatterns({ spec, box, colors, add, base, limit }) {
  const area = pane(box, 0.01);
  const min = Math.min(area.w, area.h);
  const opacity = 0.18;
  const width = clamp(min * 0.01, 0.75, 1.8);

  if (spec.variant === "dot-grid") {
    const spacing = clamp(Math.max(area.w, area.h) / 10, 14, 72);
    const cols = clamp(Math.floor(area.w / spacing), 1, 8);
    const rows = clamp(Math.floor(area.h / spacing), 1, 8);
    const radius = clamp(Math.min(area.w / cols, area.h / rows) * 0.1, 1, 3.8);
    for (let row = 0; row < rows && add.count < limit; row++) {
      for (let col = 0; col < cols && add.count < limit; col++) {
        add(circle(
          `${base}-dot-${row}-${col}`,
          area.x + ((col + 0.5) / cols) * area.w,
          area.y + ((row + 0.5) / rows) * area.h,
          radius,
          colors.main,
          { opacity },
        ));
      }
    }
    return;
  }

  if (spec.variant === "waves") {
    const rows = clamp(Math.round(2 * DENSITY[spec.density]), 1, 4);
    const segments = clamp(Math.round(area.w / 70), 5, 10);
    const amp = clamp(area.h * 0.08, 1, 7);
    let n = 0;
    for (let row = 0; row < rows && add.count < limit; row++) {
      const baseline = area.y + area.h * ((row + 1) / (rows + 1));
      const points = [];
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        points.push([area.x + t * area.w, baseline + Math.sin(t * Math.PI * 3.2 + row) * amp]);
      }
      for (let i = 1; i < points.length && add.count < limit; i++) {
        addLine(`${base}-wave-${row}`, n++, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], colors.main, width, add, { opacity });
      }
    }
    return;
  }

  if (spec.variant === "rays") {
    const cx = area.x + area.w * 0.5;
    const cy = area.y + area.h * 0.5;
    const radius = Math.max(area.w, area.h) * 0.8;
    for (let i = 0; i < 12 && add.count < limit; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const clipped = clipSegment(cx, cy, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, area);
      if (!clipped) continue;
      addLine(`${base}-ray-${i}`, i, clipped[0], clipped[1], clipped[2], clipped[3], colors.main, width, add, { opacity });
    }
    return;
  }

  const crosshatch = spec.variant === "crosshatch";
  const step = clamp(Math.max(area.w, area.h) / 9, 16, 70);
  let n = 0;
  for (let i = 0; i < 10 && add.count < limit; i++) {
    const x = area.x + (i / 9) * area.w;
    const clipped = clipSegment(x, area.y + area.h, x + area.h, area.y, area);
    if (clipped) addLine(`${base}-diag-${i}`, n++, clipped[0], clipped[1], clipped[2], clipped[3], colors.main, width, add, { opacity });
    if (crosshatch && add.count < limit) {
      const opposite = clipSegment(x, area.y, x + area.h, area.y + area.h, area);
      if (opposite) addLine(`${base}-cross-${i}`, n++, opposite[0], opposite[1], opposite[2], opposite[3], colors.main, width, add, { opacity });
    }
  }
  if (!add.count && step > 0) {
    addLine(`${base}-base`, 0, area.x, area.y + area.h, area.x + area.w, area.y + area.h, colors.main, width, add, { opacity });
  }
}

const BUILDERS = {
  circles: buildCircles,
  arcs: buildArcs,
  stars: buildStars,
  dots: buildDots,
  grids: buildGrids,
  squiggles: buildSquiggles,
  underlines: buildUnderlines,
  "corner-brackets": buildCornerBrackets,
  ribbons: buildRibbons,
  pills: buildPills,
  dividers: buildDividers,
  icons: buildIcons,
  "background-patterns": buildBackgroundPatterns,
};

/**
 * Expand one or two decoration specs into editable Design DSL primitives.
 *
 * @param {Array|object} specs decoration spec(s) from the model or defaults
 * @param {{x:number,y:number,width:number,height:number}} box reserved region
 * @param {{background:string,ink:string,accent:string,roles?:object}} palette
 * @param {{prefix?:string,limit?:number}} [options]
 * @returns {Array} flat DSL elements, all with role "decoration"
 */
export function buildDecorations(specs, box, palette, options = {}) {
  const x = Number(box?.x);
  const y = Number(box?.y);
  const width = Number(box?.width);
  const height = Number(box?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  const safeBox = { x, y, width, height };
  const list = normalizeDecorationSpecs(specs);
  const finalSpecs = list.length ? list : normalizeDecorationSpecs(defaultDecorationSpecs({ box: safeBox }));
  if (!finalSpecs.length) return [];

  const prefix = String(options.prefix || "decoration").replace(/[^a-zA-Z0-9_-]/g, "-");
  const totalLimit = clamp(Math.round(options.limit ?? MAX_DECORATION_PIECES), 1, MAX_DECORATION_PIECES);
  // Give the main family the larger share of the budget; the second spec is
  // an accent, not an equal partner. This matters for sparse but large shapes
  // such as stars and arcs, which need several primitives per motif.
  const firstLimit = finalSpecs.length > 1 ? Math.ceil(totalLimit * 0.65) : totalLimit;
  const out = [];
  for (let index = 0; index < finalSpecs.length; index++) {
    const spec = finalSpecs[index];
    const definition = DECORATION_BY_ID[spec.kind];
    if (!definition) continue;
    const base = `${prefix}-${spec.kind}${finalSpecs.length > 1 ? `-${index + 1}` : ""}`;
    const specLimit = Math.min(index === 0 ? firstLimit : totalLimit, totalLimit - out.length);
    const collector = makeCollector(specLimit);
    const colors = colorSet(palette, spec.color);
    BUILDERS[spec.kind]({
      spec,
      box: safeBox,
      colors,
      add: collector.add,
      base,
      limit: specLimit,
    });
    out.push(...collector.items);
  }
  return out;
}
