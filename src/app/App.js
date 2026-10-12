import { generateDesign } from "../ai/aiClient";
import { validateDesign } from "../design/designValidator";
import { CanvasEditor } from "../editor/Canvas";
import { LayersPanel } from "../editor/LayersPanel";
import { Toolbar } from "../editor/Toolbar";
import { PromptInput } from "../components/PromptInput";
import { GenerateButton } from "../components/GenerateButton";

/**
 * App - the UI coordination layer.
 *
 * Owns the DOM wiring and the generate pipeline:
 *   prompt -> generateDesign() -> validated design -> CanvasEditor.loadDesign()
 *
 * The App is the only module that knows about both the AI side and the
 * editor side. It does so through their public APIs and the shared Design
 * type - never through each other's internals.
 */

const EXAMPLE_PROMPT =
  "Create a modern product announcement for our new AI assistant. Include the company name header, a bold headline, supporting body text, a decorative rounded rectangle, and a footer with the website.";

export class App {
  /**
   * @param {Object} mounts element ids: prompt, generate, toolbar, layers, canvas, json
   */
  constructor(mounts) {
    this.state = {
      design: null,
      generating: false,
    };

    this.editor = new CanvasEditor(mounts.canvasHolder);

    this.promptInput = new PromptInput(document.getElementById(mounts.prompt));
    this.generateButton = new GenerateButton(
      document.getElementById(mounts.generate),
      () => this.onGenerate(),
    );

    this.layersPanel = new LayersPanel(document.getElementById(mounts.layers), (id) =>
      this.editor.selectById(id),
    );

    this.toolbar = new Toolbar(document.getElementById(mounts.toolbar), {
      onRegenerate: () => this.onGenerate(),
      onClear: () => this.onClear(),
      onExport: () => this.editor.exportPng(),
      onUndo: () => this.editor.history.undo(),
      onRedo: () => this.editor.history.redo(),
      onDuplicate: () => this.editor.duplicateActive(),
      onDelete: () => this.editor.deleteActive(),
      onPropChange: (prop, value) => this.editor.setActiveProperty(prop, value),
      getEnabledState: () => ({
        undo: !this.editor.history.canUndo(),
        redo: !this.editor.history.canRedo(),
        duplicate: this.editor.canvas?.getActiveObjects().length === 0,
        delete: this.editor.canvas?.getActiveObjects().length === 0,
      }),
    });

    this.jsonContainer = document.getElementById(mounts.json);
    this.jsonPreview = this.jsonContainer.querySelector("#json-preview");
    this.jsonToggle = this.jsonContainer.querySelector("#json-toggle");

    this.promptInput.value = EXAMPLE_PROMPT;
    this._wireJsonToggle();

    // Subscribe editor -> panels/toolbar.
    this.editor.layersCallback = (layers, activeIds) => {
      this.layersPanel.render(layers, activeIds);
    };
    this.editor.selectionCallback = (objects) => {
      this.toolbar.setSelection(objects);
      this._renderJsonPreview();
    };
  }

  async boot() {
    // Start with an empty but correctly-sized canvas so the frame is visible
    // while the first AI call runs.
    const placeholder = {
      canvas: { width: 1080, height: 1080, background: "#F5F5F7" },
      elements: [],
    };
    try {
      this.editor.mount(placeholder);
    } catch (error) {
      this.generateButton.setError(`Canvas failed to init: ${error.message}`);
      console.error(error);
      return;
    }
    await this.onGenerate();
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
      const design = await generateDesign(prompt);
      const check = validateDesign(design); // safety net (also normalizes)
      if (!check.ok) {
        throw new Error(check.errors.slice(0, 3).join("; "));
      }

      this.state.design = check.design;
      this.editor.loadDesign(check.design);
      this._renderJsonPreview();
      this.generateButton.setSuccess("Design generated - every element is editable.");
    } catch (error) {
      this.generateButton.setError(`Generation failed: ${error.message}`);
      console.error(error);
    } finally {
      this.state.generating = false;
    }
  }

  onClear() {
    this.editor.clear();
    this.generateButton.setStatus("Canvas cleared.", "");
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