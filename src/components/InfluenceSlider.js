/**
 * InfluenceSlider - 0..1 control for how strongly the generated design should
 * follow the reference design. 0 ignores the reference entirely; higher
 * values borrow its layout, palette and type scale more closely.
 */

export class InfluenceSlider {
  /**
   * @param {HTMLElement} container
   * @param {{defaultValue?: number, onChange?: (value: number) => void}} [handlers]
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.onChange = handlers.onChange;
    this.value = Number(handlers.defaultValue ?? 0.8);

    this.container.classList.add("influence-slider");
    this.container.innerHTML = `
      <label class="panel-title" for="influence-range">Reference influence</label>
      <div class="influence-row">
        <input id="influence-range" type="range" min="0" max="1" step="0.05" value="${this.value}" />
        <span class="influence-label">${this._label(this.value)}</span>
      </div>
    `;
    this.input = this.container.querySelector("#influence-range");
    this.label = this.container.querySelector(".influence-label");

    this.input.addEventListener("input", () => {
      this.value = Number(this.input.value);
      this.label.textContent = this._label(this.value);
      if (this.onChange) this.onChange(this.value);
    });
  }

  _label(value) {
    if (value === 0) return "ignore";
    if (value <= 0.2) return "hint";
    if (value <= 0.5) return "strongly follow";
    if (value <= 0.8) return "follow closely";
    return "reproduce";
  }

  reset() {
    this.value = Number(this.input.value = 0.8);
    this.label.textContent = this._label(this.value);
  }
}