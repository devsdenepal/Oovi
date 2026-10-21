/**
 * Layout templates (Phase 2D) — the structural spine of a design.
 *
 * Before this module L3 asked the model for free-form boxes. On this box that
 * call costs ~5 minutes (1.16k-token prompt at ~10 tok/s) and its boxes were
 * only *probably* collision-free — the plan had to be re-asked when they were
 * not. A template replaces that with:
 *
 *   - boxes that cannot collide by construction: every slot is a sub-rectangle
 *     of one partitioned frame, separated by a real gutter;
 *   - regions the model merely fills (L4), never invents;
 *   - a deterministic instantiation: fractions -> grid-snapped px, font sizes
 *     taken from the existing type scale.
 *
 * The model still has a say, but only inside a bounded vocabulary: pick a
 * template, then tune it (variant, show/hide optional slots, +-25% type,
 * align, density). Boxes are never accepted from the model.
 *
 * Pure data + pure functions: no Fabric, no network, so
 * tests/templates.test.mjs runs every template/variant against the real
 * quality gate (src/ai/quality.js) in node.
 */

import { sizeToPx } from "./typeScale";
import { GRID, snapBox, snapFontSize } from "./grid";
import { EXAMPLES } from "./templateExamples";
import { templateFromJson } from "./templateJson";
import raw from "./templateLibrary.json";
import extraRaw from "./extraTemplates.json";
const JSON_TABLE = raw.map(templateFromJson);
const EXTRA_TABLE = extraRaw.map(templateFromJson);

/** Frame margin, as a fraction of each axis. */
const MARGIN = 0.055;
/** Gutter between sibling slots, as a fraction of the split axis. */
const GUTTER = 0.025;
/** Decoration lives outside the frame so it can never sit under text. */
const DECOR_H = 0.045;

const DENSITY = { tight: 0.65, normal: 1, airy: 1.45 };

const rect = (x, y, w, h) => ({ x, y, w, h });

/** The one rectangle every template's content lives inside. */
function frame() {
  return rect(MARGIN, MARGIN, 1 - 2 * MARGIN, 1 - 2 * MARGIN);
}

/** Splits an area into stacked rows. Weights are proportional, gaps are real. */
function vstack(area, weights, gap) {
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const usable = Math.max(0, area.h - gap * (weights.length - 1));
  const out = [];
  let y = area.y;
  for (const w of weights) {
    const h = (w / total) * usable;
    out.push(rect(area.x, y, area.w, h));
    y += h + gap;
  }
  return out;
}

/** Splits an area into side-by-side columns. */
function hsplit(area, weights, gap) {
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const usable = Math.max(0, area.w - gap * (weights.length - 1));
  const out = [];
  let x = area.x;
  for (const w of weights) {
    const bw = (w / total) * usable;
    out.push(rect(x, area.y, bw, area.h));
    x += bw + gap;
  }
  return out;
}

/** Bottom edge strip, deliberately OUTSIDE the frame: decoration never
 * overlaps a text slot, so it can never become a contrast bed. */
function decor() {
  return rect(0, 1 - DECOR_H, 1, DECOR_H);
}

function S(id, role, box, spec = {}) {
  return {
    id,
    role,
    box,
    kind: spec.kind || "dsl",
    asset: spec.asset || "none",
    optional: !!spec.optional,
    size: spec.size || "body",
    align: spec.align || "left",
    maxChars: spec.maxChars ?? 0,
    describe: spec.describe || "",
  };
}

const DECOR_SLOT = () =>
  S("decoration-accent", "decoration", decor(), {
    optional: true,
    size: "small",
    maxChars: 0,
    describe: "theme shapes and accents scattered along the bottom edge",
  });

// --- templates -----------------------------------------------------------

function heroSplit(side, gap) {
  const [body, footer] = vstack(frame(), [0.9, 0.1], gap);
  const [left, right] = hsplit(body, [0.56, 0.44], gap);
  const type = side === "left" ? left : right;
  const art = side === "left" ? right : left;
  const [header, headline, tagline, details] = vstack(type, [0.1, 0.46, 0.14, 0.3], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "one focal artwork that carries the theme" }),
    S("header-branding", "header", header, { optional: true, size: "body", maxChars: 30, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 40, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 58, describe: "one supporting line under the title" }),
    S("details-info", "details", details, { size: "body", maxChars: 70, describe: "date, time and venue, one grouped row per fact" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
}

function heroTop(artTop, gap) {
  const [body, footer] = vstack(frame(), [0.9, 0.1], gap);
  const [a, b] = vstack(body, artTop ? [0.46, 0.54] : [0.54, 0.46], gap);
  const art = artTop ? a : b;
  const text = artTop ? b : a;
  const [header, headline, tagline, details] = vstack(text, [0.1, 0.42, 0.18, 0.3], gap);
  const slots = [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "one focal artwork that carries the theme" }),
    S("header-branding", "header", header, { optional: true, size: "body", maxChars: 30, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 44, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 64, describe: "one supporting line under the title" }),
    S("details-info", "details", details, { size: "body", maxChars: 70, describe: "date, time and venue, one grouped row per fact" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
  return slots;
}

function centeredPoster(withAudience, gap) {
  const [top, body, footer] = vstack(frame(), [0.09, 0.83, 0.08], gap);
  const [headline, tagline, lower] = vstack(body, [0.42, 0.16, 0.42], gap);
  const slots = [
    DECOR_SLOT(),
    S("header-branding", "header", top, { size: "body", maxChars: 30, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 42, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 64, describe: "one supporting line under the title" }),
  ];
  if (withAudience) {
    const [details, audience] = hsplit(lower, [0.55, 0.45], gap);
    slots.push(S("details-info", "details", details, { size: "body", maxChars: 60, describe: "date, time and venue, one grouped row per fact" }));
    slots.push(S("audience-who", "audience", audience, { optional: true, size: "body", maxChars: 50, describe: "who this is for, as a short grouped list" }));
  } else {
    slots.push(S("details-info", "details", lower, { size: "body", maxChars: 90, describe: "date, time, venue and how to join, one grouped row per fact" }));
  }
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }));
  return slots;
}

function editorialColumns(threeUp, gap) {
  const [body, footer] = vstack(frame(), [0.88, 0.12], gap);
  const [head, rest] = vstack(body, [0.32, 0.68], gap);
  const [headLeft, headRight] = hsplit(head, [0.66, 0.34], gap);
  const [header, tagline] = vstack(headRight, [0.42, 0.58], gap);
  const cols = hsplit(rest, threeUp ? [1, 1, 1] : [1.6, 1], gap);
  const slots = [
    DECOR_SLOT(),
    S("header-branding", "header", header, { optional: true, size: "body", maxChars: 26, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headLeft, { size: "display", maxChars: 44, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 46, describe: "one supporting line under the title" }),
    S("sections-primary", "sections", cols[0], { size: "subtitle", maxChars: 120, describe: "the main content column: a heading plus grouped rows" }),
    S("sections-secondary", "sections", cols[1], { size: "body", maxChars: 110, describe: "the second content column: a heading plus grouped rows" }),
  ];
  if (threeUp) slots.push(S("sections-tertiary", "sections", cols[2], { optional: true, size: "body", maxChars: 110, describe: "the third content column: a heading plus grouped rows" }));
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

function bannerStrip(gap) {
  const [top, mid, low, footer] = vstack(frame(), [0.12, 0.46, 0.28, 0.14], gap);
  const [header, tagline] = hsplit(top, [0.7, 0.3], gap);
  const [d1, d2, d3] = hsplit(low, [1, 1, 1], gap);
  return [
    DECOR_SLOT(),
    S("header-branding", "header", header, { optional: true, size: "body", maxChars: 30, describe: "organizer or event kicker, one short line" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 24, align: "right", describe: "one supporting line, short" }),
    S("headline-main", "headline", mid, { size: "display", maxChars: 48, describe: "the main title and its year — the largest type on the canvas" }),
    S("details-when", "details", d1, { size: "body", maxChars: 34, describe: "the date and time" }),
    S("details-where", "details", d2, { size: "body", maxChars: 34, describe: "the venue or place" }),
    S("details-who", "audience", d3, { size: "body", maxChars: 34, describe: "who this is for or who is hosting" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 90, describe: "registration link, organizer or partner line" }),
  ];
}

function cardGrid(count, gap) {
  const [body, footer] = vstack(frame(), [0.88, 0.12], gap);
  const [head, grid] = vstack(body, [0.3, 0.7], gap);
  const [headline, tagline] = vstack(head, [0.66, 0.34], gap);
  const cards = [];
  if (count === 4) {
    for (const col of hsplit(grid, [1, 1], gap)) cards.push(...vstack(col, [1, 1], gap));
  } else {
    cards.push(...hsplit(grid, [1, 1, 1], gap));
  }
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "display", maxChars: 40, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 60, describe: "one supporting line under the title" }),
  ];
  cards.forEach((box, i) => {
    slots.push(S(`sections-card-${i + 1}`, "sections", box, { size: "body", maxChars: 60, describe: `content card ${i + 1}: icon plus a short title and one line of detail` }));
  });
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

