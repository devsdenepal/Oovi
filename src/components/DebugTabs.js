/**
 * DebugTabs - collapsible, read-only tabs exposing the pipeline artifacts:
 *   Design      the pixel Design JSON rendered on the canvas
 *   Analysis    the ReferenceDesignAnalysis of the uploaded reference
 *   Semantic SVG   the SVG visualization of the reference analysis
 *   Semantic DSL   the model's semantic design before layout
 */

const TABS = [
  { id: "design", label: "Design" },
  { id: "analysis", label: "Analysis" },
  { id: "svg", label: "Semantic SVG" },
  { id: "semantic", label: "Semantic DSL" },
];

export class DebugTabs {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    this.container.classList.add("debug-tabs");
    this.state = {};

    this.container.innerHTML = `
      <div class="debug-tabs-header">
        <span class="panel-title">Artifacts</span>
        <div class="debug-tabs-nav"></div>
      </div>
      <div class="debug-tabs-body"></div>
    `;
    this.nav = this.container.querySelector(".debug-tabs-nav");
    this.body = this.container.querySelector(".debug-tabs-body");

    this.panels = {};
    for (const tab of TABS) {
      const button = document.createElement("button");
      button.className = "btn btn-small debug-tab-btn";
      button.textContent = tab.label;
      button.dataset.tab = tab.id;
      this.nav.appendChild(button);

      const panel = document.createElement("pre");
      panel.className = `debug-tab-panel debug-${tab.id}`;
      panel.textContent = "";
      this.body.appendChild(panel);
      this.panels[tab.id] = panel;

      button.addEventListener("click", () => this.show(tab.id));
    }

    this._active = "design";
    this._renderTabs();
  }

  /**
   * @param {{design?: object, analysis?: object|null, svg?: string, semantic?: object|null, warnings?: string[]}} state
   */
  set(state = {}) {
    this.state = state;
    this.panels.design.textContent = state.design ? JSON.stringify(state.design, null, 2) : "No design generated yet.";
    this.panels.analysis.textContent = state.analysis ? JSON.stringify(state.analysis, null, 2) : "No reference analyzed.";
    this.panels.svg.textContent = state.svg || "No reference analyzed.";
    this.panels.semantic.textContent = state.semantic ? JSON.stringify(state.semantic, null, 2) : "Pixel prompt path (no reference).";
    if (state.warnings && state.warnings.length) {
      const prepend = `// layout warnings:\n// - ${state.warnings.join("\n// - ")}\n\n`;
      if (this._active === "semantic") this.panels.semantic.textContent = prepend + this.panels.semantic.textContent;
    }
  }

  show(tabId) {
    this._active = TABS.some((t) => t.id === tabId) ? tabId : "design";
    this._renderTabs();
  }

  _renderTabs() {
    for (const button of this.nav.querySelectorAll(".debug-tab-btn")) {
      const active = button.dataset.tab === this._active;
      button.classList.toggle("debug-tab-btn-active", active);
      this.panels[button.dataset.tab].classList.toggle("debug-hidden", !active);
    }
  }
}