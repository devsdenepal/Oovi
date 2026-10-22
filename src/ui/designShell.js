/**
 * designShell | PURE INTERFACE LAYER (chrome helpers).
 *
 * Isolation contract: this module must never import from
 * ../ai, ../editor, ../renderer, ../layout, ../reference, ../design,
 * or ../app. Small DOM helpers shared by chrome code live here.
 */

/**
 * Flash a panel to draw attention (used for view shortcuts).
 * @param {HTMLElement|null} el
 */
export function flashElement(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 900);
}
