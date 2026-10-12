/**
 * Architect prompts (chunked component generation).
 *
 * Pass 1 (plan): one call returns palette + ordered component list where
 * the model routes each part (kind "dsl" for text/shapes, "image" for
 * icons/logos/illustrations) and fixes every component box.
 * Pass 2 (per component): small calls generate DSL elements inside the
 * assigned box. Image components skip pass 2 (Pollinations instead).
 */

export function buildPlanPrompt(userPrompt, canvas) {
  const w = canvas.width;
  const h = canvas.height;
  return [
    "[System]",
    "You are a design architect. Break the request into an ordered build plan.",
    `Canvas: ${w}x${h} pixels. All boxes must fit inside (x>=0, y>=0, x+width<=${w}, y+height<=${h}). Max 10 components. Every component MUST have id, kind, describe and box.`,
    "Route each component: kind \"dsl\" for text, rectangles, circles, lines (crisp editable geometry); kind \"image\" ONLY for icons, logos, illustrations, photos (organic pixels no shape can draw).",
    "For kind \"image\" add asset: icon|logo|illustration|photo, and describe the picture (style, colors, no text in the image).",
    "For kind \"dsl\" describe the piece (copy, emphasis, colors). Geometry comes later — the box here reserves its space.",
    "Also propose a palette: {background, ink, accent} as CSS colors.",
    "",
    "Return ONLY valid JSON like:",
    `{"palette":{"background":"#FFFFFF","ink":"#111111","accent":"#4F46E5"},"components":[`,
    ` {"id":"headline","kind":"dsl","describe":"Bold product headline, ink on light","box":{"x":48,"y":120,"width":${Math.min(640, w - 96)},"height":160}},`,
    ` {"id":"brand-icon","kind":"image","asset":"icon","describe":"flat rocket icon in accent color","box":{"x":${Math.max(0, w - 200)},"y":48,"width":128,"height":128}}]}`,
    "No Markdown, no fences, no commentary.",
    "",
    "[User]",
    userPrompt,
  ].join("\n");
}

export function buildComponentPrompt(component, canvas, palette) {
  const b = component.box;
  return [
    "[System]",
    "You are a graphic design layout engine. Generate ONLY the elements for ONE component.",
    `Canvas: ${canvas.width}x${canvas.height}. Palette: background ${palette.background}, ink ${palette.ink}, accent ${palette.accent}.`,
    `Component "${component.id}": ${component.describe}`,
    `Its reserved box: x=${b.x} y=${b.y} width=${b.width} height=${b.height}. Every element must stay fully inside this box.`,
    "Types: text needs content,x,y,width,fontSize(12-120),fontWeight,fill; rectangle needs x,y,width,height,fill; circle needs x,y,radius,fill; line needs x,y,x2,y2,stroke.",
    "Every element needs a unique lowercase id (prefix with the component id). 1-6 elements.",
    'Return ONLY valid JSON like {"elements":[...]}. No Markdown, no fences, no commentary.',
  ].join("\n");
}
