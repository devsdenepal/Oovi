/**
 * Layers panel - a DOM list rendered from the editor's layer stack.
 *
 * Clicking a layer selects the corresponding Fabric object.
 * The panel is refreshed by the editor on every selection/mutation event.
 */

export class LayersPanel {
  /**
   * @param {HTMLElement} container
   * @param {(id: string) => void} onSelect
   */
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.container.classList.add("layers-panel");
    this.container.innerHTML = '<div class="panel-title">Layers</div><ul class="layers-list"></ul>';
    this.listEl = this.container.querySelector(".layers-list");
  }

  /**
   * @param {fabric.Object[]} objects top-most first
   * @param {Set<string>} activeIds
   */
  render(objects, activeIds) {
    this.listEl.innerHTML = "";

    if (objects.length === 0) {
      const empty = document.createElement("li");
      empty.className = "layer-empty";
      empty.textContent = "Nothing on canvas yet";
      this.listEl.appendChild(empty);
      return;
    }

    for (const obj of objects) {
      const li = document.createElement("li");
      li.className = "layer-item";
      if (activeIds.has(obj.designId)) li.classList.add("active");

      const icon = document.createElement("span");
      icon.className = "layer-icon";
      icon.textContent = layerIcon(obj.elementType || obj.type);

      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent =
        typeof obj.designId === "string" ? obj.designId : (obj.elementType || obj.type);

      li.appendChild(icon);
      li.appendChild(name);
      li.addEventListener("click", () => {
        this.onSelect(obj.designId);
      });
      li.addEventListener("dblclick", () => this.onSelect(obj.designId));
      this.listEl.appendChild(li);
    }
  }
}

function layerIcon(type) {
  switch (type) {
    case "text":
      return "T";
    case "rectangle":
      return "▭";
    case "circle":
      return "◯";
    case "line":
      return "/";
    case "group":
      return "⊞";
    default:
      return "◈";
  }
}