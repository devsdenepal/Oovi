/**
 * toasts — Bootstrap toast notifications (interface layer only).
 *
 * Isolation contract: imports nothing from ai/editor/app. App-layer code
 * fires updates via notify(); this module only touches toast DOM.
 */

const MAX_TOASTS = 4;
const AUTO_HIDE_MS = 4500;

let zone = null;

export function initToasts() {
  if (zone) return;
  zone = document.createElement("div");
  zone.id = "toast-zone";
  zone.className = "toast-container position-fixed bottom-0 end-0 p-3";
  zone.setAttribute("aria-live", "polite");
  document.body.appendChild(zone);
}

/**
 * @param {string} message
 * @param {"info"|"success"|"error"} [kind]
 */
export function notify(message, kind = "info") {
  if (!zone) initToasts();
  while (zone.children.length >= MAX_TOASTS) zone.firstChild.remove();

  const icon =
    kind === "success"
      ? "fa-solid fa-circle-check"
      : kind === "error"
        ? "fa-solid fa-circle-exclamation"
        : "fa-solid fa-circle-info";

  const el = document.createElement("div");
  el.className = `toast show studio-toast studio-toast-${kind}`;
  el.setAttribute("role", "status");
  el.innerHTML = `
    <div class="toast-body d-flex align-items-start gap-2">
      <i class="${icon} mt-1"></i>
      <span class="flex-grow-1"></span>
      <button type="button" class="btn-close" aria-label="Close"></button>
    </div>`;
  el.querySelector("span").textContent = message;
  el.querySelector(".btn-close").addEventListener("click", () => el.remove());
  zone.appendChild(el);
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 200);
  }, AUTO_HIDE_MS);
}
