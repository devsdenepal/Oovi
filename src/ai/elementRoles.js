/**
 * Normalise the optional `role` on a generated element.
 *
 * The 270m model sometimes invents roles such as "hidden" or writes a palette
 * role ("textPrimary") into the element role. Those values are semantic noise:
 * they do not hide anything, but they make later colour passes and the saved
 * design confusing. Component roles are the authority; unknown element roles
 * are replaced with the role of the region that owns them.
 */

const ELEMENT_ROLES = new Set([
  "header",
  "brand",
  "headline",
  "hero",
  "tagline",
  "details",
  "sections",
  "audience",
  "footer",
  "decoration",
  "cta",
  "button",
  "body",
  "label",
  "caption",
  "quote",
  "attribution",
  "source",
  "image",
  "background",
]);

const ROLE_ALIASES = {
  title: "headline",
  "main title": "headline",
  subtitle: "tagline",
  subhead: "tagline",
  kicker: "header",
  eyebrow: "header",
  logo: "header",
  text: "body",
  copy: "body",
  paragraph: "body",
  "body copy": "body",
  link: "cta",
  action: "cta",
  attribution: "attribution",
  source: "source",
  credit: "source",
  quote: "quote",
  "quote text": "quote",
  label: "label",
  badge: "label",
};

/** One role, or the owning region's role when the value is unknown/empty. */
export function normalizeElementRole(role, fallback = "body") {
  const base = ELEMENT_ROLES.has(String(fallback || "").toLowerCase())
    ? String(fallback).toLowerCase()
    : "body";
  const raw = String(role || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!raw) return base;
  if (ELEMENT_ROLES.has(raw)) return raw;
  return ROLE_ALIASES[raw] || base;
}

/**
 * Recursively normalise roles, including group children. Returns the original
 * array when every role is already valid, so callers can cheaply detect a
 * no-op.
 */
export function normalizeElementRoles(elements, fallback = "body") {
  if (!Array.isArray(elements)) return elements;
  let changed = false;
  const walk = (list) =>
    list.map((element) => {
      if (!element || typeof element !== "object") return element;
      let next = element;
      const role = normalizeElementRole(element.role, fallback);
      if (role !== element.role) {
        next = { ...element, role };
        changed = true;
      }
      if (element.type === "group" && Array.isArray(element.children)) {
        const children = walk(element.children);
        if (children !== element.children) {
          next = { ...next, children };
          changed = true;
        }
      }
      return next;
    });
  const out = walk(elements);
  return changed ? out : elements;
}

export const ELEMENT_ROLE_NAMES = [...ELEMENT_ROLES];