function storyStack(bleed, gap) {
  const artH = 0.48;
  const art = bleed ? rect(0, 0, 1, artH) : rect(MARGIN, MARGIN, 1 - 2 * MARGIN, artH - MARGIN);
  const top = art.y + art.h + gap;
  const below = rect(MARGIN, top, 1 - 2 * MARGIN, Math.max(0.1, 1 - MARGIN - top));
  const [header, headline, tagline, details, footer] = vstack(below, [0.12, 0.34, 0.16, 0.24, 0.14], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "photo", describe: "one full-width focal photo that carries the theme" }),
    S("header-branding", "header", header, { optional: true, size: "body", maxChars: 30, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 40, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 58, describe: "one supporting line under the title" }),
    S("details-info", "details", details, { size: "body", maxChars: 70, describe: "date, time and venue, one grouped row per fact" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
}

function statementQuote(centered, gap) {
  const [top, body, footer] = vstack(frame(), [0.1, 0.8, 0.1], gap);
  const [statement, attribution, source] = vstack(body, [0.5, 0.2, 0.3], gap);
  const align = centered ? "center" : "left";
  return [
    DECOR_SLOT(),
    S("header-branding", "header", top, { size: "body", maxChars: 32, describe: "organizer or event kicker, one short line" }),
    S("headline-statement", "headline", statement, { size: "display", maxChars: 60, align, describe: "the single statement this design exists to say — the largest type on the canvas" }),
    S("tagline-attribution", "tagline", attribution, { size: "subtitle", maxChars: 44, align, describe: "who said it or what it is from" }),
    S("details-source", "details", source, { size: "body", maxChars: 70, align, describe: "the supporting facts: date, place or call to action" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
}

function eventListing(side, gap) {
  const [head, body, footer] = vstack(frame(), [0.3, 0.6, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.64, 0.36], gap);
  const [left, right] = hsplit(body, [0.5, 0.5], gap);
  const when = side === "left" ? left : right;
  const what = side === "left" ? right : left;
  const [whenBox, whoBox] = vstack(when, [0.55, 0.45], gap);
  const [whatBox, moreBox] = vstack(what, [0.6, 0.4], gap);
  return [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "display", maxChars: 40, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 60, describe: "one supporting line under the title" }),
    S("details-info", "details", whenBox, { size: "subtitle", maxChars: 60, describe: "date, time and venue, one grouped row per fact" }),
    S("audience-who", "audience", whoBox, { optional: true, size: "body", maxChars: 50, describe: "who should come, as a short grouped list" }),
    S("sections-agenda", "sections", whatBox, { size: "body", maxChars: 90, describe: "the programme or agenda: grouped rows with times" }),
    S("sections-notes", "sections", moreBox, { size: "body", maxChars: 90, describe: "supporting notes, requirements or highlights" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
}

function featureCta(side, gap) {
  const [body, footer] = vstack(frame(), [0.88, 0.12], gap);
  const [left, right] = hsplit(body, [0.5, 0.5], gap);
  const art = side === "left" ? left : right;
  const text = side === "left" ? right : left;
  const [header, headline, tagline, benefits, cta] = vstack(text, [0.1, 0.3, 0.14, 0.28, 0.18], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "one product or theme artwork, the visual anchor" }),
    S("header-branding", "header", header, { optional: true, size: "body", maxChars: 28, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 38, describe: "the main title and its year — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 54, describe: "one supporting line under the title" }),
    S("sections-benefits", "sections", benefits, { size: "body", maxChars: 90, describe: "three or four grouped benefit rows: icon plus one line each" }),
    S("cta-action", "cta", cta, { optional: true, size: "subtitle", maxChars: 34, describe: "the single call to action plus how to act on it" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

// --- Phase 3 geometry families -------------------------------------------
//
// Same contract as the families above — nested partitions of ONE frame with
// real gutters, so boxes cannot collide by construction — but these are the
// layouts a RETRIEVAL library needs: enough distinct shapes that a brief can
// land on a template that genuinely fits instead of a nearest generic.
//
// The constraints that make a family survivable are mechanical, not aesthetic:
//   - a text slot must be at least 1.2 x its own font size tall, or the
//     rendered line block spills into the slot below and the quality gate
//     reports a text overlap. In canvas terms that is >= 7.2% of the canvas
//     height for a "headline" slot and >= 10.3% for a "display" slot;
//   - the headline slot must therefore be generously weighted: every family
//     below clears it with room for two lines wherever "display" is used;
//   - the smallest text size any family uses is "body" (2.2% of height), so
//     nothing trips the unreadable-text rule;
//   - decoration stays in its own strip below the frame, and no family bleeds
//     artwork into that strip.

/** 11. A narrow rail (kicker, facts, CTA) beside the main column (art, headline, tagline). */
function sidebarRail(side, gap) {
  const [body, footer] = vstack(frame(), [0.9, 0.1], gap);
  const [a, b] = hsplit(body, [0.32, 0.68], gap);
  const rail = side === "left" ? a : b;
  const main = side === "left" ? b : a;
  const [kicker, facts, cta] = vstack(rail, [0.16, 0.62, 0.22], gap);
  const [art, headline, tagline] = vstack(main, [0.42, 0.38, 0.2], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "the main artwork, filling the top of the content column" }),
    S("header-branding", "header", kicker, { optional: true, size: "body", maxChars: 24, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 44, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 56, describe: "one supporting line under the title" }),
    S("details-info", "details", facts, { size: "body", maxChars: 54, describe: "the facts as grouped rows: date, time, place, price" }),
    S("cta-action", "cta", cta, { optional: true, size: "subtitle", maxChars: 26, describe: "the single call to action" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
}

/** 12. Masthead, one full-width art band, then cover lines. */
function magazineCover(gap) {
  const [mast, art, lines, footer] = vstack(frame(), [0.1, 0.4, 0.36, 0.14], gap);
  const [brand, issue] = hsplit(mast, [0.66, 0.34], gap);
  const [lead, second, third] = vstack(lines, [0.4, 0.34, 0.26], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "photo", describe: "the single full-width cover image" }),
    S("header-branding", "header", brand, { optional: true, size: "body", maxChars: 24, describe: "the masthead or publication name" }),
    S("tagline-line", "tagline", issue, { optional: true, size: "body", maxChars: 16, align: "right", describe: "issue number or date, short" }),
    S("headline-main", "headline", lead, { size: "headline", maxChars: 46, describe: "the lead cover line — the largest type on the canvas" }),
    S("sections-notes", "sections", second, { size: "subtitle", maxChars: 62, describe: "the second cover line: a supporting story" }),
    S("audience-who", "audience", third, { optional: true, size: "body", maxChars: 62, describe: "the third cover line: who or what else is inside" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "the footer: where to get it or who made it" }),
  ];
}

/** 13. Three stacked bands: head, artwork with an aside, then a three-up fact row. */
function threeBand(gap) {
  const [head, mid, low, footer] = vstack(frame(), [0.24, 0.42, 0.24, 0.1], gap);
  const [kicker, headline] = vstack(head, [0.3, 0.7], gap);
  const [art, aside] = hsplit(mid, [0.6, 0.4], gap);
  const [notes, cta] = vstack(aside, [0.66, 0.34], gap);
  const [when, where, who] = hsplit(low, [1, 1, 1], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "the focal artwork for the middle band" }),
    S("header-branding", "header", kicker, { optional: true, size: "body", maxChars: 26, describe: "organizer or event kicker, one short line" }),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 46, describe: "the main title — the largest type on the canvas" }),
    S("sections-notes", "sections", notes, { size: "body", maxChars: 80, describe: "a short block of supporting detail" }),
    S("cta-action", "cta", cta, { optional: true, size: "subtitle", maxChars: 28, describe: "the single call to action" }),
    S("details-when", "details", when, { size: "body", maxChars: 28, describe: "the date and time" }),
    S("details-where", "details", where, { size: "body", maxChars: 28, describe: "the venue or place" }),
    S("details-who", "audience", who, { size: "body", maxChars: 28, describe: "who this is for or who is hosting" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

/** 14. A gallery: headline over a grid of photographs, no captions to crowd it. */
function photoGrid(count, gap) {
  const [head, grid, notes, footer] = vstack(frame(), [0.22, 0.56, 0.12, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.62, 0.38], gap);
  const tiles = count === 6
    ? hsplit(grid, [1, 1, 1], gap).flatMap((col) => vstack(col, [1, 1], gap))
    : hsplit(grid, [1, 1], gap).flatMap((col) => vstack(col, [1, 1], gap));
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 46, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 56, describe: "one supporting line under the title" }),
  ];
  tiles.forEach((box, i) => {
    slots.push(S(`sections-photo-${i + 1}`, "sections", box, { kind: "image", asset: "photo", describe: `photograph ${i + 1} in the gallery` }));
  });
  slots.push(S("sections-notes", "sections", notes, { size: "body", maxChars: 90, describe: "one line of context for the gallery" }));
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

/** 15. One quotation, optionally inside a framing card, with an attribution. */
function quoteCard(framed, gap) {
  const [top, body, footer] = vstack(frame(), [0.12, 0.78, 0.1], gap);
  const [kicker, meta] = hsplit(top, [0.62, 0.38], gap);
  const card = framed
    ? rect(body.x + body.w * 0.06, body.y + body.h * 0.08, body.w * 0.88, body.h * 0.84)
    : body;
  const [quote, attribution, source] = vstack(card, [0.48, 0.2, 0.32], gap);
  return [
    DECOR_SLOT(),
    S("header-branding", "header", kicker, { optional: true, size: "body", maxChars: 30, describe: "organizer or event kicker, one short line" }),
    S("tagline-line", "tagline", meta, { optional: true, size: "body", maxChars: 18, align: "right", describe: "a short label, date or section, right-aligned" }),
    S("headline-quote", "headline", quote, { size: "display", maxChars: 72, align: "center", describe: "the quotation itself — the largest type on the canvas" }),
    S("tagline-attribution", "tagline", attribution, { size: "subtitle", maxChars: 40, align: "center", describe: "who said it" }),
    S("details-source", "details", source, { size: "body", maxChars: 70, align: "center", describe: "the supporting facts: where it is from, or what to do next" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "registration link, organizer or partner line" }),
  ];
}

/** 16. A vertical timeline: each row is a time gutter beside its entry. */
function timelineRows(compact, gap) {
  const [head, rows, footer] = vstack(frame(), [0.26, 0.64, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.62, 0.38], gap);
  const list = vstack(rows, compact ? [1, 1, 1, 1] : [1, 1, 1], gap);
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "display", maxChars: 40, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 56, describe: "one supporting line under the title" }),
  ];
  list.forEach((box, i) => {
    const [time, entry] = hsplit(box, [0.26, 0.74], gap);
    slots.push(S(`sections-time-${i + 1}`, "sections", time, { size: "subtitle", maxChars: 16, describe: `when step ${i + 1} happens` }));
    slots.push(S(`sections-entry-${i + 1}`, "sections", entry, { size: "subtitle", maxChars: 90, describe: `what happens at step ${i + 1}` }));
  });
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

/** 17. Two options side by side, each a name over its own set of rows. */
function comparisonTable(stacked, gap) {
  const [head, table, footer] = vstack(frame(), [0.22, 0.68, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.62, 0.38], gap);
  const [colA, colB] = stacked
    ? vstack(table, [1, 1], gap)
    : hsplit(table, [1, 1], gap);
  const [nameA, bodyA] = vstack(colA, [0.24, 0.76], gap);
  const [nameB, bodyB] = vstack(colB, [0.24, 0.76], gap);
  return [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 44, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 56, describe: "one supporting line under the title" }),
    S("sections-name-a", "sections", nameA, { size: "subtitle", maxChars: 30, describe: "the name of the first option" }),
    S("sections-body-a", "sections", bodyA, { size: "body", maxChars: 90, describe: "the first option's rows: one fact per line" }),
    S("sections-name-b", "sections", nameB, { size: "subtitle", maxChars: 30, describe: "the name of the second option" }),
    S("sections-body-b", "sections", bodyB, { size: "body", maxChars: 90, describe: "the second option's rows: one fact per line" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

/** 18. A roster: one portrait per person with the name and role beneath it. */
function teamRoster(count, gap) {
  const [head, cards, footer] = vstack(frame(), [0.22, 0.68, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.6, 0.4], gap);
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 44, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 56, describe: "one supporting line under the title" }),
  ];
  hsplit(cards, Array(count).fill(1), gap).forEach((col, i) => {
    const [portrait, caption] = vstack(col, [0.66, 0.34], gap);
    slots.push(S(`sections-portrait-${i + 1}`, "sections", portrait, { kind: "image", asset: "photo", describe: `portrait of person ${i + 1}` }));
    slots.push(S(`sections-caption-${i + 1}`, "sections", caption, { size: "body", maxChars: 34, describe: `name and role of person ${i + 1}` }));
  });
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

/** 19. A poster: the display type owns the canvas, facts sit in a bottom rail. */
function posterRail(gap) {
  const [head, rail, footer] = vstack(frame(), [0.64, 0.22, 0.14], gap);
  const [headline, tagline] = vstack(head, [0.56, 0.44], gap);
  const [when, where, who] = hsplit(rail, [1, 1, 1], gap);
  return [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "display", maxChars: 52, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 64, describe: "one supporting line under the title" }),
    S("details-when", "details", when, { size: "body", maxChars: 30, describe: "the date and time" }),
    S("details-where", "details", where, { size: "body", maxChars: 30, describe: "the venue or place" }),
    S("details-who", "audience", who, { size: "body", maxChars: 30, describe: "who this is for or who is hosting" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 90, describe: "registration link, organizer or partner line" }),
  ];
}

/** 20. A ticket: a main panel and a tear-off stub carrying the short facts. */
function ticketStub(side, gap) {
  const [body, footer] = vstack(frame(), [0.86, 0.14], gap);
  const [a, b] = hsplit(body, [0.68, 0.32], gap);
  const main = side === "left" ? a : b;
  const stub = side === "left" ? b : a;
  const [art, headline, tagline, facts] = vstack(main, [0.3, 0.3, 0.16, 0.24], gap);
  const [code, admit, price] = vstack(stub, [0.34, 0.33, 0.33], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "the artwork on the ticket's face" }),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 42, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 52, describe: "one supporting line under the title" }),
    S("details-info", "details", facts, { size: "body", maxChars: 54, describe: "the facts: date, time, doors and venue" }),
    S("sections-code", "sections", code, { size: "body", maxChars: 18, describe: "the reference, ticket number or gate" }),
    S("audience-who", "audience", admit, { size: "body", maxChars: 18, describe: "who it admits, or the ticket type" }),
    S("details-price", "details", price, { size: "subtitle", maxChars: 14, describe: "the price or entry condition" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

/** 21. An agenda: a time gutter and one entry per row. */
function agendaColumn(dense, gap) {
  const [head, list, footer] = vstack(frame(), [0.2, 0.7, 0.1], gap);
  const [headline, tagline] = hsplit(head, [0.66, 0.34], gap);
  const rows = vstack(list, dense ? [1, 1, 1, 1] : [1, 1, 1], gap);
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 40, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 30, describe: "the date or sitting, short" }),
  ];
  rows.forEach((box, i) => {
    const [time, entry] = hsplit(box, [0.24, 0.76], gap);
    slots.push(S(`sections-time-${i + 1}`, "sections", time, { size: "body", maxChars: 14, describe: `the time of agenda row ${i + 1}` }));
    slots.push(S(`sections-entry-${i + 1}`, "sections", entry, { size: "body", maxChars: 60, describe: `the agenda item at row ${i + 1}` }));
  });
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

