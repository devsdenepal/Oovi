import { Canvas, FabricText, Rect, Circle, Line, Group } from "fabric";

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
 *   supported now: text, rectangle, circle, line, group
 */

const DEFAULT_OPACITY = 1;

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
  return {
    left: element.x,
    top: element.y,
    originX: "left",
    originY: "top",
    angle: element.angle ?? 0,
    opacity: element.opacity ?? DEFAULT_OPACITY,
    designId: element.id,
    elementRole: element.role || null,
    elementType: element.type,
  };
}

function createText(element) {
  const text = new FabricText(element.content, {
    ...commonOptions(element),
    fontSize: element.fontSize,
    fontWeight: element.fontWeight ?? 400,
    fill: element.fill,
    fontFamily: element.fontFamily || "Arial",
    textAlign: element.textAlign || "left",
    lineHeight: element.lineHeight ?? 1.2,
    editable: true,
    // Keep the reported width matching the DSL width so exported JSON is stable.
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
    default:
      console.warn(`[fabricRenderer] unknown element type: ${element.type}`);
      return null;
  }
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
  }

  return base;
}