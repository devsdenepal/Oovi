/**
 * Layers panel | first-class layer list (Goal 3).
 *
 * Per-row previews (fill swatch / text sample / image thumb), drag-reorder
 * for top-level layers, visibility, lock, inline rename, duplicate,
 * delete, group/ungroup, and two-way selection sync (row click selects on
 * canvas; canvas selection highlights here through activeIds).
 */

export class LayersPanel {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {(id: string) => void} handlers.onSelect
   * @param {(id: string, name: string) => void} handlers.onRename
   * @param {(id: string) => void} handlers.onVisibility
   * @param {(id: string) => void} handlers.onLock
   * @param {(id: string) => void} handlers.onDuplicate
   * @param {(id: string) => void} handlers.onDelete
   * @param {(dragId: string, targetId: string, place: "above"|"below") => void} handlers.onReorder
   * @param {() => void} handlers.onGroup
   * @param {() => void} handlers.onUngroup
   */
  constructor(container, handlers) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("layers-panel");
    this.container.innerHTML = `
      <div class="layers-head">
        <div class="panel-title">Layers</div>
        <div class="layers-head-btns">
          <button data-layers="group" class="btn btn-sm btn-light border" title="Group selected objects" aria-label="Group selected objects"><i class="fa-solid fa-object-group"></i></button>
          <button data-layers="ungroup" class="btn btn-sm btn-light border" title="Ungroup selected group" aria-label="Ungroup selected group"><i class="fa-solid fa-object-ungroup"></i></button>
        </div>
      </div>
      <ul class="layers-list"></ul>`;
    this.listEl = this.container.querySelector(".layers-list");
    this.groupBtn = this.container.querySelector('[data-layers="group"]');
    this.ungroupBtn = this.container.querySelector('[data-layers="ungroup"]');
    this.groupBtn.addEventListener("click", () => this.handlers.onGroup());
    this.ungroupBtn.addEventListener("click", () => this.handlers.onUngroup());
    this._last = { items: [], activeIds: new Set(), caps: {} };
  }

  /** Re-renders from the cached items, merging fresh caps (e.g. AI badges). */
  refresh(newCaps = {}) {
    this.render(this._last.items, this._last.activeIds, { ...this._last.caps, ...newCaps });
  }

  /**
   * @param {Array<{obj: fabric.Object, depth: number}>} items top-most first
   * @param {Set<string>} activeIds
   * @param {{canGroup?: boolean, canUngroup?: boolean}} [caps]
   */
  render(items, activeIds, caps = {}) {
    this._last = { items, activeIds, caps };
    this.groupBtn.disabled = !caps.canGroup;
    this.ungroupBtn.disabled = !caps.canUngroup;
    this.listEl.innerHTML = "";

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "layer-empty";
      empty.textContent = "Nothing on canvas yet";
      this.listEl.appendChild(empty);
      return;
    }

    let topId = null;
    for (const { obj, depth } of items) {
      if (depth === 0) topId = obj.designId;
      const id = obj.designId;
      const name = typeof id === "string" ? id : obj.elementType || obj.type;

      const li = document.createElement("li");
      li.className = "layer-item";
      if (activeIds.has(id)) li.classList.add("active");
      if (obj.visible === false) li.classList.add("layer-off");
      if (obj.locked) li.classList.add("layer-locked-row");
      li.dataset.id = id;
      li.dataset.top = topId;
      li.style.paddingLeft = `${8 + depth * 16}px`;
      if (depth === 0) li.draggable = true;

      li.innerHTML = `
        <span class="layer-icon">${previewHtml(obj)}</span>
        <span class="layer-name">${esc(name)}</span>
        ${caps.aiIds && caps.aiIds.has(id) ? '<span class="ai-tag layer-ai-badge">AI</span>' : ""}
        <span class="layer-btns">
          <button data-op="visibility" title="${obj.visible === false ? "Show" : "Hide"}" aria-label="${obj.visible === false ? "Show layer" : "Hide layer"}"><i class="fa-solid ${obj.visible === false ? "fa-eye-slash" : "fa-eye"}"></i></button>
          <button data-op="lock" title="${obj.locked ? "Unlock" : "Lock"}" aria-label="${obj.locked ? "Unlock layer" : "Lock layer"}"><i class="fa-solid ${obj.locked ? "fa-lock" : "fa-lock-open"}"></i></button>
          <button data-op="duplicate" title="Duplicate" aria-label="Duplicate layer"><i class="fa-solid fa-copy"></i></button>
          <button data-op="delete" title="Delete" aria-label="Delete layer"><i class="fa-solid fa-trash"></i></button>
        </span>`;

      li.addEventListener("click", (event) => {
        if (event.target.closest("button, input")) return;
        this.handlers.onSelect(id);
      });
      li.querySelector(".layer-name").addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this._startRename(li, id, name);
      });
      li.querySelectorAll("[data-op]").forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const op = btn.dataset.op;
          if (op === "visibility") this.handlers.onVisibility(id);
          else if (op === "lock") this.handlers.onLock(id);
          else if (op === "duplicate") this.handlers.onDuplicate(id);
          else if (op === "delete") this.handlers.onDelete(id);
        });
      });

      if (depth === 0) {
        li.addEventListener("dragstart", (event) => {
          event.dataTransfer.setData("text/plain", id);
          event.dataTransfer.effectAllowed = "move";
        });
        li.addEventListener("dragover", (event) => {
          const dragId = event.dataTransfer.types.includes("text/plain") ? id : null;
          if (!dragId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = li.getBoundingClientRect();
          const above = event.clientY < rect.top + rect.height / 2;
          li.classList.toggle("drop-above", above);
          li.classList.toggle("drop-below", !above);
        });
        li.addEventListener("dragleave", () => {
          li.classList.remove("drop-above", "drop-below");
        });
        li.addEventListener("drop", (event) => {
          event.preventDefault();
          li.classList.remove("drop-above", "drop-below");
          const dragId = event.dataTransfer.getData("text/plain");
          const targetTop = li.dataset.top;
          if (!dragId || !targetTop || dragId === targetTop) return;
          const rect = li.getBoundingClientRect();
          const place = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
          this.handlers.onReorder(dragId, targetTop, place);
        });
      }

      this.listEl.appendChild(li);
    }
  }

  _startRename(li, id, current) {
    if (li.querySelector(".layer-rename")) return;
    const nameEl = li.querySelector(".layer-name");
    const input = document.createElement("input");
    input.className = "layer-rename";
    input.value = current;
    input.setAttribute("aria-label", "Rename layer");
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) this.handlers.onRename(id, input.value);
      else this.refresh();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }
}

