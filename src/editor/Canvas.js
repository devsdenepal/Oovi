import { createFabricCanvas, renderDesign, canvasToDesign, createDesignObject, hydrateImages } from "../renderer/fabricRenderer";
import { HistoryManager } from "./HistoryManager";
import { ActiveSelection, Group, FabricImage } from "fabric";

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
function findById(objects, id) {  for (const obj of objects) {
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
    hydrateImages(this.canvas, () => {
      this.history.snapshot();
      this.onDirty?.();
      this._syncLayers();
      this._syncSelection();
    });
    requestAnimationFrame(() => this.fitToContainer());
  }

  /**
   * Removes the background of the selected image (on-device ONNX model,
   * lazily imported so the ~MB runtime never touches initial load).
   * Pixels are swapped in place: same box, same stack position, one
   * history entry. Only local (dataURL) images — hotlinked URLs would
   * taint on fetch.
   * @returns {Promise<boolean>} false when nothing applicable selected
   * @throws on load/model/result failure (caller toasts)
   */
  async removeBackgroundActive() {
    const c = this.canvas;
    if (!c) return false;
    const obj = c.getActiveObject();
    if (!obj || (obj.elementType || obj.type) !== "image" || obj.isImagePlaceholder) return false;
    const src = obj.designSrc;
    if (!src || !src.startsWith("data:")) throw new Error("only local images (uploads, generated)");
    const { removeBackground } = await import("@imgly/background-removal");
    // The model decodes raster pixels only: rasterize SVG sources first.
    let input;
    if (src.startsWith("data:image/svg+xml")) {
      input = await rasterizeSvg(src);
    } else {
      input = await fetch(src).then((r) => r.blob());
    }
    const blob = await removeBackground(input);
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("result read failed"));
      reader.readAsDataURL(blob);
    });
    const img = await FabricImage.fromURL(dataUrl, { crossOrigin: "anonymous" });
    if (!img || typeof img.render !== "function") throw new Error("result unloadable");
    img.set({
      left: obj.left,
      top: obj.top,
      originX: "left",
      originY: "top",
      angle: obj.angle || 0,
      opacity: obj.opacity ?? 1,
      designId: obj.designId,
      elementRole: obj.elementRole || null,
      elementType: "image",
    });
    img.designSrc = dataUrl;
    const boxW = (obj.width || 1) * (obj.scaleX || 1);
    const boxH = (obj.height || 1) * (obj.scaleY || 1);
    img.set({
      scaleX: boxW / Math.max(1, img.width || 1),
      scaleY: boxH / Math.max(1, img.height || 1),
    });
    if (typeof img.setCoords === "function") img.setCoords();
    const index = Math.max(0, c.getObjects().indexOf(obj));
    this.suppressHistory = true;
    try {
      c.remove(obj);
      if (typeof c.insertAt === "function") c.insertAt(index, img);
      else c.add(img);
      c.setActiveObject(img);
    } finally {
      this.suppressHistory = false;
    }
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    return true;
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
  addElementOfType(type, fill = "#4F46E5", at = null, startEditing = false) {
    const c = this.canvas;
    if (!c) return;
    const n = ++this._insertCount;
    const cascade = (n % 5) * 24;
    const cx = c.width / 2 + cascade;
    const cy = c.height / 2 + cascade;
    const px = at && Number.isFinite(at.x) ? at.x : cx;
    const py = at && Number.isFinite(at.y) ? at.y : cy;
    const id = `${type}-${Date.now().toString(36)}-${n}`;

    let element = null;
    switch (type) {
      case "text":
        element = { id, type, role: "body", content: "Double-click to edit", x: Math.round(at ? px - 8 : cx - 200), y: Math.round(at ? py - 24 : cy - 30), width: 400, fontSize: 48, fontWeight: 700, fill };
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
    if (startEditing && typeof obj.enterEditing === "function") obj.enterEditing();
  }

  /**
   * Inserts a local image (dataURL — never taints the canvas, so PNG
   * export keeps working) fitted into the artboard, then hydrates it.
   * @param {string} src dataURL of the image
   * @param {number} naturalW intrinsic pixels
   * @param {number} naturalH intrinsic pixels
   */
  addImageElement(src, naturalW, naturalH, box = null, at = null) {
    const c = this.canvas;
    if (!c || !src) return;
    const n = ++this._insertCount;
    const cascade = (n % 5) * 24;
    const fit = Math.min(
      1,
      Math.min(c.width * 0.8, 900) / Math.max(1, naturalW),
      Math.min(c.height * 0.8, 900) / Math.max(1, naturalH),
    );
    const w = box ? Math.round(box.width) : Math.max(32, Math.round(naturalW * fit));
    const h = box ? Math.round(box.height) : Math.max(32, Math.round(naturalH * fit));
    const id = `image-${Date.now().toString(36)}-${n}`;
    const element = {
      id,
      type: "image",
      role: "image",
      x: box ? Math.round(box.x) : Math.round(c.width / 2 - w / 2 + cascade),
      y: box ? Math.round(box.y) : Math.round(c.height / 2 - h / 2 + cascade),
      width: w,
      height: h,
      src,
    };
    const obj = createDesignObject(element);
    if (!obj) return;
    if (typeof at === "number" && typeof c.insertAt === "function") {
      c.insertAt(Math.max(0, Math.min(at, c.getObjects().length)), obj);
    } else c.add(obj);
    c.setActiveObject(obj);
    c.requestRenderAll();
    this._handleSelection();
    hydrateImages(c, () => {
      this.history.snapshot();
      this.onDirty?.();
      this._syncLayers();
      this._syncSelection();
    });
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

    // Measure the frame (the fixed scroll viewport), never the page: the
    // artboard shrinks to fit the available space on frame/size change.
    const frame = holder.closest(".canvas-frame");
    let availW;
    let availH;
    if (frame) {
      const cs = window.getComputedStyle(frame);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      availW = Math.max(200, frame.clientWidth - padX - 16);
      availH = Math.max(200, frame.clientHeight - padY - 16);
    } else {
      availW = Math.max(200, area.clientWidth - 48);
      availH = Math.max(200, area.clientHeight - 64);
    }

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

  /** Applies fabric-level lock state + the DSL `locked` flag. */
  _setLocked(obj, locked) {
    obj.set({
      locked,
      lockMovementX: locked,
      lockMovementY: locked,
      lockRotation: locked,
      lockScalingX: locked,
      lockScalingY: locked,
      hasControls: !locked,
    });
    if (typeof obj.setCoords === "function") obj.setCoords();
  }

  /**
   * Toggles the Fabric-level lock on the current selection (move/rotate/
   * scale off, controls hidden). One history entry. `locked` is a DSL
   * field, so it survives JSON round-trips and undo.
   * @returns {boolean} true when the selection ends up locked
   */
  toggleLockActive() {
    const c = this.canvas;
    if (!c) return false;
    const actives = c.getActiveObjects();
    if (actives.length === 0) return false;
    const locked = !actives[0].locked;
    actives.forEach((obj) => this._setLocked(obj, locked));
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    return locked;
  }

  /** Toggles lock on one object by design id (layers panel). */
  toggleLockById(id) {
    const obj = findById(this.canvas?.getObjects() || [], id);
    if (!obj) return false;
    const locked = !obj.locked;
    this._setLocked(obj, locked);
    this.canvas.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    return locked;
  }

  /** Toggles visibility on one object by design id (layers panel). */
  toggleVisibilityById(id) {
    const obj = findById(this.canvas?.getObjects() || [], id);
    if (!obj) return true;
    obj.set("visible", obj.visible === false);
    if (this.canvas.getActiveObject() === obj && obj.visible === false) {
      this.canvas.discardActiveObject();
    }
    this.canvas.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    return obj.visible !== false;
  }

  /**
   * Renames an object, auto-suffixing on collision so ids stay unique
   * (patches and layers address objects by id).
   * @returns {string|null} the final id, or null when not found
   */
  renameById(oldId, wanted) {
    const c = this.canvas;
    if (!c) return null;
    const obj = findById(c.getObjects(), oldId);
    if (!obj) return null;
    const clean = String(wanted || "").trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "element";
    const taken = new Set();
    const collect = (list) => list.forEach((o) => {
      if (typeof o.designId === "string") taken.add(o.designId);
      if (typeof o.getObjects === "function") collect(o.getObjects());
    });
    collect(c.getObjects());
    taken.delete(oldId);
    let next = clean;
    for (let i = 2; taken.has(next); i++) next = `${clean}-${i}`;
    obj.set("designId", next);
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    return next;
  }

  /** Duplicates one object by design id and selects the copy. */
  async duplicateById(id) {
    const c = this.canvas;
    if (!c) return;
    const obj = findById(c.getObjects(), id);
    if (!obj || typeof obj.clone !== "function") return;
    const clone = await obj.clone();
    const taken = new Set(c.getObjects().map((o) => o.designId));
    let next = `${obj.designId || "element"}-copy`;
    for (let i = 2; taken.has(next); i++) next = `${obj.designId || "element"}-copy-${i}`;
    clone.set({
      left: (obj.left || 0) + 20,
      top: (obj.top || 0) + 20,
      designId: next,
    });
    if (typeof clone.setCoords === "function") clone.setCoords();
    c.add(clone);
    c.setActiveObject(clone);
    c.requestRenderAll();
    this._handleSelection();
  }

  /** Deletes one object by design id. */
  deleteById(id) {
    const c = this.canvas;
    if (!c) return;
    const obj = findById(c.getObjects(), id);
    if (!obj) return;
    c.remove(obj);
    c.discardActiveObject();
    c.requestRenderAll();
    this._handleMutation();
  }

  /**
   * Moves a top-level layer above/below another top-level layer.
   * Nested group children are excluded (their order lives with the group).
   * @param {string} dragId
   * @param {string} targetId
   * @param {"above"|"below"} place panel-visual position
   */
  reorderLayer(dragId, targetId, place) {
    const c = this.canvas;
    if (!c || dragId === targetId) return;
    const tops = c.getObjects();
    const byId = new Map(tops.map((o) => [o.designId, o]));
    const drag = byId.get(dragId);
    if (!drag || !byId.get(targetId)) return;
    const topFirst = [...tops].reverse().map((o) => o.designId).filter((id) => id !== dragId);
    const ti = topFirst.indexOf(targetId);
    if (ti < 0) return;
    topFirst.splice(place === "below" ? ti + 1 : ti, 0, dragId);
    const newBottomFirst = topFirst.reverse().map((id) => byId.get(id)).filter(Boolean);
    this.suppressHistory = true;
    try {
      [...tops].forEach((o) => c.remove(o));
      newBottomFirst.forEach((o) => c.add(o));
      c.setActiveObject(drag);
    } finally {
      this.suppressHistory = false;
    }
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
  }

  /**
   * Groups the current multi-selection into one group object (schema
   * supports group children). Visuals preserved: the v6 Group
   * constructor relativizes children via its layout manager.
   * @returns {string|null} the new group id
   */
  groupActive() {
    const c = this.canvas;
    if (!c) return null;
    const active = c.getActiveObject();
    if (!active || active.type !== "activeSelection") return null;
    const members = [...active.getObjects()];
    if (members.length < 2) return null;
    this.suppressHistory = true;
    try {
      c.discardActiveObject();
      members.forEach((o) => c.remove(o));
      const group = new Group(members, {});
      const taken = new Set(c.getObjects().map((o) => o.designId));
      let id = `group-${Date.now().toString(36)}`;
      for (let i = 2; taken.has(id); i++) id = `group-${Date.now().toString(36)}-${i}`;
      group.set({ designId: id, elementRole: "group", elementType: "group" });
      c.add(group);
      c.setActiveObject(group);
    } finally {
      this.suppressHistory = false;
    }
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    const g = c.getActiveObject();
    return g && (g.elementType || g.type) === "group" ? g.designId : null;
  }

  /**
   * Ungroups the selected group: children keep their on-screen positions
   * (exitGroup bakes the parent transform into each child) and become a
   * fresh multi-selection.
   */
  ungroupActive() {
    const c = this.canvas;
    if (!c) return;
    const active = c.getActiveObject();
    if (!active || (active.elementType || active.type) !== "group") return;
    if (typeof active.remove !== "function") return;
    this.suppressHistory = true;
    try {
      const children = [...active.getObjects()];
      children.forEach((o) => active.remove(o));
      children.forEach((o) => c.add(o));
      c.remove(active);
      if (children.length > 1) c.setActiveObject(new ActiveSelection(children, { canvas: c }));
      else if (children.length === 1) c.setActiveObject(children[0]);
      else c.discardActiveObject();
    } finally {
      this.suppressHistory = false;
    }
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
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
  /**
   * Downloads the design in the given format (PNG/JPG/SVG/PDF).
   * Empty canvas exports nothing. jsPDF loads lazily (own chunk).
   */
  exportPng(filename = "design.png") {
    const c = this.canvas;
    if (!c || c.getObjects().length === 0) return;
    const dataUrl = c.toDataURL({
      format: "png",
      multiplier: 1,
      enableRetinaScaling: true,
    });
    this._download(dataUrl, filename);
  }

  exportJpg(filename = "design.jpg") {
    const c = this.canvas;
    if (!c || c.getObjects().length === 0) return;
    const dataUrl = c.toDataURL({
      format: "jpeg",
      quality: 0.92,
      multiplier: 1,
      enableRetinaScaling: true,
    });
    this._download(dataUrl, filename);
  }

  exportSvg(filename = "design.svg") {
    const c = this.canvas;
    if (!c || c.getObjects().length === 0) return;
    const svg = c.toSVG();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      this._download(url, filename);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  async exportPdf(filename = "design.pdf") {
    const c = this.canvas;
    if (!c || c.getObjects().length === 0) return;
    const { jsPDF } = await import("jspdf");
    const w = c.width;
    const h = c.height;
    const dataUrl = c.toDataURL({ format: "jpeg", quality: 0.92, multiplier: 1 });
    const doc = new jsPDF({ unit: "px", format: [w, h], hotfixes: ["px_scaling"] });
    doc.addImage(dataUrl, "JPEG", 0, 0, w, h);
    doc.save(filename);
  }

  _download(href, filename) {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  _wireEvents() {
    const c = this.canvas;

    c.on("selection:created", () => this._handleSelection());
    c.on("selection:updated", () => this._handleSelection());
    c.on("selection:cleared", () => this._handleSelection());
    c.on("mouse:dblclick", (opt) => this._handleDoubleClick(opt));

    c.on("object:added", () => this._handleMutation());
    c.on("object:removed", () => this._handleMutation());
    c.on("object:modified", () => this._handleMutation());
    // Typing fires text:changed per keystroke; a full-canvas snapshot per
    // keystroke is pure waste (50-deep stack of whole-canvas JSON). Trailing
    // 800ms throttle keeps per-word undo granularity at ~0 cost. Discrete
    // ops above stay instant.
    c.on("text:changed", () => this._handleMutationThrottled());
    this._mutationTimer = null;
    this._removeListeners.push(() => {
      if (this._mutationTimer) window.clearTimeout(this._mutationTimer);
      this._mutationTimer = null;
    });
    c.on("history:change", () => {
      this._syncLayers();
      this._syncSelection();
    });

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

  _handleMutationThrottled() {
    if (this.suppressHistory) return;
    if (this._mutationTimer) window.clearTimeout(this._mutationTimer);
    this._mutationTimer = window.setTimeout(() => {
      this._mutationTimer = null;
      this._handleMutation();
    }, 800);
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

  /**
   * Double-click on empty canvas drops a text box at the cursor and starts
   * editing it immediately. Double-clicks on objects keep fabric defaults
   * (e.g. inline text edit), so a hit target bails out here.
   */
  _handleDoubleClick(opt) {
    if (!opt || opt.target) return;
    const c = this.canvas;
    if (!c) return;
    const active = c.getActiveObject();
    if (active && typeof active.isEditing === "function" && active.isEditing()) return;
    const e = opt.e;
    const holder = document.getElementById(this.holderId);
    if (!e || !holder || typeof e.clientX !== "number" || typeof e.clientY !== "number") return;
    const rect = holder.getBoundingClientRect();
    const x = (e.clientX - rect.left) / (this.effScale || 1);
    const y = (e.clientY - rect.top) / (this.effScale || 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.addElementOfType("text", "#1b2030", { x, y }, true);
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
    const c = this.canvas;
    if (!c) return;
    const active = c.getActiveObjects();
    if (active.length === 0) return;
    // NOTE: fabric 6.9 objects have no .remove() — removal goes through
    // the canvas. Suppressed so the batch is a single history entry.
    this.suppressHistory = true;
    try {
      active.forEach((obj) => c.remove(obj));
    } finally {
      this.suppressHistory = false;
    }
    c.discardActiveObject();
    c.requestRenderAll();
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
    active.forEach((obj) => {
      this._applyPropTo(obj, prop, value);
      if (typeof obj.setCoords === "function") obj.setCoords();
    });
    c.requestRenderAll();
    this._handleMutation();
  }

  /**
   * Single-object property write shared by the inspector and AI patches.
   * Unknown props are ignored (the patch validator filters them first).
   */
  _applyPropTo(obj, prop, value) {
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
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
        if (!isLine && !isCircle) obj.set("width", Math.max(1, num(value, obj.width)));
        break;
      case "height":
        if (!isLine && !isCircle) obj.set("height", Math.max(1, num(value, obj.height)));
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
        break;
    }
  }

  /**
   * Deterministic collision repair (post-generation tidy).
   *
   * The last fix proved more content without layout control is just noisy
   * overlap: per-component calls only see sibling boxes, never rendered
   * extents, so text drifts into text. This pass measures the LIVE Fabric
   * bounds and translates text-bearing top-level objects just enough to
   * clear text-on-text overlaps and canvas-edge overflow.
   *
   * Intent-preserving by construction: translation only (no resize,
   * restyle, or regroup), shapes/images are treated as intentional layers
   * and never moved for overlaps, and everything lands in ONE history
   * entry via applyPatchOps (one Ctrl+Z reverts the whole tidy).
   * @returns {{moved: Array<{id: string, dx: number, dy: number}>, unresolvable: string[]}}
   */
  resolveCollisions() {
    const c = this.canvas;
    const empty = { moved: [], unresolvable: [] };
    if (!c) return empty;
    const W = c.width || 0;
    const H = c.height || 0;
    if (!W || !H) return empty;
    const tops = c.getObjects().filter((o) => o && o.visible !== false);
    if (tops.length < 1) return empty;
    const isText = (o) =>
      o.elementType === "text" ||
      (typeof o.type === "string" && o.type.includes("text"));
    const bearsText = (o) => {
      if (isText(o)) return true;
      if (o.elementType === "group" && typeof o.getObjects === "function") {
        try {
          return o.getObjects().some((k) => isText(k));
        } catch {
          return false;
        }
      }
      return false;
    };
    // Base rects measured once; translation commutes with bounding boxes,
    // so offsetting the cache while planning moves is exact.
    const base = new Map();
    for (const o of tops) {
      let r = null;
      try {
        r = o.getBoundingRect();
      } catch {
        r = null;
      }
      if (
        !r ||
        [r.left, r.top, r.width, r.height].some((v) => typeof v !== "number" || !isFinite(v))
      ) {
        continue;
      }
      base.set(o, { x: r.left, y: r.top, w: Math.max(0, r.width), h: Math.max(0, r.height) });
    }
    const at = new Map(); // obj -> {dx, dy} planned translation
    const placed = (o) => {
      const b = base.get(o);
      const d = at.get(o) || { dx: 0, dy: 0 };
      return { x: b.x + d.dx, y: b.y + d.dy, w: b.w, h: b.h };
    };
    // Displacement budget: sliding back inside is unbounded (always
    // correct), but overlap shoves beyond this scream plan failure, not
    // tidyable collision — refuse and report instead of rearranging the
    // poster into new overlaps (observed: +290px cascades).
    const SHOVE_CAP = 120;
    const shift = (o, dx, dy, capped) => {
      const d = at.get(o) || { dx: 0, dy: 0 };
      if (capped && Math.max(Math.abs(d.dx + dx), Math.abs(d.dy + dy)) > SHOVE_CAP) return false;
      d.dx += dx;
      d.dy += dy;
      at.set(o, d);
      return true;
    };
    const GAP = 12;

    // Pass 1: text past the canvas edge slides back inside. Applies to any
    // text-bearing object (lone text or group card); pure shapes and photos
    // may bleed intentionally and are left alone.
    for (const o of tops) {
      if (!base.has(o) || !bearsText(o)) continue;
      const p = placed(o);
      let dx = 0;
      let dy = 0;
      if (p.x < 0) dx = -p.x;
      else if (p.x + p.w > W) dx = W - (p.x + p.w);
      if (p.y < 0) dy = -p.y;
      else if (p.y + p.h > H) dy = H - (p.y + p.h);
      if (dx || dy) shift(o, Math.round(dx), Math.round(dy));
    }

    // Pass 2: text-on-text overlaps. Only downward-then-up motion, capped,
    // so sweeps converge instead of oscillating.
    const area = (b) => b.w * b.h;
    const intersectDepth = (a, b) => ({
      x: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
      y: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
    });
    const unresolvable = new Set();
    for (let sweep = 0; sweep < 10; sweep++) {
      let fixedAny = false;
      const order = tops.filter((o) => base.has(o));
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const A = order[i];
          const B = order[j];
          const aT = bearsText(A);
          const bT = bearsText(B);
          if (!aT && !bT) continue; // two layers — intentional, never touch
          const a = placed(A);
          const b = placed(B);
          const smaller = Math.min(area(a), area(b));
          if (smaller <= 0) continue;
          const { x: ox, y: oy } = intersectDepth(a, b);
          if (ox <= 0 || oy <= 0 || (ox * oy) / smaller <= 0.15) continue;
          // Move the text side; both text-bearing → move the lower one.
          // (Text-vs-image therefore slides the text off the artwork.)
          let mover = null;
          if (aT && !bT) mover = A;
          else if (bT && !aT) mover = B;
          else mover = a.y <= b.y ? B : A;
          const m = placed(mover);
          const need = Math.ceil(oy) + GAP;
          const pushUnres = () => {
            if (A.designId) unresolvable.add(A.designId);
            if (B.designId) unresolvable.add(B.designId);
          };
          if (m.y + m.h + need <= H + 1 && shift(mover, 0, need, true)) {
            fixedAny = true;
          } else if (m.y - need >= -1 && shift(mover, 0, -need, true)) {
            fixedAny = true;
          } else {
            pushUnres();
          }
        }
      }
      if (!fixedAny) break;
    }
    // Final scan: pairs still colliding after the sweep budget are named,
    // not silently left.
    {
      const order = tops.filter((o) => base.has(o));
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const A = order[i];
          const B = order[j];
          if (!bearsText(A) && !bearsText(B)) continue;
          const a = placed(A);
          const b = placed(B);
          const smaller = Math.min(area(a), area(b));
          if (smaller <= 0) continue;
          const { x: ox, y: oy } = intersectDepth(a, b);
          if (ox > 0 && oy > 0 && (ox * oy) / smaller > 0.15) {
            if (A.designId) unresolvable.add(A.designId);
            if (B.designId) unresolvable.add(B.designId);
          }
        }
      }
    }

    const ops = [];
    const moved = [];
    for (const [o, d] of at) {      if ((!d.dx && !d.dy) || !o.designId) continue;
      ops.push({
        op: "update",
        id: o.designId,
        props: { x: Math.round((o.left || 0) + d.dx), y: Math.round((o.top || 0) + d.dy) },
      });
      moved.push({ id: o.designId, dx: d.dx, dy: d.dy });
    }
    if (ops.length) this.applyPatchOps(ops);
    console.log(
      `[tidy] moved=${moved.length} unresolvable=${unresolvable.size} ` +
        moved.map((m) => `${m.id}(${m.dx},${m.dy})`).join(" "),
    );
    return { moved, unresolvable: [...unresolvable] };
  }

  /**
   * Applies validated patch ops as ONE history entry (suppressed batch +
   * single snapshot). Returns human-readable change lines for the chat.
   * @param {Array} ops validated ops (see src/ai/patch.js)
   * @returns {{applied: string[], changedIds: string[]}}
   */
  applyPatchOps(ops) {
    const c = this.canvas;
    if (!c) return { applied: [], changedIds: [] };
    const readOld = (o, key) => {
      switch (key) {
        case "content":
          return o.text;
        case "x":
          return Math.round(o.left || 0);
        case "y":
          return Math.round(o.top || 0);
        case "width":
        case "height":
        case "radius":
        case "fontSize":
        case "angle":
        case "opacity":
        case "lineHeight":
        case "charSpacing":
        case "strokeWidth":
        case "fontWeight":
          return typeof o[key] === "number" ? Math.round(o[key] * 100) / 100 : o[key];
        default:
          return o[key];
      }
    };
    const applied = [];
    const changed = new Set();
    this.suppressHistory = true;
    try {
      for (const op of ops || []) {
        if (op.op === "update") {
          const obj = findById(c.getObjects(), op.id);
          if (!obj) continue;
          const bits = [];
          for (const [key, next] of Object.entries(op.props || {})) {
            const old = readOld(obj, key);
            this._applyPropTo(obj, key, next);
            const now = readOld(obj, key);
            if (String(old) !== String(now)) bits.push(`${key} ${old} to ${now}`);
          }
          if (typeof obj.setCoords === "function") obj.setCoords();
          changed.add(op.id);
          applied.push(`${op.id}: ${bits.length ? bits.join(", ") : "no visible change"}`);
        } else if (op.op === "add") {
          const obj = createDesignObject(op.element);
          if (!obj) continue;
          // Optional plan-rank slot: progressive application (arrival order)
          // inserts at the position the piece holds in plan order, so the
          // final stack matches the plan regardless of network timing.
          if (typeof op.at === "number" && typeof c.insertAt === "function") {
            c.insertAt(Math.max(0, Math.min(op.at, c.getObjects().length)), obj);
          } else c.add(obj);
          if (typeof obj.setCoords === "function") obj.setCoords();
          changed.add(op.element.id);
          applied.push(`+ ${op.element.id} (${op.element.type})`);
        } else if (op.op === "remove") {
          const obj = findById(c.getObjects(), op.id);
          if (!obj || !c.getObjects().includes(obj)) continue;
          c.remove(obj);
          changed.add(op.id);
          applied.push(`− ${op.id}`);
        } else if (op.op === "move") {
          const objs = c.getObjects();
          const obj = objs.find((o) => o.designId === op.id);
          if (!obj) continue;
          const i = objs.indexOf(obj);
          const j =
            op.to === "front" ? objs.length - 1
            : op.to === "back" ? 0
            : op.to === "forward" ? Math.min(objs.length - 1, i + 1)
            : Math.max(0, i - 1);
          if (i !== j) {
            c.remove(obj);
            if (typeof c.insertAt === "function") c.insertAt(j, obj);
            else c.add(obj);
          }
          changed.add(op.id);
          applied.push(`${op.id} to ${op.to}`);
        }
      }
    } finally {
      this.suppressHistory = false;
    }
    const changedIds = [...changed];
    const tops = changedIds
      .map((id) => findById(c.getObjects(), id))
      .filter((o) => o && c.getObjects().includes(o));
    if (tops.length === 1) c.setActiveObject(tops[0]);
    else if (tops.length > 1) c.setActiveObject(new ActiveSelection(tops, { canvas: c }));
    c.requestRenderAll();
    this.history.snapshot();
    this.onDirty?.();
    this._syncLayers();
    this._syncSelection();
    return { applied, changedIds };
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
    const picked = c.getActiveObjects();
    if (picked.length === 0) return;
    // NOTE: fabric 6.9 has no bringForward/sendToFront — reorder manually
    // via remove + insertAt under suppressHistory for a single entry.
    this.suppressHistory = true;
    try {
      c.discardActiveObject();
      picked.forEach((o) => {
        const objs = c.getObjects();
        const i = objs.indexOf(o);
        if (i < 0) return;
        let j = i;
        if (dir === "forward") j = Math.min(objs.length - 1, i + 1);
        else if (dir === "backward") j = Math.max(0, i - 1);
        else if (dir === "front") j = objs.length - 1;
        else if (dir === "back") j = 0;
        else return;
        if (i === j) return;
        c.remove(o);
        if (typeof c.insertAt === "function") c.insertAt(j, o);
        else c.add(o);
      });
      const still = picked.filter((o) => c.getObjects().includes(o));
      if (still.length === 1) c.setActiveObject(still[0]);
      else if (still.length > 1) c.setActiveObject(new ActiveSelection(still, { canvas: c }));
    } finally {
      this.suppressHistory = false;
    }
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