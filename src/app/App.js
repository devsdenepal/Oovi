import { generateDesign } from "../ai/aiClient";
import { validateDesign } from "../design/designValidator";
import { DEFAULT_PRESET_ID, DESIGN_PRESETS, getPreset } from "../design/presets";
import { buildSemanticSvg } from "../reference/svg/semanticSvg";
import { CanvasEditor } from "../editor/Canvas";
import { LayersPanel } from "../editor/LayersPanel";
import { Toolbar } from "../editor/Toolbar";
import { PromptInput } from "../components/PromptInput";
import { GenerateButton } from "../components/GenerateButton";
import { TopBar } from "../components/TopBar";
import { ContextToolbar } from "../components/ContextToolbar";
import { DesignTypeSelect } from "../components/DesignTypeSelect";
import { InsertPanel } from "../components/InsertPanel";
import { notify } from "../ui/toasts";
import { ReferenceUpload } from "../components/ReferenceUpload";
import { InfluenceSlider } from "../components/InfluenceSlider";
import { DebugTabs } from "../components/DebugTabs";

/**
 * App - the UI coordination layer.
 *
 * Owns the DOM wiring and the generate pipeline:
 *   prompt (+ optional reference analysis) -> generateDesign()
 *     -> validated design -> CanvasEditor.loadDesign()
 *
 * The App is the only module that knows about both the AI side and the
 * editor side. It does so through their public APIs and the shared Design
 * type - never through each other's internals.
 */

const EXAMPLE_PROMPT =
  "Create a modern product announcement for our new AI assistant. Include the company name header, a bold headline, supporting body text, a decorative rounded rectangle, and a footer with the website.";

export class App {
  /**
   * @param {Object} mounts element ids: topbar, prompt, generate, designType, insert, toolbar, layers, canvas, json, contextbar
   * @param {{leftTabs?: {set: (id: string) => void}}} [opts]
   */
  constructor(mounts, opts = {}) {
    this.state = {
      design: null,
      generating: false,
      title: "Untitled design",
      preview: false,
    };
    this.leftTabs = opts.leftTabs || null;
    this._saveTimer = null;

    this.referenceAnalysis = null;
    this.referenceInfluence = 0.8;
    this.designPreset = getPreset(DEFAULT_PRESET_ID);

    this.editor = new CanvasEditor(mounts.canvasHolder);

    this.promptInput = new PromptInput(document.getElementById(mounts.prompt));
    this.generateButton = new GenerateButton(
      document.getElementById(mounts.generate),
      () => this.onGenerate(),
    );
    this.designTypeSelect = new DesignTypeSelect(document.getElementById(mounts.designType), {
      presets: DESIGN_PRESETS,
      defaultId: DEFAULT_PRESET_ID,
      onChange: (id) => this.onDesignTypeChange(id),
    });
    this.insertPanel = new InsertPanel(document.getElementById(mounts.insert), {
      onInsert: (type, fill) => this.editor.addElementOfType(type, fill),
      onBackground: (color) => this.editor.setBackground(color),
    });

    this.referenceUpload = new ReferenceUpload(
      document.getElementById(mounts.reference),
      { onAnalysis: (analysis) => this.onReferenceAnalysis(analysis) },
    );
    this.influenceSlider = new InfluenceSlider(
      document.getElementById(mounts.influence),
      {
        defaultValue: this.referenceInfluence,
        onChange: (value) => {
          this.referenceInfluence = value;
        },
      },
    );
    this.debugTabs = new DebugTabs(document.getElementById(mounts.debug));

    this.layersPanel = new LayersPanel(document.getElementById(mounts.layers), (id) =>
      this.editor.selectById(id),
    );

    this.properties = new Toolbar(document.getElementById(mounts.toolbar), {
      onPropChange: (prop, value) => this.editor.setActiveProperty(prop, value),
    });

    this.topbar = new TopBar(document.getElementById(mounts.topbar), {
      onUndo: () => this.onUndo(),
      onRedo: () => this.onRedo(),
      onZoom: (mode) => this.onZoom(mode),
      onPreview: () => this.togglePreview(),
      onExport: () => this.editor.exportPng(),
      onTitle: (title) => this.onTitle(title),
      onTab: (tab) => this.onTab(tab),
    });

    this.contextbar = new ContextToolbar(document.getElementById(mounts.contextbar), {
      onDuplicate: () => this.editor.duplicateActive(),
      onDelete: () => this.editor.deleteActive(),
      onToggleLock: () => this.onToggleLock(),
    });

    this.jsonContainer = document.getElementById(mounts.json);
    this.devRole = document.getElementById("dev-role");
    this.jsonPreview = this.jsonContainer.querySelector("#json-preview");
    this.jsonToggle = this.jsonContainer.querySelector("#json-toggle");

    this.promptInput.value = EXAMPLE_PROMPT;
    this._wireJsonToggle();

    // Subscribe editor -> panels/toolbar.
    this.editor.layersCallback = (layers, activeIds) => {
      this.layersPanel.render(layers, activeIds);
    };
    this.editor.selectionCallback = (objects) => {
      this.properties.setSelection(objects);
      this._renderJsonPreview();
      this._syncContextBar(objects);
      const first = objects && objects[0];
      if (this.devRole) this.devRole.textContent = first ? String(first.elementRole || "—") : "—";
    };
    this.editor.onDirty = () => this.scheduleSave();
  }

