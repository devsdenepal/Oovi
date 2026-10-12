/**
 * TopBar - the single editor top bar (Goal 1 chrome).
 *
 * Owns: inline-rename title, canvas size meta, Design/Code/Pipeline view
 * tabs, undo/redo, zoom (Fit/100%/-/+) , autosave status, Preview, Export.
 * All behavior arrives via handlers from App; this class only renders DOM
 * and forwards events. It never touches the editor or AI layers.
 */

export class TopBar {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {() => void} handlers.onUndo
   * @param {() => void} handlers.onRedo
   * @param {(mode: "fit"|"actual"|"in"|"out") => void} handlers.onZoom
   * @param {() => void} handlers.onPreview
   * @param {() => void} handlers.onExport
   * @param {(title: string) => void} handlers.onTitle
   * @param {(tab: "design"|"code"|"pipeline") => void} handlers.onTab
   */
  constructor(container, handlers) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("oovi-topbar");
    this.container.innerHTML = `
      <div class="tb-brand">
        <span class="logo" aria-hidden="true"><i class="fa-solid fa-pen-nib"></i></span>
        <span class="tb-title-wrap">
          <input id="doc-title" class="tb-title" value="Untitled design" maxlength="80" aria-label="Design title" spellcheck="false" />
          <small class="tb-sub">AI Editable Studio · <span class="canvas-meta">1200 × 630</span></small>
        </span>
      </div>
      <div class="tb-tabs d-none d-md-block">
        <ul class="nav nav-pills tb-pill-nav gap-1">
          <li class="nav-item"><button class="nav-link rounded-pill active py-1 px-3" type="button" data-tb-tab="design">Design</button></li>
          <li class="nav-item"><button class="nav-link rounded-pill py-1 px-3" type="button" data-tb-tab="code">Code</button></li>
          <li class="nav-item"><button class="nav-link rounded-pill py-1 px-3" type="button" data-tb-tab="pipeline">Pipeline</button></li>
        </ul>
      </div>
      <div class="tb-actions">
        <div class="btn-group btn-group-sm" role="group" aria-label="History">
          <button data-tb="undo" class="btn btn-light border" title="Undo (Ctrl+Z)"><i class="fa-solid fa-rotate-left"></i></button>
          <button data-tb="redo" class="btn btn-light border" title="Redo (Ctrl+Y)"><i class="fa-solid fa-rotate-right"></i></button>
        </div>
        <div class="btn-group btn-group-sm" role="group" aria-label="Zoom">
          <button data-tb="zoom-out" class="btn btn-light border" title="Zoom out"><i class="fa-solid fa-minus"></i></button>
          <button data-tb="zoom-fit" class="btn btn-light border tb-zoom-label" title="Fit to screen">Fit</button>
          <button data-tb="zoom-in" class="btn btn-light border" title="Zoom in"><i class="fa-solid fa-plus"></i></button>
          <button data-tb="zoom-100" class="btn btn-light border" title="Actual size (100%)">100%</button>
        </div>
        <span id="save-status" class="save-status save-saved" title="Autosave state">Saved</span>
        <button data-tb="preview" class="btn btn-sm btn-light border" title="Preview without editor chrome"><i class="fa-solid fa-eye"></i> Preview</button>
        <button data-tb="export" class="btn btn-sm btn-primary" title="Export PNG (full dialog in Goal 6)"><i class="fa-solid fa-download"></i> Export</button>
      </div>
    `;

    this.undoBtn = this.container.querySelector('[data-tb="undo"]');
    this.redoBtn = this.container.querySelector('[data-tb="redo"]');
    this.zoomLabel = this.container.querySelector('[data-tb="zoom-fit"]');
    this.saveStatus = this.container.querySelector("#save-status");
    this.titleInput = this.container.querySelector("#doc-title");

    this.container.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tb-tab]");
      if (tab) {
        this.container.querySelectorAll("[data-tb-tab]").forEach((b) => b.classList.remove("active"));
        tab.classList.add("active");
        this.handlers.onTab(tab.dataset.tbTab);
        return;
      }
      const btn = event.target.closest("[data-tb]");
      if (!btn) return;
      const action = btn.dataset.tb;
      if (action === "undo") this.handlers.onUndo();
      else if (action === "redo") this.handlers.onRedo();
      else if (action === "zoom-out") this.handlers.onZoom("out");
      else if (action === "zoom-fit") this.handlers.onZoom("fit");
      else if (action === "zoom-in") this.handlers.onZoom("in");
      else if (action === "zoom-100") this.handlers.onZoom("actual");
      else if (action === "preview") this.handlers.onPreview();
      else if (action === "export") this.handlers.onExport();
    });

    this.titleInput.addEventListener("change", () => {
      const value = this.titleInput.value.trim() || "Untitled design";
      this.titleInput.value = value;
      this.handlers.onTitle(value);
    });
  }

  /**
   * @param {{canUndo?: boolean, canRedo?: boolean, zoomLabel?: string}} state
   */
  refresh(state = {}) {
    if (state.canUndo !== undefined) this.undoBtn.disabled = !state.canUndo;
    if (state.canRedo !== undefined) this.redoBtn.disabled = !state.canRedo;
    if (state.zoomLabel !== undefined) this.zoomLabel.textContent = state.zoomLabel;
  }

  /**
   * @param {"saved"|"saving"|"unsaved"} state
   */
  setSaveState(state) {
    this.saveStatus.className = `save-status save-${state}`;
    this.saveStatus.textContent = state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Unsaved";
  }

  /** @param {string} title */
  setTitle(title) {
    if (document.activeElement !== this.titleInput) this.titleInput.value = title;
  }
}
