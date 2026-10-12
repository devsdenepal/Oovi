/**
 * GenerateButton - triggers the AI generation pipeline and shows loading state.
 */

export class GenerateButton {
  /**
   * @param {HTMLElement} container
   * @param {() => void} onClick
   */
  constructor(container, onClick) {
    this.container = container;
    this.container.classList.add("generate-button");
    this.container.innerHTML = `
      <button id="generate-btn" class="btn btn-primary btn-lg">Generate Design</button>
      <div id="gen-status" class="gen-status"></div>
    `;
    this.button = this.container.querySelector("#generate-btn");
    this.status = this.container.querySelector("#gen-status");
    this.button.addEventListener("click", onClick);
  }

  setLoading(loading, message = "Thinking about a layout…") {
    this.button.disabled = loading;
    this.button.textContent = loading ? "Generating…" : "Generate Design";
    if (loading) {
      this.status.textContent = message;
      this.status.className = "gen-status gen-status-loading";
    }
  }

  setError(message) {
    this.button.disabled = false;
    this.button.textContent = "Generate Design";
    this.status.textContent = message;
    this.status.className = "gen-status gen-status-error";
  }

  setSuccess(message) {
    this.button.disabled = false;
    this.button.textContent = "Regenerate Design";
    this.status.textContent = message;
    this.status.className = "gen-status gen-status-success";
  }

  setStatus(message, kind = "") {
    this.status.textContent = message;
    this.status.className = `gen-status${kind ? ` gen-status-${kind}` : ""}`;
  }
}