/** 22. A located place: a map or venue panel beside its address block. */
function mapCard(side, gap) {
  const [head, body, footer] = vstack(frame(), [0.26, 0.64, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.6, 0.4], gap);
  const [a, b] = hsplit(body, [0.52, 0.48], gap);
  const art = side === "left" ? a : b;
  const info = side === "left" ? b : a;
  const [address, hours, cta] = vstack(info, [0.4, 0.34, 0.26], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "illustration", describe: "a map, floor plan or the venue's artwork" }),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 40, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 50, describe: "one supporting line under the title" }),
    S("details-address", "details", address, { size: "body", maxChars: 56, describe: "the address as grouped rows" }),
    S("sections-hours", "sections", hours, { size: "body", maxChars: 56, describe: "opening hours or service times" }),
    S("cta-action", "cta", cta, { optional: true, size: "subtitle", maxChars: 28, describe: "the single call to action, such as a booking line" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

/** 23. A shelf: three products in a row, a note line and one call to action. */
function productShelf(labelled, gap) {
  const [head, shelf, notes, footer] = vstack(frame(), [0.22, 0.5, 0.18, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.6, 0.4], gap);
  const [note, cta] = vstack(notes, [0.6, 0.4], gap);
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 40, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 52, describe: "one supporting line under the title" }),
  ];
  hsplit(shelf, [1, 1, 1], gap).forEach((col, i) => {
    if (labelled) {
      const [item, label] = vstack(col, [0.72, 0.28], gap);
      slots.push(S(`sections-item-${i + 1}`, "sections", item, { kind: "image", asset: "illustration", describe: `product or offer ${i + 1}` }));
      slots.push(S(`sections-label-${i + 1}`, "sections", label, { size: "body", maxChars: 26, describe: `name and price for product ${i + 1}` }));
    } else {
      slots.push(S(`sections-item-${i + 1}`, "sections", col, { kind: "image", asset: "illustration", describe: `product or offer ${i + 1}` }));
    }
  });
  slots.push(S("sections-notes", "sections", note, { size: "body", maxChars: 80, describe: "the terms: how long the offer runs and what it covers" }));
  slots.push(S("cta-action", "cta", cta, { optional: true, size: "subtitle", maxChars: 30, describe: "the single call to action" }));
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

