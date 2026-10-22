/**
 * Manual template previews.
 *
 * The Templates tab is the non-AI path into the same layout library the
 * planner uses. Choosing a layout must not spend a model call, so this module
 * turns an instantiated template into a real, editable Design DSL document:
 * role-coloured sample copy, honest photo placeholders and the template's own
 * geometry. The user then edits the samples like any other elements.
 *
 * Saved templates keep their own copy. Library templates use neutral sample
 * lines instead of the benchmark examples: the examples are useful offline,
 * but shipping "Kestrel Studio" or "HACKTOBERFEST 2026" as placeholder copy
 * makes a manual choice look like model leakage.
 */

import { instantiateTemplate, templateExample } from "./templates";
import { ensurePaletteRoles } from "./paletteRoles";
import { PALETTES } from "./palettes";
import { imagePlaceholderDataUrl } from "./imagePlaceholder";
import { buildDecorations, defaultDecorationSpecs, recommendDecorationSpecs } from "./decorations";

/** Palette used when a template's type has no more specific mapping. */
const FALLBACK_PALETTE = "mono-editorial";

const TEMPLATE_PALETTES = {
  "hero-split": "tech-blue",
  "hero-top": "mono-editorial",
  "centered-poster": "academic-ink",
  "editorial-columns": "academic-ink",
  "banner-strip": "civic-red",
  "card-grid": "food-orange",
  "story-stack": "travel-teal",
  "statement-quote": "wellness-sage",
  "event-listing": "corporate-navy",
  "feature-cta": "tech-blue",
  "sidebar-rail": "corporate-navy",
  "magazine-cover": "luxe-gold",
  "three-band": "festive-warm",
  "poster-rail": "mono-editorial",
  "team-roster": "pastel-playful",
  "photo-grid": "travel-teal",
  "timeline-steps": "corporate-navy",
  "comparison-table": "corporate-navy",
  "quote-card": "wellness-sage",
  "class-schedule": "academic-ink",
};

const TYPE_PALETTES = {
  poster: "mono-editorial",
  cover: "luxe-gold",
  social: "pastel-playful",
  menu: "food-orange",
  listing: "corporate-navy",
  notice: "academic-ink",
  banner: "civic-red",
  newsletter: "academic-ink",
  product: "tech-blue",
  team: "pastel-playful",
  roster: "pastel-playful",
  schedule: "corporate-navy",
  quote: "wellness-sage",
  gallery: "travel-teal",
  story: "travel-teal",
  timeline: "corporate-navy",
  comparison: "corporate-navy",
  statement: "mono-editorial",
  ticket: "music-purple",
  map: "travel-teal",
  certificate: "academic-ink",
  metrics: "tech-blue",
};

function libraryPalette(id) {
  return PALETTES.find((p) => p.id === id) || PALETTES.find((p) => p.id === FALLBACK_PALETTE);
}

/**
 * A deterministic, type-aware palette for a template's preview and its
 * manually applied design.
 * @param {object} template
 * @returns {object} palette with derived semantic roles
 */
export function paletteForTemplate(template) {
  if (template?.palette?.background && template?.palette?.ink && template?.palette?.accent) {
    return {
      ...template.palette,
      roles: ensurePaletteRoles(template.palette),
      source: "template",
    };
  }
  const id = TEMPLATE_PALETTES[template?.id] || TYPE_PALETTES[template?.type] || FALLBACK_PALETTE;
  const entry = libraryPalette(id);
  return {
    ...entry,
    roles: ensurePaletteRoles(entry),
    source: "template",
  };
}

