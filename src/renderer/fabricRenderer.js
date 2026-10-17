import { Canvas, Textbox, Rect, Circle, Line, Group, FabricImage, Point, Gradient } from "fabric";

/**
 * Fabric.js renderer.
 *
 * Maps a Design DSL document to editable Fabric.js objects and back.
 *
 * Contract:
 *  - Every rendered object keeps its DSL `id` in `obj.designId`.
 *  - The renderer knows the Design DSL and Fabric.js ONLY - never the AI layer.
 *  - The AI layer knows the Design DSL only - swapping the renderer (SVG,
 *    PSD, DOM) requires no changes to src/ai or src/design.
 *
 * Element types handled via a switch to make adding types trivial:
 *   supported now: text, rectangle, circle, line, group, image
 */

/**
 * @param {import("../design/designTypes").Design} design
 * @returns {fabric.Canvas} configured fabric canvas
 */
export function createFabricCanvas(design) {
  const { canvas: spec } = design;
  const c = new Canvas(document.getElementById("design-canvas"), {
    width: spec.width,
    height: spec.height,
    preserveObjectStacking: true,
    backgroundColor: spec.background,
    selection: true,
  });
  // Cache original dimensions so resize/zoom of the DOM element doesn't change
  // the actual design coordinate system.
  c.elementWidth = spec.width;
  c.elementHeight = spec.height;
  return c;
}

function commonOptions(element) {
  const locked = element.locked === true;
  return {
    left: element.x,
    top: element.y,
    originX: "left",
    originY: "top",
    angle: element.angle ?? 0,
    opacity: element.opacity ?? 1,
    visible: element.visible ?? true,
    lockMovementX: locked,
    lockMovementY: locked,
    lockRotation: locked,
    lockScalingX: locked,
    lockScalingY: locked,
    hasControls: !locked,
    locked,
    // Oovi selection identity (mirrors --oovi-brand; the canvas API
    // cannot consume CSS vars): accent outline + roomier handles.
    transparentCorners: false,
    cornerColor: "#4F46E5",
    cornerStrokeColor: "#FFFFFF",
    cornerSize: 14,
    borderColor: "#4F46E5",
    designId: element.id,
    elementRole: element.role || null,
    elementType: element.type,
    // Gradient round-trip: fill carries the live paint (string or Gradient
    // instance); these two always carry the DSL originals for toDesign and
    // history (see HISTORY_PROPS).
    designFill: typeof element.fill === "string" ? element.fill : null,
    designGradient: element.gradient && typeof element.gradient === "object" ? element.gradient : null,
  };
}

/**
 * DSL fill → Fabric paint. A validated gradient descriptor becomes a live
 * Gradient (percentage units, bbox-relative); otherwise the plain color.
 */
function toFabricFill(element) {
  const g = element.gradient;
  if (!g || typeof g !== "object") return element.fill;
  // Fabric percentage coords are NUMBERS (1 = 100% of bbox) — "50%"
  // strings reach createLinearGradient verbatim and throw non-finite,
  // bricking the whole canvas render. Clamp to [0,1], never negative
  // (negative radii throw too).
  const frac = (v, fb) => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
    return Math.max(0, Math.min(1, n));
  };
  const coords =
    g.type === "radial"
      ? { x1: frac(g.cx, 0.5), y1: frac(g.cy, 0.5), r1: 0, x2: frac(g.cx, 0.5), y2: frac(g.cy, 0.5), r2: frac(g.r, 0.5) }
      : { x1: frac(g.x1, 0), y1: frac(g.y1, 0), x2: frac(g.x2, 1), y2: frac(g.y2, 0) };
  try {
    const paint = new Gradient({
      type: g.type === "radial" ? "radial" : "linear",
      gradientUnits: "percentage",
      coords,
      colorStops: (Array.isArray(g.stops) ? g.stops : []).map((s) => ({ offset: s.offset, color: s.color })),
    });
    // Fabric defers the real canvas calls to render time, outside this
    // try — so smoke-test the paint NOW on a scratch context. Anything
    // pathological (bad color, wild offset) throws here and degrades to
    // the solid fill instead of bricking the design on open.
    smokeTestPaint(paint);
    return paint;
  } catch {
    return element.fill;
  }
}

// Reuses one scratch context for paint smoke tests (browser only).
let _smokeCtx = null;
function smokeTestPaint(paint) {
  if (typeof document === "undefined") return;
  if (!_smokeCtx) {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    _smokeCtx = c.getContext("2d");
  }
  if (!_smokeCtx) return;
  paint.toLive(_smokeCtx);
}