/** 24. A certificate: formal, symmetric, with an optional seal. */
function certificateFormal(sealed, gap) {
  const [top, body, footer] = vstack(frame(), [0.12, 0.78, 0.1], gap);
  const [org, date] = hsplit(top, [0.62, 0.38], gap);
  const rows = sealed ? [0.34, 0.32, 0.34] : [0.34, 0.32, 0.34];
  const [title, recipient, statement] = vstack(body, rows, gap);
  const [awarded, seal] = sealed ? hsplit(statement, [0.7, 0.3], gap) : [statement, null];
  const slots = [
    DECOR_SLOT(),
    S("header-branding", "header", org, { optional: true, size: "body", maxChars: 30, describe: "the awarding organization" }),
    S("tagline-line", "tagline", date, { optional: true, size: "body", maxChars: 18, align: "right", describe: "the date of award, short" }),
    S("headline-main", "headline", title, { size: "display", maxChars: 40, align: "center", describe: "what is being awarded — the largest type on the canvas" }),
    S("sections-recipient", "sections", recipient, { size: "title", maxChars: 40, align: "center", describe: "the recipient's name" }),
    S("details-statement", "details", awarded, { size: "body", maxChars: 80, align: "center", describe: "the citation: what it is awarded for" }),
  ];
  if (seal) slots.push(S("sections-seal", "sections", seal, { kind: "image", asset: "illustration", optional: true, describe: "the seal or signature mark" }));
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 70, describe: "the signatory, reference or verification line" }));
  return slots;
}

/** 25. A social post: kicker, one big image, the line, the action. */
function socialPost(gap) {
  const [kicker, art, headline, action, footer] = vstack(frame(), [0.08, 0.4, 0.2, 0.2, 0.12], gap);
  return [
    DECOR_SLOT(),
    S("header-branding", "header", kicker, { optional: true, size: "body", maxChars: 30, describe: "a short kicker or handle at the top" }),
    S("hero-visual", "hero", art, { kind: "image", asset: "photo", describe: "the one image this post is about" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 44, describe: "the line — the largest type on the canvas" }),
    S("cta-action", "cta", action, { size: "subtitle", maxChars: 56, describe: "the action or question this post asks for" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 60, describe: "the handle, hashtag or link line" }),
  ];
}

/** 26. A newsletter: masthead, one lead item, then two columns of briefs. */
function newsletterMasthead(gap) {
  const [mast, lead, cols, footer] = vstack(frame(), [0.1, 0.26, 0.54, 0.1], gap);
  const [brand, issue] = hsplit(mast, [0.62, 0.38], gap);
  const [headline, tagline] = vstack(lead, [0.6, 0.4], gap);
  const [c1, c2] = hsplit(cols, [1, 1], gap);
  const [head1, items1] = vstack(c1, [0.26, 0.74], gap);
  const [head2, items2] = vstack(c2, [0.26, 0.74], gap);
  return [
    DECOR_SLOT(),
    S("header-branding", "header", brand, { optional: true, size: "body", maxChars: 26, describe: "the newsletter's name or the organizer" }),
    S("tagline-line", "tagline", issue, { optional: true, size: "body", maxChars: 18, align: "right", describe: "the issue number or date, short" }),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 44, describe: "the lead item's title — the largest type on the canvas" }),
    S("sections-lead", "sections", tagline, { size: "body", maxChars: 80, describe: "one sentence of lead-in for the top item" }),
    S("sections-head-1", "sections", head1, { size: "body", maxChars: 30, describe: "the first column's heading" }),
    S("sections-list-1", "sections", items1, { size: "body", maxChars: 90, describe: "the first column's items, one per line" }),
    S("sections-head-2", "sections", head2, { size: "body", maxChars: 30, describe: "the second column's heading" }),
    S("sections-list-2", "sections", items2, { size: "body", maxChars: 90, describe: "the second column's items, one per line" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

/** 27. One statement beside one image, with a fact band beneath. */
function statementSplit(side, gap) {
  const [body, band, footer] = vstack(frame(), [0.72, 0.18, 0.1], gap);
  const [a, b] = hsplit(body, [0.56, 0.44], gap);
  const text = side === "left" ? a : b;
  const art = side === "left" ? b : a;
  const [headline, attribution] = vstack(text, [0.66, 0.34], gap);
  const [when, where, who] = hsplit(band, [1, 1, 1], gap);
  return [
    DECOR_SLOT(),
    S("hero-visual", "hero", art, { kind: "image", asset: "photo", describe: "the image the statement is set against" }),
    S("headline-main", "headline", headline, { size: "display", maxChars: 54, describe: "the statement — the largest type on the canvas" }),
    S("tagline-attribution", "tagline", attribution, { size: "subtitle", maxChars: 44, describe: "who said it, or what it refers to" }),
    S("details-when", "details", when, { size: "body", maxChars: 30, describe: "the date and time" }),
    S("details-where", "details", where, { size: "body", maxChars: 30, describe: "the venue or place" }),
    S("details-who", "audience", who, { size: "body", maxChars: 30, describe: "who this is for or who is hosting" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 90, describe: "registration link, organizer or partner line" }),
  ];
}

/** 28. A metric panel: three headline numbers, a note and one action. */
function metricPanel(gap) {
  const [head, row, notes, footer] = vstack(frame(), [0.24, 0.4, 0.26, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.6, 0.4], gap);
  const [m1, m2, m3] = hsplit(row, [1, 1, 1], gap);
  const [note, cta] = hsplit(notes, [0.68, 0.32], gap);
  const metrics = [m1, m2, m3].map((box, i) =>
    S(`sections-metric-${i + 1}`, "sections", box, { size: "subtitle", maxChars: 40, align: "center", describe: `the figure and its label, number ${i + 1}` }),
  );
  return [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 42, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 56, describe: "one supporting line under the title" }),
    ...metrics,
    S("sections-notes", "sections", note, { size: "body", maxChars: 80, describe: "the source or qualifier for the figures" }),
    S("cta-action", "cta", cta, { optional: true, size: "subtitle", maxChars: 28, describe: "the single call to action" }),
    S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }),
  ];
}

/** 29. A menu sheet: dish rows with a price column. */
function menuSheet(gap) {
  const [head, list, footer] = vstack(frame(), [0.2, 0.7, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.62, 0.38], gap);
  const rows = vstack(list, [1, 1, 1], gap);
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "headline", maxChars: 40, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "body", maxChars: 52, describe: "one supporting line under the title" }),
  ];
  rows.forEach((box, i) => {
    const [dish, price] = hsplit(box, [0.76, 0.24], gap);
    slots.push(S(`sections-dish-${i + 1}`, "sections", dish, { size: "body", maxChars: 60, describe: `dish ${i + 1}: name and one line of description` }));
    slots.push(S(`details-price-${i + 1}`, "details", price, { size: "body", maxChars: 12, align: "right", describe: `the price of dish ${i + 1}` }));
  });
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

