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
    `Canvas: ${w}x${h} pixels (${portrait ? "portrait poster" : "landscape banner"}). All boxes must fit inside (x>=0, y>=0, x+width<=${w}, y+height<=${h}). 6 to 12 components. Every component MUST have id, kind, role, describe and box. At most 2 image components per plan — never spend image calls on confetti, sparkles or icons.`,
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
    "- Type scale: headline at least 2x the tagline, tagline larger than details; details share ONE size (never three sizes for one block).",
    "- ONE dominant only: hero and headline must differ 2:1 in visual weight. A large hero means a stepped-down headline, and vice versa — never two giants competing.",
    "- One hero only; it must be unmissable, never a thumbnail. Place the focal mass near third-lines, never dead center, unless it is a full-bleed backdrop.",
    "- Align to shared left/right edges; even gaps between stacked sections.",
    "- Color discipline 60-30-10: background dominates, ink carries body, accent is rationed to headline + key details + one decoration family. Every fill MUST be background, ink, accent, or a neutral (white/black/gray) — no freelance hues.",
    "- Two fonts max: one display face for the headline, one text face for everything else.",
    "- Repetition system: one corner radius everywhere, one divider style, one icon style, one badge shape. Sameness of parts is what makes varied layouts feel designed.",
    "- Symmetry or DELIBERATE asymmetry (oversized hero vs stacked type column) — never accidental lopsidedness.",
    "- Card anatomy for sections: icon + title + one-liner per card, shared padding, thin dividers between items.",
    "- Contrast: test every text against its LOCAL backdrop (bar, disc, artwork) — never just the canvas. Body in ink on background; accent rationed to headline, key details and decoration.",
    "- Balance: visual weight on BOTH halves — never stack everything on one side.",
    "- Facts: use ONLY facts from the request. Never invent dates, venues, names or organizers; missing facts become obvious placeholders (\"Date TBA\", \"Venue TBA\", \"Lineup TBA\").",
    "- Texture rule: when the style needs texture DSL shapes cannot draw (pixel-art, neon glow, grunge, watercolor), the hero AND at least one decoration MUST be kind \"image\" with the full style baked into their describe.",
    "- Header is a kicker, at most half the headline size.",
    "- Rich headlines: multicolor titles are adjacent text runs (one element per color, same baseline, shared left edge); funky/pixel themes get an outline (stroke = canvas background, strokeWidth about fontSize/10) and a monospace fontFamily.",
    "- Scatter decoration as MANY small DSL shapes (dots, stars, sparkles: tiny circles, rects, short lines) inside one decoration component — grouped, never image calls.",
    "- Group every card/row: one group per visual unit (badge, info item, activity card). A group counts as one element and moves as one piece — density lives in groups, not in component count.",
    "- One style string (e.g. \"funky retro pixel-art, neon on dark\") baked into palette choices AND every image describe.",
    "",
    "Route each component: kind \"dsl\" for text, rectangles, circles, lines (crisp editable geometry); kind \"image\" ONLY for icons, logos, illustrations, photos (organic pixels no shape can draw). For kind \"dsl\" set asset \"none\"; for kind \"image\" set asset icon|logo|illustration|photo.",
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
    "Types: text needs content,x,y,width,fontSize(12-120),fontWeight,fill; optional stroke,strokeWidth (outline in a contrasting color),angle(-8 to 8, stickers only),fontFamily, gradient {type:linear|radial, fractions 0-1, stops:[{offset,color}]} for hero bars, headline accents and backgrounds (body text stays solid ink); rectangle needs x,y,width,height,fill (+optional cornerRadius, gradient); circle needs x,y,radius,fill (+optional gradient); line needs x,y,x2,y2,stroke.",
    "Facts: use ONLY facts from the request — never invent names, dates or venues (write \"TBA\" placeholders). Sections list REAL entries (3+ named items with one-liners), never a bare label. Text must contrast its backing bar, not just the canvas.",
    "Every element needs a unique lowercase id (prefix with the component id). 1-8 elements; wrap each visual unit (card, badge, row) in a group.",
    'Return ONLY valid JSON like {"elements":[...]}. No Markdown, no fences, no commentary.',
  ].join("\n");
}
