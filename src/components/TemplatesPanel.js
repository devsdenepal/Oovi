/**
 * TemplatesPanel | the manual, no-AI template library in the left sidebar.
 *
 * Canva's template tab is a visual browser: small previews grouped by kind,
 * searchable, and a click applies the layout. This panel uses the same
 * template geometry the planner already trusts, so a manual choice and an
 * AI choice can never drift into two different layout systems.
 *
 * Previews are DOM-only (no Fabric, no network, no model): each slot becomes
 * a coloured block/line at its real fractional position. The canvas itself is
 * only touched when the user clicks a card, via App.applyTemplate().
 */

import { TEMPLATES, sizeClassOf } from "../layout/templates";
import { listSavedTemplates } from "../layout/templateStore";
import { paletteForTemplate } from "../layout/templateSample";

const TYPE_ORDER = [
  "poster",
  "cover",
  "notice",
  "social",
  "statement",
  "listing",
  "product",
  "newsletter",
  "banner",
  "menu",
  "gallery",
  "quote",
  "timeline",
  "comparison",
  "roster",
  "ticket",
  "schedule",
  "map",
  "certificate",
  "metrics",
];

const TYPE_LABELS = {
  poster: "Posters",
  cover: "Covers",
  notice: "Notices",
  social: "Social",
  statement: "Statements",
  listing: "Listings",
  product: "Product",
  newsletter: "Editorial",
  banner: "Banners",
  menu: "Menus & cards",
  gallery: "Galleries",
  quote: "Quotes",
  timeline: "Timelines",
  comparison: "Comparisons",
  roster: "Teams",
  ticket: "Tickets",
  schedule: "Schedules",
  map: "Maps",
  certificate: "Certificates",
  metrics: "Metrics",
};

const LINE_WIDTHS = {
  header: ["38%"],
  headline: ["88%", "58%"],
  tagline: ["70%"],
  details: ["84%", "58%"],
  sections: ["80%", "54%"],
  audience: ["56%"],
  footer: ["44%"],
  cta: ["36%"],
};

const ACCENT_ROLES = new Set(["header", "cta"]);
const SECONDARY_ROLES = new Set(["tagline", "details", "footer", "audience"]);

const PHOTO_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9" r="1.6"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg>';

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function rgba(hex, alpha) {
  const value = String(hex || "").replace("#", "");
  if (value.length !== 6) return `rgba(17, 17, 17, ${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function boxStyle(box) {
  return `left:${percent(box.x)};top:${percent(box.y)};width:${percent(box.w)};height:${percent(box.h)};`;
}

function barColor(role, roles) {
  if (ACCENT_ROLES.has(role)) return roles.accent;
  if (SECONDARY_ROLES.has(role)) return roles.textSecondary;
  return roles.textPrimary;
}

function photoPreview(roles) {
  const accent = rgba(roles.accent, 0.42);
  const secondary = rgba(roles.textSecondary, 0.28);
  return (
    `radial-gradient(circle at 30% 28%, ${accent}, transparent 42%),` +
    `radial-gradient(circle at 72% 74%, ${secondary}, transparent 46%),` +
    `linear-gradient(145deg, ${roles.surface}, ${roles.background} 58%, ${roles.background})`
  );
}

function thumbnail(template, palette) {
  let slots;
  try {
    const variant = template.variants?.[0]?.id;
    slots = template.build(variant, 0.035) || [];
  } catch (error) {
    console.warn(`[templates] preview failed for ${template.id}:`, error.message);
    return "";
  }
  const roles = palette.roles;

  return slots
    .map((slot) => {
      const box = slot.box || {};
      const style = boxStyle(box);
      if (slot.kind === "image") {
        return `<span class="tpl-thumb-photo" style="${style}background-image:${photoPreview(
          roles,
        )};color:${roles.textPrimary}">${PHOTO_ICON}</span>`;
      }
      if (slot.role === "decoration") {
        return `<span class="tpl-thumb-deco" style="${style}"><span style="background:${roles.accent}"></span></span>`;
      }
      const widths = LINE_WIDTHS[slot.role] || ["64%"];
      const color = barColor(slot.role, roles);
      const lines = widths
        .map((width) => `<span class="tpl-thumb-line" style="width:${width};background:${color}"></span>`)
        .join("");
      return `<span class="tpl-thumb-text" style="${style}">${lines}</span>`;
    })
    .join("");
}

