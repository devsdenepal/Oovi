/**
 * InsertPanel - manual design tools that need no AI generation:
 * drop text and shapes onto the canvas, pick the new-element color
 * and the canvas background. Works like general design tools —
 * everything stays editable via the existing toolbar/layers.
 */

export class InsertPanel {
  /**
   * @param {HTMLElement} container
   * @param {{onInsert?: (type: string, fill: string) => void, onBackground?: (color: string) => void}} [handlers]
   */
  constructor(container, handlers = {}) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("insert-panel");
    this.container.innerHTML = `
      <div class="insert-grid">
        <button data-insert="text" class="btn btn-light border" title="Add editable text"><i class="fa-solid fa-font"></i> Text</button>
        <button data-insert="rectangle" class="btn btn-light border" title="Add rectangle"><i class="fa-solid fa-square"></i> Rect</button>
        <button data-insert="circle" class="btn btn-light border" title="Add circle"><i class="fa-solid fa-circle"></i> Circle</button>
        <button data-insert="line" class="btn btn-light border" title="Add line"><i class="fa-solid fa-minus"></i> Line</button>
      </div>
      <div class="insert-color-row">
        <label for="insert-fill">New element color</label>
        <input id="insert-fill" type="color" value="#4f46e5" />
      </div>
      <div class="insert-color-row">
        <label for="insert-bg">Canvas background</label>
        <input id="insert-bg" type="color" value="#f5f5f7" />
      </div>
      <div class="insert-hint">Dropped at canvas center — drag to move, double-click text to edit.</div>
    `;

    this.fillInput = this.container.querySelector("#insert-fill");
    this.bgInput = this.container.querySelector("#insert-bg");

    this.container.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-insert]");
      if (!btn) return;
      this.handlers.onInsert?.(btn.dataset.insert, this.fillInput.value);
    });

    // "change" (not "input") so dragging the picker doesn't flood history.
    this.bgInput.addEventListener("change", () => {
      this.handlers.onBackground?.(this.bgInput.value);
    });
  }
}