/** Cheap per-type preview: swatch / text sample / image thumb / icon. */
function previewHtml(obj) {
  const kind = obj.elementType || obj.type;
  if (kind === "image") {
    const src = obj.designSrc || obj.pendingSrc;
    if (src) return `<img class="layer-thumb" src="${esc(src)}" alt="" draggable="false" />`;
    return `<i class="fa-solid fa-image"></i>`;
  }
  if (kind === "text" || obj.type === "i-text" || obj.type === "textbox") {
    const color = typeof obj.fill === "string" ? obj.fill : "#1b2030";
    return `<span class="layer-glyph" style="color:${esc(color)}">A</span>`;
  }
  if (kind === "rectangle" || kind === "circle") {
    const fill = typeof obj.fill === "string" ? obj.fill : "transparent";
    const round = kind === "circle" ? "border-radius:50%;" : "";
    return `<span class="layer-swatch" style="background:${esc(fill)};${round}"></span>`;
  }
  if (kind === "line") {
    const stroke = typeof obj.stroke === "string" ? obj.stroke : "#1b2030";
    return `<span class="layer-linebar" style="background:${esc(stroke)}"></span>`;
  }
  if (kind === "group") return `<i class="fa-solid fa-object-group"></i>`;
  return `<i class="fa-solid fa-shapes"></i>`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
