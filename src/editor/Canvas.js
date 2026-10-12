import { createFabricCanvas, renderDesign, canvasToDesign, createDesignObject } from "../renderer/fabricRenderer";
import { HistoryManager } from "./HistoryManager";
import { ActiveSelection } from "fabric";

/**
 * Flattens the canvas object tree for the layers panel, top-most first at
 * each level, so nested group children are listed after their parent.
 * @param {fabric.Object[]} objects bottom-most first (canvas order)
 * @param {Array<{obj: fabric.Object, depth: number}>} out
 * @param {number} depth
 */
function flattenLayers(objects, out = [], depth = 0) {
  const stack = [...objects].reverse();
  for (const obj of stack) {
    out.push({ obj, depth });
    if (typeof obj.getObjects === "function" && obj.getObjects().length > 0) {
      flattenLayers(obj.getObjects(), out, depth + 1);
    }
  }
  return out;
}

/**
 * Finds an object by designId anywhere in the object tree (including inside
 * groups), mirroring how the layers panel can now select group children.
 * @param {fabric.Object[]} objects
 * @param {string} id
 */
function findById(objects, id) {
  for (const obj of objects) {
    if (obj.designId === id) return obj;
    if (typeof obj.getObjects === "function") {
      const nested = findById(obj.getObjects(), id);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Editor coordinate layer.
 *
 * Wraps a Fabric canvas and exposes a small API used by the App:
 *   - loadDesign(design)          render a Design DSL document
 *   - registerLayers(cb)          callback(list, activeIds) for layer sync
 *   - registerSelection(cb)       callback(objects) for toolbar/properties sync
 *   - clear()                     clear the canvas
 *   - duplicateActive()           duplicate selected objects
 *   - deleteActive()              delete selected objects
 *   - toDesign()                  current canvas state as Design DSL
 *   - fitToContainer()            CSS-shrink canvas to fit the viewport
 *   - exportPng()                 download current design as full-res PNG
 *
 * Only App talks to the editor; the editor itself knows Fabric.js and the
 * Design DSL but never the AI layer.
 */

export class CanvasEditor {
  constructor(holderId) {
    this.holderId = holderId;
    this.canvas = null;
    this.history = null;
    this.layersCallback = null;
    this.selectionCallback = null;
    this.suppressHistory = false;
    this._insertCount = 0;
    this.zoomMode = "fit";
    this.userZoom = 1;
    this.fitScale = 1;
    this.effScale = 1;
    this.onDirty = null;
    this._removeListeners = [];
    this._resizeDebounce = null;
  }

  /**
   * @param {import("../design/designTypes").Design} design
   */
  mount(design) {
    this.canvas = createFabricCanvas(design);
    this.history = new HistoryManager(this.canvas);
    this._wireEvents();
    this.loadDesign(design);

    this._removeListeners.push(() => {
      if (this._resizeDebounce) cancelAnimationFrame(this._resizeDebounce);
    });
    const onResize = () => {
      if (this._resizeDebounce) cancelAnimationFrame(this._resizeDebounce);
      this._resizeDebounce = requestAnimationFrame(() => this.fitToContainer());
    };
    window.addEventListener("resize", onResize);
    this._removeListeners.push(() => window.removeEventListener("resize", onResize));
  }

  loadDesign(design) {
    this.suppressHistory = true;
    renderDesign(this.canvas, design);
    this.suppressHistory = false;
    this.history.snapshot();
    this.canvas.fire("history:change");
    this._syncLayers();
    requestAnimationFrame(() => this.fitToContainer());
  }

  /**
   * Restricts the preview canvas to a new fixed size, keeping every
   * existing object in place. Reuses loadDesign() so resize goes through
   * the same render + history + fit path as generation.
   * @param {number} width
   * @param {number} height
   */
  resizeCanvas(width, height) {
    if (!this.canvas) return;
    const current = this.toDesign();
    this.loadDesign({
      canvas: {
        width,
        height,
        background: current?.canvas?.background || "#F5F5F7",
      },
      elements: current?.elements || [],
    });
  }

  /**
   * Drops a new editable element at the canvas center (with a small
   * cascade offset so repeated inserts don't stack invisibly). Needs no
   * AI — the object is created straight from a DSL fragment through the
   * same factory the renderer uses, then selected for immediate editing.
   * @param {"text"|"rectangle"|"circle"|"line"} type
   * @param {string} [fill] CSS color for the new element
   */
  addElementOfType(type, fill = "#4F46E5") {
    const c = this.canvas;
    if (!c) return;
    const n = ++this._insertCount;
    const cascade = (n % 5) * 24;
    const cx = c.width / 2 + cascade;
    const cy = c.height / 2 + cascade;
    const id = `${type}-${Date.now().toString(36)}-${n}`;

    let element = null;
    switch (type) {
      case "text":
        element = { id, type, role: "body", content: "Double-click to edit", x: cx - 200, y: cy - 30, width: 400, fontSize: 48, fontWeight: 700, fill };
        break;
      case "rectangle":
        element = { id, type, role: "decoration", x: cx - 160, y: cy - 100, width: 320, height: 200, fill, cornerRadius: 12 };
        break;
      case "circle":
        element = { id, type, role: "decoration", x: cx - 100, y: cy - 100, radius: 100, fill };
        break;
      case "line":
        element = { id, type, role: "decoration", x: cx - 150, y: cy, x2: cx + 150, y2: cy, stroke: fill, strokeWidth: 4 };
        break;
      default:
        return;
    }

    const obj = createDesignObject(element);
    if (!obj) return;
    // object:added fires here → history snapshot + panel sync via _handleMutation.
    c.add(obj);
    c.setActiveObject(obj);
    c.requestRenderAll();
    this._handleSelection();
  }

  /**
   * Recolors the canvas background (no AI, single history step).
   * @param {string} color CSS color
   */
  setBackground(color) {
    const c = this.canvas;
    if (!c || !color) return;
    c.backgroundColor = color;
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncSelection(); // refreshes toolbar state + JSON preview
  }

  clear() {
    this.canvas.discardActiveObject();
    this.suppressHistory = true;
    this.canvas.getObjects().forEach((obj) => this.canvas.remove(obj));
    this.suppressHistory = false;
    this.history.snapshot();
    this.canvas.fire("history:change");
    this._syncLayers();
    this._syncSelection();
  }

  /**
   * Fits the design canvas into the visible canvas area by CSS-scaling the
   * holder. The Fabric coordinate space stays at the native design size, so
   * pointer math and PNG export are unaffected.
   */
  fitToContainer() {
    const c = this.canvas;
    const holder = document.getElementById(this.holderId);
    if (!c || !holder) return;

    const area = holder.closest(".canvas-area");
    if (!area) return;

    // Frame padding + canvas-meta line leave room to breathe.
    const availW = Math.max(200, area.clientWidth - 48);
    const availH = Math.max(200, area.clientHeight - 64);

    const scale = Math.min(
      1, // never upscale beyond native size
      availW / c.width,
      availH / c.height,
    );
    const fitScale = Number(scale.toFixed(3));
    this.fitScale = fitScale;

    // Absolute zoom overrides fit; fit mode never upscales (old behavior).
    const eff =
      this.zoomMode === "fit" ? fitScale : Math.min(3, Math.max(0.2, this.userZoom));
    this.effScale = Number(eff.toFixed(3));

    holder.style.width = `${Math.round(c.width * this.effScale)}px`;
    holder.style.height = `${Math.round(c.height * this.effScale)}px`;

    // Scale BOTH fabric canvases. Fabric's pointer math computes the CSS scale
    // from the *upper* (interactive) canvas bounding rect, so if the transform
    // is only applied to the lower (render) canvas, clicks are mapped with no
    // fit-scale compensation and hit at the wrong position. Scaling both keeps
    // the render and hit-testing in sync at the cursor.
    const els = [c.lowerCanvasEl, c.upperCanvasEl].filter(Boolean);
    if (els.length === 0) {
      const fallback = c.getElement ? c.getElement() : holder.querySelector("canvas");
      if (fallback) els.push(fallback);
    }
    for (const el of els) {
      el.style.transform = `scale(${this.effScale})`;
      el.style.transformOrigin = "0 0";
    }
  }

  /** Fit the whole artboard into view (never upscales). */
  setZoomFit() {
    this.zoomMode = "fit";
    this.fitToContainer();
  }

  /** True pixels (100%), even if the artboard overflows and scrolls. */
  setZoomActual() {
    this.zoomMode = "absolute";
    this.userZoom = 1;
    this.fitToContainer();
  }

  /**
   * Step zoom, starting from the current effective scale when in fit mode.
   * @param {number} factor e.g. 1.25 to zoom in, 0.8 to zoom out
   */
  zoomBy(factor) {
    if (this.zoomMode === "fit") {
      this.zoomMode = "absolute";
      this.userZoom = this.fitScale;
    }
    this.userZoom = Math.min(3, Math.max(0.2, this.userZoom * factor));
    this.fitToContainer();
  }

  /** Label for the zoom control: "Fit" or "125%". */
  getZoomLabel() {
    if (this.zoomMode === "fit") return "Fit";
    return `${Math.round(this.effScale * 100)}%`;
  }

  /**
   * Viewport rect of the current selection for the floating context bar.
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  getSelectionScreenRect() {
    if (!this.canvas) return null;
    const active = this.canvas.getActiveObject();
    if (!active) return null;
    const holder = document.getElementById(this.holderId);
    if (!holder) return null;
    const bounds = active.getBoundingRect();
    const holderRect = holder.getBoundingClientRect();
    return {
      x: holderRect.left + bounds.left * this.effScale,
      y: holderRect.top + bounds.top * this.effScale,
      width: bounds.width * this.effScale,
      height: bounds.height * this.effScale,
    };
  }

  /**
   * Toggles the Fabric-level lock on the current selection (move/rotate/
   * scale off, controls hidden). One history entry. NOTE: lock is not a
   * Design-schema field, so it does not survive JSON round-trips (Goal 3).
   * @returns {boolean} true when the selection ends up locked
   */
  toggleLockActive() {
    const c = this.canvas;
    if (!c) return false;
    const actives = c.getActiveObjects();
    if (actives.length === 0) return false;
    const locked = !(actives[0].lockMovementX && actives[0].lockMovementY);
    actives.forEach((obj) => {
      obj.set({
        lockMovementX: locked,
        lockMovementY: locked,
        lockRotation: locked,
        lockScalingX: locked,
        lockScalingY: locked,
        hasControls: !locked,
      });
      obj.setCoords();
    });
    c.requestRenderAll();
    this.history.snapshot();
    this._syncSelection();
    return locked;
  }

  /** @returns {boolean} true when the first selected object is locked */
  isActiveLocked() {
    const active = this.canvas?.getActiveObject();
    return Boolean(active && active.lockMovementX && active.lockMovementY);
  }

  /**
   * Exports the full design as a PNG at native resolution, regardless of the
   * current on-screen fit scale. Triggers a browser download.
   */
  exportPng() {
    const c = this.canvas;
    if (!c || c.getObjects().length === 0) return;

    const dataUrl = c.toDataURL({
      format: "png",
      multiplier: 1,
      enableRetinaScaling: true,
    });

    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "design.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  _wireEvents() {
    const c = this.canvas;

    c.on("selection:created", () => this._handleSelection());
    c.on("selection:updated", () => this._handleSelection());
    c.on("selection:cleared", () => this._handleSelection());

    c.on("object:added", () => this._handleMutation());
    c.on("object:removed", () => this._handleMutation());
    c.on("object:modified", () => this._handleMutation());
    c.on("text:changed", () => this._handleMutation());
    c.on("history:change", () => this._syncLayers());

    c.on("selection:created", () => this._syncLayers());
    c.on("selection:updated", () => this._syncLayers());
    c.on("selection:cleared", () => this._syncLayers());

    const onKeyDown = (event) => this._handleKeyDown(event);
    window.addEventListener("keydown", onKeyDown);
    this._removeListeners.push(() => window.removeEventListener("keydown", onKeyDown));
  }

  _handleSelection() {
    this._syncSelection();
    this._syncLayers();
  }

  _handleMutation() {
    if (this.suppressHistory) return;
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
  }

  _syncSelection() {
    if (this.selectionCallback) {
      const active = this.canvas.getActiveObjects();
      this.selectionCallback(active);
    }
  }

  _syncLayers() {
    if (!this.layersCallback) return;
    // getObjects() returns bottom-most first; flattenLayers reverses at each
    // level so the panel shows top-most first, matching the spec order
    // (Footer on top of Rectangle...). Group children are nested under their
    // parent group.
    const layers = flattenLayers(this.canvas.getObjects());
    const activeIds = new Set(this.canvas.getActiveObjects().map((o) => o.designId));
    this.layersCallback(layers, activeIds);
  }

  _handleKeyDown(event) {
    const target = event.target;
    const inEditableField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;

    if (inEditableField) return;

    const c = this.canvas;
    if (!c || c.isDrawingMode) return;

    // Ignore while actively editing a fabric text.
    const active = c.getActiveObject();
    if (active && typeof active.isEditing === "function" && active.isEditing()) return;

    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.history.redo();
      else this.history.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.history.redo();
      return;
    }
    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      if (c.getActiveObjects().length) this.duplicateActive();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (c.getActiveObjects().length) {
        event.preventDefault();
        this.deleteActive();
      }
      return;
    }
    if ((event.key === "a" || event.key === "A") && mod) {
      event.preventDefault();
      if (c.getObjects().length) {
        const all = c.getObjects();
        c.setActiveObject(new ActiveSelection(all, { canvas: c }));
      }
      c.requestRenderAll();
      this._handleSelection();
    }
  }

  selectById(id) {
    const obj = findById(this.canvas.getObjects(), id);
    if (!obj) return;
    this.canvas.discardActiveObject();
    this.canvas.setActiveObject(obj);
    this.canvas.requestRenderAll();
    this._handleSelection();
  }

  async duplicateActive() {
    const active = this.canvas.getActiveObjects();
    if (active.length === 0) return;

    const clones = [];
    for (const obj of active) {
      const clone = await obj.clone();
      clone.set({
        left: (obj.left || 0) + 20,
        top: (obj.top || 0) + 20,
        designId: `${obj.designId || "element"}-copy-${Date.now()}`,
      });
      clones.push(clone);
    }

    for (const clone of clones) {
      this.canvas.add(clone);
    }

    this.canvas.discardActiveObject();
    if (clones.length === 1) {
      this.canvas.setActiveObject(clones[0]);
    } else {
      this.canvas.setActiveObject(new ActiveSelection(clones, { canvas: this.canvas }));
    }
    this.canvas.requestRenderAll();
    this._handleSelection();
  }

  deleteActive() {
    const active = this.canvas.getActiveObjects();
    if (active.length === 0) return;
    active.forEach((obj) => {
      if (typeof obj.remove === "function") obj.remove();
    });
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this._handleMutation();
  }

  /**
   * Applies one property edit to every selected object, then routes through
   * _handleMutation() — the same snapshot + sync path as direct canvas edits,
   * so every inspector change is exactly one undo entry.
   * @param {string} prop x|y|width|height|radius|angle|opacity|content|fontSize|fontWeight|fontFamily|textAlign|lineHeight|charSpacing|fill|stroke|strokeWidth|cornerRadius
   * @param {string} value raw input value (coerced for numeric props)
   */
  setActiveProperty(prop, value) {
    const c = this.canvas;
    if (!c) return;
    const active = c.getActiveObjects();
    if (active.length === 0) return;
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    active.forEach((obj) => {
      const kind = obj.elementType || obj.type;
      const isText = kind === "text" || obj.type === "i-text" || obj.type === "textbox";
      const isLine = kind === "line";
      const isCircle = kind === "circle";
      switch (prop) {
        case "x":
          obj.set("left", num(value, obj.left));
          break;
        case "y":
          obj.set("top", num(value, obj.top));
          break;
        case "angle":
          obj.set("angle", num(value, obj.angle || 0));
          break;
        case "opacity":
          obj.set("opacity", Math.min(1, Math.max(0, num(value, obj.opacity ?? 1))));
          break;
        case "width":
          if (!isText && !isLine && !isCircle) obj.set("width", Math.max(1, num(value, obj.width)));
          break;
        case "height":
          if (!isText && !isLine && !isCircle) obj.set("height", Math.max(1, num(value, obj.height)));
          break;
        case "radius":
          if (isCircle) obj.set("radius", Math.max(1, num(value, obj.radius)));
          break;
        case "cornerRadius":
          obj.set({ rx: Math.max(0, num(value, obj.rx || 0)), ry: Math.max(0, num(value, obj.ry || 0)) });
          break;
        case "content":
          if (isText) obj.set("text", value);
          break;
        case "fontSize":
          if (isText) obj.set("fontSize", Math.min(400, Math.max(4, num(value, obj.fontSize))));
          break;
        case "fontWeight":
          if (isText) obj.set("fontWeight", num(value, obj.fontWeight));
          break;
        case "fontFamily":
          if (isText) obj.set("fontFamily", value);
          break;
        case "textAlign":
          if (isText) obj.set("textAlign", value);
          break;
        case "lineHeight":
          if (isText) obj.set("lineHeight", Math.min(3, Math.max(0.5, num(value, obj.lineHeight ?? 1.2))));
          break;
        case "charSpacing":
          if (isText) obj.set("charSpacing", num(value, obj.charSpacing || 0));
          break;
        case "fill":
          if (!isLine) obj.set("fill", value);
          break;
        case "stroke":
          obj.set("stroke", value);
          break;
        case "strokeWidth":
          obj.set("strokeWidth", Math.max(0, num(value, obj.strokeWidth ?? 0)));
          break;
        default:
          return;
      }
      if (typeof obj.setCoords === "function") obj.setCoords();
    });
    c.requestRenderAll();
    this._handleMutation();
  }

  /**
   * Aligns the selection bounding box (single object or whole
   * multi-selection as one block) to the canvas.
   * @param {"left"|"center"|"right"|"top"|"middle"|"bottom"} edge
   */
  alignActive(edge) {
    const c = this.canvas;
    if (!c) return;
    const active = c.getActiveObject();
    if (!active) return;
    const box = active.getBoundingRect();
    let dx = 0;
    let dy = 0;
    if (edge === "left") dx = 0 - box.left;
    else if (edge === "center") dx = (c.width - box.width) / 2 - box.left;
    else if (edge === "right") dx = c.width - (box.left + box.width);
    else if (edge === "top") dy = 0 - box.top;
    else if (edge === "middle") dy = (c.height - box.height) / 2 - box.top;
    else if (edge === "bottom") dy = c.height - (box.top + box.height);
    else return;
    active.set({ left: active.left + dx, top: active.top + dy });
    if (typeof active.setCoords === "function") active.setCoords();
    c.requestRenderAll();
    this._handleMutation();
  }

  /**
   * Evenly distributes 3+ selected objects between the outermost two,
   * which stay fixed. Deltas apply 1:1 while the selection container
   * itself is unscaled (fresh shift-click selection); undoable regardless.
   * @param {"x"|"y"} axis
   */
  distributeActive(axis) {
    const c = this.canvas;
    if (!c) return;
    const targets = c.getActiveObjects();
    if (targets.length < 3) return;
    const rect = (o) => o.getBoundingRect();
    if (axis === "x") {
      const sorted = [...targets].sort((a, b) => rect(a).left - rect(b).left);
      const start = rect(sorted[0]).left;
      const end = rect(sorted[sorted.length - 1]).left + rect(sorted[sorted.length - 1]).width;
      const total = sorted.reduce((s, o) => s + rect(o).width, 0);
      const gap = (end - start - total) / (sorted.length - 1);
      let cursor = start;
      sorted.forEach((o) => {
        const b = rect(o);
        o.set("left", o.left + (cursor - b.left));
        if (typeof o.setCoords === "function") o.setCoords();
        cursor += b.width + gap;
      });
    } else if (axis === "y") {
      const sorted = [...targets].sort((a, b) => rect(a).top - rect(b).top);
      const start = rect(sorted[0]).top;
      const end = rect(sorted[sorted.length - 1]).top + rect(sorted[sorted.length - 1]).height;
      const total = sorted.reduce((s, o) => s + rect(o).height, 0);
      const gap = (end - start - total) / (sorted.length - 1);
      let cursor = start;
      sorted.forEach((o) => {
        const b = rect(o);
        o.set("top", o.top + (cursor - b.top));
        if (typeof o.setCoords === "function") o.setCoords();
        cursor += b.height + gap;
      });
    } else {
      return;
    }
    c.requestRenderAll();
    this._handleMutation();
  }

  /**
   * Moves every selected object one step (or to the end) in stack order.
   * @param {"forward"|"backward"|"front"|"back"} dir
   */
  orderActive(dir) {
    const c = this.canvas;
    if (!c) return;
    const targets = c.getActiveObjects();
    if (targets.length === 0) return;
    targets.forEach((o) => {
      if (dir === "forward" && typeof c.bringForward === "function") c.bringForward(o);
      else if (dir === "backward" && typeof c.sendBackwards === "function") c.sendBackwards(o);
      else if (dir === "front" && typeof c.bringToFront === "function") c.bringToFront(o);
      else if (dir === "back" && typeof c.sendToFront === "function") c.sendToFront(o);
    });
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
  }

  toDesign() {
    return this.canvas ? canvasToDesign(this.canvas) : null;
  }

  dispose() {
    this._removeListeners.forEach((fn) => fn());
    if (this.canvas) {
      this.canvas.dispose();
      this.canvas = null;
    }
  }
}