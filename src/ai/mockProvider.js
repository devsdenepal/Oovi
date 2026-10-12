/**
 * Deterministic mock provider (Goal 4 constraint).
 *
 * Powers the UI and tests offline with zero tokens. Enabled via
 * `?mock=1` or `VITE_MOCK_AI=1`. Mock output is hand-built to always
 * pass validateDesign / validatePatch — no model involved.
 */

export function isMockEnabled() {
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1") return true;
  } catch {
    // non-browser (tests): fall through to env
  }
  try {
    return import.meta.env?.VITE_MOCK_AI === "1";
  } catch {
    return false;
  }
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PALETTES = [
  { bg: "#FFFFFF", ink: "#111111", accent: "#4F46E5", soft: "#EEF0FF" },
  { bg: "#0F1420", ink: "#F5F6FA", accent: "#00C4CC", soft: "#1E2A38" },
  { bg: "#FAF7F2", ink: "#1B2030", accent: "#DC2626", soft: "#F3E4DE" },
];

/**
 * Deterministic full design for the generate path (offline demo/tests).
 * @param {string} prompt
 * @param {{width:number,height:number}} canvas
 */
export function mockDesign(prompt, canvas) {
  const w = canvas?.width || 1200;
  const h = canvas?.height || 630;
  const pal = PALETTES[hash(String(prompt)) % PALETTES.length];
  const cx = w / 2;
  return {
    canvas: { width: w, height: h, background: pal.bg },
    elements: [
      { id: "header", type: "text", role: "header", content: "OOvi Studio", x: 48, y: 32, width: 400, fontSize: 24, fontWeight: 600, fill: pal.ink },
      { id: "headline", type: "text", role: "headline", content: "Design anything, edit everything", x: 48, y: Math.round(h * 0.22), width: Math.min(640, w - 96), fontSize: Math.min(72, Math.round(w / 14)), fontWeight: 800, fill: pal.ink },
      { id: "body", type: "text", role: "body", content: "A mock layout generated offline. Every element stays editable.", x: 48, y: Math.round(h * 0.52), width: Math.min(520, w - 96), fontSize: 20, fontWeight: 400, fill: pal.ink },
      { id: "accent-bar", type: "rectangle", role: "decoration", x: 48, y: Math.round(h * 0.72), width: 160, height: 14, fill: pal.accent, cornerRadius: 7 },
      { id: "cta", type: "text", role: "button", content: "Get started", x: 48, y: Math.round(h * 0.8), width: 300, fontSize: 22, fontWeight: 700, fill: pal.accent },
      { id: "side-dot", type: "circle", role: "decoration", x: Math.round(w - 140), y: Math.round(h * 0.3), radius: 44, fill: pal.soft },
      { id: "footer", type: "text", role: "footer", content: "oovi.design", x: 48, y: h - 48, width: 300, fontSize: 16, fontWeight: 400, fill: pal.ink },
    ],
  };
}

const COLOR_WORDS = {
  red: "#DC2626", blue: "#2563EB", green: "#16A34A", black: "#111111",
  white: "#FFFFFF", purple: "#4F46E5", orange: "#EA580C", pink: "#DB2777",
  yellow: "#CA8A04", teal: "#00C4CC",
};

function targetText(design, selectedIds) {
  const texts = (design.elements || []).filter((e) => e.type === "text");
  const sel = texts.find((e) => selectedIds.includes(e.id));
  return sel || texts.find((e) => e.role === "headline") || texts[0] || null;
}

/**
 * Deterministic patch for the assistant path. Keyword rules; anything
 * unmatched returns no ops with a guidance note (shown in chat).
 */