/** 30. A schedule of parallel tracks: one column per day, each a grouped list. */
function classSchedule(gap) {
  const [head, cols, footer] = vstack(frame(), [0.26, 0.64, 0.1], gap);
  const [headline, tagline] = vstack(head, [0.62, 0.38], gap);
  const slots = [
    DECOR_SLOT(),
    S("headline-main", "headline", headline, { size: "display", maxChars: 40, describe: "the main title — the largest type on the canvas" }),
    S("tagline-line", "tagline", tagline, { optional: true, size: "subtitle", maxChars: 56, describe: "one supporting line under the title" }),
  ];
  hsplit(cols, [1, 1, 1], gap).forEach((col, i) => {
    slots.push(S(`sections-col-${i + 1}`, "sections", col, { size: "subtitle", maxChars: 110, describe: `the day ${i + 1} column: a heading plus its timed rows` }));
  });
  slots.push(S("footer-registration", "footer", footer, { size: "body", maxChars: 80, describe: "registration link, organizer or partner line" }));
  return slots;
}

// --- the template table --------------------------------------------------

const TABLE = [
  {
    id: "hero-split",
    label: "Hero split",
    blurb: "artwork beside a stacked type column",
    type: "poster",
    mood: ["bold", "editorial", "energetic"],
    density: "normal",
    tags: ["event", "launch", "campaign", "artwork", "two-column", "hero"],
    description:
      "A general-purpose announcement: one strong artwork beside a stacked column holding the title, a supporting line and the facts. Fits launches, conferences, festivals and campaigns where the artwork carries the theme.",
    sizes: ["wide", "landscape", "square"],
    keywords: ["event", "announcement", "launch", "conference", "summit", "meetup", "webinar", "poster", "campaign", "festival", "concert", "performance", "showcase", "sports", "hackathon", "bootcamp"],
    generic: true,
    variants: [
      { id: "hero-right", label: "artwork on the right" },
      { id: "hero-left", label: "artwork on the left" },
    ],
    build: (variant, gap) => heroSplit(variant === "hero-left" ? "right" : "left", gap),
  },
  {
    id: "hero-top",
    label: "Hero band",
    blurb: "a full-width artwork band above a stacked type block",
    type: "cover",
    mood: ["editorial", "clean", "confident"],
    density: "normal",
    tags: ["cover", "article", "feature", "band", "artwork", "editorial"],
    description:
      "A wide artwork band across the top with the type stacked beneath it. Suits articles, features, report covers and blog headers, and any brief that is more editorial than promotional.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["cover", "magazine", "report", "feature", "blog", "article", "profile", "editorial"],
    variants: [
      { id: "art-top", label: "artwork on top" },
      { id: "art-bottom", label: "artwork at the bottom" },
    ],
    build: (variant, gap) => heroTop(variant !== "art-bottom", gap),
  },
  {
    id: "centered-poster",
    label: "Centered poster",
    blurb: "type-first, centered, no artwork required",
    type: "notice",
    mood: ["formal", "calm", "direct"],
    density: "normal",
    tags: ["notice", "invitation", "certificate", "award", "type-only", "centered"],
    description:
      "A type-first centred announcement that needs no artwork: a kicker, a large centred title, a supporting line and the facts. Right for notices, invitations, certificates, awards and formal circulars.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["notice", "memo", "circular", "invitation", "certificate", "award", "thank", "farewell"],
    generic: true,
    variants: [
      { id: "center-stack", label: "one centered column" },
      { id: "center-split", label: "details beside a who-this-is-for column" },
    ],
    build: (variant, gap) => centeredPoster(variant === "center-split", gap),
  },
  {
    id: "editorial-columns",
    label: "Editorial columns",
    blurb: "headline bar over two or three content columns",
    type: "newsletter",
    mood: ["editorial", "informative", "calm"],
    density: "dense",
    tags: ["newsletter", "digest", "roundup", "columns", "text-heavy"],
    description:
      "A headline bar above two or three columns of grouped content. Built for newsletters, digests, programme rundowns and any brief whose weight is information rather than image.",
    sizes: ["wide", "landscape", "square"],
    keywords: ["newsletter", "digest", "roundup", "overview", "highlights", "programme", "program", "agenda", "tracks"],
    variants: [
      { id: "three-column", label: "three equal columns" },
      { id: "feature-sidebar", label: "feature column plus a sidebar" },
    ],
    build: (variant, gap) => editorialColumns(variant === "three-column", gap),
  },
  {
    id: "banner-strip",
    label: "Banner strip",
    blurb: "one wide headline with a three-up detail row",
    type: "banner",
    mood: ["clean", "corporate", "calm"],
    density: "airy",
    tags: ["banner", "web", "social", "header", "wide"],
    description:
      "A single wide headline with a three-up row of facts beneath it. Made for web banners, social headers and wide timeline covers where the whole message must read at a glance.",
    sizes: ["wide", "landscape"],
    keywords: ["banner", "website", "linkedin", "timeline", "web banner"],
    variants: [
      { id: "strip-centered", label: "centered strip" },
      { id: "strip-left", label: "left-aligned strip" },
    ],
    build: (_variant, gap) => bannerStrip(gap),
  },
  {
    id: "card-grid",
    label: "Card grid",
    blurb: "headline plus a grid of content cards",
    type: "menu",
    mood: ["friendly", "organised", "playful"],
    density: "dense",
    tags: ["cards", "grid", "menu", "pricing", "features", "services"],
    description:
      "A headline over a grid of equal cards, each holding a short title and one line of detail. The natural shape for menus, price plans, feature lists, class cards and sponsor boards.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["workshop", "classes", "courses", "menu", "pricing", "plans", "features", "benefits", "services", "sessions", "speakers", "sponsors", "team"],
    variants: [
      { id: "grid-2x2", label: "four cards (2 x 2)" },
      { id: "grid-1x3", label: "three cards in a row" },
    ],
    build: (variant, gap) => cardGrid(variant === "grid-1x3" ? 3 : 4, gap),
  },
  {
    id: "story-stack",
    label: "Story stack",
    blurb: "a tall photo with the type stacked underneath",
    type: "social",
    mood: ["warm", "personal", "playful"],
    density: "normal",
    tags: ["story", "reel", "photo", "vertical", "social"],
    description:
      "One tall photograph with the type stacked underneath it. Built for vertical stories, reels, travel and journey pieces, and photo-led social posts.",
    sizes: ["square", "portrait", "tall"],
    keywords: ["story", "reel", "update", "photo", "travel", "journey", "portrait", "testimonial", "recap"],
    generic: true,
    variants: [
      { id: "bleed-photo", label: "full-bleed photo" },
      { id: "framed-photo", label: "framed photo" },
    ],
    build: (variant, gap) => storyStack(variant !== "framed-photo", gap),
  },
  {
    id: "statement-quote",
    label: "Statement",
    blurb: "one large statement with an attribution",
    type: "statement",
    mood: ["calm", "formal", "bold"],
    density: "airy",
    tags: ["quote", "statement", "mission", "slogan", "type-only"],
    description:
      "One large statement with an attribution and its supporting facts. The right container for quotes, missions, visions, pledges and slogans, where a single sentence is the whole design.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["quote", "statement", "pledge", "mission", "vision", "manifesto", "thought", "belief", "slogan"],
    variants: [
      { id: "statement-center", label: "centered statement" },
      { id: "statement-left", label: "left-aligned statement" },
    ],
    build: (variant, gap) => statementQuote(variant !== "statement-left", gap),
  },
  {
    id: "event-listing",
    label: "Event listing",
    blurb: "the when/where facts beside the programme",
    type: "listing",
    mood: ["organised", "informative", "formal"],
    density: "dense",
    tags: ["listing", "schedule", "agenda", "programme", "facts"],
    description:
      "The when-and-where facts beside the programme or agenda. Suits event listings, schedules, timetables, expos and orientation sheets that must present many timed rows clearly.",
    sizes: ["landscape", "square", "portrait", "tall"],
    keywords: ["listing", "schedule", "timetable", "itinerary", "mela", "expo", "fair", "seminar", "orientation"],
    variants: [
      { id: "facts-left", label: "facts on the left" },
      { id: "facts-right", label: "facts on the right" },
    ],
    build: (variant, gap) => eventListing(variant === "facts-right" ? "right" : "left", gap),
  },
  {
    id: "feature-cta",
    label: "Feature + CTA",
    blurb: "artwork with benefits and one call to action",
    type: "product",
    mood: ["bold", "urgent", "commercial"],
    density: "normal",
    tags: ["product", "sale", "offer", "cta", "benefits", "artwork"],
    description:
      "Artwork beside a list of benefits and one prominent call to action. Designed for product launches, sales, offers, sign-ups and donation asks where the design must convert.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["product", "sale", "offer", "discount", "app", "signup", "register", "subscribe", "join", "donate", "enrol", "enroll"],
    generic: true,
    variants: [
      { id: "art-left", label: "artwork on the left" },
      { id: "art-right", label: "artwork on the right" },
    ],
    build: (variant, gap) => featureCta(variant === "art-right" ? "right" : "left", gap),
  },
  {
    id: "sidebar-rail",
    label: "Sidebar rail",
    blurb: "a narrow facts rail beside the content column",
    type: "poster",
    mood: ["editorial", "organised", "technical"],
    density: "normal",
    tags: ["sidebar", "rail", "facts", "artwork", "two-column"],
    description:
      "A narrow rail down one side carrying the kicker, the facts and the action, with the artwork, title and supporting line in the wider column. Good for information-dense briefs that still want one strong image.",
    sizes: ["wide", "landscape", "square"],
    keywords: ["sidebar", "rail", "specification", "details", "handbook", "guide"],
    variants: [
      { id: "rail-left", label: "facts rail on the left" },
      { id: "rail-right", label: "facts rail on the right" },
    ],
    build: (variant, gap) => sidebarRail(variant === "rail-right" ? "right" : "left", gap),
  },
  {
    id: "magazine-cover",
    label: "Magazine cover",
    blurb: "masthead, one cover image, then the cover lines",
    type: "cover",
    mood: ["editorial", "luxe", "bold"],
    density: "normal",
    tags: ["cover", "magazine", "issue", "cover-lines", "publication"],
    description:
      "A masthead and issue line, one full-width cover image, then the cover lines stacked beneath. Built for magazine and journal covers, issue launches and publication front pages.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["magazine", "issue", "journal", "publication", "cover story", "edition"],
    variants: [
      { id: "art-band", label: "cover image as a band" },
      { id: "art-tall", label: "taller cover image" },
    ],
    build: (_variant, gap) => magazineCover(gap),
  },
  {
    id: "three-band",
    label: "Three bands",
    blurb: "head band, artwork band, fact band",
    type: "poster",
    mood: ["bold", "organised", "confident"],
    density: "normal",
    tags: ["bands", "artwork", "facts", "three-part"],
    description:
      "Three clean bands top to bottom: the title, the artwork with a note and call to action beside it, then a three-up row of facts. A steady, poster-like structure for events and launches with a lot to say.",
    sizes: ["wide", "landscape", "square"],
    keywords: ["three band", "event flyer", "open day", "workshop", "seminar", "conference"],
    variants: [
      { id: "note-right", label: "note and action beside the artwork" },
      { id: "note-below", label: "note and action under the artwork" },
    ],
    build: (_variant, gap) => threeBand(gap),
  },
  {
    id: "photo-grid",
    label: "Photo grid",
    blurb: "a headline over a grid of photographs",
    type: "gallery",
    mood: ["warm", "editorial", "playful"],
    density: "normal",
    tags: ["gallery", "photo", "grid", "recap", "collage"],
    description:
      "A headline and supporting line over a grid of photographs. The shape for galleries, event recaps, photo-of-the-week posts and any brief where several images must share the canvas.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["gallery", "photos", "recap", "highlights", "album", "collage", "moments"],
    variants: [
      { id: "four-up", label: "four photographs" },
      { id: "six-up", label: "six photographs" },
    ],
    build: (variant, gap) => photoGrid(variant === "six-up" ? 6 : 4, gap),
  },
  {
    id: "quote-card",
    label: "Quote card",
    blurb: "a framed quotation with its attribution",
    type: "quote",
    mood: ["calm", "luxe", "formal"],
    density: "airy",
    tags: ["quote", "card", "testimonial", "framed", "centered"],
    description:
      "A single quotation, centred and optionally inside a framing card, with the attribution and the source facts below. For testimonials, pull-quotes, founder notes and words-of-the-day cards.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["quote", "testimonial", "pull quote", "words of wisdom", "saying"],
    variants: [
      { id: "card-plain", label: "no frame" },
      { id: "card-framed", label: "inset framing card" },
    ],
    build: (variant, gap) => quoteCard(variant === "card-framed", gap),
  },
  {
    id: "timeline",
    label: "Timeline",
    blurb: "step-by-step rows with a time gutter",
    type: "timeline",
    mood: ["organised", "informative", "clean"],
    density: "dense",
    tags: ["timeline", "steps", "process", "schedule", "rows"],
    description:
      "Rows of steps or times, each with its label in a narrow gutter beside the entry. For timelines, agendas, processes, roadmaps and itineraries where order matters.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["timeline", "roadmap", "process", "steps", "journey", "milestones", "itinerary"],
    variants: [
      { id: "three-steps", label: "three steps" },
      { id: "four-steps", label: "four steps" },
    ],
    build: (variant, gap) => timelineRows(variant === "four-steps", gap),
  },
  {
    id: "comparison",
    label: "Comparison",
    blurb: "two options side by side, each with its rows",
    type: "comparison",
    mood: ["corporate", "technical", "calm"],
    density: "dense",
    tags: ["comparison", "options", "plans", "versus", "table"],
    description:
      "Two named options side by side, each with its own set of rows. For plan comparisons, before-and-after, versus pieces and any either/or brief with two symmetric halves.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["comparison", "versus", "compare", "options", "plans", "before and after", "either"],
    variants: [
      { id: "side-by-side", label: "side by side" },
      { id: "stacked", label: "stacked one above the other" },
    ],
    build: (variant, gap) => comparisonTable(variant === "stacked", gap),
  },
  {
    id: "team-roster",
    label: "Team roster",
    blurb: "portraits in a row, each with a name",
    type: "roster",
    mood: ["friendly", "corporate", "warm"],
    density: "normal",
    tags: ["team", "roster", "portraits", "people", "speakers"],
    description:
      "Portraits in a row with a name and role under each one. For team introductions, speaker line-ups, cast lists and staff announcements.",
    sizes: ["wide", "landscape", "square"],
    keywords: ["team", "roster", "speakers", "panel", "cast", "staff", "members", "lineup"],
    variants: [
      { id: "three-up", label: "three portraits" },
      { id: "four-up", label: "four portraits" },
    ],
    build: (variant, gap) => teamRoster(variant === "four-up" ? 4 : 3, gap),
  },
  {
    id: "poster-rail",
    label: "Poster rail",
    blurb: "display type over a three-up fact rail",
    type: "poster",
    mood: ["bold", "minimal", "confident"],
    density: "airy",
    tags: ["poster", "type", "rail", "minimal", "facts"],
    description:
      "The title and its supporting line own the upper two thirds; the facts sit in a three-up rail at the bottom. A spare, poster-like shape for a strong title with only a few facts to carry.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["poster", "announcement", "big type", "save the date", "reveal", "concert", "gig", "music", "band", "festival", "lineup", "live show"],
    variants: [
      { id: "rail-centered", label: "centered type" },
      { id: "rail-left", label: "left-aligned type" },
    ],
    build: (_variant, gap) => posterRail(gap),
  },
  {
    id: "ticket",
    label: "Ticket",
    blurb: "a main panel with a tear-off stub",
    type: "ticket",
    mood: ["bold", "playful", "energetic"],
    density: "normal",
    tags: ["ticket", "stub", "admission", "pass", "event"],
    description:
      "A ticket face with a tear-off stub carrying the reference, the admission type and the price. For tickets, passes, invitations with a stub and admission cards.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["ticket", "pass", "admission", "stub", "entry", "seat", "gate"],
    variants: [
      { id: "stub-right", label: "stub on the right" },
      { id: "stub-left", label: "stub on the left" },
    ],
    build: (variant, gap) => ticketStub(variant === "stub-left" ? "left" : "right", gap),
  },
  {
    id: "agenda",
    label: "Agenda",
    blurb: "timed rows under a short title",
    type: "schedule",
    mood: ["organised", "formal", "clean"],
    density: "dense",
    tags: ["agenda", "schedule", "times", "meeting", "rows"],
    description:
      "A short title and date above timed rows, each time in its own gutter. Built for meeting agendas, class schedules, service times and run-of-show sheets.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["agenda", "schedule", "run of show", "meeting", "minutes", "timetable", "session"],
    variants: [
      { id: "three-rows", label: "three rows" },
      { id: "four-rows", label: "four rows" },
    ],
    build: (variant, gap) => agendaColumn(variant === "four-rows", gap),
  },
  {
    id: "map-card",
    label: "Map card",
    blurb: "a map or venue panel beside the address",
    type: "map",
    mood: ["calm", "friendly", "clean"],
    density: "normal",
    tags: ["map", "venue", "address", "directions", "location"],
    description:
      "A map, floor plan or venue artwork beside the address block, opening hours and a booking line. For location announcements, store openings, directions and venue cards.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["map", "directions", "location", "venue", "address", "store opening", "how to find"],
    variants: [
      { id: "map-left", label: "map on the left" },
      { id: "map-right", label: "map on the right" },
    ],
    build: (variant, gap) => mapCard(variant === "map-right" ? "right" : "left", gap),
  },
  {
    id: "product-shelf",
    label: "Product shelf",
    blurb: "three products in a row with one action",
    type: "product",
    mood: ["commercial", "clean", "urgent"],
    density: "normal",
    tags: ["products", "shelf", "shop", "offer", "cta"],
    description:
      "Three products or offers in a row, a terms line and one call to action. For product ranges, shop drops, multi-item offers and bundle announcements.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["products", "collection", "range", "shop", "bundle", "bestsellers", "new arrivals"],
    variants: [
      { id: "labelled", label: "with a name and price under each" },
      { id: "images-only", label: "images only" },
    ],
    build: (variant, gap) => productShelf(variant !== "images-only", gap),
  },
  {
    id: "certificate",
    label: "Certificate",
    blurb: "a formal award with an optional seal",
    type: "certificate",
    mood: ["formal", "luxe", "calm"],
    density: "airy",
    tags: ["certificate", "award", "recognition", "formal", "seal"],
    description:
      "A formal, symmetric award: the organization, the award title, the recipient's name, the citation and an optional seal and signatory line. For certificates, awards and recognition.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["certificate", "award", "recognition", "appreciation", "diploma", "honours", "graduation"],
    variants: [
      { id: "with-seal", label: "with a seal" },
      { id: "without-seal", label: "text only" },
    ],
    build: (variant, gap) => certificateFormal(variant === "with-seal", gap),
  },
  {
    id: "social-post",
    label: "Social post",
    blurb: "kicker, one image, the line, the action",
    type: "social",
    mood: ["friendly", "bold", "playful"],
    density: "normal",
    tags: ["social", "post", "square", "image", "cta"],
    description:
      "A kicker, one image, the line and the action stacked down the canvas. The everyday social post shape for square and portrait feeds where one image carries the message.",
    sizes: ["square", "portrait", "tall"],
    keywords: ["social post", "instagram", "feed", "post", "caption", "handle"],
    variants: [
      { id: "image-middle", label: "image in the middle" },
      { id: "image-lower", label: "image in the lower half" },
    ],
    build: (_variant, gap) => socialPost(gap),
  },
  {
    id: "newsletter",
    label: "Newsletter",
    blurb: "masthead, a lead item, then two columns of briefs",
    type: "newsletter",
    mood: ["editorial", "informative", "friendly"],
    density: "dense",
    tags: ["newsletter", "email", "digest", "columns", "masthead"],
    description:
      "A masthead and issue line, one lead item, then two columns of shorter items. For newsletters, email headers, digests and bulletins with a lead story.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["newsletter", "bulletin", "digest", "issue", "subscribe", "update"],
    variants: [
      { id: "lead-then-columns", label: "lead item then two columns" },
      { id: "flat-columns", label: "flat two-column briefs" },
    ],
    build: (_variant, gap) => newsletterMasthead(gap),
  },
  {
    id: "statement-split",
    label: "Statement split",
    blurb: "one statement beside one image",
    type: "statement",
    mood: ["calm", "bold", "warm"],
    density: "normal",
    tags: ["statement", "image", "split", "quote", "manifesto"],
    description:
      "A statement set beside a single image, with a fact band beneath. For manifestos, campaign lines, values statements and any one-sentence idea that needs an image to hold it.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["statement", "manifesto", "values", "campaign line", "belief", "message"],
    variants: [
      { id: "text-left", label: "statement on the left" },
      { id: "text-right", label: "statement on the right" },
    ],
    build: (variant, gap) => statementSplit(variant === "text-right" ? "right" : "left", gap),
  },
  {
    id: "metrics-panel",
    label: "Metrics panel",
    blurb: "three headline numbers with a note",
    type: "metrics",
    mood: ["corporate", "clean", "confident"],
    density: "normal",
    tags: ["metrics", "numbers", "results", "stats", "report"],
    description:
      "Three headline figures in a row, a note about their source and one call to action. For results, impact reports, quarterly summaries and milestone announcements.",
    sizes: ["wide", "landscape", "square"],
    keywords: ["metrics", "results", "numbers", "stats", "impact", "report", "milestone", "growth"],
    variants: [
      { id: "three-metrics", label: "three figures" },
      { id: "figures-and-notes", label: "figures with a longer note" },
    ],
    build: (_variant, gap) => metricPanel(gap),
  },
  {
    id: "menu-sheet",
    label: "Menu sheet",
    blurb: "dish rows with a price column",
    type: "menu",
    mood: ["warm", "luxe", "friendly"],
    density: "dense",
    tags: ["menu", "food", "prices", "dishes", "list"],
    description:
      "Dish rows with the name and description on the left and the price on the right. For menus, tasting lists, service lists and priced schedules.",
    sizes: ["wide", "landscape", "square", "portrait", "tall"],
    keywords: ["menu", "dishes", "food", "drinks", "price list", "specials", "tasting"],
    variants: [
      { id: "three-courses", label: "three rows" },
      { id: "four-courses", label: "four rows" },
    ],
    build: (_variant, gap) => menuSheet(gap),
  },
  {
    id: "class-schedule",
    label: "Class schedule",
    blurb: "parallel columns, one per day",
    type: "schedule",
    mood: ["organised", "friendly", "clean"],
    density: "dense",
    tags: ["schedule", "classes", "columns", "weekly", "times"],
    description:
      "Three parallel columns, one per day or track, each a heading with its timed rows. For class timetables, weekly schedules, track lists and multi-day programmes.",
    sizes: ["wide", "landscape", "square", "portrait"],
    keywords: ["timetable", "weekly schedule", "classes", "days", "tracks", "roster", "programme"],
    variants: [
      { id: "three-days", label: "three days" },
      { id: "compact", label: "compact columns" },
    ],
    build: (_variant, gap) => classSchedule(gap),
  },
];

