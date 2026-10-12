import { ELEMENT_SCHEMA, ELEMENT_TYPES } from "./designSchema";
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
      if (value < 0) {
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
  } else if (elements.length > 30) {
    errors.push("elements: at most 30 elements allowed");
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