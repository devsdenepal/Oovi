/**
 * Constraint-based layout engine.
 *
 * Resolves a Semantic Design (containers + elements with relative size
 * tokens) into a pixel Design JSON the existing Fabric renderer and
 * validator already understand. The LLM never computes coordinates; this
 * engine does, deterministically:
 *
 *   Semantic: { canvas?, containers?, elements }   (roles, flow, relative sizes)
 *   Pixel:    { canvas, elements }                 (absolute x/y/w/h)
 *
 * Sizing model (flex-like):
 *   - containers flow "vertical" (default) or "horizontal" with gap/padding
 *   - width tokens:  px | "50%" | "100%" | "fit-content" | "auto"
 *   - height tokens: px | "50%" | "100%" | "auto" (content-based)
 *   - cross axis: align start|center|end|stretch (stretch default)
 *   - main axis:   justify start|center|end|between|around
 *   - text wraps and auto-shrinks to fit its box
 *
 * Deterministic repair is part of resolution: elements are clamped to the
 * canvas, overflowing text fonts are shrunk, overlapping siblings are nudged
 * along the flow axis, and surplus decorations are dropped under the element
 * cap. The result still runs through the existing pixel validator afterwards.
 *
 * Pipeline: measureNode() builds a sized node tree; the emit pass translates
 * every node's element boxes into absolute canvas coordinates; normalize()
 * clamps and cleans the pixel elements.
 */

import { validateSemanticDesign } from "./semanticValidator";
import { sizeToPx, weightToNumber, aspectToNumber } from "./typeScale";

const DEFAULT_PADDING = 56;
const DEFAULT_GAP = 24;
const MAX_PIXEL_ELEMENTS = 30;
const MIN_FONT = 8;
const MAX_FONT = 400;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------- text measurement ----------------

let _measureCanvas = null;
function measureCtx() {
  if (!_measureCanvas) {
    _measureCanvas = document.createElement("canvas");
    _measureCanvas.width = 64;
    _measureCanvas.height = 64;
  }
  return _measureCanvas.getContext("2d");
}

function textWidthPx(text, fontSize, weight, family) {
  try {
    const ctx = measureCtx();
    ctx.font = `${weight || 400} ${fontSize}px ${family || "sans-serif"}`;
    return ctx.measureText(String(text)).width;
  } catch {
    return String(text).length * fontSize * 0.55;
  }
}

