/**
 * Pollinations image assets (icons, logos, illustrations).
 *
 * The secret key lives ONLY in the backend (/api/asset → POLLINATIONS_KEY
 * server env). The browser never holds a key: direct URLs are keyless.
 *
 * Asset flow (App): backend first → keyless direct fetch → hotlink.
 * Every step degrades to the next; failures stay visible, never silent.
 */

const IMAGE_ENDPOINT = "https://image.pollinations.ai/prompt";
const DEFAULT_MODEL = import.meta.env?.VITE_POLLINATIONS_MODEL || "turbo";

/**
 * Server-side generation through the same-origin backend.
 * @returns {Promise<string>} dataURL (throws when backend is absent/down)
 */
export async function fetchAssetViaBackend(describe, opts = {}) {
  const res = await fetch("/api/asset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      describe,
      width: opts.width,
      height: opts.height,
      seed: opts.seed,
      model: DEFAULT_MODEL,
      asset: opts.asset,
    }),
  });
  if (!res.ok) throw new Error(`backend ${res.status}`);
  const data = await res.json();
  if (!data?.dataUrl) throw new Error(data?.error || "backend gave no image");
  return data.dataUrl;
}

/**
 * @param {string} describe asset description (architect supplies style)
 * @param {{width:number,height:number,seed?:number,asset?:string}} [opts]
 */
export function assetUrl(describe, opts = {}) {
  const width = Math.min(1024, Math.max(32, Math.round(opts.width || 512)));
  const height = Math.min(1024, Math.max(32, Math.round(opts.height || 512)));
  const seed = opts.seed ?? Math.floor(Math.random() * 1000000);
  const styleSuffix =
    opts.asset === "icon" || opts.asset === "logo"
      ? ", flat vector mark, plain solid background, no text"
      : ", clean illustration, no text";
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model: DEFAULT_MODEL,
    safe: "true",
  });
  return `${IMAGE_ENDPOINT}/${encodeURIComponent(describe + styleSuffix)}?${params}`;
}

/**
 * Fetches the asset as a dataURL (never taints the canvas, export-safe).
 * Throws on CORS/network failure so callers can hotlink-fallback.
 */
export async function fetchAssetDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("asset is not an image");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("asset read failed"));
    reader.readAsDataURL(blob);
  });
}
