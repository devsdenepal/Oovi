import { analyzeReferenceImage } from "../reference/analyzeReference";

/**
 * ReferenceUpload - lets the user attach an inspiration image. The image is
 * analyzed locally (colors, layout, text regions, shapes, decorations, OCR)
 * into a ReferenceDesignAnalysis that the semantic pipeline borrows from.
 *
 * The raw image is never sent to the text LLM - only the analysis is.
 */

export class ReferenceUpload {
  /**
   * @param {HTMLElement} container
   * @param {{onAnalysis: (analysis: import("../reference/analysisTypes").ReferenceDesignAnalysis) => void}} [handlers]
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.onAnalysis = handlers.onAnalysis;
    this.currentAnalysis = null;
    this.fileName = null;

    this.container.classList.add("reference-upload");
    this.container.innerHTML = `
      <label class="panel-title" for="reference-file">Reference design <span class="muted">(optional)</span></label>
      <label class="file-drop" for="reference-file">Choose an inspiration image…</label>
      <input id="reference-file" type="file" accept="image/*" hidden />
      <div class="reference-status"></div>
    `;
    this.fileInput = this.container.querySelector("#reference-file");
    this.status = this.container.querySelector(".reference-status");

    this.fileInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) this.loadFile(file);
      this.fileInput.value = "";
    });
  }

  get hasAnalysis() {
    return Boolean(this.currentAnalysis);
  }

  get influenceEmoji() {
    return this.currentAnalysis ? " ✓" : "";
  }

  _setStatus(message, kind = "") {
    this.status.textContent = message;
    this.status.className = `reference-status${kind ? ` reference-status-${kind}` : ""}`;
  }

  async loadFile(file) {
    this._setStatus(`Analyzing “${file.name}”…`, "loading");
    try {
      const analysis = await analyzeReferenceImage(file, { runOcr: true });
      this.currentAnalysis = analysis;
      this.fileName = file.name;
      this._setStatus(
        `Analyzed ${file.name}: ${analysis.layout.type.replace(/_/g, " ")} layout, accent ${analysis.palette.accent}.`,
        "success",
      );
      if (this.onAnalysis) this.onAnalysis(analysis);
    } catch (error) {
      this._setStatus(`Analysis failed: ${error.message}`, "error");
      console.error(error);
    }
  }

  clear() {
    this.currentAnalysis = null;
    this.fileName = null;
    this._setStatus("");
  }
}