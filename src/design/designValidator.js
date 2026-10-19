import { ELEMENT_SCHEMA, ELEMENT_TYPES, MAX_ELEMENTS } from "./designSchema";
import { DESIGN_VERSION } from "./designTypes";

/**
 * Validator for Design JSON.
 *
 * Strategy: be strict about structure and required fields, lenient about
 * optional styling fields. Unknown fields are dropped during normalization
 * so the renderer never has to guess.
 *
 * validate() returns { ok: true, design } or { ok: false, errors: string[] }.
 */

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validColor(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return true;
  if (/^rgba?\([\d\s.,%]+\)$/.test(trimmed)) return true;
  return /^[a-zA-Z]+$/.test(trimmed);
}

/**
 * Gradient descriptor shape (fractions 0-1 across the bbox):
 * linear {type,x1,y1,x2,y2,stops} or radial {type,cx,cy,r,stops},
 * stops = [{offset 0-1, color}...].
 */
function validGradient(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.type !== "linear" && value.type !== "radial") return false;
  const nums =
    value.type === "linear"
      ? [value.x1, value.y1, value.x2, value.y2]
      : [value.cx, value.cy, value.r];
  if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  if (!Array.isArray(value.stops) || value.stops.length === 0) return false;
  return value.stops.every(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof s.offset === "number" &&
      s.offset >= 0 &&
      s.offset <= 1 &&
      validColor(s.color),
  );
}

function validateElement(element, path, errors) {
  if (!element || typeof element !== "object" || Array.isArray(element)) {
    errors.push(`${path}: expected an object`);
    return false;
  }

  const id = element.id;
  if (!isNonEmptyString(id)) {
    errors.push(`${path}.id: required non-empty string`);
  }

  const type = element.type;
  if (!ELEMENT_TYPES.includes(type)) {
    errors.push(`${path}.type: must be one of ${ELEMENT_TYPES.join(", ")}`);
    return false;
  }

  const schema = ELEMENT_SCHEMA[type];
  for (const field of schema.required) {
    const value = element[field];

    if (field === "children") {
      if (!Array.isArray(value) || value.length === 0) {
        errors.push(`${path}.children: required non-empty array`);
      }
      continue;
    }

    if (typeof value === "string") {
      if (!isNonEmptyString(value) && field !== "fill" && field !== "stroke") {
        errors.push(`${path}.${field}: required non-empty string`);
      } else if (field === "fill" || field === "stroke") {
        if (!validColor(value)) {
          errors.push(`${path}.${field}: invalid color "${value}"`);
        }
      }
    } else if (isFiniteNumber(value)) {
      // Positions (x/y/x2/y2) may be ANY finite number: top-level objects
      // can sit partially off-canvas, and group children live in
      // group-relative coords (routinely negative left/above the group
      // origin). Both save fine, so open must accept them — rejecting
      // them bricks saved projects. Sizes stay non-negative everywhere.
      const isPosition = field === "x" || field === "y" || field === "x2" || field === "y2";
      if (value < 0 && !isPosition) {
        errors.push(`${path}.${field}: must be >= 0`);
      }
    } else {
      errors.push(`${path}.${field}: required number or string`);
    }
  }

  // Font size sanity: prevents absurd values that break the renderer.
  if (type === "text" && isFiniteNumber(element.fontSize)) {
    if (element.fontSize > 400) {
      errors.push(`${path}.fontSize: must be <= 400`);
    }
  }

  // Gradient overlay (optional): validated strictly, rendered by fabric.
  // Strict-schema providers emit explicit nulls — default them here so the
  // shape check sees effective values (normalizeElement persists the same
  // defaults downstream).
  if (element.gradient !== undefined) {
    const raw = element.gradient && typeof element.gradient === "object" ? element.gradient : {};
    const d = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
    const g = { ...raw };
    if (g.type === "linear") {
      g.x1 = d(g.x1, 0); g.y1 = d(g.y1, 0); g.x2 = d(g.x2, 1); g.y2 = d(g.y2, 0);
    } else if (g.type === "radial") {
      g.cx = d(g.cx, 0.5); g.cy = d(g.cy, 0.5); g.r = d(g.r, 0.5);
    }
    if (!validGradient(g)) {
      errors.push(`${path}.gradient: expected {type:linear|radial, coords, stops:[{offset,color}]}`);
    } else if (type !== "text" && type !== "rectangle" && type !== "circle") {
      errors.push(`${path}.gradient: only text, rectangle and circle support gradients`);
    }
  }

  return true;
}

