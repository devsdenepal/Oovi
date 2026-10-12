import { createFabricCanvas, renderDesign, canvasToDesign } from "../renderer/fabricRenderer";
import { HistoryManager } from "./HistoryManager";
import { ActiveSelection } from "fabric";

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

    holder.style.width = `${Math.round(c.width * fitScale)}px`;
    holder.style.height = `${Math.round(c.height * fitScale)}px`;

    const canvasEl = c.getElement ? c.getElement() : holder.querySelector("canvas");
    if (canvasEl) {
      canvasEl.style.transform = `scale(${fitScale})`;
      canvasEl.style.transformOrigin = "0 0";
    }

    this.fitScale = fitScale;
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
    // getObjects() returns bottom-most first; the layers panel shows
    // top-most first, matching the spec order (Footer on top of Rectangle...).
    const layers = [...this.canvas.getObjects()].reverse();
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
    const obj = this.canvas.getObjects().find((o) => o.designId === id);
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

  setActiveProperty(prop, value) {
    const active = this.canvas.getActiveObjects();
    if (active.length === 0) return;
    active.forEach((obj) => {
      // Editable name differs per object type.
      if (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text") {
        if (prop === "content") obj.set("text", value);
        else if (prop === "fontSize") obj.set("fontSize", Number(value));
        else if (prop === "fill") obj.set("fill", value);
        else if (prop === "fontWeight") obj.set("fontWeight", Number(value));
      } else if (prop === "fill") {
        obj.set("fill", value);
      }
    });
    this.canvas.requestRenderAll();
    this._handleMutation();
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