function card(template, canvas) {
  const palette = paletteForTemplate(template);
  const label = template.label || "Untitled template";
  const kind = TYPE_LABELS[template.type] || template.type || "Layout";
  return `<button type="button" class="tpl-card" data-template-id="${esc(template.id)}" title="Apply ${esc(
    label,
  )}" aria-label="Apply template: ${esc(label)}">
    <span class="tpl-thumb" style="aspect-ratio:${canvas.width} / ${canvas.height};background:${palette.background}" aria-hidden="true">
      ${thumbnail(template, palette)}
      ${template.saved ? '<span class="tpl-badge">Saved</span>' : ""}
    </span>
    <span class="tpl-meta">
      <span class="tpl-name">${esc(label)}</span>
      <span class="tpl-kind">${esc(kind)}</span>
    </span>
  </button>`;
}

export class TemplatesPanel {
  /**
   * @param {HTMLElement} container
   * @param {{getCanvas: () => {width:number,height:number}, onSelect: (template: object) => void}} handlers
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.templates = [];
    this.canvas = null;
    this.query = "";
    if (!this.container) return;

    this.container.classList.add("tpl-panel");
    this.container.innerHTML = `
      <p class="tpl-intro">Start from a layout. Sample text and image boxes are editable. Click any text on the canvas to change it.</p>
      <label class="tpl-search" for="tpl-search-input">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input id="tpl-search-input" type="search" placeholder="Search templates" autocomplete="off" maxlength="60" />
      </label>
      <div class="tpl-results" aria-live="polite"></div>
    `;
    this.searchInput = this.container.querySelector("#tpl-search-input");
    this.resultsEl = this.container.querySelector(".tpl-results");
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value;
      this.renderResults();
    });
    this.resultsEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-template-id]");
      if (!button) return;
      const template = this.templates.find((item) => item.id === button.dataset.templateId);
      if (!template) return;
      this.resultsEl.querySelectorAll(".tpl-card.is-selected").forEach((el) => el.classList.remove("is-selected"));
      button.classList.add("is-selected");
      this.handlers.onSelect?.(template);
    });
  }

  /** Re-read the canvas size, library and saved templates. */
  refresh() {
    if (!this.container) return;
    const canvas = this.handlers.getCanvas?.() || null;
    if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return;
    this.canvas = canvas;
    const size = sizeClassOf(canvas);
    const seen = new Set();
    const all = [...TEMPLATES, ...listSavedTemplates()];
    this.templates = all.filter((template) => {
      if (!template || typeof template.id !== "string" || seen.has(template.id)) return false;
      seen.add(template.id);
      // Saved layouts are the user's own history; show them even when the
      // current canvas uses a different aspect, because the boxes are
      // normalised and the user can decide whether to adapt them.
      if (template.saved) return true;
      return Array.isArray(template.sizes) && template.sizes.includes(size);
    });
    this.renderResults();
  }

  renderResults() {
    if (!this.resultsEl || !this.canvas) return;
    const query = String(this.query || "").trim().toLowerCase();
    const matches = (template) => {
      if (!query) return true;
      const words = [
        template.label,
        template.type,
        template.blurb,
        template.description,
        ...(Array.isArray(template.tags) ? template.tags : []),
        ...(Array.isArray(template.mood) ? template.mood : []),
        ...(Array.isArray(template.keywords) ? template.keywords : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.includes(query);
    };

    const saved = this.templates.filter((template) => template.saved && matches(template));
    const library = this.templates.filter((template) => !template.saved && matches(template));
    const groups = [];
    if (saved.length) {
      groups.push(`<section class="tpl-group"><h3 class="tpl-group-title"><span>Your templates</span><span class="tpl-count">${saved.length}</span></h3><div class="tpl-grid">${saved
        .map((template) => card(template, this.canvas))
        .join("")}</div></section>`);
    }

    const types = [...new Set(library.map((template) => template.type))];
    const ordered = [
      ...TYPE_ORDER.filter((type) => types.includes(type)),
      ...types.filter((type) => !TYPE_ORDER.includes(type)).sort(),
    ];
    for (const type of ordered) {
      const items = library.filter((template) => template.type === type);
      if (!items.length) continue;
      groups.push(`<section class="tpl-group"><h3 class="tpl-group-title"><span>${esc(
        TYPE_LABELS[type] || type,
      )}</span><span class="tpl-count">${items.length}</span></h3><div class="tpl-grid">${items
        .map((template) => card(template, this.canvas))
        .join("")}</div></section>`);
    }

    if (!groups.length) {
      const message = query
        ? `No templates match “${esc(this.query.trim())}”.`
        : "No templates fit this canvas size yet. Saved templates appear here too.";
      this.resultsEl.innerHTML = `<div class="tpl-empty"><i class="fa-regular fa-rectangle-list" aria-hidden="true"></i><p>${message}</p></div>`;
      return;
    }
    this.resultsEl.innerHTML = groups.join("");
  }
}
