/**
 * ContextToolbar - floating Duplicate / Lock / Delete actions shown near
 * the current canvas selection (Goal 1 chrome).
 *
 * Positioned by App from editor coordinates; this class only renders the
 * pill and forwards clicks. Hidden whenever nothing is selected.
 */

export class ContextToolbar {
  /**
   * @param {HTMLElement} container
   * @param {Object} handlers
   * @param {() => void} handlers.onDuplicate
   * @param {() => void} handlers.onDelete
   * @param {() => void} handlers.onToggleLock
   * @param {() => void} handlers.onRemoveBackground
   */
  constructor(container, handlers) {
    this.handlers = handlers;
    this.container = container;
    this.container.classList.add("context-toolbar");
    this.container.hidden = true;
    this.container.innerHTML = `
      <button data-ctx="duplicate" class="ctx-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate"><i class="fa-solid fa-copy"></i></button>
      <button data-ctx="bgremove" class="ctx-btn" title="Remove background (images only)" aria-label="Remove background"><i class="fa-solid fa-eraser"></i></button>
      <button data-ctx="lock" class="ctx-btn" title="Lock/unlock" aria-label="Lock or unlock"><i class="fa-solid fa-lock-open"></i></button>
      <button data-ctx="delete" class="ctx-btn ctx-danger" title="Delete (Del)" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
    `;
    this.lockBtn = this.container.querySelector('[data-ctx="lock"]');
    this.bgBtn = this.container.querySelector('[data-ctx="bgremove"]');
    this.lockIcon = this.lockBtn.querySelector("svg, i");

    this.container.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-ctx]");
      if (!btn) return;
      const action = btn.dataset.ctx;
      if (action === "duplicate") this.handlers.onDuplicate();
      else if (action === "delete") this.handlers.onDelete();
      else if (action === "lock") this.handlers.onToggleLock();
      else if (action === "bgremove") this.handlers.onRemoveBackground();
    });
  }

  /**
   * @param {number} x viewport px (clamped into the window)
   * @param {number} y viewport px
   * @param {{locked?: boolean, isImage?: boolean}} [state]
   */
  show(x, y, state = {}) {
    const pad = 8;
    const w = 168;
    this.container.hidden = false;
    this.container.style.left = `${Math.min(Math.max(pad, x), window.innerWidth - w - pad)}px`;
    this.container.style.top = `${Math.max(pad, y)}px`;
    const icon = this.lockBtn.querySelector("svg, i");
    if (icon) icon.className = state.locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open";
    this.lockBtn.title = state.locked ? "Unlock" : "Lock";
    this.lockBtn.classList.toggle("ctx-active", Boolean(state.locked));
    this.bgBtn.hidden = !state.isImage;
  }

  hide() {
    this.container.hidden = true;
  }
}