/**
 * The library. Example copy is attached here rather than inline so the table
 * stays geometry + metadata and the content lives in one reviewable data
 * module. L4 consumes it as a one-shot via templateExample().
 */
const allTemplates = [
  ...TABLE,
  ...JSON_TABLE,
  ...EXTRA_TABLE
].filter((t) => t.id !== "event-listing")
.filter((t) => !['map-card','ticket','product-shelf'].includes(t.id))
.map((t) => ({
  ...t,
  examples: { ...t.examples, ...EXAMPLES[t.id] }
}));
export const TEMPLATES = Object.freeze(allTemplates);

/** Every slot of a template across all its variants, first occurrence wins. */
export function templateSlots(template) {
  if (!template) return [];
  const seen = new Map();
  for (const variant of template.variants) {
    for (const slot of template.build(variant.id, GUTTER)) {
      if (!seen.has(slot.id)) seen.set(slot.id, slot);
    }
  }
  return [...seen.values()];
}

/**
 * The closest example line for one slot of a template. "Closest" is lexical:
 * the example sharing the most words with the brief wins, ties break on
 * declaration order, so this is deterministic and costs no model call.
 */
export function templateExample(templateOrId, slotId, brief) {
  const template = typeof templateOrId === "string" ? getTemplate(templateOrId) : templateOrId;
  const options = template?.examples?.[slotId];
  if (!Array.isArray(options) || !options.length) return "";
  if (options.length === 1) return options[0];
  const words = new Set(
    briefText(brief)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
  let best = options[0];
  let bestScore = -1;
  for (const option of options) {
    const hits = String(option)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => words.has(w)).length;
    if (hits > bestScore) {
      bestScore = hits;
      best = option;
    }
  }
  return best;
}

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

