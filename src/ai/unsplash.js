/**
 * Unsplash photo search (Insert panel + AI image regions).
 *
 * Uses the public access key (VITE_UNSPLASH_ACCESS_KEY) exactly as before |
 * designed for client-side use and rate-limited. The secret key is never
 * stored or sent anywhere: this integration does not use OAuth.
 *
 * API terms honored: download tracking fires on every insert
 * (triggerDownload), photographer credit is surfaced in the UI, and
 * utm_source/medium ride on every photo URL.
 */

const SEARCH_ENDPOINT = "https://api.unsplash.com/search/photos";
const PER_PAGE = 12;

function accessKey() {
  try {
    return (import.meta.env?.VITE_UNSPLASH_ACCESS_KEY || "").trim();
  } catch {
    return "";
  }
}

function withUtm(url) {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}utm_source=oovi-studio&utm_medium=referral`;
}

/** One of Unsplash's supported orientations, or "" to let the provider decide. */
export function orientationFor(box = {}) {
  const width = Number(box.width) || 0;
  const height = Number(box.height) || 0;
  if (!(width > 0) || !(height > 0)) return "";
  const ratio = width / height;
  if (ratio >= 1.25) return "landscape";
  if (ratio <= 0.8) return "portrait";
  return "squarish";
}

/**
 * @param {string} query
 * @param {{orientation?: "landscape"|"portrait"|"squarish"|"", page?: number, perPage?: number}} [options]
 * @returns {Promise<Array<{id:string,thumb:string,full:string,alt:string,photographer:string,download:string,width:number,height:number}>>}
 */
export async function searchPhotos(query, options = {}) {
  const key = accessKey();
  if (!key) throw new Error("photo search needs VITE_UNSPLASH_ACCESS_KEY in .env");
  const q = String(query || "").trim();
  if (!q) return [];
  const orientation = String(options.orientation || "").trim().toLowerCase();
  const params = new URLSearchParams({
    query: q,
    per_page: String(options.perPage || PER_PAGE),
    client_id: key,
  });
  if (["landscape", "portrait", "squarish"].includes(orientation)) {
    params.set("orientation", orientation);
  }
  if (Number(options.page) > 0) params.set("page", String(options.page));

  const res = await fetch(`${SEARCH_ENDPOINT}?${params}`);
  if (res.status === 401) throw new Error("Unsplash rejected the access key (401)");
  if (res.status === 403 || res.status === 429) {
    throw new Error("Unsplash rate limit reached | try again later");
  }
  if (!res.ok) throw new Error(`photo search ${res.status}`);
  const data = await res.json();
  return (data?.results || [])
    .map((p) => ({
      id: p.id,
      thumb: withUtm(p.urls?.thumb || p.urls?.small || ""),
      full: withUtm(p.urls?.regular || p.urls?.full || ""),
      alt: p.alt_description || p.description || "Unsplash photo",
      photographer: p.user?.name || "Unknown",
      download: p.links?.download_location || "",
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
    }))
    .filter((p) => p.thumb && p.full);
}

/** Best-effort download tracking (API terms). Never blocks insertion. */
export async function triggerDownload(photo) {
  try {
    const key = accessKey();
    if (!photo?.download || !key) return;
    const sep = photo.download.includes("?") ? "&" : "?";
    await fetch(`${photo.download}${sep}client_id=${key}`);
  } catch {
    // tracking must never break the user flow
  }
}

/**
 * Pick the best aspect fit among the provider's relevance-ranked results.
 * Search order is the semantic judgement; this only avoids cropping a tall
 * portrait into a wide hero. It never randomises.
 */
export function choosePhoto(photos, box = {}) {
  const pool = (photos || []).filter((photo) => photo?.full).slice(0, 8);
  if (!pool.length) return null;
  const width = Number(box.width) || 1;
  const height = Number(box.height) || 1;
  const target = width / height;
  let best = pool[0];
  let bestDistance = Infinity;
  for (const photo of pool) {
    const ratio = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : target;
    const distance = Math.abs(Math.log(ratio / target));
    if (distance < bestDistance) {
      best = photo;
      bestDistance = distance;
    }
  }
  return best;
}
