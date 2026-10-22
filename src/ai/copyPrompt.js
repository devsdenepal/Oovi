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
  distinctiveWords,
  extractBrand,
  extractGreeting,
  extractOccasionTagline,
  isRecipientComponent,
  isSourceDetails,
  occasionMessage,
  recipientLine,
  sourceMessage,
} from "./copySanitize";

export const COPY_REPAIR_RULES = [
  "[System]",
  "You rewrite only the rejected copy regions named below. Return only those region ids.",
  "Copy rules:",
  "- Write the printed words, never a description of the design, template, layout or brief.",
  "- Use only facts stated in the brief or original request. Never invent dates, venues, names, prices, URLs, handles, emails, availability or sponsors.",
  "- A footer uses an action, organiser, link, date or greeting. If the brief gives no URL/handle/email, write none.",
  "- A CTA starts with an action verb. A headline is the announcement, not the brand or a design label.",
  "- Never copy the template description or a sample line.",
  "- Each region is an array of lines. The character budget is the WHOLE region, not each line. Never exceed it; never add lines.",
  "- No content word may appear in two regions. The accepted-word list below is binding.",
  "Return ONLY valid JSON with exactly the rejected region ids and arrays of printed copy.",
];

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
  "- A footer uses a link, date, organiser, action or greeting. Use a URL, handle, email, date or venue ONLY when the brief states it; never invent one. Do not claim availability unless the brief states it.",
  "- A CTA starts with an action verb: Apply now, RSVP, Get tickets, Learn more, See the lineup, View the menu.",
  "- A tagline is one short supporting line (\"Festival of Lights\"), never \"Diwali Greeting\" and never a list of keywords joined by dots.",
  "- Details use exact facts from the request, or a short greeting when the design is a greeting. Never print requirement labels or production notes such as \"at least 16px\".",
  "- Do not copy the template description or any sample line.",
  "- Each region is an array of lines. One line = one text element; obey the line count and total character budget shown for the region. Count spaces. The budget is for the WHOLE region, not each line: two 30-character lines do not fit a 35-character region. Never exceed the budget, even by one character. Use the minimum number of lines needed; never pad a region with extra lines.",
  "- A headline should be 2-5 short words. Prefer a short phrase over a sentence, and never truncate a word or add an ellipsis.",
  "- No content word may appear in more than one region. This includes the brand, the occasion and the greeting: use a different phrase or omit it rather than repeat it. Stopwords and numbers are the only exceptions.",
  "- Brand words are ordinary copy too. If a header or brand region names a company, none of that name's distinctive words may appear in the headline, tagline, supporting copy or footer.",
  "- Keep every line short enough for its box. Do not add labels, bullets, quotes around the values, or Markdown.",
  "Return ONLY valid JSON mapping each region id to its array of strings.",
].join("\n");

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** How many text elements a region can reasonably hold. */
export function copyLineLimit(component) {
  const id = String(component?.id || "").toLowerCase();
  const max = Number(component?.maxChars) || 0;
  let cap;
  switch (component?.role) {
    case "sections":
      cap = /caption|item|row/.test(id) ? 2 : 6;
      break;
    case "details":
      cap = 4;
      break;
    case "audience":
      cap = 4;
      break;
    case "footer":
      cap = 2;
      break;
    case "header":
      cap = 1;
      break;
    case "headline":
      cap = 2;
      break;
    case "tagline":
      cap = 2;
      break;
    case "cta":
      cap = 1;
      break;
    default:
      cap = 3;
      break;
  }
  // The template's total character budget is the real constraint. A 100-char
  // supporting/footer region is one printed line, not two short ones: the L4
  // layer can only guarantee the approved lines it is given, and a second deck
  // line is a common source of "approved copy was not rendered". Derive the
  // structural cap from the budget instead of one fixed number per role.
  const fromBudget = max > 0 ? Math.max(1, Math.ceil(max / 100)) : 0;
  return fromBudget ? Math.min(cap, fromBudget) : cap;
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
      return `a short occasion line (${tagline}), using words not already in the headline`;
    case "sections":
      return isRecipientComponent(component)
        ? `who the greeting is for (${recipientLine(goal, component.maxChars)})`
        : `one short line about the occasion (${tagline}), not a repeat`;
    case "details":
      return isSourceDetails(component)
        ? `the source line, different from the footer (${sourceMessage(goal, rawPrompt, brand)})`
        : `one warm sentence in fresh words (${occasionMessage(goal, rawPrompt)})`;
    case "footer":
      return "a link, date or action line. Do not repeat the greeting or the brand already used above";
    case "cta":
      return "a short greeting action (Send your wishes)";
    default:
      return `the occasion line (${tagline})`;
  }
}

