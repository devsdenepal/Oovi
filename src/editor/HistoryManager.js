/**
 * Minimal undo/redo history manager for a Fabric canvas.
 *
 * Snapshots are taken after every meaningful mutation (add, remove,
 * modify, text edit, reorder) via canvas.toObject(). Restores happen
 * through canvas.loadFromJSON().
 */

import { hydrateGradients } from "../renderer/fabricRenderer";

const MAX_HISTORY = 50;

/**
 * Custom DSL props that must survive history round-trips. fabric's
 * toObject() drops unknown props by default, which used to revive
 * anonymous objects (blank preview/layers, dead selectById/patches).
 */
const HISTORY_PROPS = [
  "designId",
  "elementRole",
  "elementType",
  "designFill",
  "designGradient",
  "locked",
  "designSrc",
  "pendingSrc",
  "isImagePlaceholder",
];

export class HistoryManager {
  /**
   * @param {fabric.Canvas} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.undoStack = [];
    this.redoStack = [];
    this.saving = false;
  }

  snapshot() {
    if (this.saving) return;
    const state = JSON.stringify(this.canvas.toObject(HISTORY_PROPS));
    if (this.undoStack[this.undoStack.length - 1] === state) return;
    this.undoStack.push(state);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo() {
    // The top entry is the current state | undo needs a state beneath it.
    return this.undoStack.length > 1;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  async restore(state) {
    this.saving = true;
    this.canvas.discardActiveObject();
    try {
      // fabric 6: loadFromJSON returns a promise (2nd arg is a per-object
      // reviver, not a completion callback). Await the real completion.
      await this.canvas.loadFromJSON(state);
      // Native revive leaves gradient paints as plain objects | re-apply
      // the recorded DSL gradients (exact; see hydrateGradients).
      hydrateGradients(this.canvas);
      this.canvas.renderAll();
    } finally {
      this.saving = false;
    }
  }

  async undo() {
    // Pop the current state onto redo, restore the entry beneath it.
    // With fewer than 2 entries there is no earlier state: no-op.
    if (this.undoStack.length < 2) return;
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    await this.restore(this.undoStack[this.undoStack.length - 1]);
    this.canvas.fire("history:change");
  }

  async redo() {
    const state = this.redoStack.pop();
    if (!state) return;
    const current = JSON.stringify(this.canvas.toObject());
    this.undoStack.push(current);
    await this.restore(state);
    this.canvas.fire("history:change");
  }
}