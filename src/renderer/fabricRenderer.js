import { Canvas, Textbox, Rect, Circle, Line, Group, FabricImage } from "fabric";

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
  };
}

function createText(element) {
  // Textbox (not FabricText) so the DSL width is a real wrap width —
  // this is what makes the inspector width row meaningful for text.
  const text = new Textbox(element.content, {
    ...commonOptions(element),
    fontSize: element.fontSize,
    fontWeight: element.fontWeight ?? 400,
    fill: element.fill,
    fontFamily: element.fontFamily || "Arial",
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
    fill: element.fill,
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
    fill: element.fill,
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
    elements.push(objectToDsl(obj));
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

function objectToDsl(obj) {
  const base = {
    id: obj.designId,
    type: obj.elementType || obj.type,
    role: obj.elementRole || undefined,
    x: obj.left,
    y: obj.top,
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
      base.fill = obj.fill;
      base.textAlign = obj.textAlign;
      base.lineHeight = obj.lineHeight;
      base.fontFamily = obj.fontFamily;
      base.charSpacing = obj.charSpacing;
      delete base.angle; // text keeps its own angle handling
      break;
    case "rectangle":
      base.width = obj.width;
      base.height = obj.height;
      base.fill = obj.fill;
      if (obj.rx) base.cornerRadius = obj.rx;
      break;
    case "circle":
      base.radius = obj.radius;
      base.fill = obj.fill;
      break;
    case "line":
      base.x2 = obj.x2;
      base.y2 = obj.y2;
      base.stroke = obj.stroke;
      base.strokeWidth = obj.strokeWidth;
      break;
    case "group":
      base.children = obj.getObjects().map(objectToDsl);
      break;
    case "image":
      base.width = Math.round((obj.width || 0) * (obj.scaleX || 1));
      base.height = Math.round((obj.height || 0) * (obj.scaleY || 1));
      base.src = obj.designSrc || obj.pendingSrc || "";
      break;
  }

  return base;
}