  async boot() {
    // Start with an empty canvas restricted to the default design-type
    // preset (Facebook Post). Generation only runs when the user presses
    // Generate — never automatically on startup.
    const preset = this.designPreset;
    const placeholder = {
      canvas: { width: preset.width, height: preset.height, background: "#F5F5F7" },
      elements: [],
    };
    try {
      this.editor.mount(placeholder);
    } catch (error) {
      this.generateButton.setError(`Canvas failed to init: ${error.message}`);
      console.error(error);
      return;
    }
    this._updateCanvasMeta(placeholder.canvas);
    this.generateButton.setStatus(`Enter a prompt, then press Generate. Canvas: ${preset.label} ${preset.width} × ${preset.height}.`, "");
    this.editor.canvas.on("history:change", () => this._refreshChrome());
    this._refreshChrome();
    this.setSaveState("saved");
    document.getElementById("clear-canvas-btn")?.addEventListener("click", () => this.onClear());
    document.getElementById("exit-preview")?.addEventListener("click", () => this.togglePreview(false));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.state.preview) this.togglePreview(false);
    });
  }

  async onGenerate() {
    const prompt = this.promptInput.value;
    if (!prompt) {
      this.generateButton.setError("Enter a design prompt first.");
      return;
    }
    if (this.state.generating) return;

    this.state.generating = true;
    this.generateButton.setLoading(true);

    try {
      const options = { canvas: { width: this.designPreset.width, height: this.designPreset.height } };
      if (this.referenceAnalysis && this.referenceInfluence > 0) {
        options.referenceAnalysis = this.referenceAnalysis;
        options.referenceInfluence = this.referenceInfluence;
        this.generateButton.setLoading(true, "Borrowing layout from the reference…");
      }

      const result = await generateDesign(prompt, options);
      const check = validateDesign(result.design); // safety net (also normalizes)
      if (!check.ok) {
        throw new Error(check.errors.slice(0, 3).join("; "));
      }

      this.state.design = check.design;
      this.editor.loadDesign(check.design);
      this.scheduleSave();
      this._refreshChrome();
      this._updateCanvasMeta(check.design.canvas);
      this._renderJsonPreview();
      this.debugTabs.set({
        design: check.design,
        analysis: this.referenceAnalysis,
        svg: this.referenceAnalysis ? buildSemanticSvg(this.referenceAnalysis) : "",
        semantic: result.semanticDesign,
        warnings: result.warnings,
      });
      if (result.warnings && result.warnings.length) {
        const message = `Design generated - every element is editable. ${result.warnings.length} layout warning(s), see Pipeline tab.`;
        this.generateButton.setSuccess(message);
        notify(message, "success");
      } else {
        const message = "Design generated - every element is editable.";
        this.generateButton.setSuccess(message);
        notify(message, "success");
      }
    } catch (error) {
      const message = `Generation failed: ${error.message}`;
      this.generateButton.setError(message);
      notify(message, "error");
      console.error(error);
      this.debugTabs.set({ ...this.debugTabs.state, warnings: [`Generation failed: ${error.message}`] });
    } finally {
      this.state.generating = false;
    }
  }

  onReferenceAnalysis(analysis) {
    this.referenceAnalysis = analysis;
  }

  onDesignTypeChange(id) {
    this.designPreset = getPreset(id);
    const { label, width, height } = this.designPreset;
    const hasObjects = (this.editor.canvas?.getObjects().length || 0) > 0;
    if (hasObjects) {
      // Never reflow or destroy a finished design: the new size applies to
      // the next Generate instead.
      const message = `Size set to ${label} ${width} × ${height} — press Regenerate to apply it.`;
      this.generateButton.setStatus(message, "");
      notify(message, "info");
      return;
    }
    this.editor.resizeCanvas(width, height);
    this._updateCanvasMeta({ width, height });
    this._renderJsonPreview();
    this.scheduleSave();
    const message = `Canvas: ${label} ${width} × ${height}.`;
    this.generateButton.setStatus(message, "");
    notify(message, "info");
  }

  _updateCanvasMeta(canvas) {
    if (!canvas) return;
    const text = `${canvas.width} × ${canvas.height}`;
    document.querySelectorAll(".canvas-meta").forEach((meta) => {
      meta.textContent = text;
    });
  }

  onClear() {
    this.editor.clear();
    this.generateButton.setStatus("Canvas cleared.", "");
    notify("Canvas cleared.", "info");
    this.scheduleSave();
    this._refreshChrome();
  }

  async onUndo() {
    await this.editor.history.undo();
    this.scheduleSave();
    this._refreshChrome();
  }

  async onRedo() {
    await this.editor.history.redo();
    this.scheduleSave();
    this._refreshChrome();
  }

  onZoom(mode) {
    if (mode === "fit") this.editor.setZoomFit();
    else if (mode === "actual") this.editor.setZoomActual();
    else if (mode === "in") this.editor.zoomBy(1.25);
    else if (mode === "out") this.editor.zoomBy(0.8);
    this._refreshChrome();
  }

  onTitle(title) {
    this.state.title = title;
    document.title = `${title} — Oovi`;
    this.scheduleSave();
  }

  onTab(tab) {
    if (tab === "pipeline") this.leftTabs?.set("pipeline");
    else if (tab === "design") {
      this.leftTabs?.set("insert");
      this._closeDeveloper();
    } else if (tab === "code") this._openDeveloper();
  }

  onToggleLock() {
    const locked = this.editor.toggleLockActive();
    this._refreshContextBar();
    notify(locked ? "Selection locked." : "Selection unlocked.", "info");
  }

  togglePreview(force) {
    const on = force !== undefined ? force : !this.state.preview;
    this.state.preview = on;
    document.getElementById("app").classList.toggle("previewing", on);
    const exit = document.getElementById("exit-preview");
    if (exit) exit.hidden = !on;
    if (on) this.contextbar.hide();
    else this._refreshContextBar();
  }

  _openDeveloper() {
    const dev = document.getElementById("developer");
    if (dev) {
      dev.open = true;
      dev.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  _closeDeveloper() {
    const dev = document.getElementById("developer");
    if (dev) dev.open = false;
  }

  _syncContextBar(objects) {
    const list = objects || [];
    if (list.length === 0 || this.state.preview) {
      this.contextbar.hide();
      return;
    }
    this._refreshContextBar();
  }

  _refreshContextBar() {
    const rect = this.editor.getSelectionScreenRect();
    if (!rect) {
      this.contextbar.hide();
      return;
    }
    this.contextbar.show(rect.x + rect.width / 2 - 66, rect.y - 48, {
      locked: this.editor.isActiveLocked(),
    });
  }

  _refreshChrome() {
    if (!this.editor.canvas) return;
    this.topbar.refresh({
      canUndo: this.editor.history.canUndo(),
      canRedo: this.editor.history.canRedo(),
      zoomLabel: this.editor.getZoomLabel(),
    });
  }

  /** @param {"saved"|"saving"|"unsaved"} state */
  setSaveState(state) {
    this.topbar.setSaveState(state);
  }

  scheduleSave() {
    this.setSaveState("unsaved");
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => this.saveDraftNow(), 800);
  }

  saveDraftNow() {
    if (!this.editor.canvas) return;
    this.setSaveState("saving");
    try {
      const payload = {
        title: this.state.title,
        savedAt: new Date().toISOString(),
        design: this.editor.toDesign(),
      };
      window.localStorage.setItem("oovi.draft.v1", JSON.stringify(payload));
      this.setSaveState("saved");
    } catch {
      this.setSaveState("unsaved");
    }
  }

  _wireJsonToggle() {
    this.jsonToggle.addEventListener("click", () => {
      const body = this.jsonContainer.querySelector(".json-body");
      const hidden = body.classList.toggle("json-hidden");
      this.jsonToggle.textContent = hidden ? "Show JSON" : "Hide JSON";
      if (!hidden) this._renderJsonPreview();
    });
  }

  _renderJsonPreview() {
    const design = this.editor.toDesign();
    if (design && this.jsonPreview) {
      this.jsonPreview.textContent = JSON.stringify(design, null, 2);
    }
  }
}