/**
 * POST /api/asset — server-side Pollinations proxy (Vercel function).
 *
 * The secret lives in the POLLINATIONS_KEY server env var and never
 * reaches the browser. Body: { describe, width, height, seed, model,
 * asset }. Responds { dataUrl } (image bytes as data: URL, export-safe).
 */

const IMAGE_ENDPOINT = "https://image.pollinations.ai/prompt";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  try {
    const { describe, width, height, seed, model, asset } = req.body || {};
    if (!describe || typeof describe !== "string") {
      res.status(400).json({ error: "describe is required" });
      return;
    }
    const w = Math.min(1024, Math.max(32, Math.round(Number(width) || 512)));
    const h = Math.min(1024, Math.max(32, Math.round(Number(height) || 512)));
    const styleSuffix =
      asset === "icon" || asset === "logo"
        ? ", flat vector mark, plain solid background, no text"
        : ", clean illustration, no text";
    const params = new URLSearchParams({
      width: String(w),
      height: String(h),
      seed: String(Number.isFinite(Number(seed)) ? seed : Math.floor(Math.random() * 1000000)),
      model: typeof model === "string" && model ? model : "turbo",
      safe: "true",
    });
    if (process.env.POLLINATIONS_KEY) {
      params.set("key", process.env.POLLINATIONS_KEY);
      params.set("nologo", "true");
    }
    const url = `${IMAGE_ENDPOINT}/${encodeURIComponent(describe + styleSuffix)}?${params}`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(502).json({ error: `provider ${upstream.status}` });
      return;
    }
    const blob = await upstream.blob();
    if (!blob.type.startsWith("image/")) {
      res.status(502).json({ error: "provider returned a non-image" });
      return;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    res.status(200).json({ dataUrl: `data:${blob.type};base64,${buf.toString("base64")}` });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
}