/** Aspect bucket of a canvas. Templates declare which buckets they suit. */
export function sizeClassOf(canvas) {
  const w = Number(canvas?.width) || 1080;
  const h = Number(canvas?.height) || 1080;
  const ratio = w / h;
  if (ratio >= 1.6) return "wide";
  if (ratio >= 1.15) return "landscape";
  if (ratio >= 0.9) return "square";
  if (ratio >= 0.65) return "portrait";
  return "tall";
}

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

export function getVariant(template, id) {
  if (!template) return null;
  return template.variants.find((v) => v.id === id) || template.variants[0];
}

export function briefText(goal) {
  if (!goal) return "";
  return [goal.style, goal.tone, goal.summary, goal.subject, goal.purpose, ...(Array.isArray(goal.mustInclude) ? goal.mustInclude : [])]
    .filter((s) => typeof s === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * The tuning schema emits arrays of {id, factor}/{id, value} because nested
 * `additionalProperties` schemas are not portable through llama.cpp's grammar
 * converter; accept the map form too so a hand-written patch still works.
 */
function tuningEntries(value, valueKeys) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => [
        String(entry.id ?? ""),
        valueKeys.map((k) => entry[k]).find((v) => v !== undefined),
      ]);
  }
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

/**
 * Step (b): sanitize the model's tuning patch. Unknown keys are dropped,
 * numbers are clamped, only optional slots may be hidden, and boxes are never
 * read from the model — only the bounded vocabulary below survives.
 */
