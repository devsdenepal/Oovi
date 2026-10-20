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
 * NOTE on frames: live group children serialize CENTER-relative (Fabric
 * native: a child emitted at x becomes left = x - groupW/2). AI plans pack
 * children from 0, so rebasing each group to its min child restores the
 * packed origin exactly; exotic packing degrades gracefully.
 */
export function elementBoxes(elements, ox = 0, oy = 0) {
  const out = [];
  for (const el of elements || []) {
    if (!el || typeof el !== "object") continue;
    const kind = el.type;
    if (kind === "group" && Array.isArray(el.children)) {
      let minX = Infinity;
      let minY = Infinity;
      for (const k of el.children) {
        if (!k || typeof k !== "object") continue;
        minX = Math.min(minX, clampNum(k.x, 0));
        minY = Math.min(minY, clampNum(k.y, 0));
        if (k.type === "line") {
          minX = Math.min(minX, clampNum(k.x2, 0));
          minY = Math.min(minY, clampNum(k.y2, 0));
        }
      }
      if (!Number.isFinite(minX)) minX = 0;
      if (!Number.isFinite(minY)) minY = 0;
      out.push(...elementBoxes(el.children, ox + clampNum(el.x, 0) - minX, oy + clampNum(el.y, 0) - minY));
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
    if (box) out.push({ id: el.id, role: el.role, kind, box, fill: el.fill, fontSize: el.fontSize, fontWeight: el.fontWeight, gradient: el.gradient });
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
 * @param {{plannedIds?: string[], renderedIds?: string[], expectHero?: boolean, palette?: {background?: string, ink?: string, accent?: string}}} [opts]
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
  // Copy by element id. elementBoxes flattens groups, but the words live on the
  // leaf element, so walk the tree once for role/limit checks.
  const copy = new Map();
  const collectCopy = (els) => {
    for (const el of els || []) {
      if (!el || typeof el !== "object") continue;
      if (el.type === "text" && typeof el.content === "string") copy.set(el.id, el.content);
      if (el.type === "group" && Array.isArray(el.children)) collectCopy(el.children);
    }
  };
  collectCopy(design.elements);

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

  // 6. Contrast of text against its LOCAL backdrop (bar, disc, gradient —
  // never just the canvas, which is how same-ink-on-same-bar dissolves go
  // uncaught). Document order is bottom-first, so the nearest solid shape
  // below the text's center wins; artwork gets one capped notice instead
  // of per-glyph noise.
  for (const t of texts) {
    const fill = t.fill;
    if (typeof fill !== "string") continue;
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    const selfIdx = boxes.indexOf(t);
    let bed = null;
    for (let k = selfIdx - 1; k >= 0; k--) {
      const b = boxes[k];
      if (b.kind !== "rectangle" && b.kind !== "circle" && b.kind !== "image") continue;
      if (cx > b.box.x && cx < b.box.x + b.box.w && cy > b.box.y && cy < b.box.y + b.box.h) {
        bed = b;
        break;
      }
    }
    const judge = (ratio, where) => {
      if (ratio === null) return;
      if (ratio < 3) err("contrast", `"${t.id}" contrast ${ratio.toFixed(1)}:1 on ${where} is unreadable.`);
      else if (ratio < 4.5) warn("contrast", `"${t.id}" contrast ${ratio.toFixed(1)}:1 on ${where} is weak.`);
    };
    if (!bed) {
      judge(contrastRatio(fill, canvas.background), "canvas");
      continue;
    }
    if (bed.kind === "image") continue; // capped notice below
    if (typeof bed.fill === "string") {
      judge(contrastRatio(fill, bed.fill), `"${bed.id}"`);
      continue;
    }
    if (bed.gradient && Array.isArray(bed.gradient.stops) && bed.gradient.stops.length) {
      const rs = bed.gradient.stops
        .map((s) => contrastRatio(fill, s && s.color))
        .filter((r) => r !== null);
      if (!rs.length) continue;
      if (rs.every((r) => r < 3)) err("contrast", `"${t.id}" unreadable across the "${bed.id}" gradient.`);
      else if (rs.some((r) => r < 4.5)) warn("contrast", `"${t.id}" weak on part of the "${bed.id}" gradient.`);
      continue;
    }
    judge(contrastRatio(fill, canvas.background), "canvas");
  }
  {
    const arts = boxes.filter((b) => b.kind === "image");
    const onArt = arts.length && texts.some((t) => {
      const cx = t.box.x + t.box.w / 2;
      const cy = t.box.y + t.box.h / 2;
      return arts.some(
        (g) => cx > g.box.x && cx < g.box.x + g.box.w && cy > g.box.y && cy < g.box.y + g.box.h,
      );
    });
    if (onArt) warn("contrast", "Some text sits on artwork — verify contrast against the pixels on export.");
  }

  // 6b. Palette discipline + type discipline. Every painted fill must be
  // a plan color or a neutral; body copy runs on at most two families.
  const palette = opts.palette;
  if (palette) {
    const norm = (c) => {
      let v = typeof c === "string" ? c.trim().toLowerCase() : "";
      const short = v.match(/^#([0-9a-f]{3})$/);
      if (short) v = `#${short[1].split("").map((ch) => ch + ch).join("")}`;
      return v;
    };
    // Canvas roles are the vocabulary. A card painted `surface` or a CTA
    // painted `ctaSurface` is ON palette; the three-colour test called those
    // rogue and pushed L5 to snap them back to ink. Roles also make the check
    // stricter where it matters: a derived border can no longer pass as a
    // "neutral".
    const roleColors =
      palette.roles && typeof palette.roles === "object"
        ? Object.values(palette.roles)
        : [palette.background, palette.ink, palette.accent];
    const planColors = new Set(roleColors.map(norm).filter(Boolean));
    const isNeutral = (c) => {
      const v = norm(c);
      if (v === "" || v === "transparent" || v === "white" || v === "black" || v === "gray" || v === "grey") return true;
      const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
      if (!m) return false;
      let hex = m[1];
      if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return r === g && g === b;
    };
    const paints = [];
    const collect = (els) => {
      for (const el of els || []) {
        if (!el || typeof el !== "object") continue;
        if ((el.type === "text" || el.type === "rectangle" || el.type === "circle") && typeof el.fill === "string") {
          paints.push({ id: el.id, color: el.fill });
        }
        if (el.gradient && Array.isArray(el.gradient.stops)) {
          for (const s of el.gradient.stops) paints.push({ id: `${el.id}:stop`, color: s && s.color });
        }
        if (el.type === "group" && Array.isArray(el.children)) collect(el.children);
      }
    };
    collect(design.elements);
    const rogue = paints.filter((p) => !planColors.has(norm(p.color)) && !isNeutral(p.color));
    for (const r of rogue.slice(0, 3)) {
      warn("palette", `"${r.id}" uses ${r.color}, outside the plan palette — ration the accent, harmonize the rest.`);
    }
  }
  {
    const families = new Set();
    for (const el of design.elements || []) {
      if (el && el.type === "text") families.add(el.fontFamily || "Arial");
    }
    if (families.size > 2) {
      warn("typography", `${families.size} typefaces (${[...families].slice(0, 4).join(", ")}) — two max: one display, one text.`);
    }
  }

  // 7. Hero artwork (only when the plan asked for images).
  if (opts.expectHero) {
    const images = boxes.filter((b) => b.kind === "image");
    if (!images.length) {
      err("hero", "The plan called for artwork but no image rendered.");
    } else {
      const biggest = images.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
      const areaFrac = (biggest.box.w * biggest.box.h) / (W * H);
      if (areaFrac < 0.1) {
        warn("hero", `Largest artwork ("${biggest.id}") covers under 10% of the canvas.`);
      }
      // Focal thirds: a centered hero reads static unless it is a backdrop.
      const cx = biggest.box.x + biggest.box.w / 2;
      const cy = biggest.box.y + biggest.box.h / 2;
      if (
        areaFrac < 0.6 &&
        cx > W / 3 && cx < (2 * W) / 3 &&
        cy > H / 3 && cy < (2 * H) / 3
      ) {
        warn("focal", `Hero ("${biggest.id}") sits dead center — push the focal mass toward third-lines.`);
      }
      // Competing dominants: a huge hero AND a huge headline fight.
      const topFs = texts.reduce((m, t) => {
        const el = (design.elements || []).find((e) => e.id === t.id) || {};
        return Math.max(m, el.fontSize || 0);
      }, 0);
      if (areaFrac > 0.2 && topFs > H * 0.08) {
        warn("focal", "Hero and headline both dominate — step one down so a single focal wins (2:1).");
      }
    }
  }

  // 8. Planned but never rendered.
  const rendered = new Set(opts.renderedIds || []);
  for (const id of opts.plannedIds || []) {
    if (!rendered.has(id)) err("missing", `Planned component "${id}" never rendered.`);
  }

  // 8b. Planned boxes: under-filled sections, small heroes, role-fit.
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
      // A hero is the focal point: an empty one is a failed composition, not a
      // cosmetic warning. Every other empty region stays a warning so a sparse
      // brief does not trigger regeneration.
      if (c.role === "hero") {
        err("empty-hero", `Hero region "${c.id}" rendered nothing inside its box — a hero must carry visual content.`);
      } else {
        warn("empty-section", `Planned section "${c.id}" rendered nothing inside its box.`);
      }
      continue;
    }
    const area = inside.reduce((s, f) => s + f.box.w * f.box.h, 0);
    if (b.width > 0 && b.height > 0 && area / (b.width * b.height) < 0.15) {
      warn("thin-section", `Planned section "${c.id}" looks nearly empty inside its box.`);
    }
    // Role fit: the region must hold the KIND of content its role promises.
    if (c.role === "sections") {
      const lines = inside.filter((f) => f.kind === "text" && (copy.get(f.id) || "").trim()).length;
      if (lines < 2) {
        warn("role-content", `Section region "${c.id}" holds ${lines} line(s) — a section needs grouped entries, not one label.`);
      }
    }
    if (c.maxChars > 0) {
      const chars = inside.reduce((s, f) => s + (copy.get(f.id) || "").length, 0);
      if (chars > Math.round(c.maxChars * 1.4)) {
        warn("copy-length", `Region "${c.id}" holds ${chars} characters against a ${c.maxChars} limit — the copy is not fitting its slot.`);
      }
    }
  }

  // 8c. Supporting copy. A headline alone in a field of containers is the
  // "template with no design" failure the product must not ship.
  {
    const roles = new Set(texts.map((t) => t.role).filter(Boolean));
    const support = ["tagline", "details", "sections", "audience", "footer", "cta", "body"];
    if (roles.has("headline") && !support.some((r) => roles.has(r))) {
      warn("support", "The design is a headline with no supporting copy — add the facts, a tagline or a call to action.");
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

  // Spacious, not empty: a low-coverage design whose hierarchy, alignment
  // and contrast are otherwise clean is breathing room, not failure.
  const onlySparse = issues.filter((i) => i.severity === "error");
  const sparseErr = onlySparse.find((i) => i.code === "sparse");
  if (sparseErr && onlySparse.length === 1 && coverage >= 0.15) {
    sparseErr.severity = "warn";
    sparseErr.message += " (structured — treated leniently)";
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  return { score: Math.max(0, 100 - errors * 12 - warns * 4), issues };
}
