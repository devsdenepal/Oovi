/**
 * InsertPanel - manual design tools that need no AI generation:
 * drop text and shapes onto the canvas, pick the new-element color
 * and the canvas background. Works like general design tools —
 * everything stays editable via the existing toolbar/layers.
 */

export class InsertPanel {
  /**
   * @param {HTMLElement} container
   * @param {{onInsert?: (type: string, fill: string) => void, onImage?: (src: string, w: number, h: number) => void, onBackground?: (color: string) => void, onPhotoSearch?: (query: string) => Promise<Array>, onPhoto?: (photo: object) => void}} [handlers]
   */
  constructor(container, handlers = {}) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("insert-panel");
    this.container.innerHTML = `
      <div class="prop-section-name">Basics</div>
      <div class="insert-grid">
        <button data-insert="text" class="btn btn-light border" title="Add editable text (T)" aria-label="Add text"><i class="fa-solid fa-font"></i> Text</button>
        <button data-insert="rectangle" class="btn btn-light border" title="Add rectangle (R)" aria-label="Add rectangle"><i class="fa-solid fa-square"></i> Rect</button>
        <button data-insert="circle" class="btn btn-light border" title="Add circle (O)" aria-label="Add circle"><i class="fa-solid fa-circle"></i> Circle</button>
        <button data-insert="line" class="btn btn-light border" title="Add line (L)" aria-label="Add line"><i class="fa-solid fa-minus"></i> Line</button>
        <button data-insert="image" class="btn btn-light border" title="Upload a local image" aria-label="Upload image"><i class="fa-solid fa-image"></i> Image</button>
        <button data-focus-search class="btn btn-light border" title="Search free photos (P)" aria-label="Search photos"><i class="fa-solid fa-magnifying-glass"></i> Photo</button>
      </div>
      <input id="insert-file" type="file" accept="image/*" hidden />
      <div class="prop-section-name">Photos</div>
      <div class="insert-search-row">
        <input id="insert-search" type="text" placeholder="Search free photos" maxlength="60" autocomplete="off" aria-label="Search free photos" />
        <button id="insert-search-btn" class="btn btn-sm btn-light border" title="Search photos" aria-label="Search photos"><i class="fa-solid fa-magnifying-glass"></i></button>
      </div>
      <div class="insert-results" id="insert-results"></div>
      <div class="insert-photo-note">Photos by Unsplash</div>
      <details class="insert-defaults">
        <summary>Defaults</summary>
        <div class="insert-color-row">
          <label for="insert-fill">New element color</label>
          <input id="insert-fill" type="color" value="#4f46e5" />
        </div>
        <div class="insert-color-row">
          <label for="insert-bg">Canvas background</label>
          <input id="insert-bg" type="color" value="#f5f5f7" />
        </div>
      </details>
      <div class="insert-hint">Dropped at canvas center. Drag to move, double-click text to edit.</div>
    `;

    this.fillInput = this.container.querySelector("#insert-fill");
    this.bgInput = this.container.querySelector("#insert-bg");
    this.fileInput = this.container.querySelector("#insert-file");
    this.searchInput = this.container.querySelector("#insert-search");
    this.searchBtn = this.container.querySelector("#insert-search-btn");
    this.resultsEl = this.container.querySelector("#insert-results");

    this.container.addEventListener("click", (event) => {
      if (event.target.closest("[data-focus-search]")) {
        this.focusSearch();
        return;
      }
      const btn = event.target.closest("[data-insert]");
      if (!btn) return;
      this.insert(btn.dataset.insert);
    });

    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result || "");
        if (!src.startsWith("data:")) return;
        const probe = new Image();
        probe.onload = () => this.handlers.onImage?.(src, probe.naturalWidth, probe.naturalHeight);
        probe.src = src;
      };
      reader.readAsDataURL(file);
    });

    // "change" (not "input") so dragging the picker doesn't flood history.
    this.bgInput.addEventListener("change", () => {
      this.handlers.onBackground?.(this.bgInput.value);
    });

    const runSearch = async () => {
      const q = this.searchInput.value.trim();
      if (!q || !this.handlers.onPhotoSearch) return;
      this._lastQuery = q;
      this.searchBtn.disabled = true;
      this.resultsEl.innerHTML = `<div class="insert-skel"></div>`.repeat(6);
      try {
        this.showResults(await this.handlers.onPhotoSearch(q));
      } catch (error) {
        this.resultsEl.innerHTML = "";
        const msg = document.createElement("div");
        msg.className = "insert-hint insert-error";
        msg.textContent = `Couldn't reach Unsplash. `;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn btn-sm btn-light border";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => runSearch());
        msg.appendChild(retry);
        if (error?.message) {
          const detail = document.createElement("div");
          detail.textContent = error.message;
          msg.appendChild(detail);
        }
        this.resultsEl.appendChild(msg);
      } finally {
        this.searchBtn.disabled = false;
      }
    };
    this.searchBtn.addEventListener("click", runSearch);
    this.searchInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") runSearch();
    });
  }

  /** Programmatic insert (tool buttons and keyboard shortcuts share it). */
  insert(type) {
    if (type === "image") {
      this.fileInput.click();
      return;
    }
    this.handlers.onInsert?.(type, this.fillInput.value);
  }

  focusSearch() {
    this.searchInput.focus();
  }

  /** Renders photo thumbnails; click inserts the full image. */
  showResults(photos) {
    this.resultsEl.innerHTML = "";
    if (!photos || photos.length === 0) {
      this.resultsEl.innerHTML = `<div class="insert-hint">No photos found.</div>`;
      return;
    }
    for (const photo of photos) {
      const img = document.createElement("img");
      img.className = "insert-thumb";
      img.src = photo.thumb;
      img.alt = photo.alt || "Unsplash photo";
      img.title = `Photo by ${photo.photographer || "Unknown"}. Click to insert`;
      img.loading = "lazy";
      img.addEventListener("click", () => this.handlers.onPhoto?.(photo));
      this.resultsEl.appendChild(img);
    }
  }
}