export function mockPatch(message, design, selectedIds = []) {
  const msg = String(message || "").toLowerCase();
  const canvas = design.canvas;
  const ops = [];
  const target = targetText(design, selectedIds);

  const colorHit = Object.keys(COLOR_WORDS).find((c) => msg.includes(c));
  if (colorHit && target) {
    ops.push({ op: "update", id: target.id, props: { fill: COLOR_WORDS[colorHit] } });
    return { ops, note: "" };
  }
  if (/bigger|larger|increase|grow/.test(msg) && target) {
    ops.push({ op: "update", id: target.id, props: { fontSize: Math.min(400, (target.fontSize || 32) + 12) } });
    return { ops, note: "" };
  }
  if (/smaller|shrink|decrease|reduce/.test(msg) && target) {
    ops.push({ op: "update", id: target.id, props: { fontSize: Math.max(12, (target.fontSize || 32) - 12) } });
    return { ops, note: "" };
  }
  if (/cent(er|re)/.test(msg) && target) {
    const width = target.width || 400;
    ops.push({ op: "update", id: target.id, props: { x: Math.max(0, Math.round((canvas.width - width) / 2)) } });
    return { ops, note: "" };
  }
  if (/remove|delete/.test(msg) && selectedIds.length > 0) {
    const removable = selectedIds.filter((id) =>
      (design.elements || []).some((e) => e.id === id && e.locked !== true),
    );
    removable.forEach((id) => ops.push({ op: "remove", id }));
    if (ops.length) return { ops, note: "" };
  }
  const addMatch = msg.match(/add (a |an )?(headline|text|button|rectangle|circle)/);
  if (addMatch) {
    const kind = addMatch[2];
    const id = `${kind}-${Date.now().toString(36)}`;
    if (kind === "circle") {
      ops.push({ op: "add", element: { id, type: "circle", role: "decoration", x: Math.round(canvas.width / 2 - 60), y: Math.round(canvas.height / 2 - 60), radius: 60, fill: "#4F46E5" } });
    } else if (kind === "rectangle") {
      ops.push({ op: "add", element: { id, type: "rectangle", role: "decoration", x: Math.round(canvas.width / 2 - 160), y: Math.round(canvas.height / 2 - 60), width: 320, height: 120, fill: "#4F46E5", cornerRadius: 12 } });
    } else {
      ops.push({ op: "add", element: { id, type: "text", role: kind === "button" ? "button" : "body", content: kind === "button" ? "Click me" : "New headline", x: Math.round(canvas.width / 2 - 200), y: Math.round(canvas.height / 2 - 30), width: 400, fontSize: kind === "headline" ? 48 : 24, fontWeight: 700, fill: "#111111" } });
    }
    return { ops, note: "" };
  }
  return { ops, note: "Try: “make it bigger”, “center”, “make it blue”, “add button”, “remove this” (with a selection)." };
}

/**
 * Deterministic architect plan (offline/tests): DSL text pieces plus one
 * icon routed to image generation.
 */
export function mockPlan(prompt, canvas) {
  const w = canvas?.width || 1200;
  const h = canvas?.height || 630;
  return {
    palette: { background: "#FFFFFF", ink: "#111111", accent: "#4F46E5" },
    style: "clean modern",
    components: [
      { id: "header", kind: "dsl", role: "header", describe: "Company name header text" },
      { id: "headline", kind: "dsl", role: "headline", describe: "Bold product headline" },
      {
        id: "brand-icon", kind: "image", role: "decoration", asset: "icon", describe: "flat rocket icon",
        box: { x: Math.max(0, w - 200), y: 48, width: 128, height: 128 },
      },
      { id: "footer", kind: "dsl", role: "footer", describe: "Footer text with website" },
    ],
  };
}

/** Deterministic DSL elements per mock plan component (always valid). */
export function mockComponent(component, canvas) {
  const w = canvas?.width || 1200;
  const h = canvas?.height || 630;
  const id = component.id;
  if (id === "header") {
    return [{ id: `${id}-txt`, type: "text", role: "header", content: "OOvi Studio", x: 48, y: 32, width: 400, fontSize: 24, fontWeight: 600, fill: "#111111" }];
  }
  if (id === "headline") {
    return [{ id: `${id}-txt`, type: "text", role: "headline", content: "Design anything, edit everything", x: 48, y: Math.round(h * 0.25), width: Math.min(640, w - 96), fontSize: 56, fontWeight: 800, fill: "#111111" }];
  }
  if (id === "footer") {
    return [{ id: `${id}-txt`, type: "text", role: "footer", content: "oovi.design", x: 48, y: h - 48, width: 300, fontSize: 16, fontWeight: 400, fill: "#111111" }];
  }
  return [{ id: `${id}-txt`, type: "text", role: "body", content: id, x: 48, y: Math.round(h / 2), width: 400, fontSize: 24, fontWeight: 400, fill: "#111111" }];
}

/** Deterministic offline asset: accent tile with the initial letter. */
export function mockAssetDataUrl(describe, box) {
  const w = Math.round(box?.width || 128);
  const h = Math.round(box?.height || 128);
  const letter = String(describe || "A").trim().charAt(0).toUpperCase() || "A";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" rx="${Math.round(Math.min(w, h) / 5)}" fill="#4F46E5"/>` +
    `<text x="${w / 2}" y="${h / 2}" font-size="${Math.round(Math.min(w, h) * 0.5)}" font-weight="800" fill="#FFFFFF" font-family="Arial" text-anchor="middle" dominant-baseline="central">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
