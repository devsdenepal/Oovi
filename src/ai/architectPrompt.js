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
 * palette and skeleton layers; pass 2 is unchanged except that it also
 * receives the refined goal as a brief.
 */

import { DESIGN_CORE, formatGoal } from "./layerPrompt";
import { templateExample } from "../layout/templates";
import { formatPaletteRoles, textRoleFor } from "../layout/paletteRoles";

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

export function buildComponentPrompt(component, canvas, plan, goal = null) {
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
  // Colour is a ROLE decision, not a hex decision. The prompt names the role
  // this region paints with, so L5 corrects mistakes instead of inventing a
  // scheme after the fact.
  const colourRole =
    component.role === "decoration"
      ? "accent (shapes, rules and small marks only — never text)"
      : component.role === "cta"
        ? "ctaText on a ctaSurface block"
        : textRoleFor(component.role) === "textSecondary"
          ? "textSecondary for supporting copy, textPrimary for any heading inside it"
          : "textPrimary";
  const rolesLine = palette?.roles
    ? `Palette roles — ${formatPaletteRoles(palette.roles)}.`
    : `Palette: background ${palette.background}, ink ${palette.ink}, accent ${palette.accent}.`;
  // One worked example of THIS slot, chosen lexically from the template's own
  // copy (see src/layout/templates.js). A few dozen prompt tokens against a
  // prefill that already costs ~90s, and it pins the register of the copy.
  const example = plan?.template ? templateExample(plan.template, component.id, goal) : "";
  // Output budget per role. On-device generation is ~1-3 tok/s, so the ask
  // itself is the wall clock: an unbounded "1-8 elements" got regions writing
  // 700+ tokens. Density is bought with SIZE and grouping, not element count.
  const budget =
    component.role === "decoration"
      ? "8-14 tiny shapes (dots, rects, short lines), grouped as one unit."
      : component.role === "sections"
        ? "4-6 elements: a heading plus 3-4 grouped cards (icon + title + one-liner)."
        : component.role === "details"
          ? "2-4 elements: one grouped row per fact."
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
                    : "2-5 elements.";
  // L4 shares the byte-identical DESIGN_CORE prefix with L1-L3. Everything
  // that varies lives in the [User] turn, ordered constant-within-design
  // first (canvas, palette, theme, brief) and region-specific last, so a
  // warmed prefix still covers as much of the prompt as possible.
  return [
    DESIGN_CORE,
    "",
    "Your task now: output the elements for exactly ONE region of the design. Another pass already decided the regions and this region's box; you only fill it.",
    "Region rules:",
    "- Fill the box deliberately; an empty-looking box is a failure. Every element stays fully inside this box AND inside the canvas.",
    "- The reserved box is authoritative: do not move or resize the region, and do not invent a different position for it.",
    "- Match the box: a tall box wants larger type and more grouped rows; a thin bar wants a single line.",
    "- Give every element an id prefixed with the region id.",
    "- Paint with the named palette roles only. Never invent a hue; the palette is a system, not a suggestion.",
    'Return ONLY valid JSON: {"elements":[...]}.',
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height}. ${rolesLine} Theme: ${plan.style || "clean modern"}.`,
    goal ? `The design brief:\n${formatGoal(goal)}` : "",
    `Region "${component.id}" (role ${component.role || "body"}): ${component.describe}.${roleRule}`,
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
    example
      ? `Copy example for this region (follow its register and length, write your own words): "${example}"`
      : "",
    `Budget — ${budget}`,
    siblings ? `Sibling regions (align edges with them, never overlap their text): ${siblings}.` : "",
    "Generate the elements for this region now.",
  ].join("\n");
}
