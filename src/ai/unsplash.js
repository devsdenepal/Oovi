/**
 * Unsplash photo search (Insert panel + AI image regions).
 *
 * Search and download tracking go through the local `/api/photos` route so the
 * Unsplash access key stays on the server. The browser only ever receives
 * result URLs, never the key.
 *
 * API terms honored: download tracking fires on every insert (triggerDownload),
 * photographer credit is surfaced in the UI, and utm_source/medium ride on
 * every photo URL.
 */

const SEARCH_ENDPOINT = "/api/photos";
const PER_PAGE = 12;

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
  const q = String(query || "").trim();
  if (!q) return [];
  const orientation = String(options.orientation || "").trim().toLowerCase();
  const params = new URLSearchParams({
    q,
    per_page: String(options.perPage || PER_PAGE),
  });
  if (["landscape", "portrait", "squarish"].includes(orientation)) {
    params.set("orientation", orientation);
  }
  if (Number(options.page) > 0) params.set("page", String(options.page));

  const res = await fetch(`${SEARCH_ENDPOINT}?${params}`);
  if (res.status === 401) throw new Error("photo search is not configured on the server");
  if (res.status === 403 || res.status === 429) {
    throw new Error("photo rate limit reached — try again later");
  }
  if (!res.ok) {
    let message = `photo search ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  const data = await res.json();
  return (data?.photos || [])
    .map((p) => ({
      id: p.id,
      thumb: withUtm(p.thumb || p.urls?.small || ""),
      full: withUtm(p.full || p.urls?.regular || ""),
      alt: p.alt || "Unsplash photo",
      photographer: p.photographer || "Unknown",
      download: p.download || "",
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
    }))
    .filter((p) => p.full);
}

/** Best-effort download tracking (API terms). Never blocks insertion. */
export async function triggerDownload(photo) {
  try {
    if (!photo?.download) return;
    await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ download: photo.download }),
    });
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