function rgba(hex, alpha) {
  const value = String(hex || "").replace("#", "");
  if (value.length !== 6) return `rgba(17, 17, 17, ${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function photoPlaceholder(width, height, palette, query, seed = "") {
  return imagePlaceholderDataUrl({
    width,
    height,
    palette,
    query: query ? String(query) : "",
    seed,
  });
}

function fitCopy(value, maxChars) {
  const text = String(value || "").trim();
  if (!maxChars || text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(1, maxChars - 1));
  const line = cut.lastIndexOf("\n");
  if (line > maxChars * 0.55) {
    cut = cut.slice(0, line);
  } else {
    const space = cut.lastIndexOf(" ");
    if (space > maxChars * 0.55) cut = cut.slice(0, space);
  }
  return `${cut.replace(/[\s·,;:./-]+$/, "")}…`;
}

function sampleFor(component, template) {
  const authored = template?.samples?.[component.id];
  if (typeof authored === "string" && authored.trim()) return authored;
  if (template?.saved) {
    const saved = templateExample(template, component.id, {});
    if (saved) return saved;
  }
  const describe = String(component.describe || "").toLowerCase();
  const role = component.role || "body";

  // Role first: a headline description often mentions "year", a card
  // description mentions "title", and a footer description mentions
  // "registration". Matching facts before the role turned those slots into
  // "2026" or "yoursite.com" and left the actual title empty.
  if (role === "headline") return "Add your headline";
  if (role === "tagline") return "A short supporting line";
  if (role === "header") return "YOUR BRAND";
  if (role === "cta") return "Get started";
  if (role === "footer") return "yoursite.com/book";
  if (role === "audience") return "Who it's for";

  // Slot descriptions carry the only per-region meaning available without a
  // model call. Use them before the generic role text so menus, people grids
  // and schedules do not all say "Section title".
  if (/\bprice\b/.test(describe)) return "$12";
  if (/attribution|source|credit/.test(describe)) return "— Your Name";
  if (/quote|statement|mission|vision|pledge/.test(describe)) return "A short, memorable statement.";
  if (/dish|menu item/.test(describe)) return "Dish name\nShort description";
  if (/step|stage|phase/.test(describe)) return "Step one\nWhat happens here";
  if (/feature|benefit|plan/.test(describe)) return "Key benefit\nOne line of detail";
  if (/day.*column/.test(describe)) return "Day one\n09:00 · Session\n11:00 · Session";
  if (/card/.test(describe)) return "Card title\nOne line of detail";
  if (/name.*role|role|speaker|person|portrait|cast|member/.test(describe)) return "Name · Role";
  if (/audience|who this is for|who it's for/.test(describe)) return "Who it's for";

  if (role === "details") {
    if (/date|time|when|opening/.test(describe) && /venue|where|address/.test(describe)) {
      return "Sat 14 Nov · 10:00\nVenue name, City";
    }
    if (/date|time|when|opening/.test(describe)) return "Sat 14 Nov · 10:00";
    if (/venue|where|address/.test(describe)) return "Venue name, City";
    return "Date · Time\nVenue";
  }
  if (/registration|booking|link|website|site/.test(describe)) return "yoursite.com/book";
  if (/date|time|when|opening/.test(describe)) return "Sat 14 Nov · 10:00";
  if (/venue|where|address/.test(describe)) return "Venue name, City";
  if (/year|edition|issue/.test(describe)) return "2026";
  if (role === "sections") return "Section title\nOne line of detail";
  return "Add your text";
}

function textColor(role, roles) {
  if (role === "header" || role === "cta") return roles.accent;
  if (role === "tagline" || role === "details" || role === "footer" || role === "audience") return roles.textSecondary;
  return roles.textPrimary;
}

function fontWeight(role) {
  if (role === "headline" || role === "header" || role === "cta") return 700;
  if (role === "sections") return 600;
  return 500;
}

/**
 * Instantiate a template into editable sample elements.
 * @param {object} template library or saved template
 * @param {{width:number,height:number}} canvas
 * @param {object} [palette] optional palette, defaults to the template's
 * @param {object|null} [tuning] optional plan tuning so the sample matches the
 *   exact variant, density, hidden regions and scale the AI chose
 * @param {Record<string,string>} [imageQueries] optional prompt-grounded
 *   Unsplash query per image region, used for the preview placeholder
 * @returns {{ok:true,design:object,palette:object}|{ok:false,reason:string}}
 */
export function sampleDesignForTemplate(
  template,
  canvas,
  palette = paletteForTemplate(template),
  tuning = null,
  imageQueries = {},
) {
  const width = Number(canvas?.width) || 0;
  const height = Number(canvas?.height) || 0;
  if (!template || !(width > 0) || !(height > 0)) return { ok: false, reason: "no template or canvas" };
  const roles = palette?.roles || ensurePaletteRoles(palette);
  const built = instantiateTemplate(template, tuning, { width, height });
  if (!built.ok) return { ok: false, reason: built.reason || "template could not be instantiated" };

  const elements = [];
  for (const component of built.components) {
    const box = component.box;
    if (!box) continue;
    if (component.kind === "image") {
      const sampleSrc = template?.sampleImages?.[component.id];
      const usableSample = typeof sampleSrc === "string" && /^(https?:|data:|\/)/i.test(sampleSrc);
      elements.push({
        id: `${component.id}-img`,
        type: "image",
        role: component.role,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        src: usableSample
          ? sampleSrc
          : photoPlaceholder(
              box.width,
              box.height,
              palette,
              imageQueries[component.id] || component.describe,
              component.id,
            ),
      });
      continue;
    }
    if (component.role === "decoration") {
      // Use the same art-direction vocabulary as live generation so a manual
      // template preview shows the kind of marks the template's mood implies,
      // not one universal placeholder. Keep the sample to one family so the
      // strip stays calm; live L4 may choose a second accent.
      const suggested = recommendDecorationSpecs({
        component,
        plan: { style: `${template.description || ""} ${(template.mood || []).join(" ")}` },
        goal: { summary: template.blurb, keywords: template.keywords || [] },
        rawPrompt: `${(template.tags || []).join(" ")} ${(template.keywords || []).join(" ")}`,
      });
      const specs = suggested.length ? [suggested[0]] : defaultDecorationSpecs(component);
      const decoration = buildDecorations(specs, box, palette, {
        prefix: component.id,
      });
      if (decoration.length) {
        elements.push(...decoration);
        continue;
      }
      // A zero-area or malformed saved slot should still show a deliberate
      // mark rather than disappearing from the preview.
      const bar = Math.max(2, Math.min(8, Math.round(box.height * 0.22)));
      elements.push({
        id: `${component.id}-bar`,
        type: "rectangle",
        role: "decoration",
        x: box.x,
        y: Math.round(box.y + (box.height - bar) / 2),
        width: box.width,
        height: bar,
        fill: roles.accent,
      });
      continue;
    }
    const content = fitCopy(sampleFor(component, template), component.maxChars);
    if (!content) continue;
    elements.push({
      id: `${component.id}-text`,
      type: "text",
      role: component.role,
      x: box.x,
      y: box.y,
      width: box.width,
      content,
      fontSize: component.fontSize || 16,
      fontWeight: fontWeight(component.role),
      fill: textColor(component.role, roles),
      textAlign: component.align || "left",
      lineHeight: 1.15,
      fontFamily: "Arial",
      charSpacing: 0,
    });
  }

  if (!elements.length) return { ok: false, reason: "the template produced no editable elements" };
  return {
    ok: true,
    palette,
    design: {
      canvas: { width, height, background: roles.background },
      elements,
    },
  };
}
