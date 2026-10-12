/**
 * Unsplash photo search (Insert panel element source).
 *
 * Uses the public access key (VITE_UNSPLASH_ACCESS_KEY) — designed for
 * client-side use and rate-limited. The secret key is never stored or
 * sent anywhere: this integration does not use OAuth.
 *
 * API terms honored: download tracking fires on every insert
 * (triggerDownload), photographer credit is surfaced in chat, and
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

/**
 * @param {string} query
 * @returns {Promise<Array<{id:string,thumb:string,full:string,alt:string,photographer:string,download:string}>>}
 */
export async function searchPhotos(query) {
  const key = accessKey();
  if (!key) throw new Error("photo search needs VITE_UNSPLASH_ACCESS_KEY in .env");
  const q = String(query || "").trim();
  if (!q) return [];
  const url =
    `${SEARCH_ENDPOINT}?${new URLSearchParams({ query: q, per_page: String(PER_PAGE), client_id: key })}`;
  const res = await fetch(url);
  if (res.status === 401) throw new Error("Unsplash rejected the access key (401)");
  if (res.status === 403 || res.status === 429) throw new Error("Unsplash rate limit reached — try again later");
  if (!res.ok) throw new Error(`photo search ${res.status}`);
  const data = await res.json();
  return (data?.results || []).map((p) => ({
    id: p.id,
    thumb: withUtm(p.urls?.thumb || p.urls?.small || ""),
    full: withUtm(p.urls?.regular || p.urls?.full || ""),
    alt: p.alt_description || p.description || "Unsplash photo",
    photographer: p.user?.name || "Unknown",
    download: p.links?.download_location || "",
  })).filter((p) => p.thumb && p.full);
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