function createText(element) {
  // Textbox (not FabricText) so the DSL width is a real wrap width —
  // this is what makes the inspector width row meaningful for text.
  const text = new Textbox(element.content, {
    ...commonOptions(element),
    fontSize: element.fontSize,
    fontWeight: element.fontWeight ?? 400,
    fill: toFabricFill(element),
    fontFamily: element.fontFamily || "Arial",
    // Outline channel (pixel-art/funky headlines): off unless the model
    // asks. paintFirst keeps the fill crisp over the stroke.
    stroke: element.stroke || null,
    strokeWidth: element.strokeWidth ?? 0,
    paintFirst: "stroke",
    textAlign: element.textAlign || "left",
    lineHeight: element.lineHeight ?? 1.2,
    charSpacing: element.charSpacing || 0,
    editable: true,
    width: element.width,
  });
  return text;
}

function createRectangle(element) {
  const rect = new Rect({
    ...commonOptions(element),
    width: element.width,
    height: element.height,
    fill: toFabricFill(element),
    rx: element.cornerRadius ?? 0,
    ry: element.cornerRadius ?? 0,
    stroke: element.stroke || null,
    strokeWidth: element.strokeWidth ?? 0,
  });
  return rect;
}

function createCircle(element) {
  const circle = new Circle({
    ...commonOptions(element),
    radius: element.radius,
    fill: toFabricFill(element),
    stroke: element.stroke || null,
    strokeWidth: element.strokeWidth ?? 0,
  });
  return circle;
}

function createLine(element) {
  const line = new Line([element.x, element.y, element.x2, element.y2], {
    ...commonOptions(element),
    stroke: element.stroke,
    strokeWidth: element.strokeWidth ?? 2,
    strokeLineCap: "round",
  });
  return line;
}

function createGroup(element) {
  const children = (element.children || []).map(createObject);
  const group = new Group(children, {
    ...commonOptions(element),
    originX: "left",
    originY: "top",
    // Allow selecting the individual children (text/rect/…) under the cursor
    // instead of always selecting the whole group. Both flags are required:
    // subTargetCheck makes hit-testing descend into children, interactive
    // makes the innermost child under the pointer the selection target.
    subTargetCheck: true,
    interactive: true,
  });
  return group;
}

function createObject(element) {
  switch (element.type) {
    case "text":
      return createText(element);
    case "rectangle":
      return createRectangle(element);
    case "circle":
      return createCircle(element);
    case "line":
      return createLine(element);
    case "group":
      return createGroup(element);
    case "image":
      return createImagePlaceholder(element);
    default:
      console.warn(`[fabricRenderer] unknown element type: ${element.type}`);
      return null;
  }
}

/**
 * Creates a single editable Fabric object from a Design DSL element.
 * Used by the editor for manual inserts (text/shapes) without AI.
 * @param {import("../design/designTypes").DesignElement} element
 * @returns {fabric.Object|null}
 */
export function createDesignObject(element) {
  return createObject(element);
}

/**
 * Image placeholder: a dashed box at the DSL rect carrying the pending
 * source. The real pixels arrive via hydrateImages() (async, after the
 * sync render pass), so generation/rendering never blocks on network.
 * A failed load keeps the placeholder — layout never breaks.
 * @param {import("../design/designTypes").DesignElement} element
 */
function createImagePlaceholder(element) {
  const holder = new Rect({
    ...commonOptions(element),
    width: Math.max(1, element.width),
    height: Math.max(1, element.height),
    fill: "#E5E7EB",
    stroke: "#9AA1B5",
    strokeWidth: 1,
    strokeDashArray: [6, 4],
  });
  holder.isImagePlaceholder = true;
  holder.pendingSrc = element.src;
  return holder;
}

/**
 * Re-applies recorded gradients after a native loadFromJSON revive.
 * History snapshots serialize the live Gradient instance as a plain
 * object, which fabric does not turn back into paint on its own — but
 * the DSL originals ride along (HISTORY_PROPS), so re-mapping them is
 * exact. Walks group children too.
 */
export function hydrateGradients(canvas) {
  if (!canvas || typeof canvas.getObjects !== "function") return;
  const walk = (objs) => {
    for (const o of objs || []) {
      if (!o || typeof o !== "object") continue;
      if (o.designGradient && !(o.fill instanceof Gradient)) {
        o.fill = toFabricFill({ fill: typeof o.fill === "string" ? o.fill : o.designFill, gradient: o.designGradient });
        if (typeof o.setCoords === "function") o.setCoords();
      }
      if (typeof o.getObjects === "function") {
        try {
          walk(o.getObjects());
        } catch {
          // ignore exotic containers
        }
      }
    }
  };
  walk(canvas.getObjects());
}

/**
 * Swaps every pending image placeholder on the canvas for its loaded
 * pixels (stretched exactly to the DSL box), preserving stack order.
 * @param {fabric.Canvas} canvas
 * @param {() => void} [onSettled] called once per swapped image
 */
