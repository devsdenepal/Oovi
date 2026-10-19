/**
 * Incremental extractor for streamed component JSON.
 *
 * The model writes `{"elements":[{…},{…}]}` one token at a time. Rather than
 * waiting minutes for the whole array, this scanner emits each element the
 * moment its closing brace arrives, so the canvas can develop in chunks.
 *
 * It is a stateful, resumable scanner: `createElementScanner()` returns a
 * function you feed the FULL text so far on every token batch; it returns only
 * the elements that completed since the previous call.
 */

/** Index of the start of the elements array, or -1 while it is still pending. */
function findArrayStart(text) {
  const key = text.indexOf('"elements"');
  if (key !== -1) {
    // Wait for the array itself — do not fall back to some other bracket.
    return text.indexOf("[", key);
  }
  // Fallback: a root-level array of objects, e.g. `[{"id":…`
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === "{") return i;
  }
  return -1;
}

/**
 * @returns {(text: string) => object[]} feed it the accumulated stream text;
 *   get back the elements that completed since the last call.
 */
export function createElementScanner() {
  let cursor = 0;
  let inArray = false;
  let objStart = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  return function scan(text) {
    const out = [];
    if (!inArray) {
      const open = findArrayStart(text);
      if (open === -1) return out;
      inArray = true;
      cursor = open + 1;
      objStart = -1;
      depth = 0;
      inStr = false;
      esc = false;
    }
    for (let i = cursor; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        if (depth === 0) objStart = i;
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
        if (depth === 0 && objStart !== -1) {
          try {
            const obj = JSON.parse(text.slice(objStart, i + 1));
            if (obj && typeof obj === "object" && typeof obj.type === "string") out.push(obj);
          } catch {
            // A brace pair that is not yet valid JSON: skip it, keep scanning.
          }
          objStart = -1;
        }
      } else if (ch === "]" && depth === 0) {
        cursor = text.length; // array closed
        return out;
      }
    }
    cursor = text.length;
    return out;
  };
}
