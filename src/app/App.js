import {
  generateDesign,
  generatePatch,
  planTemplate,
  planPalette,
  planCopyDeck,
  refineGoal,
  componentDesign,
} from "../ai/aiClient";
import { evaluateDesign } from "../ai/quality";
import { correctColors } from "../ai/colorCorrect";
import {
  collectTextElements,
  findCopyRepetitions,
  findTextRepetitionsForChanged,
  normalizeCopyLines,
  textElementsUnder,
} from "../ai/copySanitize";
import { FEATURES } from "../config/features";
import { searchPhotos, triggerDownload, orientationFor, choosePhoto } from "../ai/unsplash";
import { buildDensityRepair } from "../layout/densityRepair";
import {
  createDesignMemory,
  emptyDesignMemory,
  memoryPersistKey,
  normalizeDesignMemory,
  recordMemoryEdit,
  syncMemoryCopy,
} from "../memory/designMemory";
import { isMockEnabled, mockAssetDataUrl } from "../ai/mockProvider";
import { validateDesign } from "../design/designValidator";
import { DEFAULT_PRESET_ID, DESIGN_PRESETS, getPreset } from "../design/presets";
import { templateFromDesign } from "../layout/saveAsTemplate";
import { saveTemplate } from "../layout/templateStore";
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
import { TemplatesPanel } from "../components/TemplatesPanel";
import { AssistantPanel } from "../components/AssistantPanel";
import { paletteForTemplate, sampleDesignForTemplate } from "../layout/templateSample";
import { notify } from "../ui/toasts";
import { projects } from "../storage/projects";
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

function probeImage(src, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => reject(new Error("image probe timed out")), timeoutMs);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("image probe failed"));
    };
    img.src = src;
  });
}

/**
 * Fetch a remote image as a data URL. Data URLs never taint the Fabric
 * canvas, so PNG export keeps working after an Unsplash image lands.
 */
async function fetchImageAsDataUrl(url, timeoutMs = 60000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("response is not an image");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("image read failed"));
    reader.readAsDataURL(blob);
  });
}

