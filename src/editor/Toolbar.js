/**
 * Toolbar - regeneration, clear, canvas operations, and a properties
 * panel for editing the selected object directly (text edit, size, color).
 */

export class Toolbar {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {() => void} handlers.onRegenerate
   * @param {() => void} handlers.onClear
   * @param {() => void} handlers.onUndo
   * @param {() => void} handlers.onRedo
   * @param {() => void} handlers.onDuplicate
   * @param {() => void} handlers.onDelete
   * @param {() => void} handlers.onExport
   * @param {(prop: string, value: string) => void} handlers.onPropChange
   * @param {() => Object} handlers.getDesign   - returns current enabled state info
   */
  constructor(container, handlers) {
    this.container = container;
    this.handlers = handlers;
    this.container.classList.add("toolbar");
    this.activeObjects = [];
    this._build();
  }

  _build() {
    this.container.innerHTML = `
      <div class="toolbar-row">
        <button data-action="regenerate" class="btn btn-primary">Regenerate</button>
        <button data-action="clear" class="btn">Clear Canvas</button>
        <button data-action="export" class="btn" title="Export the design as a PNG">⇩ Export PNG</button>
      </div>
      <div class="toolbar-row">
        <button data-action="undo" class="btn" title="Undo (Ctrl+Z)">↩ Undo</button>
        <button data-action="redo" class="btn" title="Redo (Ctrl+Y)">↪ Redo</button>
        <button data-action="duplicate" class="btn" title="Duplicate (Ctrl+D)">⧉ Duplicate</button>
        <button data-action="delete" class="btn btn-danger" title="Delete (Del)">🗑 Delete</button>
      </div>
      <div class="toolbar-row hint">Double-click text on canvas to edit it · Shift-click to multi-select · Ctrl+A select all</div>
      <div class="properties-panel">
        <div class="panel-title">Properties</div>
        <div id="prop-empty" class="prop-empty">Select an element to edit it here.</div>
        <div id="prop-fields" class="prop-fields hidden"></div>
      </div>
    `;

    this.propEmpty = this.container.querySelector("#prop-empty");
    this.propFields = this.container.querySelector("#prop-fields");

    this.container.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const handlers = {
        regenerate: () => this.handlers.onRegenerate(),
        clear: () => this.handlers.onClear(),
        export: () => this.handlers.onExport(),
        undo: () => this.handlers.onUndo(),
        redo: () => this.handlers.onRedo(),
        duplicate: () => this.handlers.onDuplicate(),
        delete: () => this.handlers.onDelete(),
      };
      handlers[action]?.();
    });

    this.propFields.addEventListener("change", (event) => {
      const field = event.target.closest("[data-prop]");
      if (!field) return;
      this.handlers.onPropChange(field.dataset.prop, field.value);
    });
  }

  /**
   * @param {fabric.Object[]} objects the currently selected objects
   */
  setSelection(objects) {
    this.activeObjects = objects || [];
    let disabled = { undo: false, redo: false, duplicate: true, delete: true };
    if (this.handlers.getEnabledState) {
      disabled = { ...disabled, ...this.handlers.getEnabledState() };
    }
    this.container.querySelector('[data-action="duplicate"]').disabled = disabled.duplicate;
    this.container.querySelector('[data-action="delete"]').disabled = disabled.delete;
    this.container.querySelector('[data-action="undo"]').disabled = disabled.undo;
    this.container.querySelector('[data-action="redo"]').disabled = disabled.redo;

    this._renderProperties();
  }

  _renderProperties() {
    const first = this.activeObjects[0];
    if (!first) {
      this.propEmpty.classList.remove("hidden");
      this.propFields.classList.add("hidden");
      this.propFields.innerHTML = "";
      return;
    }

    this.propEmpty.classList.add("hidden");
    this.propFields.classList.remove("hidden");

    const type = first.elementType || first.type;
    const isText =
      type === "text" || first.type === "i-text" || first.type === "textbox";

    this.propFields.innerHTML = `
      <div class="prop-row">
        <label for="prop-id">id</label>
        <input id="prop-id" type="text" value="${esc(first.designId || "")}" disabled />
      </div>
      <div class="prop-row">
        <label for="prop-role">role</label>
        <input id="prop-role" type="text" value="${esc(first.elementRole || "")}" disabled />
      </div>
      ${isText ? `
        <div class="prop-row">
          <label for="prop-content">content</label>
          <textarea id="prop-content" data-prop="content" rows="2">${esc(first.text || "")}</textarea>
        </div>
        <div class="prop-row">
          <label for="prop-fontSize">font size</label>
          <input id="prop-fontSize" type="number" min="4" max="400" data-prop="fontSize" value="${first.fontSize ?? 24}" />
        </div>
        <div class="prop-row">
          <label for="prop-fontWeight">weight</label>
          <select id="prop-fontWeight" data-prop="fontWeight">
            ${[100,200,300,400,500,600,700,800,900].map(w => `<option value="${w}" ${first.fontWeight === w ? "selected" : ""}>${w}</option>`).join("")}
          </select>
        </div>
      ` : ""}
      <div class="prop-row">
        <label for="prop-fill">color</label>
        <input id="prop-fill" type="color" data-prop="fill" value="${colorValue(first.fill)}" />
      </div>
    `;
  }
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colorValue(fill) {
  if (typeof fill === "string" && /^#[0-9a-fA-F]{6}$/.test(fill)) return fill;
  return "#000000";
}