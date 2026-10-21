/**
 * L3c — the copy deck.
 *
 * One bounded call writes the words for every text region AFTER the template
 * has been chosen and tuned. The per-region L4 call then lays those lines out;
 * it no longer has to invent copy, obey role rules and fit a box at the same
 * time. This is the smallest change that removes the "Available now" /
 * "Diwali · Happy" class of failure without replacing the model.
 *
 * The output is a map from region id to an array of text lines. The schema is
 * generated per template so every region is required and every array is
 * bounded. The static rules are shared with the repair prompt, so a warmed
 * prefix still helps the second call.
 */

import { formatGoal } from "./layerPrompt";
import {
  extractBrand,
  extractGreeting,
  extractOccasionTagline,
  isRecipientComponent,
  isSourceDetails,
  occasionMessage,
  recipientLine,
  sourceMessage,
} from "./copySanitize";

export const COPY_RULES = [
  "[System]",
  "You are the copy director of a design pipeline. Write the exact words that will be printed in a chosen template.",
  "The brief describes the design and its requirements. Never copy the brief into the design.",
  "Copy rules:",
  "- Write in the reader's voice, for the person receiving the design.",
  "- Never describe the design, the template, the layout or the brief. Bad: \"A festive greeting card wishing a Happy Diwali\". Good: \"Happy Diwali\".",
  "- Use only facts stated in the brief or original request. Never invent dates, venues, names, prices, URLs, availability or sponsors.",
  "- Greeting or celebration briefs lead with the greeting and sign it from the organiser. Do not use product-launch language such as \"Available now\".",
  "- A greeting headline is the greeting itself (\"Happy Diwali\"), never just the brand name. A recipient region names the person or audience (\"To our clients and community\"), never the design type.",
  "- A region described as \"who said it\" or \"attribution\" names the person or organisation. Never use an audience, language, date or keyword label there.",
  "- A footer uses a real link, date, organiser, action or greeting. Do not claim availability unless the brief states it.",
  "- A CTA starts with an action verb: RSVP, Get tickets, Learn more, See the lineup, View the menu.",
  "- A tagline is one short supporting line (\"Festival of Lights\"), never \"Diwali Greeting\" and never a list of keywords joined by dots.",
  "- Details use exact facts from the request, or a short greeting when the design is a greeting. Never print requirement labels or production notes such as \"at least 16px\".",
  "- Do not copy the template description or any sample line.",
  "- Each region is an array of lines. One line = one text element; obey the line count and total character budget shown for the region.",
  "- Keep every line short enough for its box. Do not add labels, bullets, quotes around the values, or Markdown.",
  "Return ONLY valid JSON mapping each region id to its array of strings.",
].join("\n");

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** How many text elements a region can reasonably hold. */
export function copyLineLimit(component) {
  const id = String(component?.id || "").toLowerCase();
  switch (component?.role) {
    case "sections":
      return /caption|item|row/.test(id) ? 2 : 6;
    case "details":
      return 4;
    case "audience":
      return 4;
    case "footer":
      return 2;
    case "header":
      return 1;
    case "headline":
      return 2;
    case "tagline":
      return 2;
    case "cta":
      return 1;
    default:
      return 3;
  }
}

export function isCopyRegion(component) {
  return component && component.kind !== "image" && component.role !== "decoration";
}

function greetingSignoff(goal, rawPrompt) {
  const greeting = extractGreeting(goal, rawPrompt);
  if (!greeting) return "";
  const brand = extractBrand(goal, rawPrompt);
  return brand ? `${greeting} from ${brand}` : greeting;
}

/**
 * A greeting card can land on a certificate/notice template. Its slot
 * descriptions then say "what is being awarded" or "the recipient's name",
 * and a tiny model faithfully writes award copy for a Diwali card. For a
 * greeting context, describe each slot by the greeting line it needs instead.
 * The parenthetical is a prompt-specific example, not metadata to copy.
 */