export class App {
  /**
   * @param {Object} mounts element ids: topbar, prompt, generate, designType, insert, toolbar, layers, canvas, json, contextbar
   * @param {{leftTabs?: {set: (id: string) => void}}} [opts]
   */
  constructor(mounts, opts = {}) {
    this.state = {
      design: null,
      generating: false,
      assisting: false,
      removing: false,
      title: "Untitled design",
      preview: false,
    };
    this.leftTabs = opts.leftTabs || null;
    this._saveTimer = null;
    this._persistTimer = null;
    this._lastPersisted = "";
    this._dirtySincePersist = false;
    this.projectId = opts.projectId || null;
    this.aiIds = new Set();
    this._preview = null;
    this._persistLocked = false;
    this._generationInvalid = false;
    this.designMemory = emptyDesignMemory();

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
      onImage: (src, w, h) => this.editor.addImageElement(src, w, h),
      onBackground: (color) => this.editor.setBackground(color),
      onPhotoSearch: (query) => searchPhotos(query),
      onPhoto: (photo) => this.onPhotoInsert(photo),
    });
    this.templatesPanel = new TemplatesPanel(document.getElementById(mounts.templates), {
      getCanvas: () => ({
        width: this.editor.canvas?.width || this.designPreset.width,
        height: this.editor.canvas?.height || this.designPreset.height,
      }),
      onSelect: (template) => this.applyTemplate(template),
    });
    this.assistant = new AssistantPanel(document.getElementById(mounts.assistant), {
      onSend: (message) => this.onAssistantSend(message),
      onSuggestion: (sug) => this.onSuggestion(sug),
      onApply: () => this.onApplyProposal(),
      onCancel: () => this.onCancelProposal(),
      onTogglePreview: () => this.onTogglePreview(),
      onRegenerate: () => this.onAssistantRegenerate(),
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

    this.layersPanel = new LayersPanel(document.getElementById(mounts.layers), {
      onSelect: (id) => this.editor.selectById(id),
      onRename: (id, name) => {
        if (!this.editor.renameById(id, name)) this.layersPanel.refresh();
      },
      onVisibility: (id) => this.editor.toggleVisibilityById(id),
      onLock: (id) => this.editor.toggleLockById(id),
      onDuplicate: (id) => this.editor.duplicateById(id),
      onDelete: (id) => this.editor.deleteById(id),
      onReorder: (dragId, targetId, place) => this.editor.reorderLayer(dragId, targetId, place),
      onGroup: () => {
        const id = this.editor.groupActive();
        if (id) notify(`Grouped into ${id}.`, "success");
      },
      onUngroup: () => this.editor.ungroupActive(),
    });

    this.properties = new Toolbar(document.getElementById(mounts.toolbar), {
      onPropChange: (prop, value) => this.editor.setActiveProperty(prop, value),
      onCommand: (cmd) => this.onCommand(cmd),
      onArtboardProp: (key, value) => this.onArtboardProp(key, value),
      getArtboard: () => {
        const c = this.editor.canvas;
        if (!c) return null;
        return {
          background: this.editor.toDesign()?.canvas?.background,
          width: c.width,
          height: c.height,
        };
      },
    });

    this.topbar = new TopBar(document.getElementById(mounts.topbar), {
      onUndo: () => this.onUndo(),
      onRedo: () => this.onRedo(),
      onZoom: (mode) => this.onZoom(mode),
      onPreview: () => this.togglePreview(),
      onSaveTemplate: () => this.saveCurrentAsTemplate(),
      onExport: (format) => this.exportDesign(format),
      onTitle: (title) => this.onTitle(title),
      onTab: (tab) => this.onTab(tab),
      onHome: () => this.onHome(),
    });

    this.contextbar = new ContextToolbar(document.getElementById(mounts.contextbar), {
      onDuplicate: () => this.editor.duplicateActive(),
      onDelete: () => this.editor.deleteActive(),
      onToggleLock: () => this.onToggleLock(),
      onRemoveBackground: () => this.onRemoveBackground(),
    });

    this.jsonContainer = document.getElementById(mounts.json);
    this.devRole = document.getElementById("dev-role");
    this.jsonPreview = this.jsonContainer.querySelector("#json-preview");
    this.jsonToggle = this.jsonContainer.querySelector("#json-toggle");

    this.promptInput.value = EXAMPLE_PROMPT;
    this._wireJsonToggle();

    // Subscribe editor -> panels/toolbar.
    this.editor.layersCallback = (layers, activeIds) => {
      const a = this.editor.canvas?.getActiveObject();
      this.layersPanel.render(layers, activeIds, {
        canGroup: !!a && a.type === "activeSelection" && a.getObjects().length > 1,
        canUngroup: !!a && (a.elementType || a.type) === "group",
        aiIds: this.aiIds,
      });
    };
    this.editor.selectionCallback = (objects) => {
      this.properties.setSelection(objects);
      this._renderJsonPreview();
      this._syncContextBar(objects);
      this._updateAssistantContext(objects);
      const first = objects && objects[0];
      if (this.devRole) this.devRole.textContent = first ? String(first.elementRole || "None") : "None";
    };
    this.editor.onDirty = () => {
      this.scheduleSave();
      if (this._preview?.active && this._preview.clean) {
        this._preview.clean = false;
        this.assistant.setToggleEnabled(false);
      }
    };
  }

  async boot() {
    // Start with an empty canvas restricted to the default design-type
    // preset (Facebook Post). Generation only runs when the user presses
    // Generate | never automatically on startup.
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
    this.templatesPanel.refresh();
    this.generateButton.setStatus(`Enter a prompt, then press Generate. Canvas: ${preset.label} ${preset.width} × ${preset.height}.`, "");
    this.editor.canvas.on("history:change", () => this._refreshChrome());
    this._refreshChrome();
    this.setSaveState("saved");
    document.getElementById("clear-canvas-btn")?.addEventListener("click", () => this.onClear());
    document.getElementById("sidebar-toggle")?.addEventListener("click", () => this.toggleSidebar());
    // Clicking any sidebar tab while collapsed re-opens the sidebar.
    document.querySelectorAll("[data-ltab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (document.getElementById("app").classList.contains("side-collapsed")) this.setSidebar(true);
      });
    });
    try {
      if (window.localStorage.getItem("oovi.sidebar") === "collapsed") this.setSidebar(false);
    } catch {
      // private mode: sidebar simply starts open
    }
    document.getElementById("exit-preview")?.addEventListener("click", () => this.togglePreview(false));
    this.assistant.pushAssistant("Select a layer, then describe a change.");
    this._updateAssistantContext([]);
    let pending = "";
    try {
      // Dashboard stores the prompt by project id because a new tab has its
      // own sessionStorage. Read and consume both storage fallbacks.
      if (this.projectId) {
        const key = `oovi.pendingPrompt.${this.projectId}`;
        pending = window.localStorage.getItem(key) || window.sessionStorage.getItem(key) || "";
        if (pending) {
          window.localStorage.removeItem(key);
          window.sessionStorage.removeItem(key);
        }
      }
    } catch {
      pending = "";
    }
    if (pending) this.promptInput.value = pending;
    if (this.projectId) await this.loadProject();
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.state.preview) this.togglePreview(false);
    });
    // Single-key insert shortcuts (T/R/O/L/P). Typing fields, modifiers
    // and preview mode are excluded; the canvas handler ignores the rest.
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        this.persistNow();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const t = event.target;
      if (
        t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement || t.isContentEditable
      ) {
        return;
      }
      if (this.state.preview) return;
      const k = event.key.toLowerCase();
      if (k === "t") this.insertPanel.insert("text");
      else if (k === "r") this.insertPanel.insert("rectangle");
      else if (k === "o") this.insertPanel.insert("circle");
      else if (k === "l") this.insertPanel.insert("line");
      else if (k === "p") this.insertPanel.focusSearch();
    });
  }

  async onGenerate() {
    const prompt = this.promptInput.value;
    if (!prompt) {
      this.generateButton.setError("Enter a design prompt first.");
      return;
    }
    if (this.state.generating) return;
    // Reference path keeps the unchanged semantic pipeline (constraint).
    if (this.referenceAnalysis && this.referenceInfluence > 0) {
      await this.onGenerateDirect(prompt);
      return;
    }
    await this.onGenerateArchitected(prompt);
  }

  /** Direct whole-design path (reference mode + plan-fallback). Unchanged. */
  async onGenerateDirect(prompt) {
    this.state.generating = true;
    this._persistLocked = true;
    this._generationInvalid = false;
    this.generateButton.setLoading(true);
    this._clearPreviewUI();

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
      this.designMemory = syncMemoryCopy(emptyDesignMemory(), check.design);
      this._persistLocked = false;
      this._generationInvalid = false;
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
      this._markGenerationInvalid();
      const message = `Generation failed: ${error.message}`;
      this.generateButton.setError(message);
      notify(message, "error");
      console.error(error);
      this.debugTabs.set({ ...this.debugTabs.state, warnings: [`Generation failed: ${error.message}`] });
    } finally {
      this.state.generating = false;
    }
  }

  /**
   * Architected path: choose a template, show its regions immediately, then
   * fill them one by one | DSL text/shapes through the existing pipeline,
   * photos through a prompt-grounded Unsplash search. Each component is its
   * own undo entry.
   */
  async onGenerateArchitected(prompt) {
    const canvas = { width: this.designPreset.width, height: this.designPreset.height };
    this.state.generating = true;
    // Lock the library while regions are being replaced piecemeal. A sample
    // layout is on screen before the first model call; without this lock the
    // debounced persist would upload that placeholder as if it were finished.
    this._persistLocked = true;
    this._generationInvalid = false;
    if (this._persistTimer) {
      window.clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    // Memory is read before the first model call. L1 decides whether this
    // request is a revision of the saved design or a different brief; the
    // pipeline never silently bolts old copy onto a new concept.
    const priorMemory = normalizeDesignMemory(this.designMemory);
    this._clearPreviewUI();
    // A previous run's wireframe must never linger over a new one.
    this.editor.clearSkeletonGuides?.();
    const status = (msg) => this.generateButton.setLoading(true, msg);
    // Live token counter for the running layer (the server throttles progress
    // to ~1/s), so a minutes-long generation visibly moves instead of hanging.
    const live = (label) => (chunks, secs) => {
      if (chunks) status(`${label}: ${chunks} tok · ${secs}s…`);
    };
    try {
      // Template-only cascade: L1 refines the goal, L2 chooses the palette,
      // L3 chooses a template (retrieval + small tuning call) and exposes its
      // regions immediately, L4 fills those regions one by one, L5 corrects
      // colour. There is no free-form skeleton fallback.
      status("1/5 Refining the goal…");
      let goal;
      let plan;
      try {
        goal = await refineGoal(prompt, canvas, live("1/5 goal"), priorMemory);
        this.assistant.pushAssistant(`Goal: ${goal.summary}`);
        status("2/5 Choosing the palette…");
        const palette = await planPalette(goal, canvas, live("2/5 palette"));
        this.assistant.pushAssistant(
          `Palette: ${palette.background} / ${palette.ink} / ${palette.accent}. Style: ${palette.style}` +
            `${palette.source === "library" ? " (library)" : ""}.`,
        );
        status("3/5 Choosing a template…");
        plan = await planTemplate(goal, palette, canvas, live("3/5 template"), { rawPrompt: prompt });
        this.assistant.pushAssistant(
          `Template: "${plan.template}" (${plan.tuning.variant}, ${plan.tuning.density}), ${plan.components.length} regions.`,
        );
      } catch (error) {
        console.error("[architect] template planning failed:", error);
        this._markGenerationInvalid();
        this.assistant.pushAssistant(`Generation failed (${error.message}).`, "error");
        this.generateButton.setError(`Generation failed: ${error.message}`);
        this.state.generating = false;
        this.editor.clearSkeletonGuides?.();
        return;
      }

      // Show the chosen template immediately, with its sample content, so the
      // user sees the layout before the slow per-region AI pass starts. Each
      // region is replaced by prompt-specific content as it lands; a region
      // that fails keeps the template sample instead of leaving a hole.
      const placeholders = new Map();
      const showTemplateSample = (activePlan) => {
        placeholders.clear();
        const imageQueries = Object.fromEntries(
          activePlan.components
            .filter((component) => component.kind === "image" && component.imageQuery)
            .map((component) => [component.id, component.imageQuery]),
        );
        const sample = activePlan.templateRef
          ? sampleDesignForTemplate(
              activePlan.templateRef,
              canvas,
              activePlan.palette,
              activePlan.tuning,
              imageQueries,
            )
          : { ok: false };
        if (!sample.ok) {
          this.editor.loadDesign({ canvas: { ...canvas, background: activePlan.palette.background }, elements: [] });
          return false;
        }
        // Template samples are temporary stand-ins, not AI output. Prefix
        // their ids so a model element that happens to use the same id
        // ("subtitle-text", "headline-bar") cannot collide with the sample:
        // Fabric allows duplicate ids, and dropping one would leave the
        // other (previously the sample survived while the AI content was
        // removed). The prefix also makes leftovers obvious in the layers.
        const SAMPLE_PREFIX = "tpl-";
        for (const element of sample.design.elements) {
          if (element && typeof element.id === "string") element.id = `${SAMPLE_PREFIX}${element.id}`;
        }
        this.editor.loadDesign(sample.design);
        for (const component of activePlan.components) {
          // Text/image samples have one stable id. Decorations expand into
          // several primitives, so own every decoration id under this region
          // and retire the whole layer when the AI decoration lands.
          const fixed = new Set([
            `${SAMPLE_PREFIX}${component.id}-text`,
            `${SAMPLE_PREFIX}${component.id}-img`,
            `${SAMPLE_PREFIX}${component.id}-bar`,
          ]);
          const decorationPrefix = `${SAMPLE_PREFIX}${component.id}-`;
          placeholders.set(
            component.id,
            sample.design.elements
              .filter((element) => {
                const id = String(element.id);
                return fixed.has(id) || (element.role === "decoration" && id.startsWith(decorationPrefix));
              })
              .map((element) => element.id),
          );
        }
        return true;
      };
      // Retire a region's template samples. Shared by the build pass and the
      // per-region refinement, so a failed region that succeeds on refine
      // cannot end up with both the sample and the AI content.
      const dropPlaceholders = (id) => {
        const ids = placeholders.get(id) || [];
        if (!ids.length) return;
        placeholders.set(id, []);
        try {
          this.editor.applyPatchOps(ids.map((x) => ({ op: "remove", id: x })), {
            history: false,
            quiet: true,
          });
        } catch {
          // already gone
        }
      };
      if (showTemplateSample(plan)) {
        this.assistant.pushAssistant(
          `Showing template "${plan.template}". ${plan.components.length} regions. Replacing each region with content from your prompt…`,
        );
      }
      this._updateCanvasMeta(canvas);
      this._renderJsonPreview();
      this.setSaveState("saving");
      this._refreshChrome();
      if (plan.warnings.length) {
        this.assistant.pushAssistant(`Plan notes: ${plan.warnings.join("; ")}`);
      }
      this.assistant.pushAssistant(`Plan: ${plan.components.length} components (${plan.source}).`);

      // L3c: write the whole copy deck while the template sample is already
      // visible. L4 then lays out approved lines instead of inventing copy per
      // region. The preview and the template choice are untouched by this call.
      status("3/5 Writing the copy…");
      const copyDeck = await planCopyDeck(plan.components, goal, canvas, prompt, live("3/5 copy"));
      // The deck is the single source of approved copy. If a text region has no
      // approved lines after the repair passes, stop before any region is
      // rebuilt: letting L4 invent its own line here is how the same audience
      // label and brand sentence ended up in three different regions.
      const unresolved = Array.isArray(copyDeck.unresolved) ? copyDeck.unresolved : [];
      if (copyDeck.source === "failed" || unresolved.length) {
        const details = (unresolved.length ? unresolved : copyDeck.rejected || [])
          .map((entry) => `${entry.id || entry.component?.id || "region"}: ${entry.reason || "no approved copy"}`)
          .join("; ");
        throw new Error(`Copy deck incomplete: ${details || "no approved copy for every text region"}`);
      }
      plan = {
        ...plan,
        components: plan.components.map((component) => {
          const isText = component.kind !== "image" && component.role !== "decoration";
          const copy = Array.isArray(copyDeck.copies?.[component.id]) ? copyDeck.copies[component.id] : [];
          if (copy.length) return { ...component, copy, copySource: "deck" };
          return component;
        }),
        copySource: copyDeck.source,
        copyStats: copyDeck.stats,
      };
      const textRegions = plan.components.filter(
        (component) => component.kind !== "image" && component.role !== "decoration",
      );
      const copiedRegions = textRegions.filter((component) => component.copySource === "deck");
      console.log(
        `[build] copy deck ${copyDeck.source} ${copiedRegions.length}/${textRegions.length} text regions`,
      );
      if (copyDeck.source !== "mock" && copyDeck.source !== "none") {
        this.assistant.pushAssistant(
          `Copy deck: ${copiedRegions.length}/${textRegions.length} text regions (${copyDeck.source}).`,
        );
      }

      let done = 0;
      let failed = 0;
      let appliedTotal = 0;
      let renderedIds = [];
      // One pass over the plan; extracted so a thin first pass can retry
      // with corrections without duplicating the loop.
      //
      // The on-device model serves ONE generation at a time
      // (OLLAMA_NUM_PARALLEL=1). Fanning component calls out does not make
      // them faster | Ollama just queues them, and while queued they receive
      // no bytes, so a queued request eventually dies on a client timeout
      // ("fetch failed") while the total wall clock stays the same. So run
      // them strictly serially: same speed, no queue-timeout failures.
      //
      // Each result paints AS IT LANDS (the old batch-apply left the canvas
      // blank for 10+ minutes), inserted at its plan-rank position so final
      // layer order is exactly plan order regardless of arrival order. Undo
      // entries stay one-per-component.
      const fanOut = async (tasks, onSettled) => {
        const limit = 1;
        const results = new Array(tasks.length);
        const order = [];
        let next = 0;
        console.log(`[build] fan-out ${tasks.length} tasks, serial (on-device model, 1 slot)`);
        const workers = Array.from({ length: limit }, async () => {
          while (next < tasks.length) {
            const i = next++;
            console.log(`[build] start ${tasks[i].label}`);
            try {
              results[i] = { ok: true, value: await tasks[i].run() };
            } catch (error) {
              results[i] = { ok: false, error };
            }
            order.push(i);
            // Paint as it lands: the apply step runs here, inside the
            // worker, so the canvas grows throughout the run instead of
            // appearing all at once at the end. Layer order still resolves
            // to plan order via the plan-rank insert position.
            await onSettled(i, results[i]);
          }
        });
        await Promise.all(workers);
        return { results, order };
      };
      const buildAll = async (activePlan) => {
        const selectedImages = new Map();
        const out = { done: 0, failed: 0, appliedTotal: 0, renderedIds: [] };
        const n = activePlan.components.length;
        // Generation ORDER is independent of LAYER order. The headline and the
        // hero are what the eye wants first, so they are generated first, while
        // each region's insert position stays its plan rank (slotFor(planIndex))
        // so the final z-order is still plan order. On-device this is the
        // difference between seeing the title at ~2 minutes and seeing nothing
        // for ~9.
        const priority = (c) =>
          c.role === "headline" ? 0
          : c.role === "hero" ? 1
          : c.kind === "image" ? 2
          : c.role === "decoration" ? 4
          : 3;
        const queue = activePlan.components
          .map((component, i) => ({ component, i }))
          .sort((a, b) => priority(a.component) - priority(b.component) || a.i - b.i);
        // Placed pieces as {i: plan index, count: elements}; a component's
        // slot = total elements of placed components ranked below it.
        const placed = [];
        const slotFor = (i) => placed.filter((p) => p.i < i).reduce((s, p) => s + p.count, 0);
        // Per-region bookkeeping for the refinement pass: pieces placed (0 =
        // failed) and the top-level element ids the region owns, so a later
        // refinement can remove them before regenerating just that region.
        const regions = new Map();
        const note = (id, count, ids = []) => regions.set(id, { count, ids });
        // Chunk development: elements painted straight from the live token
        // stream, before the component's validated set lands. Tracked per
        // region so the final apply can retract them first (they carry the
        // same ids as the validated elements and must not double up).
        const streamed = new Map(); // component.id -> string[] of element ids
        const retractStreamed = (id) => {
          const ids = streamed.get(id) || [];
          streamed.set(id, []);
          if (!ids.length) return;
          try {
            this.editor.applyPatchOps(ids.map((x) => ({ op: "remove", id: x })), {
              history: false,
              quiet: true,
            });
          } catch {
            // already gone
          }
        };
        const streamElement = (i, id, element) => {
          if (!element || typeof element.id !== "string") return;
          const ids = streamed.get(id) || [];
          if (ids.includes(element.id)) return; // already painted
          const at = slotFor(i) + ids.length;
          // Track optimistically: if the apply throws (or the element is
          // invalid) the id is still retracted later, and removing a
          // non-existent id is a no-op.
          ids.push(element.id);
          streamed.set(id, ids);
          try {
            this.editor.applyPatchOps([{ op: "add", element, at }], { history: false, quiet: true });
          } catch {
            // a malformed partial must never break the build
          }
        };
        // Template sample elements for one region stay on the canvas until
        // the region's validated content is ready; if generation fails, they
        // are the fallback so the template never loses a region.
        status(`4/5 Adding text: ${n} regions (serially, on this device)…`);
        const applyOne = async (q, settled) => {
          const { component, i } = queue[q];
          out.done += 1;
          // The region's turn has come: retire its wireframe. It stays visible
          // for the whole (slow) generation and disappears as content lands.
          this.editor.clearGuideFor?.(component.id);
          status(`Placing ${out.done}/${n}: ${component.id}…`);
          const at = slotFor(i);
          if (!settled || !settled.ok) {
            out.failed += 1;
            note(component.id, 0);
            retractStreamed(component.id);
            console.warn(`[build] place ${component.id} FAILED: ${settled && settled.error ? settled.error.message : "unknown error"}`);
            const kept = (placeholders.get(component.id) || []).length > 0;
            this.assistant.pushAssistant(
              `${component.id} skipped: ${settled && settled.error ? settled.error.message : "unknown error"}` +
                `${kept ? " Kept the template sample." : ""}`,
              "error",
            );
          } else if (settled.value.kind === "image") {
            const fetched = settled.value.fetched;
            if (!fetched) {
              out.failed += 1;
              note(component.id, 0);
            } else {
              try {
                this.editor.addImageElement(fetched.src, fetched.w, fetched.h, component.box, at);
                dropPlaceholders(component.id);
                out.appliedTotal += 1;
                out.renderedIds.push(component.id);
                placed.push({ i, count: 1 });
                note(component.id, 1);
                selectedImages.set(component.id, {
                  region: component.id,
                  query:
                    component.imageQueries?.[0] ||
                    component.imageQuery ||
                    goal?.imageSubject ||
                    "",
                  source: fetched.note || "",
                  photographer: fetched.photographer || "",
                });
                const imagetag = isMockEnabled()
                  ? "mock"
                  : fetched.note || "";
                console.log(`[build] placed ${component.id} image at=${at}`);
                this.assistant.pushAssistant(
                  `Added ${component.id} (image${imagetag ? `, ${imagetag}` : ""})`,
                );
              } catch (error) {
                out.failed += 1;
                note(component.id, 0);
                this.assistant.pushAssistant(`${component.id} skipped: ${error.message}`, "error");
              }
            }
          } else {
            try {
              // Drop whatever the token stream painted, then apply the
              // validated set in one undo step (as before).
              retractStreamed(component.id);
              const res = this.editor.applyPatchOps(
                settled.value.elements.map((element, k) => ({ op: "add", element, at: at + k })),
              );
              dropPlaceholders(component.id);
              out.appliedTotal += res.applied.length;
              out.renderedIds.push(component.id);
              placed.push({ i, count: res.applied.length });
              note(component.id, res.applied.length, res.changedIds || []);
              console.log(`[build] placed ${component.id} ${res.applied.length} pieces at=${at}`);
              this.assistant.pushAssistant(`Added ${component.id} (${res.applied.length} pieces)`);
            } catch (error) {
              out.failed += 1;
              note(component.id, 0);
              retractStreamed(component.id);
              this.assistant.pushAssistant(`${component.id} skipped: ${error.message}`, "error");
            }
          }
          this._renderJsonPreview();
          this._refreshChrome();
        };
        await fanOut(
          queue.map(({ component, i }) => ({
            label: component.id,
            run: async () => {
              const t = Date.now();
              if (component.kind === "image") {
                const fetched = await this._fetchImageComponent(component);
                console.log(`[build] fetched ${component.id} ${Date.now() - t}ms ${fetched ? fetched.note || "ok" : "FAILED"}`);
                return { kind: "image", fetched };
              }
              // Keep the template sample in place while the model works: a
              // partial token stream would paint on top of it and look like a
              // duplicate region. The validated set swaps in atomically.
              const hasSample = (placeholders.get(component.id) || []).length > 0;
              const { elements } = await componentDesign(component, canvas, activePlan, goal, {
                rawPrompt: prompt,
                onProgress: (chunks, secs) => {
                  const painted = (streamed.get(component.id) || []).length;
                  live(`4/5 ${component.id}`)(chunks, secs);
                  if (painted) status(`4/5 ${component.id}: ${painted} element(s) placed · ${chunks} tok · ${secs}s…`);
                },
                onStreamStart: hasSample ? undefined : () => retractStreamed(component.id),
                onElement: hasSample ? undefined : (element) => streamElement(i, component.id, element),
              });
              console.log(`[build] ready ${component.id} ${Date.now() - t}ms elements=${elements.length}`);
              return { kind: "dsl", elements };
            },
          })),
          applyOne,
        );
        return { ...out, regions, images: [...selectedImages.values()] };
      };
      const evalOpts = (activePlan, ids) => ({
        plannedIds: activePlan.components.map((c) => c.id),
        renderedIds: ids,
        expectHero: activePlan.components.some((c) => c.kind === "image"),
        components: activePlan.components,
        palette: activePlan.palette,
      });
      const topDefects = (report) =>
        [...report.issues]
          .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
          .slice(0, 4)
          .map((i) => i.message)
          .join(" ");

      // Maps the quality gate's complaints back to the regions that own the
      // offending elements. Issues name element ids (e.g. "headline-txt",
      // "card-1"); a region owns an element whose id equals its id or is
      // prefixed by it (component ids are the element-id prefix by convention).
      const flagRegions = (rep, activePlan) => {
        const out = new Map();
        // Regenerating a region is the most expensive action in the app (~250 s
        // of on-device generation, and the user watches the region they just
        // got disappear and redraw). So it is reserved for defects that mean
        // "this region failed", not for taste:
        //
        //   - every ERROR always qualifies (checked below);
        //   - these WARNINGS qualify because they describe a region that did
        //     not render what was asked: an empty reservation, or a missing
        //     planned region.
        //
        // Deliberately absent: `thin-section` (a sparse box is a style | and
        // this is what made elements vanish in a cycle on a real run: a region
        // that filled its box only partly was deleted and regenerated, up to
        // four times per build), plus `contrast` (L5 re-inks faded text
        // deterministically and for free), `alignment`, `spacing`,
        // `typography`, `tiny-text` and `palette`, which are advisory.
        const REFINE_CODES = new Set(["empty-section", "missing", "empty-hero"]);
        const idsIn = (msg) => [...String(msg).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        for (const issue of rep.issues) {
          if (issue.severity !== "error" && !REFINE_CODES.has(issue.code)) continue;
          for (const id of idsIn(issue.message)) {
            const comp = activePlan.components.find(
              (c) => c.kind === "dsl" && (id === c.id || id.startsWith(`${c.id}-`) || id.startsWith(`${c.id}_`)),
            );
            if (!comp) continue;
            const list = out.get(comp.id) || [];
            if (!list.includes(issue.message)) list.push(issue.message);
            out.set(comp.id, list);
          }
        }
        return out;
      };

      const reEval = (activePlan) => {
        const appliedIds = [...result.regions.entries()].filter(([, r]) => r.count > 0).map(([id]) => id);
        return evaluateDesign(this.editor.toDesign(), evalOpts(activePlan, appliedIds));
      };

      let result = await buildAll(plan);
      let report = evaluateDesign(this.editor.toDesign(), evalOpts(plan, result.renderedIds));
      console.log(`[build] pass complete: ${result.done - result.failed}/${result.done} components, ${result.appliedTotal} pieces, quality=${report.score}`);

      // Refinement is PER REGION, not a whole rebuild: complaints map back to
      // the regions that own the offending elements, and only those are
      // regenerated | each in its own call, atomically. A region fix cannot
      // repair a template whose regions stack on top of each other (mass
      // overlap), so that | and complaints with no owning region at all |
      // re-tunes the SAME template instead of swapping in a different one.
      const overlapErrors = report.issues.filter((i) => i.severity === "error" && i.code === "overlap").length;
      const crowded = overlapErrors >= 5;
      const failing = crowded ? new Map() : flagRegions(report, plan);
      const hasErrors = report.issues.some((i) => i.severity === "error");
      // An image miss is not a template-layout problem. Re-tuning and
      // rebuilding the whole template for one failed photo was wiping manual
      // edits and then failing on the same photo again. Keep the template (and
      // its edits) intact; retry only the image with the compact search
      // variants, then fail closed if Unsplash still has no honest result.
      const failedImages = plan.components.filter(
        (component) =>
          component.kind === "image" && (result.regions.get(component.id)?.count || 0) === 0,
      );
      const imageOnlyFailure = failedImages.length > 0 && !failing.size && !crowded;

      // Strict word-repetition check over what actually rendered. Comparing
      // the rendered elements (not the plan) catches duplicates introduced by
      // a failed deck pass, and word-level matching catches partial copies
      // such as "New AI Assistant" / "New AI Assistant Product Launch".
      const collectCopyRepetitions = () => {
        const design = this.editor.toDesign();
        const allTexts = collectTextElements(design.elements);
        const renderedRegions = [];
        const owned = new Set();
        for (const [id, region] of result.regions) {
          const comp = plan.components.find((c) => c.id === id);
          if (!comp) continue;
          const texts = textElementsUnder(design, region.ids || []);
          if (!texts.length) continue;
          for (const text of texts) owned.add(text.id);
          renderedRegions.push({ id, text: texts.map((text) => text.text).join(" ") });
        }
        // Template samples, manual text and assistant-added text are rendered
        // copy too. Treat each unowned element as its own region so no gate can
        // miss a duplicate merely because it did not come from the plan.
        for (const text of allTexts) {
          if (owned.has(text.id)) continue;
          renderedRegions.push({ id: `unowned-${text.id}`, text: text.text });
        }
        return findCopyRepetitions(renderedRegions, goal, prompt);
      };
      const mergeRepetitions = (map) => {
        for (const [id, messages] of collectCopyRepetitions()) {
          const list = map.get(id) || [];
          for (const message of messages) if (!list.includes(message)) list.push(message);
          map.set(id, list);
        }
      };

      // A small headline is a copy/fit problem, not a layout problem.
      // Replanning the whole canvas for it sends a template build down the
      // slow free-form path (and usually produces a worse layout). Route the
      // complaint to the headline region and regenerate just that box.
      const headlineIssue = !crowded && report.issues.find((i) => i.severity === "error" && i.code === "headline");
      if (headlineIssue) {
        const headlineComponent = plan.components.find((c) => c.kind === "dsl" && c.role === "headline");
        if (headlineComponent) {
          const notes = failing.get(headlineComponent.id) || [];
          notes.push(
            `${headlineIssue.message} Make this the dominant headline: at least ${Math.max(24, Math.round(canvas.height * 0.06))}px, with fewer words if the box is tight.`,
          );
          failing.set(headlineComponent.id, notes);
        }
      }

      // Copy repetition is a region failure too: regenerate the offenders
      // rather than letting the duplicate words ship.
      if (!crowded && FEATURES.copy.strictRepetition) mergeRepetitions(failing);

      const replanOnce = async (why) => {
        console.warn(`[build] refining template in place: ${why}`);
        this.assistant.pushAssistant(`${why} Refining the same template instead of choosing a new one…`);
        status("3/5 Refining the template…");
        try {
          // Only approved deck copy is carried over to the re-tuned template.
          // The old fallback copy is deliberately not reused: it was the same
          // generic line for every uncovered region, and re-injecting it
          // locked the repetition back in after refinement.
          const copies = Object.fromEntries(
            plan.components
              .filter((component) => component.copySource === "deck")
              .filter((component) => Array.isArray(component.copy) && component.copy.length)
              .map((component) => [component.id, component.copy]),
          );
          const plan2 = await planTemplate(goal, plan.palette, canvas, live("3/5 refine template"), {
            rawPrompt: prompt,
            template: plan.template,
            correction: why,
          });
          const knobs = (tuning) =>
            JSON.stringify({
              variant: tuning?.variant,
              density: tuning?.density,
              hide: tuning?.hide || [],
              scale: tuning?.scale || {},
              align: tuning?.align || {},
            });
          // Check this BEFORE writing a fresh copy deck: an unchanged tuning
          // means the first pass is kept, so a deck call here is pure waste.
          if (knobs(plan2.tuning) === knobs(plan.tuning)) {
            this.assistant.pushAssistant("The template tuning did not change. Keeping the first pass.");
            return;
          }
          plan2.components = plan2.components.map((component) => {
            if (copies[component.id]) {
              return { ...component, copy: copies[component.id], copySource: "reuse" };
            }
            return component;
          });
          // A re-tuned variant can expose regions that did not exist in the
          // first pass. They must not fall through to model-invented copy:
          // write a fresh deck for the new plan and use it for every text
          // region, so repetition is checked against one authoritative deck.
          const copyRegions = plan2.components.filter(
            (component) => component.kind !== "image" && component.role !== "decoration",
          );
          const missingCopy = copyRegions.filter(
            (component) => !Array.isArray(component.copy) || !component.copy.length,
          );
          if (missingCopy.length) {
            this.assistant.pushAssistant(
              `Refined template exposed ${missingCopy.length} region(s) without approved copy. Writing a fresh deck…`,
            );
            const freshDeck = await planCopyDeck(plan2.components, goal, canvas, prompt, live("3/5 copy refine"));
            const freshUnresolved = Array.isArray(freshDeck.unresolved) ? freshDeck.unresolved : [];
            if (freshDeck.source === "failed" || freshUnresolved.length) {
              throw new Error("refined template has no complete copy deck");
            }
            plan2.components = plan2.components.map((component) => {
              const copy = freshDeck.copies?.[component.id];
              return Array.isArray(copy) && copy.length
                ? { ...component, copy, copySource: "deck" }
                : component;
            });
            const stillMissing = plan2.components.filter(
              (component) =>
                component.kind !== "image" &&
                component.role !== "decoration" &&
                (!Array.isArray(component.copy) || !component.copy.length),
            );
            if (stillMissing.length) throw new Error("refined template copy deck is incomplete");
            plan2.copySource = "deck";
          } else {
            plan2.copySource = "reuse";
          }
          if (showTemplateSample(plan2)) {
            this.assistant.pushAssistant(
              `Refined template: "${plan2.template}" (${plan2.tuning.variant}, ${plan2.tuning.density}), ${plan2.components.length} regions.`,
            );
          }
          plan = plan2;
          result = await buildAll(plan2);
          report = reEval(plan2);
        } catch (error) {
          this.assistant.pushAssistant(`Template refinement failed (${error.message}). Keeping the first pass.`, "error");
        }
      };

      const refineRegions = async (reasons) => {
        const ids = [...reasons.keys()].slice(0, FEATURES.copy.maxRegionRepairs);
        if (!ids.length) return;
        console.warn(`[build] per-region refinement: ${ids.join(", ")}`);
        this.assistant.pushAssistant(
          `Refining ${ids.length} template region(s) in place: ${ids.join(", ")}. The layout stays the same.`,
        );
        for (const [index, cid] of ids.entries()) {
          const component = plan.components.find((c) => c.id === cid);
          if (!component || component.kind !== "dsl") continue;
          status(`Refining template region ${index + 1}/${ids.length}: ${cid}…`);
          // Generate first, swap second. The previous version removed the
          // region before asking the model, so a failed refine left a hole in
          // the template. Keep the old elements until the replacement is valid.
          const owned = result.regions.get(cid)?.ids || [];
          const before = owned.length
            ? this.editor.toDesign().elements.filter((element) => owned.includes(element.id))
            : [];
          try {
            const { elements } = await componentDesign(component, canvas, plan, goal, {
              rawPrompt: prompt,
              onProgress: live(`Refining ${cid}`),
              correction: `This region was flagged by the quality gate: ${reasons.get(cid).join(" ")} Rewrite ONLY this region's elements to fix it. Keep every element inside the reserved box and do not reuse words from other regions.`,
            });
            const at = component.role === "decoration" ? 0 : undefined;
            let res;
            try {
              res = this.editor.applyPatchOps([
                ...owned.map((id) => ({ op: "remove", id })),
                ...elements.map((element, k) => ({
                  op: "add",
                  element,
                  ...(typeof at === "number" ? { at: at + k } : {}),
                })),
              ]);
            } catch (error) {
              // The swap failed: put the previous region back so the template
              // never loses a component to a failed refinement.
              if (before.length) {
                try {
                  this.editor.applyPatchOps(
                    before.map((element) => ({ op: "add", element })),
                    { history: false, quiet: true },
                  );
                } catch {
                  // best effort
                }
              }
              throw error;
            }
            result.regions.set(cid, { count: res.applied.length, ids: res.changedIds || [] });
            dropPlaceholders(cid);
            console.log(`[build] refined ${cid} ${res.applied.length} pieces`);
            this.assistant.pushAssistant(`Added refined template region ${cid} (${res.applied.length} pieces)`);
          } catch (error) {
            this.assistant.pushAssistant(`Refine ${cid} failed: ${error.message}. Kept the previous content.`, "error");
          }
        }
        report = reEval(plan);
      };

      if (crowded) {
        await replanOnce(
          `Sections overlap (${overlapErrors} collisions). Stagger boxes vertically with breathing room, keep bars behind their own text.`,
        );
      } else if (failing.size) {
        await refineRegions(failing);
      } else if (hasErrors && !imageOnlyFailure) {
        await replanOnce(`First pass under-built (${topDefects(report)}).`);
      }

      // One strict second pass: the first regeneration may have fixed the
      // quality issue but left a word collision, and replanning can reuse deck
      // copy. Regenerate the remaining offenders once; if it still persists,
      // say so instead of silently shipping the duplicate.
      if (!crowded && FEATURES.copy.strictRepetition && FEATURES.copy.repairPasses > 1) {
        const repeats = collectCopyRepetitions();
        if (repeats.size) {
          await refineRegions(repeats);
          const remaining = collectCopyRepetitions();
          if (remaining.size) {
            this.assistant.pushAssistant(
              `Copy repetition remains in ${[...remaining.keys()].join(", ")}. The region kept its last valid content.`,
              "error",
            );
          }
        }
      }

      // Density is a hard product default, not a taste preference. A region
      // that renders at 10% of its reserved box, or a layout with two lonely
      // marks, is refined in place first; deterministic frames then close any
      // remaining gap so the user never gets a hollow template.
      const densityFindings = report.issues.filter(
        (issue) => issue.code === "thin-section" || issue.code === "decoration-sparse",
      );
      if (FEATURES.layout.densityRepair && densityFindings.length) {
        // Density is repaired deterministically inside the existing boxes.
        // Re-tuning and rebuilding every region for a thin text box was both
        // the largest optional cost and unable to fix the actual fill: the
        // frame/rail/accent pass below does it without another model call.
        renderedIds = [...result.regions.entries()]
          .filter(([, region]) => region.count > 0)
          .map(([id]) => id);
        const densityReport = evaluateDesign(this.editor.toDesign(), evalOpts(plan, renderedIds));
        const repair = buildDensityRepair(densityReport, plan, plan.palette, canvas, this.editor.toDesign());
        if (repair.behind.length || repair.front.length) {
          const ops = [
            ...repair.behind.map((element) => ({ op: "add", element, at: 0 })),
            ...repair.front.map((element) => ({ op: "add", element })),
          ];
          try {
            this.editor.applyPatchOps(ops);
            console.log(`[build] density repair: ${repair.notes.join("; ")}`);
            this.assistant.pushAssistant(`Density repair: ${repair.notes.join("; ")}.`);
            report = evaluateDesign(this.editor.toDesign(), evalOpts(plan, renderedIds));
          } catch (error) {
            console.warn(`[build] density repair failed: ${error.message}`);
            report = densityReport;
          }
        } else {
          report = densityReport;
        }
      }

      // Recount from per-region state so the summary reflects any refinement.
      {
        const applied = [...result.regions.entries()].filter(([, r]) => r.count > 0);
        done = plan.components.length;
        failed = plan.components.length - applied.length;
        appliedTotal = applied.reduce((s, [, r]) => s + r.count, 0);
        renderedIds = applied.map(([id]) => id);

      }

      // The wireframe has served its purpose: the design is settled, so retire
      // any guides left by regions that failed to generate.
      this.editor.clearSkeletonGuides?.();

      const COLLISION = new Set(["overlap", "overflow"]);
      if (report.issues.some((i) => i.severity === "error" && COLLISION.has(i.code))) {
        console.log("[build] collisions detected, running deterministic tidy");
        const fix = this.editor.resolveCollisions();
        console.log(`[build] tidy: moved=${fix.moved.length} unresolvable=${fix.unresolvable.length}`);
        if (fix.moved.length) {
          this.assistant.pushAssistant(
            `Auto-arranged ${fix.moved.length} piece${fix.moved.length === 1 ? "" : "s"} to clear overlaps (one undo step).`,
          );
          report = evaluateDesign(this.editor.toDesign(), evalOpts(plan, renderedIds));
        }
        if (fix.unresolvable.length) {
          this.assistant.pushAssistant(
            `Could not separate: ${fix.unresolvable.slice(0, 4).join(", ")}. Drag them apart by hand.`,
            "error",
          );
        }
      }

      // L5 | Color correction: re-ink text that fades into its backdrop and
      // snap off-palette fills back to the palette. Applied as one undo step.
      status("5/5 Correcting colors…");
      const colorFix = correctColors(this.editor.toDesign(), plan.palette);
      if (colorFix.ops.length) {
        this.editor.applyPatchOps(colorFix.ops);
        this.assistant.pushAssistant(
          `Color correction: ${colorFix.notes.slice(0, 4).join("; ")}` +
            `${colorFix.notes.length > 4 ? ` (${colorFix.notes.length - 4} more)` : ""}`,
        );
        report = evaluateDesign(this.editor.toDesign(), evalOpts(plan, renderedIds));
      } else {
        this.assistant.pushAssistant("Color correction: palette and contrast are clean.");
      }

      // Final repetition gate: refinement may have left a collision (or a
      // template sample may repeat deck words). No duplicate copy may ship, and
      // no attempted repair is allowed to bypass this last check.
      const finalRepeats = collectCopyRepetitions();
      if (finalRepeats.size) {
        const details = [...finalRepeats.entries()]
          .map(([id, messages]) => `${id}: ${messages.join(" ")}`)
          .join("; ");
        this._markGenerationInvalid();
        throw new Error(`Copy repetition remains: ${details}`);
      }

      // Completeness gate: every planned region must have rendered output.
      // A region still showing its template sample is not this brief's design,
      // so it is never captured into memory or written to the library.
      const missingRegions = plan.components.filter(
        (component) => (result.regions.get(component.id)?.count || 0) === 0,
      );
      if (missingRegions.length) {
        const details = missingRegions.map((component) => component.id).join(", ");
        this._markGenerationInvalid();
        throw new Error(`Template regions failed and could not be regenerated: ${details}`);
      }

      // Copy completeness gate: approving a deck line is a promise to render
      // it. A salvage pass may keep only part of a region, so compare the
      // rendered lines with the approved deck instead of trusting a non-zero
      // element count.
      const designForCopy = this.editor.toDesign();
      const incompleteCopy = [];
      for (const component of plan.components) {
        const approved = normalizeCopyLines(component.copy);
        if (!approved.length) continue;
        const region = result.regions.get(component.id);
        const rendered = textElementsUnder(designForCopy, region?.ids || [])
          .flatMap((text) => normalizeCopyLines(text.text.split(/\n+/)));
        if (
          rendered.length !== approved.length ||
          rendered.some((line, index) => line !== approved[index])
        ) {
          incompleteCopy.push({ id: component.id, approved, rendered });
        }
      }
      if (incompleteCopy.length) {
        const details = incompleteCopy
          .map(({ id, approved, rendered }) => {
            const missing = approved.filter((line) => !rendered.includes(line));
            return `${id}: missing ${missing.length ? missing.join(" / ") : "approved line order"}`;
          })
          .join("; ");
        this._markGenerationInvalid();
        throw new Error(`Approved copy was not rendered: ${details}`);
      }

      this.state.design = this.editor.toDesign();
      this.debugTabs.set({
        design: this.state.design,
        analysis: this.referenceAnalysis,
        svg: "",
        semantic: null,
        warnings: [],
      });
      // report already holds the final pass (plus any tidy); refresh its
      // options against the active plan, then present it.
      report = evaluateDesign(this.state.design, evalOpts(plan, renderedIds));
      const top = [...report.issues]
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
        .slice(0, 4);
      this.assistant.pushAssistant(
        `Quality ${report.score}/100${top.length ? ": " + top.map((i) => i.message).join(" ") : "clean."}`,
      );
      if (report.issues.length) {
        this.debugTabs.set({
          ...this.debugTabs.state,
          warnings: [
            ...(this.debugTabs.state.warnings || []),
            ...report.issues.slice(0, 8).map((i) => `${i.severity}: ${i.message}`),
          ],
        });
      }
      const keptSample = plan.components.filter((c) => (placeholders.get(c.id) || []).length > 0).length;
      if (appliedTotal === 0) {
        this._markGenerationInvalid();
        const message = keptSample
          ? `Kept the template sample for all ${done} regions. Oovi could not fill them (see the assistant log).`
          : `All ${done} components failed. See the assistant log for reasons.`;
        this.generateButton.setError(message);
        notify(message, "error");
      } else {
        const message =
          `Built ${done - failed}/${done} regions (${appliedTotal} pieces)` +
          `${keptSample ? `; ${keptSample} kept the template sample` : ""}. Every element is editable.`;
        this.generateButton.setSuccess(message);
        notify(message, failed > 0 ? "info" : "success");
        // Capture the design-scoped model context only after the hard gates.
        // The memory is derived from what actually rendered; it cannot smuggle
        // back a rejected deck line or a random image.
        this.designMemory = createDesignMemory({
          brief: prompt,
          goal,
          plan,
          design: this.state.design,
          regions: result.regions,
          images: result.images || [],
          quality: report,
        });
        // Only now, after the copy deck, rendered repetition and quality gates,
        // may this design reach the library.
        this._persistLocked = false;
        this._generationInvalid = false;
        this.scheduleSave();
        await this.persistNow();
      }
    } catch (error) {
      this._markGenerationInvalid();
      const message = `Generation failed: ${error.message}`;
      this.generateButton.setError(message);
      notify(message, "error");
      console.error(error);
    } finally {
      // Safety net: however the run ends (error, latency, fallback), no
      // stale template guide may outlive it.
      this.editor.clearSkeletonGuides?.();
      this.state.generating = false;
    }
  }

  /**
   * Fetch phase of an image component. The subject comes from L1 and is led by
   * the tuning query only when L1 supplied none. Search goes through the local
   * Unsplash proxy, picks the best aspect fit among relevance-ranked results,
   * and inlines the image as a data URL. There is no image fallback: if the
   * query or the Unsplash result is missing, this region fails and the final
   * completeness gate blocks persistence.
   */
  async _fetchImageComponent(component) {
    const box = component.box || {};
    const tStart = Date.now();
    if (isMockEnabled()) {
      return { src: mockAssetDataUrl(component.describe, box), w: box.width, h: box.height, note: "mock", photographer: "" };
    }

    const candidates = [];
    for (const raw of [...(component.imageQueries || []), component.imageQuery]) {
      const query = String(raw || "").replace(/\s+/g, " ").trim();
      if (query && !candidates.includes(query)) candidates.push(query);
    }
    const query = candidates[0] || "";
    if (!query) {
      console.warn(`[build] image ${component.id} has no image subject | failing region`);
      return null;
    }

    const orientation = orientationFor(box);
    for (const candidate of candidates.slice(0, 4)) {
      try {
        let photos = await searchPhotos(candidate, { orientation });
        if (!photos.length) photos = await searchPhotos(candidate);
        const photo = choosePhoto(photos, box);
        if (!photo) {
          console.warn(`[build] image ${component.id} no photo for "${candidate}"`);
          continue;
        }
        try {
          const src = await fetchImageAsDataUrl(photo.full);
          const dims = await probeImage(src).catch(() => ({ w: box.width, h: box.height }));
          triggerDownload(photo); // best-effort, never blocks
          console.log(
            `[build] image ${component.id} unsplash ${Date.now() - tStart}ms ` +
              `orientation=${orientation || "any"} by ${photo.photographer}`,
          );
          return {
            src,
            w: dims.w,
            h: dims.h,
            note: `unsplash: ${photo.photographer}`,
            photographer: photo.photographer || "",
          };
        } catch (error) {
          console.warn(`[build] image ${component.id} fetch failed (${error.message})`);
        }
      } catch (error) {
        console.warn(`[build] image ${component.id} search failed (${error.message})`);
      }
    }
    console.warn(`[build] image ${component.id} found no usable Unsplash photo | failing region`);
    return null;
  }

  onReferenceAnalysis(analysis) {
    this.referenceAnalysis = analysis;
  }

  async loadProject() {
    try {
      const row = await projects.get(this.projectId);
      this.state.title = row.title || "Untitled design";
      this.topbar.setTitle(this.state.title);
      document.title = `${this.state.title} | Oovi`;
      const design = row.design;
      if (design && Array.isArray(design.elements) && design.elements.length) {
        const check = validateDesign(design);
        if (!check.ok) throw new Error(check.errors.slice(0, 2).join("; "));
        this.state.design = check.design;
        this.editor.loadDesign(check.design);
        this._updateCanvasMeta(check.design.canvas);
        this._renderJsonPreview();
        this.debugTabs.set({ design: check.design, analysis: null, svg: "", semantic: null, warnings: [] });
      }
      this.designMemory = normalizeDesignMemory(row.ai_memory);
      this._syncDesignMemory();
      this.templatesPanel.refresh();
      this._lastPersisted = this.persistKey();
      this._dirtySincePersist = false;
      this._persistLocked = false;
      this._generationInvalid = false;
      this.setSaveState("saved");
    } catch (error) {
      notify(`Couldn't open project: ${error.message}`, "error");
      console.error(error);
    }
  }

  onHome() {
    window.location.hash = "#/";
  }

  onDesignTypeChange(id) {
    this.designPreset = getPreset(id);
    const { label, width, height } = this.designPreset;
    const hasObjects = (this.editor.canvas?.getObjects().length || 0) > 0;
    if (hasObjects) {
      // Never reflow or destroy a finished design: the new size applies to
      // the next Generate instead.
      const message = `Size set to ${label} ${width} × ${height}. Press Regenerate to apply it.`;
      this.generateButton.setStatus(message, "");
      notify(message, "info");
      return;
    }
    this.editor.resizeCanvas(width, height);
    this._updateCanvasMeta({ width, height });
    this.templatesPanel.refresh();
    this._renderJsonPreview();
    this.properties.setSelection(this.editor.canvas?.getActiveObjects() || []);
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
    // Native confirm matches the Regenerate precedent; Goal 5 custom dialog replaces both.
    if (!window.confirm("Clear the canvas? Everything is removed (one undo brings it back).")) return;
    this.editor.clear();
    this._clearPreviewUI();
    this.designMemory = syncMemoryCopy(emptyDesignMemory(), this.editor.toDesign());
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
    document.title = `${title} | Oovi`;
    this.scheduleSave();
  }

  onTab(tab) {
    if (tab === "pipeline") {
      this.leftTabs?.set("pipeline");
      this._revealLeftPanel();
    } else if (tab === "design") {
      this.leftTabs?.set("insert");
      this._closeDeveloper();
      this._revealCanvas();
    } else if (tab === "code") this._openDeveloper();
  }

  onToggleLock() {
    const locked = this.editor.toggleLockActive();
    this._refreshContextBar();
    notify(locked ? "Selection locked." : "Selection unlocked.", "info");
  }

  async onRemoveBackground() {
    if (this.state.removing) {
      notify("Background removal already running.", "info");
      return;
    }
    this.state.removing = true;
    notify("Removing background… (first run downloads the model)", "info");
    try {
      const ok = await this.editor.removeBackgroundActive();
      if (ok) {
        notify("Background removed.", "success");
        this._renderJsonPreview();
        this.scheduleSave();
        this._refreshChrome();
      } else {
        notify("Select a single loaded image first.", "error");
      }
    } catch (error) {
      notify(`Background removal failed: ${error.message}`, "error");
      console.error(error);
    } finally {
      this.state.removing = false;
    }
  }

  onCommand(cmd) {
    if (cmd === "remove-bg") {
      this.onRemoveBackground();
      return;
    }
    const [action, arg] = String(cmd).split("-");
    if (action === "align") this.editor.alignActive(arg);
    else if (action === "distribute") this.editor.distributeActive(arg);
    else if (action === "order") this.editor.orderActive(arg);
    else return;
    this._refreshChrome();
  }

  onArtboardProp(key, value) {
    const c = this.editor.canvas;
    if (!c) return;
    if (key === "background") {
      this.editor.setBackground(value);
      return;
    }
    if (key === "width" || key === "height") {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return;
      const width = key === "width" ? Math.min(4096, Math.max(64, n)) : c.width;
      const height = key === "height" ? Math.min(4096, Math.max(64, n)) : c.height;
      this.editor.resizeCanvas(width, height);
      this._updateCanvasMeta({ width, height });
      this.templatesPanel.refresh();
      this._renderJsonPreview();
      this.properties.setSelection(c.getActiveObjects());
      this.scheduleSave();
    }
  }

  _updateAssistantContext(objects) {
    const list = objects || [];
    if (list.length === 1) {
      const o = list[0];
      const kind = o.elementType || o.type;
      const isText = kind === "text" || o.type === "i-text" || o.type === "textbox";
      this.assistant.setContext({
        label: `Editing: ${o.designId || kind}`,
        suggestions: isText
          ? [
              { label: "Bigger", kind: "ai", text: "make it bigger" },
              { label: "Center", kind: "ai", text: "center it" },
              { label: "Blue", kind: "ai", text: "make it blue" },
            ]
          : [
              { label: "Center", kind: "ai", text: "center it" },
              { label: "To front", kind: "cmd", cmd: "order-front" },
              { label: "To back", kind: "cmd", cmd: "order-back" },
            ],
      });
    } else if (list.length > 1) {
      this.assistant.setContext({
        label: `Editing: ${list.length} objects`,
        suggestions: [
          { label: "Distribute", kind: "cmd", cmd: "distribute-x" },
          { label: "Align center", kind: "cmd", cmd: "align-center" },
          { label: "Group", kind: "cmd", cmd: "group" },
        ],
      });
    } else {
      this.assistant.setContext({
        label: "Whole design",
        suggestions: [
          { label: "Add headline", kind: "ai", text: "add a headline" },
          { label: "Add button", kind: "ai", text: "add a button" },
          { label: "Bigger headline", kind: "ai", text: "make it bigger" },
        ],
      });
    }
  }

  onSuggestion(sug) {
    if (!sug) return;
    if (sug.kind === "ai") {
      this.onAssistantSend(sug.text || sug.label);
      return;
    }
    if (sug.cmd === "group") {
      const id = this.editor.groupActive();
      if (id) notify(`Grouped into ${id}.`, "success");
      this._refreshChrome();
      return;
    }
    const [action, arg] = String(sug.cmd || "").split("-");
    if (action === "order") this.editor.orderActive(arg);
    else if (action === "distribute") this.editor.distributeActive(arg);
    else if (action === "align") this.editor.alignActive(arg);
    else return;
    this._refreshChrome();
  }

  async onAssistantSend(message) {
    const text = String(message || "").trim();
    if (!text || this.state.assisting) return;
    this._clearPreviewUI();
    this.state.assisting = true;
    this.assistant.setBusy(true);
    this.assistant.pushUser(text);
    try {
      const design = this.editor.toDesign();
      if (!design || !(design.elements || []).length) {
        this.assistant.pushAssistant("Generate or add something first, then ask for changes.", "error");
        return;
      }
      const selectedIds = (this.editor.canvas?.getActiveObjects() || [])
        .map((o) => o.designId)
        .filter((id) => typeof id === "string");
      const { ops, errors, note, source } = await generatePatch(text, {
        design,
        selectedIds,
        memory: this.designMemory,
      });
      if (!ops.length) {
        this.assistant.pushAssistant(note || errors.join("; ") || "No changes proposed.", errors.length ? "error" : "");
        if (errors.length) notify(`Assistant: ${errors[0]}`, "error");
        return;
      }
      const { applied, changedIds } = this.editor.applyPatchOps(ops);
      // A follow-up edit must honor the same no-repeat invariant as a full
      // generation. Check only the text this patch touched, against everything
      // already rendered; if it collides, undo the whole patch atomically.
      const touchedText = new Set();
      for (const op of ops) {
        if (op.op === "add" && op.element?.id) {
          // A group add carries text children; the repetition gate expands a
          // group id to the text it owns.
          touchedText.add(op.element.id);
        } else if (op.op === "update" && Object.prototype.hasOwnProperty.call(op.props || {}, "content")) {
          touchedText.add(op.id);
        }
      }
      if (touchedText.size) {
        const repeats = findTextRepetitionsForChanged(this.editor.toDesign(), [...touchedText]);
        if (repeats.size) {
          const details = [...repeats.entries()]
            .map(([id, messages]) => `${id}: ${messages.join("; ")}`)
            .join(" | ");
          try {
            await this.editor.history.undo();
          } catch (undoError) {
            this._markGenerationInvalid();
            console.error(`[assistant] could not undo repeated copy: ${undoError.message}`);
          }
          this._clearPreviewUI();
          this._syncDesignMemory();
          this._refreshChrome();
          const message = `Patch rejected. It would repeat copy: ${details}`;
          this.assistant.pushAssistant(message, "error");
          notify(message, "error");
          return;
        }
      }
      this._renderJsonPreview();
      this._refreshChrome();
      this.scheduleSave();
      this.aiIds = new Set(changedIds);
      this.layersPanel.refresh({ aiIds: this.aiIds });
      this._preview = {
        active: true,
        showingAfter: true,
        clean: true,
        request: text,
        source,
        changedIds,
      };
      this.assistant.showProposal({ lines: applied, errors, note, source });
      this._positionGhost(true);
      notify(`Assistant proposed ${applied.length} change(s).`, "info");
    } catch (error) {
      this.assistant.pushAssistant(`Failed: ${error.message}`, "error");
      notify(`Assistant failed: ${error.message}`, "error");
      console.error(error);
    } finally {
      this.state.assisting = false;
      this.assistant.setBusy(false);
    }
  }

  onApplyProposal() {
    if (!this._preview?.active) return;
    const preview = { ...this._preview };
    this._clearPreviewUI();
    this.designMemory = recordMemoryEdit(this.designMemory, {
      request: preview.request,
      source: preview.source,
      changedIds: preview.changedIds,
    });
    this._syncDesignMemory();
    this.scheduleSave();
    this.assistant.pushAssistant("Applied. Undo is available (Ctrl+Z).");
    notify("AI changes applied.", "success");
  }

  async onCancelProposal() {
    if (!this._preview?.active) return;
    await this.editor.history.undo();
    this._clearPreviewUI();
    this._syncDesignMemory();
    this.assistant.pushAssistant("Discarded.");
    this.scheduleSave();
    this._refreshChrome();
  }

  async onTogglePreview() {
    if (!this._preview?.active) return;
    if (this._preview.showingAfter) {
      await this.editor.history.undo();
      this._preview.showingAfter = false;
      this.assistant.setToggleLabel(false);
    } else {
      await this.editor.history.redo();
      this._preview.showingAfter = true;
      this.assistant.setToggleLabel(true);
    }
  }

  onAssistantRegenerate() {
    // Native confirm is the Goal-5-dialog predecessor (logged in DECISIONS).
    if (!window.confirm("Replace the whole design? Your current edits stay one undo away.")) return;
    this.onGenerate();
  }

  _positionGhost(show) {
    const overlay = document.getElementById("ghost-overlay");
    if (!overlay) return;
    if (!show) {
      overlay.hidden = true;
      return;
    }
    const holder = document.getElementById(this.editor.holderId);
    const main = holder?.closest(".canvas-area");
    if (!holder || !main) return;
    const hr = holder.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    overlay.style.left = `${hr.left - mr.left}px`;
    overlay.style.top = `${hr.top - mr.top}px`;
    overlay.style.width = `${hr.width}px`;
    overlay.style.height = `${hr.height}px`;
    overlay.hidden = false;
  }

  _clearPreviewUI() {
    this._preview = null;
    this.aiIds = new Set();
    this.layersPanel.refresh({ aiIds: this.aiIds });
    this.assistant.clearProposal();
    this._positionGhost(false);
  }

  toggleSidebar() {
    const collapsed = document.getElementById("app").classList.contains("side-collapsed");
    this.setSidebar(collapsed);
  }

  /** @param {boolean} open true = sidebar visible */
  setSidebar(open) {
    document.getElementById("app").classList.toggle("side-collapsed", !open);
    const btn = document.getElementById("sidebar-toggle");
    if (btn) {
      const icon = btn.querySelector("svg, i");
      if (icon) icon.className = open ? "fa-solid fa-angles-left" : "fa-solid fa-angles-right";
      btn.title = open ? "Collapse sidebar" : "Expand sidebar";
      btn.setAttribute("aria-label", open ? "Collapse sidebar" : "Expand sidebar");
      btn.setAttribute("aria-expanded", String(open));
    }
    try {
      window.localStorage.setItem("oovi.sidebar", open ? "open" : "collapsed");
    } catch {
      // ignore
    }
    requestAnimationFrame(() => this.editor.fitToContainer());
  }

  async exportDesign(format = "png") {
    const c = this.editor.canvas;
    if (!c || c.getObjects().length === 0) {
      notify("Nothing to export yet.", "error");
      return;
    }
    const slug =
      this.state.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "design";
    try {
      if (format === "jpg") await this.editor.exportJpg(`${slug}.jpg`);
      else if (format === "svg") await this.editor.exportSvg(`${slug}.svg`);
      else if (format === "pdf") await this.editor.exportPdf(`${slug}.pdf`);
      else await this.editor.exportPng(`${slug}.png`);
      notify(`Exported ${slug}.${format}.`, "success");
    } catch (error) {
      notify(`Export failed: ${error.message}`, "error");
      console.error(error);
    }
  }

  /**
   * Apply a template from the manual gallery. This is deliberately the same
   * instantiation path the planner uses (normalised boxes -> snapped pixels),
   * but with neutral sample copy instead of a model call. The result is a
   * normal editable design, so undo, persistence and export all just work.
   * @param {object} template
   */
  applyTemplate(template) {
    if (!template) return;
    if (this.state.generating) {
      notify("Wait for the current generation to finish before applying a template.", "info");
      return;
    }
    const canvas = {
      width: this.editor.canvas?.width || this.designPreset.width,
      height: this.editor.canvas?.height || this.designPreset.height,
    };
    const palette = paletteForTemplate(template);
    const result = sampleDesignForTemplate(template, canvas, palette);
    if (!result.ok) {
      notify(`Couldn't apply template: ${result.reason}`, "error");
      return;
    }
    const check = validateDesign(result.design);
    if (!check.ok) {
      const reason = check.errors.slice(0, 2).join("; ");
      notify(`Template is not valid: ${reason}`, "error");
      console.error("[template] invalid design", check.errors, result.design);
      return;
    }

    this._clearPreviewUI();
    this.state.design = check.design;
    this.editor.loadDesign(check.design);
    this.designMemory = syncMemoryCopy(emptyDesignMemory(), check.design);
    this._persistLocked = false;
    this._generationInvalid = false;
    this._updateCanvasMeta(check.design.canvas);
    this._renderJsonPreview();
    this.debugTabs.set({
      design: check.design,
      analysis: null,
      svg: "",
      semantic: null,
      warnings: [`Template "${template.label}" applied with editable sample copy.`],
    });
    this.scheduleSave();
    this._refreshChrome();
    const message = `Applied "${template.label}". Edit the sample text, or Undo to go back.`;
    this.generateButton.setStatus(message, "");
    notify(message, "success");
  }

  /**
   * "Save as template": turn the current canvas into a reusable layout.
   * The converter reads the RENDERED design and the result must clear the same
   * quality gate the template tests use | a layout that would overflow, collide
   * or fade is refused with the reasons rather than stored.
   */
  saveCurrentAsTemplate() {
    const design = this.editor.toDesign();
    if (!design?.elements?.length) {
      notify("Nothing to save yet. Generate or draw a design first.", "error");
      return;
    }
    const title = (this.state?.title || "Saved layout").trim() || "Saved layout";
    const result = templateFromDesign(design, {
      label: title,
      blurb: "a layout saved from a finished design",
      keywords: title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
    });
    if (!result.ok) {
      notify(`Not saved: ${result.reason}`, "error");
      console.warn("[template] save refused", result);
      return;
    }
    const saved = saveTemplate(result.template);
    if (!saved.ok) {
      notify(`Not saved: ${saved.reason}`, "error");
      return;
    }
    this.templatesPanel.refresh();
    const regions = result.template.build("as-saved", 0.025).filter((s) => s.role !== "decoration").length;
    notify(`Saved "${result.template.label}" as a ${regions}-region template (${saved.count} in the library).`, "success");
    console.log(
      `[template] saved ${result.template.id} regions=${regions} warnings=${result.issues.filter((i) => i.severity === "warning").length}`,
    );
  }

  async onPhotoInsert(photo) {
    if (!photo?.full) return;
    notify(`Fetching photo by ${photo.photographer || "Unknown"}…`, "info");
    try {
      triggerDownload(photo); // best-effort credit, never blocks
      const src = await fetchImageAsDataUrl(photo.full);
      const dims = await probeImage(src).catch(() => ({ w: 800, h: 600 }));
      this.editor.addImageElement(src, dims.w, dims.h);
      this.assistant.pushAssistant(`Photo by ${photo.photographer || "Unknown"} on Unsplash.`);
      notify("Photo inserted.", "success");
    } catch (error) {
      notify(`Photo failed: ${error.message}`, "error");
      console.error(error);
    }
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

  _stackedLayout() {
    const grid = document.querySelector(".editor-grid");
    return Boolean(grid) && getComputedStyle(grid).display === "flex";
  }

  _revealLeftPanel() {
    const app = document.getElementById("app");
    if (app?.classList.contains("side-collapsed")) this.setSidebar(true);
    if (!this._stackedLayout()) return;
    const left = document.querySelector(".editor-left");
    requestAnimationFrame(() => left?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  _revealCanvas() {
    if (!this._stackedLayout()) return;
    const center = document.querySelector(".editor-center");
    requestAnimationFrame(() => center?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  _openDeveloper() {
    const dev = document.getElementById("developer");
    if (dev) {
      dev.open = true;
      dev.scrollIntoView({
        behavior: "smooth",
        block: this._stackedLayout() ? "center" : "nearest",
      });
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
    const selected = this.editor.canvas?.getActiveObjects() || [];
    const isImage = selected.length === 1 && (selected[0].elementType || selected[0].type) === "image";
    this.contextbar.show(rect.x + rect.width / 2 - 84, rect.y - 48, {
      locked: this.editor.isActiveLocked(),
      isImage,
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

  /** @param {"saved"|"saving"|"unsaved"|"error"} state */
  setSaveState(state) {
    this.topbar.setSaveState(state);
  }

  /**
   * A generation that fails a hard gate must not be written to the library.
   * The canvas may still show the template sample so the user can see what was
   * attempted, but the debounced persist stays locked until a later run or a
   * manual template choice replaces it.
   */
  _markGenerationInvalid() {
    this._generationInvalid = true;
    this._persistLocked = true;
    if (this._persistTimer) {
      window.clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this.setSaveState("error");
  }

  /**
   * Re-derive copy and used words from the rendered canvas. Safe to call on
   * every save: it only advances the timestamp when the memory content really
   * changed, so the durable store does not churn.
   */
  _syncDesignMemory() {
    if (!this.editor?.canvas) return;
    try {
      this.designMemory = syncMemoryCopy(
        this.designMemory || emptyDesignMemory(),
        this.editor.toDesign(),
      );
    } catch (error) {
      console.warn(`[memory] could not sync rendered copy: ${error.message}`);
    }
  }

  scheduleSave() {
    if (this._persistLocked) return;
    this._syncDesignMemory();
    this.setSaveState("unsaved");
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => this.saveDraftNow(), 800);
    // Library persist (debounced harder; skips when nothing changed).
    this._dirtySincePersist = true;
    if (this._persistTimer) window.clearTimeout(this._persistTimer);
    this._persistTimer = window.setTimeout(() => this.persistNow(), 2500);
  }

  persistKey() {
    try {
      return `${this.state.title}\n${JSON.stringify(this.editor.toDesign())}\n${memoryPersistKey(this.designMemory)}`;
    } catch {
      return "";
    }
  }

  async persistNow() {
    if (!this.editor.canvas) return;
    if (this._persistLocked) {
      console.log("[persist] skipped | generation is locked until its final gates pass");
      return;
    }
    this._syncDesignMemory();
    const key = this.persistKey();
    if (!key || key === this._lastPersisted) return;
    try {
      const design = this.editor.toDesign();
      let thumbnail = null;
      try {
        thumbnail = this.editor.canvas.toDataURL({ format: "png", multiplier: 0.25 });
      } catch {
        thumbnail = null;
      }
      if (!this.projectId) {
        const row = await projects.create({
          title: this.state.title,
          design,
          memory: this.designMemory,
        });
        this.projectId = row.id;
        try {
          window.history.replaceState(null, "", `#/design/${row.id}`);
        } catch {
          // non-fatal: hash stays at /design/new
        }
      } else {
        await projects.update(this.projectId, {
          title: this.state.title,
          design,
          memory: this.designMemory,
          thumbnail,
        });
      }
      this._lastPersisted = key;
      this._dirtySincePersist = false;
    } catch (error) {
      console.error("[persist]", error.message);
      notify(`Couldn't save to library: ${error.message}`, "error");
    }
  }

  saveDraftNow() {
    if (!this.editor.canvas) return;
    if (this._persistLocked) return;
    this._syncDesignMemory();
    this.setSaveState("saving");
    try {
      const payload = {
        title: this.state.title,
        savedAt: new Date().toISOString(),
        design: this.editor.toDesign(),
        memory: this.designMemory,
      };
      window.localStorage.setItem("oovi.draft.v1", JSON.stringify(payload));
      this.setSaveState("saved");
    } catch {
      this.setSaveState("error");
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