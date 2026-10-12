/**
 * Minimal undo/redo history manager for a Fabric canvas.
 *
 * Snapshots are taken after every meaningful mutation (add, remove,
 * modify, text edit, reorder) via canvas.toObject(). Restores happen
 * through canvas.loadFromJSON().
 */

const MAX_HISTORY = 50;

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
    const state = JSON.stringify(this.canvas.toObject());
    if (this.undoStack[this.undoStack.length - 1] === state) return;
    this.undoStack.push(state);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  async restore(state) {
    this.saving = true;
    this.canvas.discardActiveObject();
    try {
      await new Promise((resolve) => {
        this.canvas.loadFromJSON(state, () => {
          this.canvas.renderAll();
          resolve();
        });
      });
    } finally {
      this.saving = false;
    }
  }

  async undo() {
    const state = this.undoStack.pop();
    if (!state) return;
    const current = JSON.stringify(this.canvas.toObject());
    this.redoStack.push(current);
    await this.restore(state);
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