export function hydrateImages(canvas, onSettled) {
  const pending = canvas
    .getObjects()
    .filter((o) => o.isImagePlaceholder && typeof o.pendingSrc === "string" && o.pendingSrc);
  pending.forEach((holder) => {
    FabricImage.fromURL(holder.pendingSrc, { crossOrigin: "anonymous" })
      .then((img) => {
        if (!img || typeof img.set !== "function" || typeof img.render !== "function") {
          throw new Error(`unusable image object (${img?.constructor?.name || typeof img})`);
        }
        img.set({
          left: holder.left,
          top: holder.top,
          originX: "left",
          originY: "top",
          angle: holder.angle || 0,
          opacity: holder.opacity ?? 1,
          designId: holder.designId,
          elementRole: holder.elementRole || null,
          elementType: "image",
        });
        img.designSrc = holder.pendingSrc;
        img.set({
          scaleX: holder.width / Math.max(1, img.width || 1),
          scaleY: holder.height / Math.max(1, img.height || 1),
        });
        if (typeof img.setCoords === "function") img.setCoords();
        const index = Math.max(0, canvas.getObjects().indexOf(holder));
        canvas.remove(holder);
        if (typeof canvas.insertAt === "function") canvas.insertAt(index, img);
        else canvas.add(img);
        canvas.requestRenderAll();
        onSettled?.();
      })
      .catch(() => {
        console.warn("[fabricRenderer] image failed to load; placeholder kept");
      });
  });
}

/**
 * Renders a valid Design onto an empty canvas, in document order
 * (first element = bottom-most layer).
 * @param {fabric.Canvas} canvas
 * @param {import("../design/designTypes").Design} design
 */
export function renderDesign(canvas, design) {
  const { width, height, background } = design.canvas;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.setDimensions({ width, height });
    canvas.elementWidth = width;
    canvas.elementHeight = height;
  }
  canvas.clear();
  canvas.backgroundColor = background;

  const objects = [];
  for (const element of design.elements) {
    const obj = createObject(element);
    if (obj) objects.push(obj);
  }

  canvas.add(...objects);
  canvas.renderAll();
}

/**
 * Serializes the current editable canvas back into a Design DSL document.
 * Used by the JSON preview panel and for future export/round-trip features.
 * @param {fabric.Canvas} canvas
 */
export function canvasToDesign(canvas) {
  const objects = [...canvas.getObjects()].reverse(); // bottom-most first
  const elements = [];
  for (const obj of objects) {
    if (obj.designId === undefined) continue;
    elements.push(objectToDsl(obj, absoluteOrigin(obj)));
  }
  return {
    canvas: {
      width: canvas.width,
      height: canvas.height,
      background: canvas.backgroundColor || "#FFFFFF",
    },
    elements,
  };
}

/**
 * Canvas-space origin of an object. Members of an ActiveSelection store
 * coordinates relative to the selection (v6 behavior), so reading
 * obj.left/top raw makes persist, validate and quality depend on what
 * happens to be selected — the exact corruption the resolver runs exposed
 * (moved pieces serialized hundreds of px off). Ancestor matrices compose,
 * so nested groups resolve exactly too.
 */
function absoluteOrigin(obj) {
  if (!obj.group) return { x: obj.left, y: obj.top };
  try {
    const p = new Point(obj.left, obj.top).transform(obj.group.calcTransformMatrix());
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  } catch {
    // fall through to raw coords
  }
  return { x: obj.left, y: obj.top };
}

function objectToDsl(obj, origin) {
  const base = {
    id: obj.designId,
    type: obj.elementType || obj.type,
    role: obj.elementRole || undefined,
    x: origin ? origin.x : obj.left,
    y: origin ? origin.y : obj.top,
    angle: obj.angle,
    opacity: obj.opacity,
    // Sparse: only present when non-default, keeping AI output clean.
    visible: obj.visible === false ? false : undefined,
    locked: obj.locked === true ? true : undefined,
  };

  switch (obj.elementType || obj.type) {
    case "text":
      base.content = obj.text;
      base.width = obj.width;
      base.fontSize = obj.fontSize;
      base.fontWeight = obj.fontWeight;
      base.fill = obj.designFill || obj.fill;
      base.gradient = obj.designGradient || undefined;
      base.textAlign = obj.textAlign;
      base.lineHeight = obj.lineHeight;
      base.fontFamily = obj.fontFamily;
      base.charSpacing = obj.charSpacing;
      delete base.angle; // text keeps its own angle handling
      break;
    case "rectangle":
      base.width = obj.width;
      base.height = obj.height;
      base.fill = obj.designFill || obj.fill;
      base.gradient = obj.designGradient || undefined;
      if (obj.rx) base.cornerRadius = obj.rx;
      break;
    case "circle":
      base.radius = obj.radius;
      base.fill = obj.designFill || obj.fill;
      base.gradient = obj.designGradient || undefined;
      break;
    case "line":
      base.x2 = obj.x2;
      base.y2 = obj.y2;
      base.stroke = obj.stroke;
      base.strokeWidth = obj.strokeWidth;
      break;
    case "group":
      base.children = obj.getObjects().map((k) => objectToDsl(k));
      break;
    case "image":
      base.width = Math.round((obj.width || 0) * (obj.scaleX || 1));
      base.height = Math.round((obj.height || 0) * (obj.scaleY || 1));
      base.src = obj.designSrc || obj.pendingSrc || "";
      break;
  }

  return base;
}