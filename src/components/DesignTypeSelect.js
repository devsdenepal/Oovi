/**
 * DesignTypeSelect - picks the design format; the preview canvas is
 * restricted to the preset's fixed dimensions.
 */

export class DesignTypeSelect {
  /**
   * @param {HTMLElement} container
   * @param {{presets: Array<{id:string,label:string,width:number,height:number}>, defaultId?: string, onChange?: (id: string) => void}} [handlers]
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.presets = handlers.presets || [];
    this.onChange = handlers.onChange;
    this.value = handlers.defaultId || this.presets[0]?.id;

    this.container.classList.add("designtype-select");
    this.container.innerHTML = `
      <label class="designtype-label" for="designtype-input"><i class="fa-solid fa-crop-simple"></i> Size</label>
      <select id="designtype-input" class="form-select form-select-sm">
        ${this.presets
          .map(
            (p) =>
              `<option value="${p.id}"${p.id === this.value ? " selected" : ""}>${p.label} · ${p.width} × ${p.height}</option>`,
          )
          .join("")}
      </select>
    `;
    this.select = this.container.querySelector("#designtype-input");
    this.select.addEventListener("change", () => {
      this.value = this.select.value;
      if (this.onChange) this.onChange(this.value);
    });
  }
}
