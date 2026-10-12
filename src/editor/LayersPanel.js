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
   * @param {Array<{obj: fabric.Object, depth: number}>} items top-most first
   *        at each nesting level; group children follow their parent group
   * @param {Set<string>} activeIds
   */
  render(items, activeIds) {
    this.listEl.innerHTML = "";

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "layer-empty";
      empty.textContent = "Nothing on canvas yet";
      this.listEl.appendChild(empty);
      return;
    }

    for (const { obj, depth } of items) {
      const li = document.createElement("li");
      li.className = "layer-item";
      if (activeIds.has(obj.designId)) li.classList.add("active");
      li.style.paddingLeft = `${8 + depth * 16}px`;

      const icon = document.createElement("span");
      icon.className = "layer-icon";
      icon.innerHTML = `<i class="${layerIcon(obj.elementType || obj.type)}"></i>`;

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
      return "fa-solid fa-font";
    case "rectangle":
      return "fa-solid fa-square";
    case "circle":
      return "fa-solid fa-circle";
    case "line":
      return "fa-solid fa-minus";
    case "group":
      return "fa-solid fa-object-group";
    default:
      return "fa-solid fa-shapes";
  }
}