/**
 * Unsplash routes (Vercel-shaped handler, also mounted by server/index.js).
 *
 * The access key lives ONLY in UNSPLASH_ACCESS_KEY server env | the
 * browser never holds it (api/asset.js pattern for Pollinations).
 *
 *   GET  /api/photos?q=mountains&page=1&orientation=landscape
 *                                        → { photos: [...] }
 *   POST /api/photos  { download }       → fires download tracking
 *                                            (API terms, best-effort)
 */

const SEARCH_ENDPOINT = "https://api.unsplash.com/search/photos";
const PER_PAGE = 12;

function key() {
  return (process.env.UNSPLASH_ACCESS_KEY || "").trim();
}

function slim(p) {
  return {
    id: p.id,
    thumb: p.urls?.thumb || p.urls?.small || "",
    full: p.urls?.regular || p.urls?.full || "",
    alt: p.alt_description || p.description || "Unsplash photo",
    photographer: p.user?.name || "Unknown",
    width: Number(p.width) || 0,
    height: Number(p.height) || 0,
  };
}

export default async function handler(req, res) {
  const k = key();
  if (!k) {
    res.status(500).json({ error: "photo search is not configured on the server" });
    return;
  }

  if (req.method === "GET") {
    const q = String(req.query?.q || "").trim();
    if (!q) {
      res.status(200).json({ photos: [] });
      return;
    }
    const orientation = String(req.query?.orientation || "").toLowerCase();
    const page = Math.max(1, Number(req.query?.page) || 1);
    try {
      const params = new URLSearchParams({
        query: q,
        per_page: String(PER_PAGE),
        page: String(page),
        client_id: k,
      });
      if (["landscape", "portrait", "squarish"].includes(orientation)) {
        params.set("orientation", orientation);
      }
      const url = `${SEARCH_ENDPOINT}?${params}`;
      const upstream = await fetch(url);
      if (upstream.status === 401) {
        res.status(502).json({ error: "photo provider rejected the server key" });
        return;
      }
      if (upstream.status === 403 || upstream.status === 429) {
        res.status(502).json({ error: "photo rate limit reached | try again later" });
        return;
      }
      if (!upstream.ok) {
        res.status(502).json({ error: `photo search ${upstream.status}` });
        return;
      }
      const data = await upstream.json();
      const photos = (data?.results || [])
        .map((p) => ({ ...slim(p), download: p.links?.download_location || "" }))
        .filter((p) => p.thumb && p.full);
      console.log(
        `[photos] q="${q}" orientation=${orientation || "any"} page=${page} results=${photos.length}`,
      );
      res.status(200).json({ photos });
    } catch (error) {
      console.error(`[photos] search failed: ${error.message}`);
      res.status(500).json({ error: "photo search failed" });
    }
    return;
  }

  if (req.method === "POST") {
    // Download tracking (terms): fire with the server key, never block.
    const download = req.body?.download;
    if (download) {
      fetch(`${download}${download.includes("?") ? "&" : "?"}client_id=${k}`).catch(() => {});
      console.log("[photos] download tracked");
    }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: "GET or POST only" });
}
