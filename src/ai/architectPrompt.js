/**
 * Architect prompts v2 (composition planning).
 *
 * Pass 1 (plan): palette + THEME + ordered components with roles and
 * boxes. A section checklist forces deliberate coverage (adapted, never
 * padded); every component carries a role, boxes reserve real space, and
 * the style string propagates the visual theme to all later calls.
 * Pass 2 (per component): DSL elements for one component, aware of its
 * role, the theme, and sibling boxes (alignment, no accidental overlap).
 *
 * In the layered pipeline (layerPrompt.js) pass 1 is split into goal,
 * palette and template layers; pass 2 is unchanged except that it also
 * receives the refined goal as a brief.
 */

import { DESIGN_CORE, formatGoal } from "./layerPrompt";
import { formatPaletteRoles, textRoleFor, ensurePaletteRoles } from "../layout/paletteRoles";
import { DECORATION_VOCABULARY, recommendDecorationSpecs } from "../layout/decorations";

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
    "- Decoration regions use a reusable vocabulary (circles, arcs, stars, dots, grids, squiggles, underlines, corner brackets, ribbons, pills, dividers, small icons, background patterns); keep one family plus one small accent, behind content, never image calls.",
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

export function buildComponentPrompt(component, canvas, plan, goal = null, rawPrompt = "") {
  const b = component.box;
  const palette = plan.palette;
  const siblings = (plan.components || [])
    .filter((c) => c.id !== component.id && c.box)
    .map((c) => `${c.id}(${c.role || "?"}) [${c.box.x},${c.box.y} ${c.box.width}x${c.box.height}]`)
    .join("; ");
  const regionName = `${component.id || ""} ${component.describe || ""}`.toLowerCase();
  const isAttribution = /\b(attribution|who said|credit)\b/.test(regionName);
  const isQuote = /\b(quote|quotation)\b/.test(regionName);
  const isDecoration = component.role === "decoration";
  const roleRule =
    isDecoration
      ? " Decoration: choose one or two families from the vocabulary below. Do not write text and do not invent arbitrary shapes; the renderer expands your choice into editable vector primitives."
      : component.role === "headline"
      ? ` Headline floor: fontSize at least ${Math.max(24, Math.round(canvas.height * 0.06))}px and larger than any other text. Use the approved copy or the message itself; never describe the design. Keep it short (at most 6 words) so it fits on one line at the planned size.`
      : component.role === "details"
        ? " Details floor: every text at least 16px. Use the approved copy or the exact date, time, venue and link from the original request — never a template example or a description of the design."
        : component.role === "footer"
          ? " Footer: use the approved copy or a real link, date, organiser or greeting. Do not claim availability unless the brief says so; do not repeat the venue already shown in details."
          : component.role === "tagline"
            ? isAttribution
              ? " Attribution: name the person or organisation this is from. Never an audience, language, date or keyword label."
              : isQuote
                ? " Quote line: the message itself, never a description of the design."
                : " Tagline: one short supporting line from the approved copy; never a keyword list."
            : component.role === "header"
              ? " Header is a kicker: brand, organiser or event label, single line, small (at most 4% of canvas height)."
              : "";
  const approvedCopy = (Array.isArray(component.copy) ? component.copy : [])
    .map((line) => String(line ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const approvedBlock = approvedCopy.length
    ? [
        "Approved copy — use these exact lines, in order; do not rewrite, shorten, merge or add copy:",
        ...approvedCopy.map((line, index) => `${index + 1}. ${line}`),
      ].join("\n")
    : "";
  const recommendedDecorations = isDecoration
    ? recommendDecorationSpecs({ component, plan, goal, rawPrompt })
    : [];
  const decorationExample = recommendedDecorations.length
    ? JSON.stringify(recommendedDecorations)
    : '[{"kind":"stars","variant":"scatter","density":"normal","color":"accent"}]';
  const decorationBlock = isDecoration
    ? [
        "Decoration vocabulary — choose from these exact kind ids:",
        DECORATION_VOCABULARY,
        "Decoration rules:",
        "- Pick 1-2 kinds that reinforce the design. Use the recommendation below as the starting point; prefer one main family plus one small accent. Default to `dense` density unless the box is tiny.",
        `- Recommended for this design: ${recommendedDecorations.map((item) => item.kind).join(", ") || "stars"}.`,
        "- `variant` is optional; use one of the listed variants for the chosen kind.",
        "- `density` is sparse, normal or dense. `color` is accent, ink, secondary or muted.",
        "- Leave `elements` empty. Put the specs in `decorations`.",
        "- Never add text, copy, dates, labels or image elements to this region.",
      ].join("\n")
    : "";
  // Colour is a ROLE decision, not a hex decision. The prompt names the role
  // this region paints with AND its literal hex: q8 otherwise writes the role
  // name into `fill` ("textPrimary") or drops the leading "#".
  const roles = ensurePaletteRoles(palette);
  const colourRole =
    isDecoration
      ? `accent (${roles.accent}) by default; use accent, ink (${roles.textPrimary}), secondary (${roles.textSecondary}) or muted (${roles.muted}) — shapes, rules and small marks only, never text`
      : component.role === "cta"
        ? `ctaText (${roles.ctaText}) on a ctaSurface block (${roles.ctaSurface})`
        : textRoleFor(component.role) === "textSecondary"
          ? `textSecondary (${roles.textSecondary}) for supporting copy, textPrimary (${roles.textPrimary}) for any heading inside it`
          : `textPrimary (${roles.textPrimary})`;
  const rolesLine = palette?.roles
    ? `Palette roles — ${formatPaletteRoles(palette.roles)}.`
    : `Palette: background ${palette.background}, ink ${palette.ink}, accent ${palette.accent}.`;
  // No worked example here. The template examples are useful for the offline
  // benchmark, but at this model size q8 copies them verbatim into the design
  // (a pottery poster came back as "HACKTOBERFEST 2026" / "Kestrel Studio").
  // The brief plus the raw request is the factual source; the budget and slot
  // description set the register.
  // Output budget per role. On-device generation is ~1-3 tok/s, so the ask
  // itself is the wall clock: an unbounded "1-8 elements" got regions writing
  // 700+ tokens. Density is bought with SIZE and grouping, not element count.
  const budget =
    isDecoration
      ? "1-2 decoration specs at dense density; the renderer expands them into 12-24 editable shapes."
      : component.role === "sections"
        ? /card|caption|item/i.test(component.id)
          ? "2-3 elements: one short label and one line of detail — this is a single card, not a section."
          : "6-10 elements: a heading plus 4-6 grouped cards (icon + title + one-liner), tightly packed."
        : component.role === "details"
          ? "4-6 elements: one grouped row per fact, plus a supporting label or badge."
          : component.role === "header"
            ? "2-3 elements: a bar or badge plus one kicker line."
            : component.role === "headline"
              ? "1-4 elements: the title (one text run per colour when multicolour, sharing a baseline)."
              : component.role === "tagline"
                ? "1-2 elements: a single supporting line."
                : component.role === "audience"
                  ? "2-4 elements: a label plus grouped entries."
                  : component.role === "footer"
                    ? "2-4 elements: grouped organizer/registration lines."
                    : "4-8 elements, tightly packed.";
  // L4 shares the byte-identical DESIGN_CORE prefix with L1-L3. Everything
  // that varies lives in the [User] turn, ordered constant-within-design
  // first (canvas, palette, theme, brief) and region-specific last, so a
  // warmed prefix still covers as much of the prompt as possible.
  return [
    DESIGN_CORE,
    "",
    "Your task now: output the elements for exactly ONE region of the design. Another pass already decided the regions and this region's box; you only fill it.",
    decorationBlock,
    "Region rules:",
    isDecoration
      ? "- Fill the reserved box with a deliberate decoration layer; layer shapes behind text and add a dense accent (dots, grids, stars, dividers)."
      : "- Fill the box deliberately; no large empty zones. Layer decorative shapes (bars, dots, small grids, thin strips) behind the text, add a small label/badge beside it, keep content prominent, and add a supporting detail (divider, chip, pill) where space allows.",
    "- Visual coverage: aim to fill at least 80% of the reserved box. Layer shapes behind the text, add a side panel, small label or badge beside it, and use supporting details (thin rules, dots, chips) so no large area stays empty.",
    "- The reserved box is authoritative: do not move or resize the region, and do not invent a different position for it.",
    isDecoration
      ? "- Match the box shape: thin strips want a few small marks; large boxes can carry a fuller pattern."
      : "- Match the box: a tall box wants larger type and more grouped rows; a thin bar wants a single line.",
    "- Give every element an id prefixed with the region id.",
    "- Paint with the named palette roles only. Never invent a hue; the palette is a system, not a suggestion.",
    `- "fill" and "stroke" MUST be literal hex strings from the palette (for example "${roles.textPrimary}"), never a role name, a bare hex without "#", or prose.`,
    isDecoration
      ? `Return ONLY valid JSON: {"elements":[],"decorations":${decorationExample}}.`
      : 'Return ONLY valid JSON: {"elements":[...]}.',
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height}. ${rolesLine} Theme: ${plan.style || "clean modern"}.`,
    goal ? `The design brief:\n${formatGoal(goal)}` : "",
    rawPrompt
      ? `Original request (source of truth for concrete facts — copy dates, times, venues, addresses, prices and links exactly as written; keep them in this region if they belong here):\n${String(rawPrompt).slice(0, 1600)}`
      : "",
    "Treat every brief line as a requirement, never as copy. Do not print requirement labels, design rules, or template examples. Use only facts stated in the brief or original request; do not invent dates, prices, names or venues.",
    `Region "${component.id}" (role ${component.role || "body"}): ${component.describe}.${roleRule}`,
    approvedBlock,
    `Reserved box: x=${b.x} y=${b.y} width=${b.width} height=${b.height} — this is the whole region; keep every element inside it.`,
    component.fontSize
      ? `Type: this region's main text is ${component.fontSize}px${component.align ? `, aligned ${component.align}` : ""} (the template fixed the box, so keep the type at this size).`
      : component.align
        ? `Alignment: ${component.align}.`
        : "",
    component.maxChars > 0
      ? `Copy limit: at most ${component.maxChars} characters of text in this whole region.`
      : "",
    `Colour for this region: ${colourRole}.`,
    `Budget — ${budget}`,
    siblings ? `Sibling regions (align edges with them, never overlap their text): ${siblings}.` : "",
    "Generate the elements for this region now.",
  ].join("\n");
}
