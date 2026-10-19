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
   * @param {() => void} [handlers.onSaveTemplate]
   * @param {(format: "png"|"jpg"|"svg"|"pdf") => void} handlers.onExport
   * @param {(title: string) => void} handlers.onTitle
   * @param {(tab: "design"|"code"|"pipeline") => void} handlers.onTab
   * @param {() => void} handlers.onHome
   */
  constructor(container, handlers) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("oovi-topbar");
    this.container.innerHTML = `
      <div class="tb-brand">
        <button class="logo logo-btn" data-tb="home" title="Back to dashboard" aria-label="Back to dashboard"><i class="fa-solid fa-pen-nib"></i></button>
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
          <button data-tb="undo" class="btn btn-light border" title="Undo (Ctrl+Z)" aria-label="Undo"><i class="fa-solid fa-rotate-left"></i></button>
          <button data-tb="redo" class="btn btn-light border" title="Redo (Ctrl+Y)" aria-label="Redo"><i class="fa-solid fa-rotate-right"></i></button>
        </div>
        <div class="btn-group btn-group-sm" role="group" aria-label="Zoom">
          <button data-tb="zoom-out" class="btn btn-light border" title="Zoom out" aria-label="Zoom out"><i class="fa-solid fa-minus"></i></button>
          <button data-tb="zoom-fit" class="btn btn-light border tb-zoom-label" title="Fit to screen">Fit</button>
          <button data-tb="zoom-in" class="btn btn-light border" title="Zoom in" aria-label="Zoom in"><i class="fa-solid fa-plus"></i></button>
          <button data-tb="zoom-100" class="btn btn-light border" title="Actual size (100%)">100%</button>
        </div>
        <span id="save-status" class="save-status save-saved" title="Autosave state">Saved</span>
        <button data-tb="save-template" class="btn btn-sm btn-light border" title="Save this layout as a reusable template"><i class="fa-solid fa-bookmark"></i> Template</button>
        <button data-tb="preview" class="btn btn-sm btn-light border" title="Preview without editor chrome"><i class="fa-solid fa-eye"></i> Preview</button>
        <div class="tb-export-wrap">
          <button data-tb="export-menu" class="btn btn-sm btn-primary" title="Download the design"><i class="fa-solid fa-download"></i> Export</button>
          <div class="tb-export-menu" hidden>
            <button type="button" data-tb-export="png">PNG <span class="muted">image</span></button>
            <button type="button" data-tb-export="jpg">JPG <span class="muted">image</span></button>
            <button type="button" data-tb-export="svg">SVG <span class="muted">vector</span></button>
            <button type="button" data-tb-export="pdf">PDF <span class="muted">document</span></button>
          </div>
        </div>
      </div>
    `;

    this.undoBtn = this.container.querySelector('[data-tb="undo"]');
    this.redoBtn = this.container.querySelector('[data-tb="redo"]');
    this.zoomLabel = this.container.querySelector('[data-tb="zoom-fit"]');
    this.saveStatus = this.container.querySelector("#save-status");
    this.titleInput = this.container.querySelector("#doc-title");
    this.exportMenu = this.container.querySelector(".tb-export-menu");

    this.container.addEventListener("click", (event) => {
      const fmt = event.target.closest("[data-tb-export]");
      if (fmt) {
        this.exportMenu.hidden = true;
        this.handlers.onExport(fmt.dataset.tbExport);
        return;
      }
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
      else if (action === "save-template") this.handlers.onSaveTemplate?.();
      else if (action === "export-menu") this.exportMenu.hidden = !this.exportMenu.hidden;
      else if (action === "home") this.handlers.onHome();
    });

    this.titleInput.addEventListener("change", () => {
      const value = this.titleInput.value.trim() || "Untitled design";
      this.titleInput.value = value;
      this.handlers.onTitle(value);
    });

    document.addEventListener("click", (event) => {
      if (!this.exportMenu.hidden && !event.target.closest(".tb-export-wrap")) {
        this.exportMenu.hidden = true;
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.exportMenu.hidden) this.exportMenu.hidden = true;
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
   * @param {"saved"|"saving"|"unsaved"|"error"} state
   */
  setSaveState(state) {
    const safe = state === "error" ? "error" : state;
    this.saveStatus.className = `save-status save-${safe}`;
    this.saveStatus.textContent =
      safe === "saved" ? "Saved" : safe === "saving" ? "Saving…" : safe === "error" ? "Save error" : "Unsaved";
  }

  /** @param {string} title */
  setTitle(title) {
    if (document.activeElement !== this.titleInput) this.titleInput.value = title;
  }
}
