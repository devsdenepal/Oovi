/**
 * Architect prompts v2 (composition planning).
 *
 * Pass 1 (plan): palette + THEME + ordered components with roles and
 * boxes. A section checklist forces deliberate coverage (adapted, never
 * padded); every component carries a role, boxes reserve real space, and
 * the style string propagates the visual theme to all later calls.
 * Pass 2 (per component): DSL elements for one component, aware of its
 * role, the theme, and sibling boxes (alignment, no accidental overlap).
 */

export function buildPlanPrompt(userPrompt, canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const portrait = h > w;
  return [
    "[System]",
    "You are a design architect. Produce a deliberate, complete layout — never a minimal sketch.",
    `Canvas: ${w}x${h} pixels (${portrait ? "portrait poster" : "landscape banner"}). All boxes must fit inside (x>=0, y>=0, x+width<=${w}, y+height<=${h}). 4 to 10 components. Every component MUST have id, kind, role, describe and box.`,
    "",
    "Section checklist — include each section the request has content for, omit the rest (never pad):",
    "- header: event identity + organizer",
    "- headline: dominant title + year, the single largest type on the canvas",
    "- hero: ONE dominant focal image or artwork, at least 35% of canvas width",
    "- tagline: supporting line under the headline",
    "- details: date, time, venue (keep each ≥16px, never tiny)",
    "- sections: activities, benefits, lineup — grouped, evenly spaced",
    "- audience: who should come, when the request implies it",
    "- footer: organizer, partners, registration info when supplied",
    "- decoration: theme-reinforcing shapes, behind content, may bleed off edges",
    "",
    "Composition contract:",
    "- Cover the canvas: text boxes, art and shapes together should fill most of it. A half-empty canvas is a failed plan.",
    "- Headline is the largest text: fontSize at least 6% of canvas height.",
    "- One hero only; it must be unmissable, never a thumbnail.",
    "- Align to shared left/right edges; even gaps between stacked sections.",
    "- Contrast: body text in ink on background; accent reserved for the headline, key details and decoration.",
    "- Balance: visual weight on BOTH halves — never stack everything on one side.",
    "- Facts: use ONLY facts from the request. Never invent dates, venues, names or organizers; missing facts become obvious placeholders (\"Date TBA\", \"Venue TBA\", \"Lineup TBA\").",
    "- Texture rule: when the style needs texture DSL shapes cannot draw (pixel-art, neon glow, grunge, watercolor), the hero AND at least one decoration MUST be kind \"image\" with the full style baked into their describe.",
    "- Header is a kicker, at most half the headline size.",
    "- One style string (e.g. \"funky retro pixel-art, neon on dark\") baked into palette choices AND every image describe.",
    "",
    "Route each component: kind \"dsl\" for text, rectangles, circles, lines (crisp editable geometry); kind \"image\" ONLY for icons, logos, illustrations, photos (organic pixels no shape can draw).",
    "Roles: header|headline|hero|tagline|details|sections|audience|footer|decoration.",
    "Also propose a palette: {background, ink, accent} as CSS colors.",
    "",
    "Return ONLY valid JSON like:",
    `{"palette":{"background":"#14101F","ink":"#FFFFFF","accent":"#FFC400"},"style":"funky retro pixel-art, neon on dark",`,
    `"components":[`,
    ` {"id":"headline","kind":"dsl","role":"headline","describe":"HACKTOBERFEST 2026, huge neon headline","box":{"x":48,"y":120,"width":${Math.min(640, w - 96)},"height":180}},`,
    ` {"id":"hero-art","kind":"image","role":"hero","asset":"illustration","describe":"pixel-art rocket bursting from a pumpkin, neon palette","box":{"x":${Math.max(0, w - 460)},"y":300,"width":400,"height":400}}]}`,
    "No Markdown, no fences, no commentary.",
    "",
    "[User]",
    userPrompt,
  ].join("\n");
}

export function buildComponentPrompt(component, canvas, plan) {
  const b = component.box;
  const palette = plan.palette;
  const siblings = (plan.components || [])
    .filter((c) => c.id !== component.id && c.box)
    .map((c) => `${c.id}(${c.role || "?"}) [${c.box.x},${c.box.y} ${c.box.width}x${c.box.height}]`)
    .join("; ");
  const roleRule =
    component.role === "headline"
      ? ` Headline floor: fontSize at least ${Math.max(24, Math.round(canvas.height * 0.06))}px and larger than any other text.`
      : component.role === "details"
        ? " Details floor: every text at least 16px."
        : component.role === "header"
          ? " Header is a kicker: single line, small (at most 4% of canvas height)."
          : "";
  return [
    "[System]",
    "You are a graphic design layout engine. Generate ONLY the elements for ONE component.",
    `Canvas: ${canvas.width}x${canvas.height}. Palette: background ${palette.background}, ink ${palette.ink}, accent ${palette.accent}. Theme: ${plan.style || "clean modern"}.`,
    `Component "${component.id}" (role ${component.role || "body"}): ${component.describe}.${roleRule}`,
    `Its reserved box: x=${b.x} y=${b.y} width=${b.width} height=${b.height}. Fill the box deliberately; an empty-looking box is a failure. Every element must stay fully inside this box AND inside the canvas.`,
    siblings ? `Sibling components (align edges with them, never overlap their text): ${siblings}.` : "",
    "Types: text needs content,x,y,width,fontSize(12-120),fontWeight,fill; rectangle needs x,y,width,height,fill; circle needs x,y,radius,fill; line needs x,y,x2,y2,stroke.",
    "Facts: use ONLY facts from the request — never invent names, dates or venues (write \"TBA\" placeholders). Sections list REAL entries (3+ named items with one-liners), never a bare label.",
    "Every element needs a unique lowercase id (prefix with the component id). 1-6 elements.",
    'Return ONLY valid JSON like {"elements":[...]}. No Markdown, no fences, no commentary.',
  ].join("\n");
}
