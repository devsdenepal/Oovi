/**
 * Toolbar - properties panel for editing the selected object directly
 * (text edit, size, color). Goal 1: action buttons (undo/redo/duplicate/
 * delete/regenerate/clear/export) moved to TopBar + ContextToolbar;
 * this component owns selection properties only. (Adaptive per-type
 * controls arrive in Goal 2.)
 */

export class Toolbar {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {(prop: string, value: string) => void} handlers.onPropChange
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
      <div class="properties-panel">
        <div class="panel-title">Properties</div>
        <div id="prop-empty" class="prop-empty">Select an element to edit it here.</div>
        <div id="prop-fields" class="prop-fields hidden"></div>
      </div>
    `;

    this.propEmpty = this.container.querySelector("#prop-empty");
    this.propFields = this.container.querySelector("#prop-fields");

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