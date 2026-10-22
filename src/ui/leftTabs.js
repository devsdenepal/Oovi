/**
 * leftTabs | ONE left sidebar tab controller (Goal 1 chrome).
 *
 * Replaces the old icon-rail + accordion duplication: tab buttons
 * `[data-ltab]` switch panels `[data-lpanel]`. Pure DOM, no imports |
 * the handle is created in main.js and handed to App for view shortcuts.
 *
 * @param {{initial?: string}} [options] tab to open first (defaults to Insert)
 * @returns {{set: (id: string) => void, current: () => string}}
 */
export function initLeftTabs(options = {}) {
  const buttons = [...document.querySelectorAll("[data-ltab]")];
  const panels = [...document.querySelectorAll("[data-lpanel]")];
  let active = options.initial || "insert";

  function set(id) {
    if (!panels.some((p) => p.dataset.lpanel === id)) return;
    active = id;
    buttons.forEach((b) => {
      const on = b.dataset.ltab === id;
      b.classList.toggle("left-tab-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    panels.forEach((p) => {
      p.hidden = p.dataset.lpanel !== id;
    });
  }

  buttons.forEach((b) => b.addEventListener("click", () => set(b.dataset.ltab)));
  set(active);
  return { set, current: () => active };
}
