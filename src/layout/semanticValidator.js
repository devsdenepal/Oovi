/**
 * Validator for the Semantic Design DSL.
 *
 * Lenient about optional styling, strict about structure: ids unique, types
 * known, container references exist, size tokens well-formed. Produces a
 * normalized SemanticDesign ready for the layout engine.
 */

import {
  SEMANTIC_ELEMENT_TYPES,
  DIRECTION_VALUES,
  JUSTIFY_VALUES,
  ALIGN_VALUES,
  FIT_VALUES,
  MAX_SEMANTIC_ELEMENTS,
} from "./semanticTypes";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isFinite(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validSizeToken(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "number") return isFinite(v) && v <= 4096;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "auto" || s === "fit-content" || s === "100%") return true;
    if (/^\d{1,3}%$/.test(s)) return true;
    return /^\d+$/.test(s);
  }
  return false;
}

function isValidColor(v) {
  if (typeof v !== "string") return false;
  return /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) || /^[a-zA-Z]+$/.test(v.trim()) || /^rgba?\(/.test(v.trim());
}

function normalizeBox(v) {
  if (typeof v === "number") return { top: v, right: v, bottom: v, left: v };
  if (v && typeof v === "object") {
    return {
      top: isFinite(v.top) ? v.top : 0,
      right: isFinite(v.right) ? v.right : 0,
      bottom: isFinite(v.bottom) ? v.bottom : 0,
      left: isFinite(v.left) ? v.left : 0,
    };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/**
 * @param {unknown} json
 * @returns {{ ok: true, semantic: import("./semanticTypes").SemanticDesign } | { ok: false, errors: string[] }}
 */
export function validateSemanticDesign(json) {
  const errors = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, errors: ["semantic design must be a JSON object"] };
  }

  // --- canvas ---
  let canvas;
  if (json.canvas !== undefined) {
    const c = json.canvas;
    if (!c || typeof c !== "object") {
      errors.push("canvas: must be an object");
    } else {
      const bad = { width: false, height: false };
      if (c.width !== undefined) {
        if (!isFinite(c.width) || c.width < 64 || c.width > 4096) {
          errors.push("canvas.width: must be a number 64..4096");
        }
      } else {
        bad.width = true;
      }
      if (c.height !== undefined) {
        if (!isFinite(c.height) || c.height < 64 || c.height > 4096) {
          errors.push("canvas.height: must be a number 64..4096");
        }
      } else {
        bad.height = true;
      }
      if (c.background !== undefined && !isValidColor(c.background)) {
        errors.push(`canvas.background: invalid color "${c.background}"`);
      }
      if (errors.length >= 0 && !bad.width && !bad.height) canvas = c;
    }
  }

  // --- containers ---
  const containerIds = new Set();
  let containers = [];
  if (json.containers !== undefined) {
    if (!Array.isArray(json.containers)) {
      errors.push("containers: must be an array");
    } else {
      json.containers.forEach((container, i) => {
        const path = `containers[${i}]`;
        if (!container || typeof container !== "object") {
          errors.push(`${path}: must be an object`);
          return;
        }
        if (!isNonEmptyString(container.id)) {
          errors.push(`${path}.id: required non-empty string`);
          return;
        }
        if (containerIds.has(container.id)) {
          errors.push(`${path}.id: duplicate container id "${container.id}"`);
        }
        containerIds.add(container.id);
        if (container.direction && !DIRECTION_VALUES.includes(container.direction)) {
          errors.push(`${path}.direction: must be one of ${DIRECTION_VALUES.join("|")}`);
        }
        if (container.justify && !JUSTIFY_VALUES.includes(container.justify)) {
          errors.push(`${path}.justify: must be one of ${JUSTIFY_VALUES.join("|")}`);
        }
        if (container.align && !ALIGN_VALUES.includes(container.align)) {
          errors.push(`${path}.align: must be one of ${ALIGN_VALUES.join("|")}`);
        }
        if (container.gap !== undefined && !isFinite(container.gap)) {
          errors.push(`${path}.gap: must be a number >= 0`);
        }
        if (!validSizeToken(container.width)) {
          errors.push(`${path}.width: invalid size token`);
        }
        if (!validSizeToken(container.height)) {
          errors.push(`${path}.height: invalid size token`);
        }
        if (container.children !== undefined && !Array.isArray(container.children)) {
          errors.push(`${path}.children: must be an array of ids`);
        }
      });
    }
    containers = json.containers.filter((c) => isNonEmptyString(c?.id));
  }

  // --- elements ---
  const elementIds = new Set();
  const elements = json.elements;
  if (!Array.isArray(elements)) {
    errors.push("elements: required array");
  } else if (elements.length === 0) {
    errors.push("elements: at least one element required");
  } else if (elements.length > MAX_SEMANTIC_ELEMENTS) {
    errors.push(`elements: at most ${MAX_SEMANTIC_ELEMENTS} elements allowed`);
  }

  const seenIds = new Set();
  let userIds = new Set();
  if (Array.isArray(elements)) {
    elements.forEach((el, i) => {
      const path = `elements[${i}]`;
      if (!el || typeof el !== "object" || Array.isArray(el)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      if (!isNonEmptyString(el.id)) {
        errors.push(`${path}.id: required non-empty string`);
      } else if (seenIds.has(el.id)) {
        errors.push(`${path}.id: duplicate id "${el.id}"`);
      } else {
        seenIds.add(el.id);
      }

      if (!SEMANTIC_ELEMENT_TYPES.includes(el.type)) {
        errors.push(`${path}.type: must be one of ${SEMANTIC_ELEMENT_TYPES.join(", ")}`);
        return;
      }

      if (el.container !== undefined && el.container !== "root" && !containerIds.has(el.container)) {
        errors.push(`${path}.container: unknown container "${el.container}"`);
      }
      if (!validSizeToken(el.width)) {
        errors.push(`${path}.width: invalid size token`);
      }
      if (!validSizeToken(el.height)) {
        errors.push(`${path}.height: invalid size token`);
      }
      if (el.align !== undefined && !ALIGN_VALUES.includes(el.align)) {
        errors.push(`${path}.align: must be one of ${ALIGN_VALUES.join("|")}`);
      }
      if (el.gap !== undefined && !isFinite(el.gap)) {
        errors.push(`${path}.gap: must be a number >= 0`);
      }
      if (el.margin !== undefined && !isFinite(el.margin) && typeof el.margin !== "object") {
        errors.push(`${path}.margin: must be a number or box object`);
      }
      if (el.fit !== undefined && !FIT_VALUES.includes(el.fit)) {
        errors.push(`${path}.fit: must be "cover" or "contain"`);
      }
      if ((el.type === "text" || el.type === "button") && !isNonEmptyString(el.content)) {
        errors.push(`${path}.content: required for type "${el.type}"`);
      }
      if (el.style && typeof el.style === "object") {
        if (el.style.color !== undefined && !isValidColor(el.style.color)) {
          errors.push(`${path}.style.color: invalid color`);
        }
        if (el.style.fill !== undefined && !isValidColor(el.style.fill)) {
          errors.push(`${path}.style.fill: invalid color`);
        }
      }
      userIds.add(el.id);
    });
  }

  // container children references
  for (const c of containers) {
    for (const childRef of c.children || []) {
      if (childRef !== "root" && !seenIds.has(childRef) && !containerIds.has(childRef)) {
        errors.push(`containers.${c.id}.children: unknown id "${childRef}"`);
      }
    }
    userIds.delete(c.id);
    seenIds.add(c.id);
  }

  if (errors.length) {
    return { ok: false, errors: [...new Set(errors)] };
  }

  // --- normalize ---
  const elementFields = new Set([
    "id", "type", "role", "container", "width", "height", "align", "margin",
    "gap", "content", "fit", "style", "x", "y", "children",
  ]);
  const containerFields = new Set([
    "id", "direction", "justify", "align", "gap", "padding", "margin",
    "width", "height", "children",
  ]);

  return {
    ok: true,
    semantic: {
      ...(json.canvas ? { canvas: json.canvas } : {}),
      ...(json.layout && typeof json.layout === "object"
        ? { layout: { ...json.layout } }
        : {}),
      containers: containers.map((c) => {
        const out = { children: Array.isArray(c.children) ? c.children : [] };
        for (const key of containerFields) {
          if (key !== "children" && c[key] !== undefined) {
            out[key] = typeof c[key] === "object" && c[key] !== null ? { ...c[key] } : c[key];
          }
        }
        out.padding = normalizeBox(c.padding);
        out.margin = normalizeBox(c.margin);
        return out;
      }),
      elements: elements.map((el) => {
        const out = {};
        for (const key of elementFields) {
          if (el[key] === undefined) continue;
          out[key] = el[key] && typeof el[key] === "object" ? { ...el[key] } : el[key];
        }
        return out;
      }),
    },
  };
}