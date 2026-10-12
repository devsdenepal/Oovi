/**
 * Route parsing (hash routes, no dependency).
 *   #/                → home dashboard
 *   #/design/new      → editor, fresh unsaved canvas
 *   #/design/<uuid>   → editor, loads the project from the backend
 */
export function parseRoute() {
  const hash = (typeof location !== "undefined" && location.hash) || "#/";
  const match = hash.match(/^#\/design\/([A-Za-z0-9-]+)\/?$/);
  if (match) {
    return { view: "editor", id: match[1] === "new" ? null : match[1] };
  }
  return { view: "home" };
}

export function editorUrl(id) {
  return `#/design/${id}`;
}