/** Wraps text to fit maxW and auto-shrinks font when a single word is too wide. */
function fitText(text, maxW, style) {
  const lh = style.lineHeight || 1.2;
  let fs = clamp(style.fontSize || 24, MIN_FONT, MAX_FONT);
  const weight = weightToNumber(style.weight);
  const family = style.family || "sans-serif";
  const capW = Math.max(1, maxW);

  if (textWidthPx(text, fs, weight, family) > capW) {
    const w0 = textWidthPx(text, fs, weight, family);
    fs = Math.max(MIN_FONT, Math.round((fs * Math.max(1, capW)) / w0));
  }

  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  let lineW = 0;
  const spaceW = textWidthPx(" ", fs, weight, family);
  for (const word of words) {
    const w = textWidthPx(word, fs, weight, family);
    const next = line ? lineW + spaceW + w : w;
    if (line && next > capW) {
      lines.push(line);
      line = word;
      lineW = w;
    } else {
      line = line ? line + " " + word : word;
      lineW = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length === 0) lines.push(String(text));

  const width = Math.min(capW, Math.max(...lines.map((l) => textWidthPx(l, fs, weight, family))));
  const height = lines.length * fs * lh;
  return { lines, width, height, fontSize: fs, weight, family, lineHeight: lh };
}

// ---------------- token / box helpers ----------------

function boxValue(v, def) {
  if (typeof v === "number") return { top: v, right: v, bottom: v, left: v };
  if (v && typeof v === "object") {
    return {
      top: v.top ?? def,
      right: v.right ?? def,
      bottom: v.bottom ?? def,
      left: v.left ?? def,
    };
  }
  return { top: def, right: def, bottom: def, left: def };
}

function isFixedToken(token) {
  if (typeof token === "number") return true;
  if (typeof token === "string") {
    const t = token.trim().toLowerCase();
    return t.endsWith("%") || /^\d+$/.test(t);
  }
  return false;
}

function resolveW(token, availW) {
  if (typeof token === "number") return Math.max(0, token);
  if (typeof token === "string") {
    const t = token.trim().toLowerCase();
    if (t === "100%" || t === "fit-content" || t === "auto") return Math.max(0, availW);
    const pct = /^(\d{1,3})%$/.exec(t);
    if (pct) return (availW * parseInt(pct[1], 10)) / 100;
    const px = parseInt(token, 10);
    if (!Number.isNaN(px)) return Math.max(0, px);
  }
  return Math.max(0, availW);
}

function resolveH(token, availH) {
  if (typeof token === "number") return Math.max(0, token);
  if (typeof token === "string") {
    const t = token.trim().toLowerCase();
    if (t === "100%") return availH == null ? null : Math.max(0, availH);
    if (t === "fit-content" || t === "auto") return null;
    const pct = /^(\d{1,3})%$/.exec(t);
    if (pct) return availH == null ? null : (availH * parseInt(pct[1], 10)) / 100;
    const px = parseInt(token, 10);
    if (!Number.isNaN(px)) return Math.max(0, px);
  }
  return null;
}

function alignOffset(align, space, childSize) {
  switch (align) {
    case "end":
      return Math.max(0, space - childSize);
    case "center":
      return Math.max(0, (space - childSize) / 2);
    default:
      return 0;
  }
}

// ---------------- main resolver ----------------

/**
 * @param {import("./semanticTypes").SemanticDesign} semanticJson
 * @param {{defaultCanvas?: {width:number,height:number,background:string}, heightRef?: number}} [options]
 */
export function resolveSemanticDesign(semanticJson, options = {}) {
  const check = validateSemanticDesign(semanticJson);
  if (!check.ok) {
    throw new Error(`Invalid semantic design: ${check.errors.slice(0, 6).join("; ")}`);
  }
  const sem = check.semantic;
  const warnings = [];

  const def = options.defaultCanvas || {};
  const cw = clamp(Math.round(sem.canvas?.width ?? def.width ?? 1080), 64, 4096);
  const ch = clamp(Math.round(sem.canvas?.height ?? def.height ?? 1080), 64, 4096);
  const canvas = {
    width: cw,
    height: ch,
    background: sem.canvas?.background || def.background || "#FFFFFF",
  };
  const heightRef = options.heightRef || Math.max(cw, ch);

  // ---- node registries ----
  const containerSpecs = new Map();
  for (const c of sem.containers || []) {
    containerSpecs.set(c.id, {
      id: c.id,
      direction: c.direction === "horizontal" ? "horizontal" : "vertical",
      justify: c.justify || "start",
      align: c.align || "stretch",
      gap: c.gap ?? DEFAULT_GAP,
      padding: boxValue(c.padding, DEFAULT_PADDING),
      margin: boxValue(c.margin, 0),
      width: c.width ?? "auto",
      height: c.height ?? "auto",
      children: Array.isArray(c.children) ? c.children : [],
    });
  }
  const elementsById = new Map();
  for (const el of sem.elements || []) elementsById.set(el.id, el);

  const layout = sem.layout && typeof sem.layout === "object" ? sem.layout : {};
  const rootSpec = containerSpecs.get("root") || {
    id: "root",
    direction: layout.direction === "horizontal" ? "horizontal" : "vertical",
    justify: layout.justify || "start",
    align: layout.align || "stretch",
    gap: layout.gap ?? DEFAULT_GAP,
    padding: boxValue(layout.padding, DEFAULT_PADDING),
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    width: "100%",
    height: "100%",
    children: [],
  };

  const referenced = new Set();
  for (const spec of containerSpecs.values()) {
    for (const child of spec.children || []) referenced.add(child);
  }
  const rootLevelContainers = [...containerSpecs.keys()].filter(
    (id) => id !== "root" && !referenced.has(id),
  );

  function childOrderOf(spec) {
    if (spec.children && spec.children.length) return spec.children;
    if (spec.id === "root") {
      return [
        ...rootLevelContainers,
        ...(sem.elements || [])
          .map((el) => el.id)
          .filter((id) => {
            const el = elementsById.get(id);
            return el.container === undefined || el.container === "root" || el.container === "";
          }),
      ];
    }
    return (sem.elements || []).filter((el) => el.container === spec.id).map((el) => el.id);
  }

  // ---------------- measurement ----------------
  function measureElement(el, availW, availH) {
    const style = el.style || {};
    const margin = typeof el.margin === "number" ? el.margin : style.margin || 0;
    const innerW = Math.max(1, availW - margin * 2);

    // Legacy: absolute position on canvas.
    if (typeof el.x === "number" && typeof el.y === "number") {
      const w = resolveW(el.width ?? style.width ?? 200, innerW);
      const h = resolveH(el.height ?? style.height ?? (el.type === "circle" ? 80 : 60), availH) ?? (el.type === "text" ? 24 : w * 0.75);
      return { w, h, emit: emitAbsolute(el, w, h, style), absolute: true };
    }

    const widthToken = el.width ?? style.width;
    const fixedW = isFixedToken(widthToken) && typeof el.width !== "undefined" || (typeof el.width === "undefined" && isFixedToken(style.width));
    let fontSize = sizeToPx(style.size ?? style.fontSize, heightRef);
    const weight = weightToNumber(style.weight);

    if (el.type === "text") {
      const maxTextW = fixedW ? Math.max(1, resolveW(widthToken, innerW)) : innerW;
      const fit = fitText(el.content || "", maxTextW, {
        fontSize,
        weight,
        family: style.family,
        lineHeight: style.lineHeight,
      });
      const w = fixedW ? resolveW(widthToken, innerW) : Math.min(fit.width, innerW);
      const h = fit.height;
      return {
        w,
        h,
        emit: [
          textEl(el, fit, w, style),
        ],
        fit,
      };
    }

    if (el.type === "button") {
      const padH = Math.max(12, fontSize * 0.8);
      const padV = Math.max(8, fontSize * 0.55);
      const maxTextW = fixedW ? Math.max(1, resolveW(widthToken, innerW) - padH * 2) : innerW - padH * 2;
      const fit = fitText(el.content || "", Math.max(1, maxTextW), {
        fontSize,
        weight,
        family: style.family,
        lineHeight: style.lineHeight,
      });
      const w = fixedW ? resolveW(widthToken, innerW) : Math.min(fit.width + padH * 2, innerW);
      const h = fit.height + padV * 2;
      const bg = {
        id: `${el.id}_bg`,
        type: "rectangle",
        role: el.role || "button",
        x: 0,
        y: 0,
        width: w,
        height: h,
        fill: style.fill || "#6C6CFF",
        cornerRadius: style.cornerRadius ?? Math.min(8, Math.round(h * 0.2)),
      };
      const label = {
        id: `${el.id}_label`,
        type: "text",
        role: el.role || "button",
        content: fit.lines.join("\n"),
        width: Math.max(fit.width, 1),
        fontSize: Math.round(fit.fontSize),
        fontWeight: weightToNumber(style.weight),
        fill: style.color?.startsWith("#") || style.color?.startsWith("rgb") || style.color?.toLowerCase?.() === "white" ? style.color : "#FFFFFF",
        textAlign: style.alignment || "center",
        lineHeight: style.lineHeight || 1.2,
        fontFamily: style.family || "sans-serif",
      };
      // vertical centering via y offset; horizontal centering via x offset
      const labelH = fit.lines.length * fit.fontSize * (style.lineHeight || 1.2);
      const tx = style.alignment === "left" ? padH : (w - fit.width) / 2;
      const ty = (h - labelH) / 2;
      return {
        w,
        h,
        emit: [
          bg,
          ...translateEl(label, tx, ty),
        ],
      };
    }

    if (el.type === "image") {
      const w = fixedW ? resolveW(widthToken, innerW) : innerW;
      const aspect = aspectToNumber(style.aspectRatio);
      let h;
      if (el.height !== undefined && isFixedToken(el.height)) {
        h = resolveH(el.height, availH) ?? w * (aspect || 0.75);
      } else if (aspect) {
        h = w / aspect;
      } else if (availH != null) {
        h = availH;
      } else {
        h = w * 0.75;
      }
      return { w, h, emit: emitImage(el, w, h, style) };
    }

    if (el.type === "rectangle") {
      const w = fixedW ? resolveW(widthToken, innerW) : innerW;
      const aspect = aspectToNumber(style.aspectRatio);
      let h;
      if (el.height !== undefined && isFixedToken(el.height)) {
        h = resolveH(el.height, availH) ?? w * (aspect || 0.75);
      } else if (aspect) {
        h = w / aspect;
      } else {
        // decorations/cards keep an intrinsic ratio unless height is explicit
        h = w * 0.5;
      }
      return {
        w,
        h,
        emit: [
          {
            id: el.id,
            type: "rectangle",
            role: el.role || "decoration",
            x: 0,
            y: 0,
            width: w,
            height: h,
            fill: style.fill || style.color || "#6C6CFF",
            cornerRadius: style.cornerRadius || 0,
          },
        ],
      };
    }

    if (el.type === "circle") {
      const r =
        typeof widthToken === "number"
          ? widthToken / 2
          : typeof style.radius === "number"
            ? style.radius
            : Math.min(availW, 120) / 2;
      return {
        w: r * 2,
        h: r * 2,
        emit: [
          {
            id: el.id,
            type: "circle",
            role: el.role || "decoration",
            x: 0,
            y: 0,
            radius: r,
            fill: style.fill || style.color || "#B9B9C4",
          },
        ],
      };
    }

    if (el.type === "line") {
      const strokeWidth = style.strokeWidth || 2;
      const w = fixedW ? resolveW(widthToken, innerW) : innerW;
      return {
        w,
        h: strokeWidth,
        emit: [
          {
            id: el.id,
            type: "line",
            role: el.role || "decoration",
            x: 0,
            y: 0,
            x2: w,
            y2: strokeWidth,
            stroke: style.stroke || style.color || "#6C6CFF",
            strokeWidth,
          },
        ],
      };
    }

    // group: flow its children vertically inside this element's box
    const pad = 8;
    const gapS = style.gap ?? 8;
    const slotW = Math.max(1, innerW - pad * 2);
    const groupChildren = (sem.elements || []).filter(
      (childEl) => childEl.id !== el.id && childEl.container === el.id,
    );
    const measured = [];
    let cursor = 0;
    let maxChildW = 0;
    for (const childEl of groupChildren) {
      const res = measureElement(childEl, slotW, null);
      measured.push({ el: childEl, res, offset: cursor });
      maxChildW = Math.max(maxChildW, res.w);
      cursor += res.h + gapS;
    }
    const groupW = fixedW ? resolveW(widthToken, innerW) : Math.min(maxChildW + pad * 2, innerW);
    const groupH = measured.length ? cursor - gapS + pad * 2 : pad * 2 + 20;
    return {
      w: groupW,
      h: groupH,
      emit: [],
      group: { pad, gap: gapS, children: measured },
    };
  }

  function emitAbsolute(el, w, h, style) {
    const base = {
      id: el.id,
      type: el.type === "circle" ? "circle" : el.type,
      role: el.role || undefined,
      x: el.x,
      y: el.y,
      width: w,
      height: h,
      radius: el.type === "circle" ? w / 2 : undefined,
      fill: style.fill || style.color || "#6C6CFF",
    };
    if (el.type === "circle") {
      base.width = undefined;
      base.height = undefined;
    }
    return [base];
  }

  function textEl(el, fit, w, style) {
    return {
      id: el.id,
      type: "text",
      role: el.role || "text",
      content: fit.lines.join("\n"),
      width: Math.max(fit.width, 1),
      fontSize: Math.round(fit.fontSize),
      fontWeight: fit.weight,
      fill: style.color || "#1B1B1F",
      textAlign: style.alignment || "left",
      lineHeight: style.lineHeight || 1.2,
      fontFamily: style.family || "sans-serif",
    };
  }

  function emitImage(el, w, h, style) {
    const labelH = clamp(Math.round(h * 0.12), 10, 32);
    const img = {
      id: `${el.id}_img`,
      type: "rectangle",
      role: el.role || "image",
      x: 0,
      y: 0,
      width: w,
      height: h,
      fill: style.fill || "#DEDEE4",
      cornerRadius: style.cornerRadius ?? 8,
    };
    const label = {
      id: `${el.id}_label`,
      type: "text",
      role: el.role || "image",
      content: el.role === "hero" ? "Hero image" : "Image",
      width: Math.max(w - 8, 1),
      fontSize: labelH,
      fontWeight: 500,
      fill: style.color || "#6E6E76",
      textAlign: "center",
      lineHeight: 1,
      fontFamily: "sans-serif",
    };
    const ty = (h - labelH) / 2;
    return [img, ...translateEl(label, 0, ty)];
  }

  function translateEl(el, dx, dy) {
    if (dx === 0 && dy === 0) return [el];
    return [{ ...el, x: Math.round((el.x || 0) + dx), y: Math.round((el.y || 0) + dy) }];
  }

  // ---------------- container flow ----------------
  // measureChildren lays a container's children out in its CONTENT area and
  // returns every child's offset from the content-area origin plus its size.
  function measureContainer(spec, availW, availH, isRoot) {
    const pad = spec.padding;
    const outerW = isRoot ? availW : Math.max(1, resolveW(spec.width, availW));

    let fixedH = null;
    if (isRoot) {
      fixedH = availH;
    } else if (isFixedToken(spec.height)) {
      fixedH = resolveH(spec.height, availH);
    }

    const contentW = Math.max(1, outerW - pad.left - pad.right);
    const { items, contentH } = layContent(spec, contentW, fixedH != null ? fixedH - pad.top - pad.bottom : null);

    const outerH = fixedH != null ? fixedH : Math.max(0, contentH + pad.top + pad.bottom);
    return { w: outerW, h: outerH, items, pad, fixedH };
  }

  function layContent(spec, contentW, contentHDefinite) {
    const dir = spec.direction === "horizontal" ? "horizontal" : "vertical";
    const align = spec.align || "stretch";
    const gap = spec.gap ?? 0;
    const order = childOrderOf(spec);
    const items = [];

    let main = 0;
    let maxMain = 0;
    let maxCross = 0;

    for (const id of order) {
      let item;
      if (elementsById.has(id)) {
        const el = elementsById.get(id);
        if (!el) continue;
        const res = measureElement(el, contentW, contentHDefinite);
        item = { id, kind: "element", w: res.w, h: res.h, fit: res.fit, group: res.group, emit: res.emit, absolute: !!res.absolute };
      } else if (containerSpecs.has(id)) {
        const childSpec = containerSpecs.get(id);
        const childFit = measureContainer(childSpec, contentW, contentHDefinite, false);
        item = { id, kind: "container", w: childFit.w, h: childFit.h, containerFit: childFit, emit: [] };
      } else {
        continue;
      }

      if (item.absolute) {
        // legacy absolute element participates in layering but not flow
        items.push(item);
        continue;
      }
      const ms = dir === "vertical" ? item.h : item.w;
      const cs = dir === "vertical" ? item.w : item.h;
      item.mainPos = main;
      item.mainSize = ms;
      item.crossSize = cs;
      main += ms + gap;
      maxMain = main;
      maxCross = Math.max(maxCross, cs);
      items.push(item);
    }

    const used = maxMain > 0 ? maxMain - gap : 0;
    const mainSpace = dir === "vertical" ? contentHDefinite ?? contentW : contentW;
    const available = dir === "vertical" ? mainSpace : mainSpace;
    const extra = Math.max(0, available - used);
    const justify = spec.justify || "start";

    if (items.length > 1) {
      if (justify === "between" && extra > 0) {
        const step = extra / Math.max(1, items.filter((it) => !it.absolute).length - 1);
        let acc = 0;
        for (const it of items) {
          if (it.absolute) continue;
          it.mainPos += acc;
          acc += step;
        }
      } else if ((justify === "center" || justify === "end") && extra > 0) {
        const shift = justify === "center" ? extra / 2 : extra;
        for (const it of items) {
          if (!it.absolute) it.mainPos += shift;
        }
      }
    }

    // cross-axis offsets
    for (const it of items) {
      if (it.absolute) continue;
      let crossPos;
      if (it.kind === "container") {
        const childAlign = containerSpecs.get(it.id)?.align || align;
        crossPos =
          childAlign === "stretch" && !isFixedToken(containerSpecs.get(it.id)?.width)
            ? 0
            : alignOffset(childAlign, contentW, it.w);
        if (childAlign === "stretch" && !isFixedToken(containerSpecs.get(it.id)?.width)) {
          it.w = contentW;
        }
      } else {
        const el = elementsById.get(it.id);
        const effAlign = el?.align || align;
        crossPos = effAlign === "stretch" ? 0 : alignOffset(effAlign, contentW, it.crossSize);
        if (effAlign === "stretch" && !isFixedToken(el?.width)) {
          it.w = contentW;
        }
      }
      it.crossPos = crossPos;
      it.ox = dir === "vertical" ? it.crossPos : it.mainPos;
      it.oy = dir === "vertical" ? it.mainPos : it.crossPos;
    }

    // sibling overlap repair along the main axis
    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      if (it.absolute) continue;
      for (let j = 0; j < i; j++) {
        const prev = items[j];
        if (prev.absolute) continue;
        const inters =
          Math.min(prev.ox + prev.w, it.ox + it.w) - Math.max(prev.ox, it.ox);
        const intery =
          Math.min(prev.oy + prev.h, it.oy + it.h) - Math.max(prev.oy, it.oy);
        if (inters <= 0 || intery <= 0) continue;
        const minArea = Math.min(prev.w * prev.h, it.w * it.h);
        if (inters * intery < minArea * 0.2) continue;
        if (dir === "vertical") it.oy += intery + 2;
        else it.ox += inters + 2;
        warnings.push(`Repaired overlap between "${prev.id}" and "${it.id}"`);
      }
    }

    const realMain = items
      .filter((it) => !it.absolute)
      .reduce((acc, it) => Math.max(acc, it.mainPos + it.mainSize), 0);
    const contentH = dir === "vertical" ? realMain + (items.some((it) => !it.absolute) ? 0 : -gap) : maxCross;
    return { items, contentH };
  }

  // ---------------- emit pass ----------------

  const pixelElements = [];

  function emitNode(item, originX, originY) {
    const ox = originX + (item.ox || 0);
    const oy = originY + (item.oy || 0);
    if (item.absolute) {
      // already expressed in canvas coords; no translation
      for (const el of item.emit || []) pixelElements.push(el);
      return;
    }
    for (const el of item.emit || []) {
      pixelElements.push({
        ...el,
        x: Math.round((el.x || 0) + ox),
        y: Math.round((el.y || 0) + oy),
        x2: typeof el.x2 === "number" ? Math.round(el.x2 + ox) : undefined,
        y2: typeof el.y2 === "number" ? Math.round(el.y2 + oy) : undefined,
      });
    }
    if (item.kind === "container") {
      const fit = item.containerFit;
      const innerOx = ox + fit.pad.left;
      const innerOy = oy + fit.pad.top;
      for (const child of fit.items) {
        if (child.absolute) {
          emitNode(child, 0, 0);
        } else {
          emitNode(child, innerOx, innerOy);
        }
      }
    }
    if (item.group) {
      // group elements: flatten their measured children into the flow slot
      const padInner = item.group.pad || 0;
      const oxInner = ox + padInner;
      const oyInner = oy + padInner;
      for (const { res, offset } of item.group.children) {
        for (const pe of res.emit || []) {
          pixelElements.push({
            ...pe,
            x: Math.round((pe.x || 0) + oxInner),
            y: Math.round((pe.y || 0) + oyInner + offset),
          });
        }
      }
    }
  }

  // root
  const rootMeasured = measureContainer(rootSpec, canvas.width, canvas.height, true);
  for (const child of rootMeasured.items) {
    emitNode(child, 0, 0);
  }

  // ---------------- normalize + clamp ----------------

  function normalizePixelEl(el) {
    const out = { ...el };
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    out.x = n(out.x);
    out.y = n(out.y);

    if (out.type === "circle") {
      if (typeof out.radius !== "number") return null;
      out.radius = clamp(out.radius, 4, Math.max(4, canvas.width));
      out.x = clamp(out.x, 0, canvas.width - 1);
      out.y = clamp(out.y, 0, canvas.height - 1);
    } else if (out.type === "line") {
      out.x = clamp(out.x, 0, canvas.width - 1);
      out.y = clamp(out.y, 0, canvas.height - 1);
      out.x2 = clamp(out.x2 ?? out.x, 0, canvas.width) ;
      out.y2 = clamp(out.y2 ?? out.y, 0, canvas.height);
    } else {
      out.width = clamp(n(out.width), 1, canvas.width);
      out.height = clamp(n(out.height), 1, canvas.height);
      out.x = clamp(out.x, 0, Math.max(0, canvas.width - out.width));
      out.y = clamp(out.y, 0, Math.max(0, canvas.height - out.height));
    }

    if (out.type === "text") {
      if (!out.content) return null;
      out.fontSize = clamp(Math.round(out.fontSize), MIN_FONT, MAX_FONT);
      out.fontWeight = out.fontWeight ?? 400;
      out.textAlign = out.textAlign || "left";
      out.lineHeight = out.lineHeight ?? 1.2;
      out.fontFamily = out.fontFamily || "sans-serif";
      out.fill = out.fill || "#1B1B1F";
      out.width = clamp(n(out.width), 1, canvas.width);
    }
    if (out.type === "rectangle") {
      out.fill = out.fill || "#6C6CFF";
      out.cornerRadius = out.cornerRadius ?? 0;
    }
    out.role = out.role || out.type;
    return out;
  }

  const cleaned = [];
  for (const el of pixelElements) {
    const norm = normalizePixelEl(el);
    if (norm) cleaned.push(norm);
  }

  // element cap: drop decoratives first, keeping flow order
  if (cleaned.length > MAX_PIXEL_ELEMENTS) {
    const decorative = (e) =>
      e.type !== "text" &&
      /decoration|badge|divider|dot/.test(String(e.role || "").toLowerCase());
    while (cleaned.length > MAX_PIXEL_ELEMENTS) {
      const idx = cleaned.findIndex(decorative);
      if (idx === -1) break;
      const [dropped] = cleaned.splice(idx, 1);
      warnings.push(`Dropped decorative element "${dropped.id}" (element cap).`);
    }
    while (cleaned.length > MAX_PIXEL_ELEMENTS) {
      const dropped = cleaned.pop();
      warnings.push(`Dropped element "${dropped.id}" (element cap).`);
    }
  }

  return { canvas, elements: cleaned, semantic: sem, warnings };
}