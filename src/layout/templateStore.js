/**
 * Saved-template store (Phase 3, step 5).
 *
 * A template carries a `build` function, so it cannot be serialised as-is.
 * Records are plain data (the instantiated slots plus metadata); this module
 * is the only place that knows how to persist and rehydrate them.
 *
 * Storage is localStorage | the app has no server-side document store for
 * templates, and a saved layout is only as useful as the browser it was saved
 * from. Every read is defensive: a corrupt or hand-edited record is skipped
 * rather than allowed to break the library.
 */

import { templateFromRecord, templateToRecord } from "./saveAsTemplate";

const KEY = "oovi.savedTemplates.v1";

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** @returns {Array} raw records, newest first. */
export function listSavedTemplateRecords() {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

/** @returns {Array} usable templates (with build functions). */
export function listSavedTemplates() {
  return listSavedTemplateRecords()
    .map(templateFromRecord)
    .filter(Boolean);
}

/**
 * Persist a template, replacing any record with the same id.
 * @param {object} template a template (as returned by templateFromDesign)
 * @returns {{ok:boolean, reason?:string, count:number}}
 */
export function saveTemplate(template) {
  const store = storage();
  if (!store) return { ok: false, reason: "this browser has no storage available", count: 0 };
  if (!template || !template.id) return { ok: false, reason: "not a template", count: 0 };
  const record = templateToRecord(template);
  const records = listSavedTemplateRecords().filter((r) => r.id !== record.id);
  records.unshift(record);
  try {
    store.setItem(KEY, JSON.stringify(records));
  } catch (error) {
    return { ok: false, reason: `could not save: ${error.message}`, count: records.length };
  }
  return { ok: true, count: records.length };
}

/** @returns {number} how many templates remain. */
export function removeTemplate(id) {
  const store = storage();
  if (!store) return 0;
  const records = listSavedTemplateRecords().filter((r) => r.id !== id);
  try {
    store.setItem(KEY, JSON.stringify(records));
  } catch {
    /* keep the old list */
  }
  return records.length;
}
