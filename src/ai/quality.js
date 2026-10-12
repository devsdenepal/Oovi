/**
 * Layout-quality gate (Phase 3). Pure functions — no Fabric, no AI —
 * so they run in node tests as well as the browser.
 *
 * evaluateDesign() measures the RENDERED design with canvas-relative
 * thresholds. It REPORTS issues only; nothing here mutates a design.
 * Intentional overlap, bleed and asymmetry are preserved by design:
 * only text-on-text obscuring, out-of-canvas text, unreadable sizes and
 * failing contrast are errors. Everything debatable is a warning.
 */

function clampNum(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

const NAMED = {
  white: "#ffffff", black: "#000000", red: "#ff0000", blue: "#0000ff",
  green: "#008000", yellow: "#ffff00", purple: "#800080", orange: "#ffa500",
  pink: "#ffc0cb", gray: "#808080", grey: "#808080", transparent: null,
};

function toRgb(color) {
  if (typeof color !== "string") return null;
  const v = color.trim().toLowerCase();
  if (NAMED[v] !== undefined) return NAMED[v] ? toRgb(NAMED[v]) : null;
  const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) return null;
  const l1 = luminance(ra);
  const l2 = luminance(rb);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Estimated pixel box for a text element (wrap-aware). */
export function textBox(el) {
  const fontSize = clampNum(el.fontSize, 24);
  const width = Math.max(8, clampNum(el.width, fontSize * 4));
  const perLine = Math.max(1, width / (fontSize * 0.55));
  const lines = Math.max(1, Math.ceil(String(el.content || "").length / perLine));
  return {
    x: clampNum(el.x, 0),
    y: clampNum(el.y, 0),
    w: width,
    h: lines * fontSize * (el.lineHeight || 1.2),
  };
}

/**
 * Flattened absolute boxes (groups offset by their origin).
 * NOTE: assumes group children are stored group-relative (true after a
 * renderer round-trip; AI-fresh groups conventionally use a 0,0 origin,
 * for which the same math holds).
 */
export function elementBoxes(elements, ox = 0, oy = 0) {
  const out = [];
  for (const el of elements || []) {
    if (!el || typeof el !== "object") continue;
    const kind = el.type;
    if (kind === "group" && Array.isArray(el.children)) {
      out.push(...elementBoxes(el.children, ox + clampNum(el.x, 0), oy + clampNum(el.y, 0)));
      continue;
    }
    let box = null;
    if (kind === "text") box = { ...textBox(el), x: ox + clampNum(el.x, 0), y: oy + clampNum(el.y, 0) };
    else if (kind === "rectangle" || kind === "image") {
      box = { x: ox + clampNum(el.x, 0), y: oy + clampNum(el.y, 0), w: Math.max(1, clampNum(el.width, 0)), h: Math.max(1, clampNum(el.height, 0)) };
    } else if (kind === "circle") {
      const r = Math.max(1, clampNum(el.radius, 0));
      box = { x: ox + clampNum(el.x, 0), y: oy + clampNum(el.y, 0), w: r * 2, h: r * 2 };
    } else if (kind === "line") {
      const pad = (el.strokeWidth || 2) / 2;
      box = {
        x: ox + Math.min(clampNum(el.x, 0), clampNum(el.x2, 0)) - pad,
        y: oy + Math.min(clampNum(el.y, 0), clampNum(el.y2, 0)) - pad,
        w: Math.abs(clampNum(el.x2, 0) - clampNum(el.x, 0)) + pad * 2,
        h: Math.abs(clampNum(el.y2, 0) - clampNum(el.y, 0)) + pad * 2,
      };
    }
    if (box) out.push({ id: el.id, role: el.role, kind, box });
  }
  return out;
}

function intersect(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * @param {object} design validated Design JSON
 * @param {{plannedIds?: string[], renderedIds?: string[], expectHero?: boolean}} [opts]
 * @returns {{score: number, issues: Array<{severity: "error"|"warn", code: string, message: string}>}}
 */
export function evaluateDesign(design, opts = {}) {
  const issues = [];
  const err = (code, message) => issues.push({ severity: "error", code, message });
  const warn = (code, message) => issues.push({ severity: "warn", code, message });
  const canvas = design?.canvas || {};
  const W = clampNum(canvas.width, 0);
  const H = clampNum(canvas.height, 0);
  if (!W || !H) {
    err("no-canvas", "Design has no usable canvas size.");
    return { score: 0, issues };
  }
  const boxes = elementBoxes(design.elements);
  const texts = boxes.filter((b) => b.kind === "text");

  // 1. Bounds — text escaping the canvas is an error; decorations may bleed.
  for (const b of boxes) {
    const over =
      Math.max(0, -b.box.x) + Math.max(0, -(W - (b.box.x + b.box.w))) +
      Math.max(0, -b.box.y) + Math.max(0, -(H - (b.box.y + b.box.h)));
    if (over <= 1) continue;
    const dim = Math.min(W, H);
    if (b.kind === "text") {
      err("overflow", `"${b.id}" extends past the canvas edge by ${Math.round(over)}px.`);
    } else if (b.role === "decoration") {
      continue;
    } else if (over > Math.max(8, dim * 0.02)) {
      warn("overflow", `"${b.id}" crosses the canvas edge by ${Math.round(over)}px.`);
    }
  }

  // 2. Text-on-text obscuring (shape layering is intentional — ignored).
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].box;
      const c = texts[j].box;
      const area = intersect(a, c);
      const smaller = Math.min(a.w * a.h, c.w * c.h);
      if (smaller > 0 && area / smaller > 0.15) {
        err("overlap", `"${texts[i].id}" and "${texts[j].id}" overlap (text obscured).`);
      }
    }
  }

  // 3. Tiny / unreadable text.
  for (const t of texts) {
    const el = (design.elements || []).find((e) => e.id === t.id) || {};
    const fs = el.fontSize || 0;
    if (fs > 0 && fs < 12) warn("tiny-text", `"${t.id}" is ${Math.round(fs)}px — unreadable at export.`);
  }

  // 4. Coverage (coarse grid sample of all painted boxes).
  const N = 48;
  let filled = 0;
  let leftHalf = 0;
  let rightHalf = 0;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const px = ((gx + 0.5) / N) * W;
      const py = ((gy + 0.5) / N) * H;
      if (boxes.some((b) => px >= b.box.x && px <= b.box.x + b.box.w && py >= b.box.y && py <= b.box.y + b.box.h)) {
        filled++;
        if (gx < N / 2) leftHalf++;
        else rightHalf++;
      }
    }
  }
  const coverage = filled / (N * N);
  if (coverage < 0.25) err("sparse", `Only ${Math.round(coverage * 100)}% of the canvas is used — the poster reads empty.`);
  else if (coverage < 0.4) warn("sparse", `Only ${Math.round(coverage * 100)}% of the canvas is used.`);
  if (coverage >= 0.25 && rightHalf > 0 && leftHalf / rightHalf < 0.35) {
    warn("balance", "Content is bunched on the left — the right half is nearly empty.");
  } else if (coverage >= 0.25 && leftHalf > 0 && rightHalf / leftHalf < 0.35) {
    warn("balance", "Content is bunched on the right — the left half is nearly empty.");
  }

  // 5. Headline prominence (canvas-relative).
  const sizes = texts.map((t) => {
    const el = (design.elements || []).find((e) => e.id === t.id) || {};
    return { id: t.id, role: el.role, fs: el.fontSize || 0 };
  });
  if (!sizes.length) {
    warn("no-text", "The design contains no text at all.");
  } else {
    const top = sizes.reduce((a, b) => (b.fs > a.fs ? b : a));
    if (top.fs < H * 0.05) {
      err("headline", `Largest type is ${Math.round(top.fs)}px on a ${H}px canvas — no clear headline.`);
    }
    const headlined = sizes.find((s) => s.role === "headline");
    if (headlined && headlined.fs < top.fs) {
      warn("headline", `"${headlined.id}" is marked headline but is not the largest text.`);
    }
    const header = sizes.find((s) => s.role === "header");
    if (header && top.fs > 0 && header.id !== top.id && header.fs > top.fs * 0.6) {
      warn("hierarchy", `"${header.id}" (header) is nearly as large as the headline — shrink it to kicker size.`);
    }
  }

  // 6. Contrast of text against the background.
  for (const t of texts) {
    const el = (design.elements || []).find((e) => e.id === t.id) || {};
    const ratio = contrastRatio(el.fill, canvas.background);
    if (ratio === null) continue;
    if (ratio < 3) err("contrast", `"${t.id}" contrast ${ratio.toFixed(1)}:1 is unreadable.`);
    else if (ratio < 4.5) warn("contrast", `"${t.id}" contrast ${ratio.toFixed(1)}:1 is weak.`);
  }

  // 7. Hero artwork (only when the plan asked for images).
  if (opts.expectHero) {
    const images = boxes.filter((b) => b.kind === "image");
    if (!images.length) {
      err("hero", "The plan called for artwork but no image rendered.");
    } else {
      const biggest = images.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
      if ((biggest.box.w * biggest.box.h) / (W * H) < 0.1) {
        warn("hero", `Largest artwork ("${biggest.id}") covers under 10% of the canvas.`);
      }
    }
  }

  // 8. Planned but never rendered.
  const rendered = new Set(opts.renderedIds || []);
  for (const id of opts.plannedIds || []) {
    if (!rendered.has(id)) err("missing", `Planned component "${id}" never rendered.`);
  }

  // 8b. Planned boxes: under-filled sections and small heroes.
  const comps = Array.isArray(opts.components) ? opts.components : [];
  for (const c of comps) {
    if (!c || !c.box) continue;
    const b = c.box;
    if (c.role === "hero" && b.width > 0 && b.height > 0 && (b.width * b.height) / (W * H) < 0.15) {
      warn("hero", `Hero "${c.id}" box covers under 15% of the canvas.`);
    }
    if (c.kind === "image") continue; // presence covered by hero/missing checks
    const inside = boxes.filter((f) => {
      const cx = f.box.x + f.box.w / 2;
      const cy = f.box.y + f.box.h / 2;
      return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
    });
    if (!inside.length) {
      warn("empty-section", `Planned section "${c.id}" rendered nothing inside its box.`);
    } else {
      const area = inside.reduce((s, f) => s + f.box.w * f.box.h, 0);
      if (b.width > 0 && b.height > 0 && area / (b.width * b.height) < 0.15) {
        warn("thin-section", `Planned section "${c.id}" looks nearly empty inside its box.`);
      }
    }
  }

  // 9. Ragged alignment + inconsistent gaps (text left edges / vertical rhythm).
  if (texts.length >= 3) {
    const edges = new Set(texts.map((t) => Math.round(t.box.x / 8) * 8));
    if (edges.size > 5) warn("alignment", `${edges.size} distinct text left-edges — alignment looks ragged.`);
    const ordered = [...texts].sort((a, b) => a.box.y - b.box.y);
    const gaps = [];
    for (let i = 1; i < ordered.length; i++) {
      const g = ordered[i].box.y - (ordered[i - 1].box.y + ordered[i - 1].box.h);
      if (g > 0) gaps.push(g);
    }
    if (gaps.length >= 3) {
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
      if (mean > 0 && Math.sqrt(variance) / mean > 0.8) {
        warn("spacing", "Vertical gaps between text blocks are inconsistent.");
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  return { score: Math.max(0, 100 - errors * 12 - warns * 4), issues };
}