/**
 * Drop unknown/optional fields so the downstream renderer sees a clean shape.
 */
function normalizeElement(element) {
  const type = element.type;
  const known = new Set([
    "id",
    "type",
    "role",
    "x",
    "y",
    "width",
    "height",
    "fill",
    "gradient",
    "stroke",
    "strokeWidth",
    "content",
    "fontSize",
    "fontWeight",
    "textAlign",
    "lineHeight",
    "fontFamily",
    "cornerRadius",
    "radius",
    "fontFamily",
    "charSpacing",
    "src",
    "visible",
    "locked",
    "x2",
    "y2",
    "angle",
    "opacity",
    "children",
  ]);
  const normalized = {};
  for (const key of Object.keys(element)) {
    if (known.has(key)) normalized[key] = element[key];
  }
  // Strict-schema providers emit explicit nulls for omitted optionals —
  // drop them so missing-field defaults apply instead of type errors.
  for (const key of Object.keys(normalized)) {
    if (normalized[key] === null) delete normalized[key];
  }
  // Persist effective gradient coords (strict-mode nulls become defaults).
  if (normalized.gradient && typeof normalized.gradient === "object") {
    const g = { ...normalized.gradient };
    const d = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
    if (g.type === "linear") {
      g.x1 = d(g.x1, 0); g.y1 = d(g.y1, 0); g.x2 = d(g.x2, 1); g.y2 = d(g.y2, 0);
      delete g.cx; delete g.cy; delete g.r;
    } else if (g.type === "radial") {
      g.cx = d(g.cx, 0.5); g.cy = d(g.cy, 0.5); g.r = d(g.r, 0.5);
      delete g.x1; delete g.y1; delete g.x2; delete g.y2;
    }
    if (Array.isArray(g.stops)) {
      g.stops = g.stops
        .filter((s) => s && typeof s === "object")
        .map((s) => ({ offset: s.offset, color: s.color }));
    }
    normalized.gradient = g;
  }
  if (normalized.fontWeight === undefined) normalized.fontWeight = 400;
  if (normalized.opacity === undefined) normalized.opacity = 1;
  if (normalized.angle === undefined) normalized.angle = 0;
  return normalized;
}

/**
 * Validate (and lightly normalize) a Design JSON object.
 * @param {unknown} json
 * @returns {{ ok: true, design: import("./designTypes").Design } | { ok: false, errors: string[] }}
 */
export function validateDesign(json) {
  const errors = [];

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, errors: ["design must be a JSON object"] };
  }

  const data = json;

  // --- canvas ---
  const canvas = data.canvas || {};
  if (typeof canvas.width !== "number" || !isFiniteNumber(canvas.width)) {
    errors.push("canvas.width: required finite number");
  } else if (canvas.width < 64 || canvas.width > 4096) {
    errors.push("canvas.width: must be between 64 and 4096");
  }
  if (typeof canvas.height !== "number" || !isFiniteNumber(canvas.height)) {
    errors.push("canvas.height: required finite number");
  } else if (canvas.height < 64 || canvas.height > 4096) {
    errors.push("canvas.height: must be between 64 and 4096");
  }
  if (canvas.background !== undefined && !validColor(canvas.background)) {
    errors.push(`canvas.background: invalid color "${canvas.background}"`);
  }

  // --- elements ---
  const elements = data.elements;
  if (!Array.isArray(elements)) {
    errors.push("elements: required array");
  } else if (elements.length === 0) {
    errors.push("elements: at least one element required");
  } else if (elements.length > MAX_ELEMENTS) {
    errors.push(`elements: at most ${MAX_ELEMENTS} elements allowed`);
  }

  const seenIds = new Set();
  if (Array.isArray(elements)) {
    elements.forEach((element, index) => {
      const valid = validateElement(element, `elements[${index}]`, errors);
      if (!valid) return;

      const id = element.id;
      if (seenIds.has(id)) {
        errors.push(`elements[${index}].id: duplicate id "${id}"`);
      }
      seenIds.add(id);

      if (element.type === "group" && Array.isArray(element.children)) {
        element.children.forEach((child, childIndex) => {
          validateElement(child, `elements[${index}].children[${childIndex}]`, errors);
          if (isNonEmptyString(child?.id)) seenIds.add(child.id);
        });
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Normalize to a clean design.
  const normalized = {
    version: DESIGN_VERSION,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      background: canvas.background || "#FFFFFF",
    },
    elements: elements.map(normalizeElement),
  };

  return { ok: true, design: normalized };
}