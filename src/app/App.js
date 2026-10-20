import {
  generateDesign,
  generatePatch,
  planSkeleton,
  planTemplate,
  planPalette,
  refineGoal,
  componentDesign,
} from "../ai/aiClient";
import { evaluateDesign } from "../ai/quality";
import { correctColors } from "../ai/colorCorrect";
import { assetUrl, fetchAssetDataUrl, fetchAssetViaBackend } from "../ai/pollinations";
import { searchPhotos, triggerDownload } from "../ai/unsplash";
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
import { AssistantPanel } from "../components/AssistantPanel";
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
      if (this.devRole) this.devRole.textContent = first ? String(first.elementRole || "—") : "—";
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
    this.assistant.pushAssistant("Select something, then describe a change. Offline? Add ?mock=1 to the URL.");
    this._updateAssistantContext([]);
    let pending = "";
    try {
      pending = window.sessionStorage.getItem("oovi.pendingPrompt") || "";
      window.sessionStorage.removeItem("oovi.pendingPrompt");
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

  /**
   * Architected path: plan once, then stream components one by one —
   * DSL text/shapes through the existing pipeline, icons/logos/photos
   * through Pollinations. Each component is its own undo entry.
   */
  async onGenerateArchitected(prompt) {
    const canvas = { width: this.designPreset.width, height: this.designPreset.height };
    this.state.generating = true;
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
      // Layered cascade (raw -> best), so a terse request still lands a
      // complete design: L1 redefine the goal, L2 choose the palette,
      // L3 lay out the skeleton. L4 (add text) is the component build below;
      // L5 (color correction) runs after the build.
      status("1/5 Refining the goal…");
      let goal;
      let plan;
      try {
        goal = await refineGoal(prompt, canvas, live("1/5 goal"));
        this.assistant.pushAssistant(`Goal: ${goal.summary}`);
        status("2/5 Choosing the palette…");
        const palette = await planPalette(goal, canvas, live("2/5 palette"));
        this.assistant.pushAssistant(
          `Palette: ${palette.background} / ${palette.ink} / ${palette.accent} — ${palette.style}` +
            `${palette.source === "library" ? " (library)" : ""}.`,
        );
        status("3/5 Choosing the layout…");
        // Phase 2D: a template's boxes cannot collide, so L3 is normally a
        // keyword pre-filter plus a small tuning call instead of a five-minute
        // free-form skeleton. The full L3 stays as the fallback whenever no
        // template fits this canvas or the instantiated plan fails its check.
        plan = await planTemplate(goal, palette, canvas, live("3/5 layout"));
        if (plan) {
          this.assistant.pushAssistant(
            `Layout: template "${plan.template}" (${plan.tuning.variant}, ${plan.tuning.density}).`,
          );
        } else {
          status("3/5 Laying out the skeleton…");
          plan = await planSkeleton(goal, palette, canvas, "", live("3/5 skeleton"));
        }
      } catch (error) {
        console.warn("[architect] planning failed, falling back to direct:", error.message);
        this.assistant.pushAssistant(`Planning failed (${error.message}) — falling back to one-shot generation.`);
        this.state.generating = false;
        return await this.onGenerateDirect(prompt);
      }

      this.editor.loadDesign({ canvas: { ...canvas, background: plan.palette.background }, elements: [] });
      // Show the planned regions as a dashed wireframe right away, so the
      // canvas reflects the skeleton during the long per-region generation
      // instead of sitting blank. Each box is replaced by real content as its
      // component lands.
      this.editor.showSkeletonGuides?.(plan.components);
      this._updateCanvasMeta(canvas);
      this._renderJsonPreview();
      this.scheduleSave();
      this._refreshChrome();
      if (plan.warnings.length) {
        this.assistant.pushAssistant(`Plan notes: ${plan.warnings.join("; ")}`);
      }
      this.assistant.pushAssistant(`Plan: ${plan.components.length} components (${plan.source}).`);

      let done = 0;
      let failed = 0;
      let appliedTotal = 0;
      let renderedIds = [];
      // One pass over the plan; extracted so a thin first pass can retry
      // with corrections without duplicating the loop.
      //
      // The on-device model serves ONE generation at a time
      // (OLLAMA_NUM_PARALLEL=1). Fanning component calls out does not make
      // them faster — Ollama just queues them, and while queued they receive
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
        status(`4/5 Adding text — ${n} regions (serially, on-device model)…`);
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
            this.assistant.pushAssistant(
              `${component.id} skipped: ${settled && settled.error ? settled.error.message : "unknown error"}`,
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
                out.appliedTotal += 1;
                out.renderedIds.push(component.id);
                placed.push({ i, count: 1 });
                note(component.id, 1);
                const imagetag = isMockEnabled()
                  ? "mock"
                  : fetched.note || "";
                console.log(`[build] placed ${component.id} image at=${at}`);
                this.assistant.pushAssistant(
                  `+ ${component.id} (image${imagetag ? `, ${imagetag}` : ""})`,
                );
                if (fetched.note === "hotlinked" && !isMockEnabled()) {
                  notify("Image hotlinked: PNG export may be blocked by the provider.", "error");
                }
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
              out.appliedTotal += res.applied.length;
              out.renderedIds.push(component.id);
              placed.push({ i, count: res.applied.length });
              note(component.id, res.applied.length, res.changedIds || []);
              console.log(`[build] placed ${component.id} ${res.applied.length} pieces at=${at}`);
              this.assistant.pushAssistant(`+ ${component.id} (${res.applied.length} pieces)`);
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
              const { elements } = await componentDesign(component, canvas, activePlan, goal, {
                onProgress: (chunks, secs) => {
                  const painted = (streamed.get(component.id) || []).length;
                  live(`4/5 ${component.id}`)(chunks, secs);
                  if (painted) status(`4/5 ${component.id}: ${painted} element(s) placed · ${chunks} tok · ${secs}s…`);
                },
                onStreamStart: () => retractStreamed(component.id),
                onElement: (element) => streamElement(i, component.id, element),
              });
              console.log(`[build] ready ${component.id} ${Date.now() - t}ms elements=${elements.length}`);
              return { kind: "dsl", elements };
            },
          })),
          applyOne,
        );
        return { ...out, regions };
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
        // Deliberately absent: `thin-section` (a sparse box is a style — and
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

      // Refinement is PER REGION, not a whole replan: complaints map back to
      // the regions that own the offending elements, and only those are
      // regenerated — each in its own call. A region fix cannot repair a
      // skeleton that stacks sections on top of each other (mass overlap), so
      // that — and complaints with no owning region at all — still replan once.
      const overlapErrors = report.issues.filter((i) => i.severity === "error" && i.code === "overlap").length;
      const crowded = overlapErrors >= 5;
      const failing = crowded ? new Map() : flagRegions(report, plan);
      const hasErrors = report.issues.some((i) => i.severity === "error");

      const replanOnce = async (why) => {
        console.warn(`[build] replanning once: ${why}`);
        this.assistant.pushAssistant(`${why} Retrying the plan once…`);
        status("3/5 Re-laying out with corrections…");
        try {
          const plan2 = await planSkeleton(
            goal,
            plan.palette,
            canvas,
            `Your previous skeleton failed quality checks: ${topDefects(report)}. Fix every defect above; keep the rest of the brief.`,
            live("3/5 re-skeleton"),
          );
          this.editor.loadDesign({ canvas: { ...canvas, background: plan2.palette.background }, elements: [] });
          this.editor.showSkeletonGuides?.(plan2.components);
          if (plan2.warnings.length) {
            this.assistant.pushAssistant(`Replan notes: ${plan2.warnings.join("; ")}`);
          }
          this.assistant.pushAssistant(`Replan: ${plan2.components.length} components (${plan2.source}).`);
          plan = plan2;
          result = await buildAll(plan2);
          report = reEval(plan2);
        } catch (error) {
          this.assistant.pushAssistant(`Replan failed (${error.message}) — keeping the first pass.`, "error");
        }
      };

      if (crowded) {
        await replanOnce(
          `Sections overlap (${overlapErrors} collisions) — stagger boxes vertically with breathing room, keep bars behind their own text.`,
        );
      } else if (failing.size) {
        const ids = [...failing.keys()].slice(0, 4);
        console.warn(`[build] per-region refinement: ${ids.join(", ")}`);
        this.assistant.pushAssistant(`Refining ${ids.length} region(s) individually: ${ids.join(", ")}.`);
        for (const cid of ids) {
          const component = plan.components.find((c) => c.id === cid);
          if (!component || component.kind !== "dsl") continue;
          status(`Refining ${cid}…`);
          const owned = result.regions.get(cid)?.ids || [];
          if (owned.length) {
            try {
              this.editor.applyPatchOps(owned.map((id) => ({ op: "remove", id })));
            } catch {
              // element already gone; regenerate regardless
            }
          }
          // Elements painted from this refinement's own token stream, retracted
          // before the validated set lands (same policy as the build loop).
          const liveIds = [];
          const retractLive = () => {
            if (!liveIds.length) return;
            const ids = liveIds.splice(0);
            try {
              this.editor.applyPatchOps(ids.map((id) => ({ op: "remove", id })), { history: false, quiet: true });
            } catch {
              // already gone
            }
          };
          try {
            const { elements } = await componentDesign(component, canvas, plan, goal, {
              onProgress: live(`Refining ${cid}`),
              correction: `This region was flagged by the quality gate: ${failing.get(cid).join(" ")} Rewrite ONLY this region's elements to fix it. Keep every element inside the reserved box.`,
              onStreamStart: retractLive,
              onElement: (element) => {
                if (!element || typeof element.id !== "string" || liveIds.includes(element.id)) return;
                liveIds.push(element.id);
                try {
                  this.editor.applyPatchOps([{ op: "add", element }], { history: false, quiet: true });
                } catch {
                  // a malformed partial must never break the build
                }
              },
            });
            retractLive();
            const at = component.role === "decoration" ? 0 : undefined;
            const res = this.editor.applyPatchOps(
              elements.map((element, k) => ({
                op: "add",
                element,
                ...(typeof at === "number" ? { at: at + k } : {}),
              })),
            );
            result.regions.set(cid, { count: res.applied.length, ids: res.changedIds || [] });
            console.log(`[build] refined ${cid} ${res.applied.length} pieces`);
            this.assistant.pushAssistant(`+ refined ${cid} (${res.applied.length} pieces)`);
          } catch (error) {
            retractLive();
            this.assistant.pushAssistant(`Refine ${cid} failed: ${error.message}`, "error");
          }
        }
        report = reEval(plan);
      } else if (hasErrors) {
        await replanOnce(`First pass under-built (${topDefects(report)}).`);
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
            `Could not separate: ${fix.unresolvable.slice(0, 4).join(", ")} — drag them apart by hand.`,
            "error",
          );
        }
      }

      // L5 — Color correction: re-ink text that fades into its backdrop and
      // snap off-palette fills back to the palette. Applied as one undo step.
      status("5/5 Correcting colors…");
      const colorFix = correctColors(this.editor.toDesign(), plan.palette);
      if (colorFix.ops.length) {
        this.editor.applyPatchOps(colorFix.ops);
        this.assistant.pushAssistant(
          `Color correction: ${colorFix.notes.slice(0, 4).join("; ")}` +
            `${colorFix.notes.length > 4 ? ` (+${colorFix.notes.length - 4} more)` : ""}`,
        );
        report = evaluateDesign(this.editor.toDesign(), evalOpts(plan, renderedIds));
      } else {
        this.assistant.pushAssistant("Color correction: palette and contrast are clean.");
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
        `Quality ${report.score}/100${top.length ? ": " + top.map((i) => i.message).join(" ") : " — clean."}`,
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
      if (appliedTotal === 0) {
        const message = `All ${done} components failed — see the assistant log for reasons.`;
        this.generateButton.setError(message);
        notify(message, "error");
      } else {
        const message = `Built ${done - failed}/${done} components (${appliedTotal} pieces) — every element is editable.`;
        this.generateButton.setSuccess(message);
        notify(message, failed > 0 ? "info" : "success");
      }
      this.scheduleSave();
    } catch (error) {
      const message = `Generation failed: ${error.message}`;
      this.generateButton.setError(message);
      notify(message, "error");
      console.error(error);
    } finally {
      // Safety net: however the run ends (error, latency, fallback), no
      // skeleton wireframe may outlive it.
      this.editor.clearSkeletonGuides?.();
      this.state.generating = false;
    }
  }

  /**
   * Fetch phase of an image component: pure network, no canvas mutation,
   * so the build loop can run these concurrently. Returns the asset spec
   * (or null on failure); the caller adds it in plan order.
   */
  async _fetchImageComponent(component) {
    const box = component.box;
    const tStart = Date.now();
    if (isMockEnabled()) {
      return { src: mockAssetDataUrl(component.describe, box), w: box.width, h: box.height, note: "mock" };
    }
    const assetOpts = { width: box.width, height: box.height, asset: component.asset };
    // 1. Backend first — the secret key never leaves the server.
    try {
      const src = await fetchAssetViaBackend(component.describe, assetOpts);
      const dims = await probeImage(src).catch(() => ({ w: box.width, h: box.height }));
      console.log(`[build] image ${component.id} via backend ${Date.now() - tStart}ms`);
      return { src, w: dims.w, h: dims.h, note: "" };
    } catch (error) {
      console.warn(`[build] image ${component.id} backend failed: ${error.message}`);
      console.warn("[architect] backend unavailable, trying direct:", error.message);
    }
    // 2. Keyless direct fetch (dataURL: export-safe).
    try {
      const url = assetUrl(component.describe, assetOpts);
      const src = await fetchAssetDataUrl(url);
      const dims = await probeImage(src).catch(() => ({ w: box.width, h: box.height }));
      console.log(`[build] image ${component.id} direct ${Date.now() - tStart}ms`);
      return { src, w: dims.w, h: dims.h, note: "" };
    } catch (error) {
      console.warn(`[build] image ${component.id} direct failed: ${error.message}`);
      console.warn("[architect] asset fetch failed, hotlinking:", error.message);
      return { src: assetUrl(component.describe, { width: box.width, height: box.height, asset: component.asset }), w: box.width, h: box.height, note: "hotlinked" };
    }
  }

  onReferenceAnalysis(analysis) {
    this.referenceAnalysis = analysis;
  }

  async loadProject() {
    try {
      const row = await projects.get(this.projectId);
      this.state.title = row.title || "Untitled design";
      this.topbar.setTitle(this.state.title);
      document.title = `${this.state.title} — Oovi`;
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
      this._lastPersisted = this.persistKey();
      this._dirtySincePersist = false;
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
      const message = `Size set to ${label} ${width} × ${height} — press Regenerate to apply it.`;
      this.generateButton.setStatus(message, "");
      notify(message, "info");
      return;
    }
    this.editor.resizeCanvas(width, height);
    this._updateCanvasMeta({ width, height });
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
      const { ops, errors, note, source } = await generatePatch(text, { design, selectedIds });
      if (!ops.length) {
        this.assistant.pushAssistant(note || errors.join("; ") || "No changes proposed.", errors.length ? "error" : "");
        if (errors.length) notify(`Assistant: ${errors[0]}`, "error");
        return;
      }
      const { applied, changedIds } = this.editor.applyPatchOps(ops);
      this._renderJsonPreview();
      this._refreshChrome();
      this.scheduleSave();
      this.aiIds = new Set(changedIds);
      this.layersPanel.refresh({ aiIds: this.aiIds });
      this._preview = { active: true, showingAfter: true, clean: true };
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
    this._clearPreviewUI();
    this.assistant.pushAssistant("Applied. Undo is available (Ctrl+Z).");
    notify("AI changes applied.", "success");
  }

  async onCancelProposal() {
    if (!this._preview?.active) return;
    await this.editor.history.undo();
    this._clearPreviewUI();
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
   * "Save as template": turn the current canvas into a reusable layout.
   * The converter reads the RENDERED design and the result must clear the same
   * quality gate the template tests use — a layout that would overflow, collide
   * or fade is refused with the reasons rather than stored.
   */
  saveCurrentAsTemplate() {
    const design = this.editor.toDesign();
    if (!design?.elements?.length) {
      notify("Nothing to save yet — generate or draw a design first.", "error");
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
      let src;
      try {
        src = await fetchAssetDataUrl(photo.full);
      } catch (error) {
        console.warn("[photos] direct fetch failed, hotlinking:", error.message);
        this.editor.addImageElement(photo.full, 800, 600);
        this.assistant.pushAssistant(`Photo by ${photo.photographer || "Unknown"} on Unsplash (hotlinked — export may warn).`);
        notify("Photo hotlinked: PNG export may be blocked.", "error");
        return;
      }
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

  scheduleSave() {
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
      return `${this.state.title}\n${JSON.stringify(this.editor.toDesign())}`;
    } catch {
      return "";
    }
  }

  async persistNow() {
    if (!this.editor.canvas) return;
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
        const row = await projects.create({ title: this.state.title, design });
        this.projectId = row.id;
        try {
          window.history.replaceState(null, "", `#/design/${row.id}`);
        } catch {
          // non-fatal: hash stays at /design/new
        }
      } else {
        await projects.update(this.projectId, { title: this.state.title, design, thumbnail });
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