const LINK_IN_BRIEF = /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/i;

function briefHasLink(goal, rawPrompt) {
  return LINK_IN_BRIEF.test(`${formatGoal(goal)} ${normalize(rawPrompt)}`);
}

function roleGuidance(component, goal, rawPrompt) {
  switch (component?.role) {
    case "headline":
      return "Use 1 line of 2-5 short words; never use the brand name here.";
    case "details":
      return "Use at most two short sentences, and never use the brand name here.";
    case "footer":
      return briefHasLink(goal, rawPrompt)
        ? "Use only the URL/handle/email stated in the brief."
        : "The brief gives no URL, handle or email: do not write one. Use an action line instead.";
    case "cta":
      return "Start with an action verb.";
    case "tagline":
      return "One short line, not a list.";
    default:
      return "";
  }
}

/** Repair calls may keep a rejected region's line count, but never add lines. */
export function repairLineLimit(entry) {
  const component = entry?.component || entry;
  const rejectedLines = Array.isArray(entry?.lines) ? entry.lines.length : 0;
  return Math.max(1, Math.min(copyLineLimit(component), rejectedLines || 1));
}

function regionLine(component, goal, rawPrompt) {
  const limit = copyLineLimit(component);
  const max = Number(component?.maxChars) || 0;
  const limits = [
    `${limit} line${limit === 1 ? "" : "s"}`,
    max > 0
      ? `at most ${max} characters total across all lines${
          component.role === "headline" ? " (count spaces)" : ""
        }`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const guidance = roleGuidance(component, goal, rawPrompt);
  return `- ${component.id} (${component.role || "body"}; ${limits}): ${regionBrief(component, goal, rawPrompt)}${
    guidance ? ` ${guidance}` : ""
  }`;
}

function hardLimitBlock(components, lineLimits = null, goal = null, rawPrompt = "") {
  return components
    .map((component) => {
      const cap =
        lineLimits && Number.isFinite(lineLimits[component.id])
          ? lineLimits[component.id]
          : copyLineLimit(component);
      const max = Number(component?.maxChars) || 0;
      const budget =
        max > 0
          ? `combined length of all lines \u2264 ${max} characters (not per line)`
          : "short";
      const guidance = roleGuidance(component, goal, rawPrompt);
      return `- ${component.id}: at most ${cap} line${cap === 1 ? "" : "s"}; ${budget}.${
        guidance ? ` ${guidance}` : ""
      }`;
    })
    .join("\n");
}

function regionBlock(components, goal, rawPrompt) {
  return components.map((component) => regionLine(component, goal, rawPrompt)).join("\n");
}

/**
 * The validator treats brand words as ordinary content, so the writer must see
 * the actual reserved vocabulary — "brand" in the abstract is not enough for
 * a tiny model. Only emit this when a brand-like region is present.
 */
function reservedBrandWords(goal) {
  const brand = normalize(extractBrand(goal));
  if (!brand) return [];
  return distinctiveWords(brand);
}

function reservedBrandBlock(components, goal) {
  const hasBrandRegion = (components || []).some((component) =>
    /brand|logo|company|organi[sz]ation|identity/i.test(
      `${component?.id || ""} ${component?.role || ""} ${component?.describe || ""}`,
    ),
  );
  if (!hasBrandRegion) return "";
  const words = reservedBrandWords(goal);
  if (!words.length) return "";
  return `Reserved brand words (already used by the brand region): ${words
    .map((word) => `"${word}"`)
    .join(", ")}. Do not use them in any other region.`;
}

function acceptedDistinctiveWords(accepted, rejectedIds) {
  return [
    ...new Set(
      Object.entries(accepted && typeof accepted === "object" ? accepted : {})
        .filter(([id, lines]) => !rejectedIds.has(id) && Array.isArray(lines))
        .flatMap(([, lines]) => distinctiveWords(lines)),
    ),
  ]
    .slice(0, 60)
    .sort();
}

function acceptedWordBlock(accepted, rejectedIds) {
  const words = acceptedDistinctiveWords(accepted, rejectedIds);
  if (!words.length) return "";
  return `Words already used in accepted copy (do not repeat): ${words
    .map((word) => `"${word}"`)
    .join(", ")}.`;
}

function forbiddenWordBlock(accepted, rejectedIds) {
  const words = acceptedDistinctiveWords(accepted, rejectedIds);
  if (!words.length) return "";
  return `HARD: none of these words may appear in any rewritten line: ${words
    .map((word) => `"${word}"`)
    .join(", ")}.`;
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

export function buildCopyPrompt(components, goal, rawPrompt, canvas, allComponents = components) {
  const regions = (components || []).filter(isCopyRegion);
  const reserved = (allComponents || components || []).filter(isCopyRegion);
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
    reservedBrandBlock(reserved, goal),
    "Regions to write:",
    regionBlock(regions, goal, rawPrompt),
    "Hard limits before you return:",
    hardLimitBlock(regions, null, goal, rawPrompt),
    "Return ONLY valid JSON: an object whose keys are exactly the region ids above and whose values are arrays of the printed copy. Never use the region id, role, line limit or description as copy.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildCopyRepairPrompt(components, goal, rawPrompt, rejected, canvas, accepted = {}) {
  const regions = (components || []).filter(isCopyRegion);
  const rejectedIds = new Set(
    (rejected || [])
      .map((entry) => entry.component?.id || entry.id)
      .filter(Boolean),
  );
  const usedLines = Object.entries(accepted && typeof accepted === "object" ? accepted : {})
    .filter(([id, lines]) => !rejectedIds.has(id) && Array.isArray(lines) && lines.length)
    .map(([id, lines]) => `- ${id}: "${lines.map(normalize).filter(Boolean).join(" / ")}"`)
    .join("\n");
  const lineLimits = Object.fromEntries(
    (rejected || []).map((entry) => [
      entry.component?.id || entry.id,
      repairLineLimit(entry),
    ]),
  );
  const problems = (rejected || [])
    .map((entry) => {
      const id = entry.component?.id || entry.id || "?";
      const lines = Array.isArray(entry.lines) ? entry.lines.join(" / ") : normalize(entry.lines);
      const max = Number(entry.component?.maxChars) || 0;
      const cap = lineLimits[id] || 1;
      return `- ${id}: ${entry.reason}. Rewrite in at most ${cap} line${
        cap === 1 ? "" : "s"
      }${max > 0 ? ` and ${max} characters total across all lines` : ""} — rejected copy: "${lines}"`;
    })
    .join("\n");
  const acceptedComponents = Object.keys(accepted || {}).map((id) => ({ id }));
  const acceptedWords = acceptedWordBlock(accepted, rejectedIds);
  return [
    COPY_REPAIR_RULES,
    "",
    "Your task now: rewrite ONLY the rejected regions below. Keep the same reader-facing voice and obey the limits.",
    "Do not add lines. A rejected region that had one line must be rewritten as one line or fewer.",
    "The first copy pass had these problems:",
    problems,
    usedLines
      ? `Copy already accepted for other regions — do not reuse any of its distinctive words:\n${usedLines}`
      : "",
    acceptedWords,
    reservedBrandBlock([...acceptedComponents, ...regions], goal),
    "",
    "[User]",
    `Canvas: ${canvas.width}x${canvas.height} pixels.`,
    "The brief:",
    formatGoal(goal),
    requestBlock(rawPrompt),
    occasionBlock(goal, rawPrompt),
    "Regions to rewrite:",
    regionBlock(regions, goal, rawPrompt),
    "Hard limits before you return:",
    hardLimitBlock(regions, lineLimits, goal, rawPrompt),
    forbiddenWordBlock(accepted, rejectedIds),
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
export function copyDeckSchema(components, lineLimits = null) {
  const regions = (components || []).filter(isCopyRegion);
  if (!regions.length) return null;
  const properties = {};
  const required = [];
  for (const component of regions) {
    const maxItems =
      lineLimits && Number.isFinite(lineLimits[component.id])
        ? lineLimits[component.id]
        : copyLineLimit(component);
    properties[component.id] = {
      type: "array",
      maxItems,
      items: {
        type: "string",
        maxLength: Math.max(1, Number(component.maxChars) || 200),
      },
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