export function sanitizeTuning(raw, template) {
  const out = { variant: template?.variants?.[0]?.id || "", density: "dense", hide: [], scale: {}, align: {}, images: {} };
  if (!raw || typeof raw !== "object") return out;
  if (template) {
    const wanted = String(raw.variant ?? raw.variantId ?? "");
    if (template.variants.some((v) => v.id === wanted)) out.variant = wanted;
  }
  if (["tight", "normal", "airy"].includes(raw.density)) out.density = raw.density;

  const gap = GUTTER * DENSITY[out.density];
  const slots = template ? template.build(out.variant, gap) : [];
  const byId = new Map(slots.map((s) => [s.id, s]));

  const hide = new Set();
  for (const id of Array.isArray(raw.hide) ? raw.hide : []) hide.add(String(id));
  for (const patch of Array.isArray(raw.slots) ? raw.slots : []) {
    if (!patch || typeof patch !== "object") continue;
    if (patch.hide === true || patch.show === false) hide.add(String(patch.id));
  }
  for (const id of hide) {
    if (byId.get(id)?.optional) out.hide.push(id);
  }

  for (const [id, value] of tuningEntries(raw.scale, ["factor", "value", "scale"])) {
    if (!byId.has(id)) continue;
    const n = Number(value);
    if (Number.isFinite(n)) out.scale[id] = Math.min(1.25, Math.max(0.75, n));
  }

  for (const [id, value] of tuningEntries(raw.align, ["value", "align"])) {
    if (!byId.has(id)) continue;
    if (["left", "center", "right"].includes(value)) out.align[id] = value;
  }

  for (const item of Array.isArray(raw.images) ? raw.images : []) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id ?? "");
    const query = String(item.query ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!query) continue;
    if (byId.get(id)?.kind !== "image") continue;
    out.images[id] = query;
  }
  return out;
}

function geometryMaxChars(box, fontSize) {
  const cap = Math.max(2, box.width / (fontSize * 0.55));
  const lines = Math.max(1, Math.floor(box.height / (fontSize * 1.2)));
  return Math.max(4, Math.min(200, Math.floor(cap) * lines));
}

function scaleImageBox(box, factor, canvas) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const width = Math.round(box.width * factor);
  const height = Math.round(box.height * factor);
  const x = Math.max(0, Math.min(canvas.width - width, Math.round(cx - width / 2)));
  const y = Math.max(0, Math.min(canvas.height - height, Math.round(cy - height / 2)));
  return { x, y, width, height };
}

/**
 * Deterministic instantiation: template + tuning + canvas -> the SAME plan
 * shape the rest of the pipeline already consumes, so the build loop, the
 * quality gate and the collision tidy are untouched.
 *
 * @returns {{ok:true, components:Array, tuning:object, template:string} | {ok:false, reason:string}}
 */
export function instantiateTemplate(templateOrId, rawTuning, canvas) {
  const template = typeof templateOrId === "string" ? getTemplate(templateOrId) : templateOrId;
  if (!template) return { ok: false, reason: "unknown template" };
  const width = Number(canvas?.width) || 0;
  const height = Number(canvas?.height) || 0;
  if (!(width > 0) || !(height > 0)) return { ok: false, reason: "no canvas" };

  const tuning = sanitizeTuning(rawTuning, template);
  const gap = GUTTER * DENSITY[tuning.density];
  const slots = template.build(tuning.variant, gap).filter((s) => !tuning.hide.includes(s.id));
  if (!slots.length) return { ok: false, reason: "every slot was hidden" };

  const components = [];
  for (const slot of slots) {
    const isText = slot.kind !== "image" && slot.role !== "decoration";
    // The template's own size comes FROM the type scale; the model's bounded
    // tune is then a real multiplier on top of it (snapping the tuned value
    // back onto the scale would make a +12% headline a no-op).
    const baseFont = snapFontSize(sizeToPx(slot.size, height), height);
    const factor = tuning.scale[slot.id] || 1;
    // The quality gate treats <12px as unreadable at export. Do not plan type
    // below that floor: on a wide 630px canvas the `small` token resolves to
    // 8px, which makes brand, eyebrow and footer labels disappear in print.
    const fontSize = isText ? Math.max(12, Math.round(baseFont * factor)) : 0;
    // Text slots keep their box (the template's partition is authoritative)
    // and move their TYPE instead; artwork boxes may grow or shrink.
    let box = {
      x: Math.round(slot.box.x * width),
      y: Math.round(slot.box.y * height),
      width: Math.round(slot.box.w * width),
      height: Math.round(slot.box.h * height),
    };
    box = snapBox(box, GRID, { width, height });
    if (slot.kind === "image" && factor !== 1) box = scaleImageBox(box, factor, { width, height });
    const maxChars = isText && slot.maxChars > 0 ? Math.min(slot.maxChars, geometryMaxChars(box, fontSize)) : 0;
    components.push({
      id: slot.id,
      kind: slot.kind,
      role: slot.role,
      asset: slot.asset,
      describe: slot.describe,
      sample: slot.sample || "",
      box,
      fontSize,
      maxChars,
      align: tuning.align[slot.id] || slot.align,
      size: slot.size,
      optional: slot.optional,
    });
  }

  // Scale can only move artwork boxes, so collisions are possible there and
  // only there. Reverting a growing box to its template rectangle always
  // restores the partition, so this terminates.
  for (let i = 0; i < components.length; i++) {
    const a = components[i];
    if (a.kind !== "image" || (tuning.scale[a.id] || 1) === 1) continue;
    for (let j = 0; j < components.length; j++) {
      if (i === j) continue;
      const b = components[j];
      if (b.role === "decoration") continue;
      const overlapX = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
      const overlapY = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
      if (overlapX > 0 && overlapY > 0) {
        const slot = slots[i];
        a.box = snapBox(
          { x: Math.round(slot.box.x * width), y: Math.round(slot.box.y * height), width: Math.round(slot.box.w * width), height: Math.round(slot.box.h * height) },
          GRID,
          { width, height },
        );
        break;
      }
    }
  }

  const area = components
    .filter((c) => c.role !== "decoration")
    .reduce((sum, c) => sum + c.box.width * c.box.height, 0);
  if (area / (width * height) < 0.25) return { ok: false, reason: "template covers too little of the canvas" };

  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i];
      const b = components[j];
      if (a.role === "decoration" || b.role === "decoration") continue;
      const overlapX = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
      const overlapY = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
      if (overlapX > 0 && overlapY > 0) {
        return { ok: false, reason: `template collided: ${a.id} / ${b.id}` };
      }
    }
  }

  return { ok: true, components, tuning, template: template.id, style: template.label };
}

/** Every template/variant pair, for menus and exhaustive tests. */
export function allTemplateVariants() {
  return TEMPLATES.flatMap((t) => t.variants.map((v) => ({ template: t, variant: v })));
}
