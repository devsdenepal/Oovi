/**
 * Toolbar - adaptive properties panel (Goal 2).
 *
 * Renders controls by selection: none → artboard (background/size);
 * single text / shape / line / group; multi → align/distribute/order.
 * Actions live in TopBar + ContextToolbar; this component owns
 * selection properties only. Every edit routes through the editor's
 * history path (one undo entry per change).
 */

const FONT_STACK = ["Arial", "Georgia", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "Impact"];
const TEXT_ALIGNS = ["left", "center", "right", "justify"];

export class Toolbar {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {(prop: string, value: string) => void} handlers.onPropChange
   * @param {(cmd: string) => void} [handlers.onCommand] align/distribute/order commands
   * @param {(key: string, value: string) => void} [handlers.onArtboardProp]
   * @param {() => ({background?: string, width?: number, height?: number} | null)} [handlers.getArtboard]
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
        <div id="prop-empty" class="prop-empty">Select an object to edit it.</div>
        <div id="prop-fields" class="prop-fields hidden"></div>
      </div>
    `;

    this.propEmpty = this.container.querySelector("#prop-empty");
    this.propFields = this.container.querySelector("#prop-fields");

    this.container.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-cmd]");
      if (!btn || btn.disabled) return;
      this.handlers.onCommand?.(btn.dataset.cmd);
    });

    this.propFields.addEventListener("change", (event) => {
      const abo = event.target.closest("[data-aprop]");
      if (abo) {
        this.handlers.onArtboardProp?.(abo.dataset.aprop, abo.value);
        return;
      }
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
    const objs = this.activeObjects;
    this.propEmpty.classList.add("hidden");
    this.propFields.classList.remove("hidden");
    this.propFields.innerHTML =
      objs.length === 0
        ? this._artboardSection()
        : objs.length > 1
          ? this._multiSection(objs)
          : this._singleSection(objs[0]);
  }

  _artboardSection() {
    const board = this.handlers.getArtboard ? this.handlers.getArtboard() : null;
    return `
      <div class="prop-section-name">Artboard</div>
      <div class="prop-row">
        <label for="prop-bg">background</label>
        <input id="prop-bg" type="color" data-aprop="background" value="${cssToHex(board?.background, "#f5f5f7")}" />
      </div>
      <div class="prop-row">
        <label for="prop-aw">width</label>
        <input id="prop-aw" type="number" min="64" max="4096" step="1" data-aprop="width" value="${Math.round(board?.width || 0)}" />
      </div>
      <div class="prop-row">
        <label for="prop-ah">height</label>
        <input id="prop-ah" type="number" min="64" max="4096" step="1" data-aprop="height" value="${Math.round(board?.height || 0)}" />
      </div>
    `;
  }

  _geomRows(obj, size) {
    let sizeRows = "";
    if (size === "rect") {
      sizeRows =
        numRow("width", `data-prop="width" value="${Math.round(obj.width || 0)}" min="1" step="1"`, "px") +
        numRow("height", `data-prop="height" value="${Math.round(obj.height || 0)}" min="1" step="1"`, "px");
    } else if (size === "circle") {
      sizeRows = numRow("radius", `data-prop="radius" value="${Math.round(obj.radius || 0)}" min="1" step="1"`, "px");
    } else if (size === "text") {
      sizeRows = numRow("width", `data-prop="width" value="${Math.round(obj.width || 0)}" min="40" step="1" title="Wrap width"`, "px");
    }
    return (
      numRow("x", `data-prop="x" value="${Math.round(obj.left || 0)}" step="1"`, "px") +
      numRow("y", `data-prop="y" value="${Math.round(obj.top || 0)}" step="1"`, "px") +
      sizeRows +
      numRow("rotation", `data-prop="angle" value="${Math.round(obj.angle || 0)}" min="0" max="360" step="1"`, "°") +
      `<div class="prop-row"><label>opacity</label><input type="range" min="0" max="1" step="0.05" data-prop="opacity" value="${obj.opacity ?? 1}" /></div>`
    );
  }

  _orderRow() {
    const b = (cmd, label) =>
      `<button class="btn btn-sm btn-light border" data-cmd="${cmd}" title="${label}" aria-label="${label}"><i class="fa-solid ${cmd === "order-front" ? "fa-chevrons-up" : cmd === "order-forward" ? "fa-chevron-up" : cmd === "order-backward" ? "fa-chevron-down" : "fa-chevrons-down"}"></i></button>`;
    return `
      <div class="prop-section-name">Arrange</div>
      <div class="prop-btn-row">
        ${b("order-front", "Bring to front")}
        ${b("order-forward", "Bring forward")}
        ${b("order-backward", "Send backward")}
        ${b("order-back", "Send to back")}
      </div>`;
  }

  _alignRow() {
    const b = (cmd, icon, title) =>
      `<button class="btn btn-sm btn-light border" data-cmd="${cmd}" title="${title}" aria-label="${title}"><i class="fa-solid ${icon}"></i></button>`;
    return `
      <div class="prop-section-name">Align to canvas</div>
      <div class="prop-btn-row">
        ${b("align-left", "fa-align-left", "Align left")}
        ${b("align-center", "fa-align-center", "Align center")}
        ${b("align-right", "fa-align-right", "Align right")}
        ${b("align-top", "fa-arrow-up", "Align top")}
        ${b("align-middle", "fa-minus", "Align middle")}
        ${b("align-bottom", "fa-arrow-down", "Align bottom")}
      </div>`;
  }

  _distributeRow(count) {
    const dis = count < 3 ? "disabled" : "";
    return `
      <div class="prop-section-name">Distribute</div>
      <div class="prop-btn-row">
        <button class="btn btn-sm btn-light border" data-cmd="distribute-x" title="Distribute horizontally (needs 3+ selected)" aria-label="Distribute horizontally" ${dis}><i class="fa-solid fa-arrows-left-right"></i></button>
        <button class="btn btn-sm btn-light border" data-cmd="distribute-y" title="Distribute vertically (needs 3+ selected)" aria-label="Distribute vertically" ${dis}><i class="fa-solid fa-arrows-up-down"></i></button>
      </div>`;
  }

  _singleSection(obj) {
    const kind = obj.elementType || obj.type;
    const isText = kind === "text" || obj.type === "i-text" || obj.type === "textbox";
    const isLine = kind === "line";
    const isCircle = kind === "circle";
    const isImage = kind === "image";
    const label = typeof obj.designId === "string" && obj.designId ? obj.designId : kind;

    if (isImage) {
      return `
      <div class="prop-section-name">${esc(label)}</div>
      ${this._geomRows(obj, "rect")}
      <div class="prop-row"><label>source</label><input type="text" value="${esc(obj.designSrc || obj.pendingSrc || "")}" disabled /></div>
      <div class="insert-hint">Image from this device.</div>
      <button class="btn btn-sm btn-light border w-100" data-cmd="remove-bg" title="Remove the image background"><i class="fa-solid fa-eraser"></i> Remove background</button>
      ${this._alignRow()}
      ${this._orderRow()}`;
    }

    let paint = "";
    if (!isLine) {
      paint += `<div class="prop-row"><label>fill</label><input type="color" data-prop="fill" value="${colorValue(obj.fill)}" /></div>`;
    }
    paint += `
      <div class="prop-row"><label>stroke</label><input type="color" data-prop="stroke" value="${colorValue(obj.stroke)}" /></div>
      <div class="prop-row"><label>stroke w</label><span class="prop-num"><input type="number" min="0" step="1" data-prop="strokeWidth" value="${Math.round(obj.strokeWidth ?? (isLine ? 4 : 0))}" /><span aria-hidden="true">px</span></span></div>`;

    let textRows = "";
    if (isText) {
      textRows = `
        <div class="prop-section-name">Text</div>
        <div class="prop-row"><label>content</label><textarea data-prop="content" rows="2">${esc(obj.text || "")}</textarea></div>
        <div class="prop-row"><label>font</label><select data-prop="fontFamily">${FONT_STACK.map((f) => `<option value="${f}"${(obj.fontFamily || "Arial") === f ? " selected" : ""}>${f}</option>`).join("")}</select></div>
        <div class="prop-row"><label>size</label><span class="prop-num"><input type="number" min="4" max="400" step="1" data-prop="fontSize" value="${Math.round(obj.fontSize ?? 24)}" /><span aria-hidden="true">px</span></span></div>
        <div class="prop-row"><label>weight</label><select data-prop="fontWeight">${[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => `<option value="${w}"${obj.fontWeight === w ? " selected" : ""}>${w}</option>`).join("")}</select></div>
        <div class="prop-row"><label>align</label><select data-prop="textAlign">${TEXT_ALIGNS.map((a) => `<option value="${a}"${(obj.textAlign || "left") === a ? " selected" : ""}>${a}</option>`).join("")}</select></div>
        <div class="prop-row"><label>line h</label><input type="number" min="0.5" max="3" step="0.1" data-prop="lineHeight" value="${obj.lineHeight ?? 1.2}" /></div>
        <div class="prop-row"><label>spacing</label><input type="number" step="50" data-prop="charSpacing" value="${Math.round(obj.charSpacing || 0)}" title="Letter spacing in 1/1000 em" /></div>`;
    }

    let shapeRows = "";
    if (kind === "rectangle") {
      shapeRows = `<div class="prop-row"><label>radius</label><input type="number" min="0" step="1" data-prop="cornerRadius" value="${Math.round(obj.rx || 0)}" /></div>`;
    }

    return `
      <div class="prop-section-name">${esc(label)}</div>
      ${this._geomRows(obj, isCircle ? "circle" : isLine ? "none" : isText ? "text" : "rect")}
      ${textRows}
      ${shapeRows}
      ${paint ? `<div class="prop-section-name">Paint</div>${paint}` : ""}
      ${this._alignRow()}
      ${this._orderRow()}`;
  }

  _multiSection(objs) {
    return `
      <div class="prop-section-name">${objs.length} selected</div>
      <div class="prop-row"><label>opacity</label><input type="range" min="0" max="1" step="0.05" data-prop="opacity" value="1" /></div>
      ${this._alignRow()}
      ${this._distributeRow(objs.length)}
      ${this._orderRow()}`;
  }
}

function numRow(label, inputAttrs, unit) {
  return `<div class="prop-row"><label>${label}</label><span class="prop-num"><input type="number" ${inputAttrs} /><span aria-hidden="true">${unit}</span></span></div>`;
}

function cssToHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  const full = v.match(/^#([0-9a-f]{6})$/);
  if (full) return `#${full[1]}`;
  const short = v.match(/^#([0-9a-f]{3})$/);
  if (short) return `#${short[1].split("").map((c) => c + c).join("")}`;
  if (v === "white") return "#ffffff";
  if (v === "black") return "#000000";
  if (v === "transparent") return "#ffffff";
  return fallback;
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