function regionBrief(component, goal, rawPrompt) {
  const greeting = extractGreeting(goal, rawPrompt);
  if (!greeting) return normalize(component.describe) || "copy";
  const brand = extractBrand(goal, rawPrompt);
  const tagline = extractOccasionTagline(goal, rawPrompt) || greeting;
  const signoff = greetingSignoff(goal, rawPrompt);
  const name = `${component?.id || ""} ${component?.describe || ""}`;
  if (/attribution|who said|credit|attributed to/i.test(name)) {
    return `the sign-off from the organiser (${brand || signoff})`;
  }
  switch (component?.role) {
    case "header":
      return `the organisation sending the greeting (${brand || "the organiser"})`;
    case "headline":
      return `the greeting itself (${greeting}) — not the brand or a description`;
    case "tagline":
      return `a short occasion line (${tagline})`;
    case "sections":
      return isRecipientComponent(component)
        ? `who the greeting is for (${recipientLine(goal, component.maxChars)})`
        : `one short line about the occasion (${tagline})`;
    case "details":
      return isSourceDetails(component)
        ? `the source line, different from the footer (${sourceMessage(goal, rawPrompt, brand)})`
        : `one warm sentence (${occasionMessage(goal, rawPrompt)})`;
    case "footer":
      return `the sign-off from the organiser (${signoff})`;
    case "cta":
      return "a short greeting action (Send your wishes)";
    default:
      return `the occasion line (${tagline})`;
  }
}

function regionLine(component, goal, rawPrompt) {
  const limit = copyLineLimit(component);
  const max = Number(component?.maxChars) || 0;
  const limits = [
    `${limit} line${limit === 1 ? "" : "s"}`,
    max > 0 ? `at most ${max} characters total` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${component.id} (${component.role || "body"}; ${limits}): ${regionBrief(component, goal, rawPrompt)}`;
}

function regionBlock(components, goal, rawPrompt) {
  return components.map((component) => regionLine(component, goal, rawPrompt)).join("\n");
}

function requestBlock(rawPrompt) {
  const value = normalize(rawPrompt);
  if (!value) return "";
  return `Original request (source of truth for concrete facts):\n${value.slice(0, 1600)}`;
}

function occasionBlock(goal, rawPrompt) {
  const greeting = extractGreeting(goal, rawPrompt);
  if (!greeting) return "";
  const tagline = extractOccasionTagline(goal, rawPrompt);
  return [
    `Occasion: ${greeting}.`,
    "The headline must be the greeting itself (or a direct variation), not the brand or a description of the card.",
    tagline ? `A strong tagline for this occasion: "${tagline}".` : "",
    "Sign the greeting from the organiser in the footer.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildCopyPrompt(components, goal, rawPrompt, canvas) {
  const regions = (components || []).filter(isCopyRegion);
  return [
    COPY_RULES,
    "",
    "Your task now: write the copy deck for this design.",
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height} pixels.`,
    "The brief:",
    formatGoal(goal),
    requestBlock(rawPrompt),
    occasionBlock(goal, rawPrompt),
    "Regions to write:",
    regionBlock(regions, goal, rawPrompt),
    "Return ONLY valid JSON: an object whose keys are exactly the region ids above and whose values are arrays of the printed copy. Never use the region id, role, line limit or description as copy.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildCopyRepairPrompt(components, goal, rawPrompt, rejected, canvas) {
  const regions = (components || []).filter(isCopyRegion);
  const problems = (rejected || [])
    .map((entry) => {
      const id = entry.component?.id || entry.id || "?";
      const lines = Array.isArray(entry.lines) ? entry.lines.join(" / ") : normalize(entry.lines);
      return `- ${id}: ${entry.reason} — rejected copy: "${lines}"`;
    })
    .join("\n");
  return [
    COPY_RULES,
    "",
    "Your task now: rewrite ONLY the rejected regions below. Keep the same reader-facing voice and obey the limits.",
    "The first copy pass had these problems:",
    problems,
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height} pixels.`,
    "The brief:",
    formatGoal(goal),
    requestBlock(rawPrompt),
    occasionBlock(goal, rawPrompt),
    "Regions to rewrite:",
    regionBlock(regions, goal, rawPrompt),
    "Return ONLY valid JSON with exactly these region ids and arrays of the printed copy.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Dynamic schema: every text region is required, and each answer is a bounded
 * array. The grammar enforces the shape so a malformed deck never reaches the
 * validator.
 */
export function copyDeckSchema(components) {
  const regions = (components || []).filter(isCopyRegion);
  if (!regions.length) return null;
  const properties = {};
  const required = [];
  for (const component of regions) {
    properties[component.id] = {
      type: "array",
      maxItems: copyLineLimit(component),
      items: { type: "string" },
    };
    required.push(component.id);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
