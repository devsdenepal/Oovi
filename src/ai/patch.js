/**
 * AI patch protocol (Goal 4).
 *
 * The assistant returns a PATCH, not a full design:
 *   { ops: [...] }
 *   update   { op:"update", id, props:{ fontSize: 72 } }   changed props only
 *   add      { op:"add", element:{...} }                   full DSL element
 *   remove   { op:"remove", id }
 *   move     { op:"move", id, to:"front"|"forward"|"backward"|"back" }
 *
 * validatePatch() checks every op against the live design (unknown ids,
 * locked objects, numeric bounds, add-element schema via validateDesign).
 * Invalid ops are reported, never applied; valid ones flow through.
 */

import { validateDesign } from "../design/designValidator";

const MAX_OPS = 20;
const UPDATE_KEYS = new Set([
  "x", "y", "width", "height", "radius", "angle", "opacity",
  "content", "fontSize", "fontWeight", "fontFamily", "textAlign",
  "lineHeight", "charSpacing", "fill", "stroke", "strokeWidth",
  "cornerRadius", "background",
]);
const MOVE_DIRS = new Set(["front", "forward", "backward", "back"]);

function collectIds(elements, top = true, out = { all: new Set(), top: new Set(), locked: new Set() }) {
  for (const el of elements || []) {
    if (!el || typeof el.id !== "string") continue;
    out.all.add(el.id);
    if (top) out.top.add(el.id);
    if (el.locked === true) out.locked.add(el.id);
    if (Array.isArray(el.children)) collectIds(el.children, false, out);
  }
  return out;
}

function isGoodNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function checkProps(props, canvas, errors, prefix) {
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    errors.push(`${prefix}: props must be an object`);
    return false;
  }
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (!UPDATE_KEYS.has(key)) {
      errors.push(`${prefix}: unknown prop "${key}"`);
      return false;
    }
    if (key === "content" || key === "fontFamily" || key === "textAlign" || key === "fill" || key === "stroke" || key === "background") {
      if (typeof v !== "string" || v.trim() === "") {
        errors.push(`${prefix}: prop "${key}" must be a non-empty string`);
        return false;
      }
    } else if (key === "fontWeight") {
      if (!isGoodNumber(v)) {
        errors.push(`${prefix}: prop "${key}" must be a number`);
        return false;
      }
    } else {
      if (!isGoodNumber(v)) {
        errors.push(`${prefix}: prop "${key}" must be a number`);
        return false;
      }
      // Positions accept any finite number: top-level objects may sit
      // partially off-canvas and nested children are group-relative
      // (negative is routine). Sizes stay bounded below.
      if ((key === "width" || key === "height" || key === "radius") && v <= 0) {
        errors.push(`${prefix}: prop "${key}" must be > 0`);
        return false;
      }
      if (key === "opacity" && (v < 0 || v > 1)) {
        errors.push(`${prefix}: opacity must be 0..1`);
        return false;
      }
      if (key === "fontSize" && (v < 4 || v > 400)) {
        errors.push(`${prefix}: fontSize must be 4..400`);
        return false;
      }
      if (key === "width" && canvas && v > canvas.width) {
        errors.push(`${prefix}: width exceeds canvas (${canvas.width})`);
        return false;
      }
      if (key === "height" && canvas && v > canvas.height) {
        errors.push(`${prefix}: height exceeds canvas (${canvas.height})`);
        return false;
      }
    }
  }
  return true;
}

/**
 * @param {unknown} patch
 * @param {import("../design/designTypes").Design} design current live design
 * @returns {{ops: Array, errors: string[]}} valid ops + reasons for rejects
 */
export function validatePatch(patch, design) {
  const errors = [];
  const ops = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ops, errors: ["patch must be an object with an ops array"] };
  }
  const list = patch.ops;
  if (!Array.isArray(list) || list.length === 0) {
    return { ops, errors: ["patch.ops must be a non-empty array"] };
  }
  if (list.length > MAX_OPS) {
    return { ops, errors: [`patch limited to ${MAX_OPS} ops`] };
  }
  const ids = collectIds(design?.elements);
  const canvas = design?.canvas;

  list.forEach((raw, i) => {
    const prefix = `ops[${i}]`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    if (raw.op === "update") {
      if (typeof raw.id !== "string" || !ids.all.has(raw.id)) {
        errors.push(`${prefix}: unknown id "${raw.id}"`);
        return;
      }
      if (ids.locked.has(raw.id)) {
        errors.push(`${prefix}: "${raw.id}" is locked`);
        return;
      }
      if (!checkProps(raw.props, canvas, errors, prefix)) return;
      ops.push({ op: "update", id: raw.id, props: { ...raw.props } });
    } else if (raw.op === "add") {
      const check = validateDesign({ canvas, elements: [raw.element] });
      if (!check.ok) {
        errors.push(`${prefix}: invalid element (${check.errors.slice(0, 2).join("; ")})`);
        return;
      }
      const el = check.design.elements[0];
      if (ids.all.has(el.id)) {
        errors.push(`${prefix}: duplicate id "${el.id}"`);
        return;
      }
      ops.push({ op: "add", element: el });
    } else if (raw.op === "remove") {
      if (typeof raw.id !== "string" || !ids.all.has(raw.id)) {
        errors.push(`${prefix}: unknown id "${raw.id}"`);
        return;
      }
      if (ids.locked.has(raw.id)) {
        errors.push(`${prefix}: "${raw.id}" is locked`);
        return;
      }
      if (!ids.top.has(raw.id)) {
        errors.push(`${prefix}: "${raw.id}" is nested; only top-level remove`);
        return;
      }
      ops.push({ op: "remove", id: raw.id });
    } else if (raw.op === "move") {
      if (typeof raw.id !== "string" || !ids.top.has(raw.id)) {
        errors.push(`${prefix}: unknown top-level id "${raw.id}"`);
        return;
      }
      if (ids.locked.has(raw.id)) {
        errors.push(`${prefix}: "${raw.id}" is locked`);
        return;
      }
      if (!MOVE_DIRS.has(raw.to)) {
        errors.push(`${prefix}: to must be front|forward|backward|back`);
        return;
      }
      ops.push({ op: "move", id: raw.id, to: raw.to });
    } else {
      errors.push(`${prefix}: unknown op "${raw.op}"`);
    }
  });

  return { ops, errors };
}
