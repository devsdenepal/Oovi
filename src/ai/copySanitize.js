/**
 * Deterministic copy guard for AI-filled template regions.
 *
 * The 270m model fills regions reliably once colours are repaired, but it
 * still leaks prompt instructions into copy ("one short supporting line…"),
 * describes the design instead of addressing the reader, ignores the region's
 * character budget, or writes a footer for the wrong occasion. This module is
 * the last, non-model step: keep valid, prompt-specific copy; restore an
 * approved copy-deck line when one exists; otherwise drop the line so L4 can
 * regenerate it. It never invents facts or fallback copy.
 */

import { FEATURES } from "../config/features";

const INSTRUCTION_PHRASES = [
  "supporting line",
  "not a repeat",
  "what is included",
  "call to action",
  "category label",
  "production label",
  "cinematic title",
  "concise explanation",
  "launch or experience",
  "reserved box",
  "copy limit",
  "font size",
  "template example",
  "region rules",
  "do not repeat",
  "website or launch date",
  "large cinematic",
  "short uppercase",
  "small luminous",
  "minimal brand",
  "atmospheric 3d",
  "futuristic environment",
  "conceptual artwork",
  "one short",
  "single line",
  "short call",
];

// Copy that is really a production note copied out of the L4 prompt. The
// phrase list above catches template-era leaks; these patterns catch the
// current role rules ("every text at least 16px", "the largest type on the
// canvas", "approved copy …").
const INSTRUCTION_PATTERNS = [
  /\b(?:at least|no smaller than|minimum)\s+\d+\s*px\b/i,
  /\b(?:every|all)\s+text\s+at\s+least\b/i,
  /\b(?:font\s?size|type\s?size|fontsize)\b/i,
  /\b(?:reserved box|region rules|copy limit|character budget|line count|max chars?)\b/i,
  /\b(?:approved copy|use these exact|use the exact|do not rewrite|do not add copy|never a template example)\b/i,
  /\b(?:largest type on the canvas|headline floor|details floor|footer:|tagline:|header is a kicker)\b/i,
  /\b(?:the whole region|keep every element inside|the message itself)\b/i,
  /\b(?:the greeting itself|a short occasion line|the organisation sending|one warm sentence|the sign-off from|who the greeting is for|the big greeting)\b/i,
  /\b(?:one short line about|the occasion line|the sign-off|a short greeting action|region id|line limit|printed copy)\b/i,
  /\b\d+\s+lines?\b/i,
  /\bat most\s+\d+\s+characters?\b/i,
];

const META_COPY_PATTERNS = [
  /\b(?:this|the)\s+(?:design|poster|flyer|banner|card|invitation|announcement|graphic)\b/i,
  /\b(?:a|an)\s+(?:(?:festive|modern|bold|minimal|elegant|clean|dark|bright|warm|joyful|colorful|colourful)\s+)?(?:greeting\s+card|poster|flyer|banner|invitation|announcement|design|graphic)\b(?:\s+(?:wishing|featuring|promoting|announcing|for|from|that|which)\b)/i,
  /\b(?:design|poster|flyer|card|invitation|announcement)\s+(?:wishing|featuring|promoting|announcing|for)\b/i,
  /\b(?:describes?|showcases?|highlights?)\b[^.!?]{0,50}\b(?:design|poster|card|brief)\b/i,
];

const STYLE_DESCRIPTION =
  /\b(?:dark|confident|modern|clean|bold|cinematic|minimal|elegant|futuristic|vibrant|moody|editorial|playful|warm)\b[^.!?]{0,40}\b(?:announcement|launch|design|poster|experience|composition|brief)\b/i;

const GENERIC_BRAND = /\b(team members|our team|audience|brand name|your brand|placeholder)\b/i;
const PLACEHOLDER_PATTERNS = [
  /\b(?:client|customer|recipient|guest|attendee|speaker|artist|name)\s+(?:[A-Z]|one|two|three|\d+)\b/i,
  /\b(?:tbd|tba|placeholder|sample name|your name)\b/i,
];
const DATE_WORD =
  /\b(?:January|February|March|April|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g;
const YEAR = /\b(?:19|20)\d{2}\b/g;
const TIME = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi;
const GREETING_FORBIDDEN =
  /\b(?:award|awarded|awarding|certificate|citation|recipient|signatory|signature|honou?r|achiev|recogni[sz]|diploma|graduation)\b/i;
const COMMON_TITLE_WORDS = new Set([
  "The", "This", "That", "These", "Those", "A", "An", "And", "Or", "But", "For",
  "From", "To", "With", "Without", "Our", "Your", "Their", "We", "You", "They",
  "It", "Its", "Join", "Get", "Learn", "Discover", "Start", "Try", "Book",
  "Register", "Download", "Explore", "Meet", "See", "Claim", "Reserve", "Shop",
  "Watch", "Read", "Visit", "Reply", "Order", "Buy", "Happy", "Merry", "Wishing",
  "Wish", "Wishes", "May", "Celebrate", "Celebration", "Season", "Seasons",
  "Festival", "Festivals", "Light", "Lights", "Joy", "Joyful", "Warm", "Warmest",
  "Best", "Greetings", "Dear", "Hello", "Hi", "Welcome", "Together", "Today",
  "Tonight", "Now", "New", "Year", "Years", "Day", "Days", "Night", "Evening",
  "Morning", "Diwali", "Christmas", "Eid", "Hanukkah", "Thanksgiving", "Birthday",
  "Anniversary", "Valentine's", "Valentines", "Mother's", "Father's", "Holiday",
  "Holidays",
]);
const ACTION_WORD =
  /\b(get|join|learn|discover|start|try|book|register|download|explore|meet|see|claim|reserve|shop|watch|read|visit|rsvp|reply|order|buy)\b/i;
const FOOTER_FACT =
  /(https?:\/\/|www\.|@|©|\b(?:19|20)\d{2}\b|\b(?:available|coming|launch|now|today|register|book|reserve|tba|details|learn|rsvp|join|discover|visit|see)\b)/i;
const AVAILABILITY_CLAIM = /\b(available now|out now|on sale|buy now|order now|in stores|coming soon)\b/i;
const AVAILABILITY_GROUND = /\b(available|availability|on sale|buy|order|in stores|coming soon|pre[- ]?order)\b/i;

const GREETING_PATTERNS = [
  /\b(happy\s+(?:diwali|christmas|holidays?|new\s+year|eid|hanukkah|thanksgiving|birthday|anniversary|valentine'?s?\s+day|mother'?s?\s+day|father'?s?\s+day))\b/i,
  /\b(merry\s+christmas)\b/i,
  /\b(season'?s\s+greetings)\b/i,
  /\b(best\s+wishes)\b/i,
  /\b(warm\s+wishes)\b/i,
  /\b(congratulations)\b/i,
];

// A brief often names the occasion without writing the greeting ("a Diwali
// greeting card", "a Christmas post"). Turn that into the words a reader
// expects, so fallbacks are occasion-aware rather than returning "Details TBA"
// or the bare subject.
const OCCASION_GREETINGS = [
  [/\bdiwali\b/i, "Happy Diwali"],
  [/\bchristmas\b/i, "Merry Christmas"],
  [/\bnew\s+year\b/i, "Happy New Year"],
  [/\beid\b/i, "Eid Mubarak"],
  [/\bhanukkah\b/i, "Happy Hanukkah"],
  [/\bthanksgiving\b/i, "Happy Thanksgiving"],
  [/\bbirthday\b/i, "Happy Birthday"],
  [/\banniversary\b/i, "Happy Anniversary"],
  [/\bvalentine'?s?\s+day\b/i, "Happy Valentine's Day"],
  [/\bmother'?s?\s+day\b/i, "Happy Mother's Day"],
  [/\bfather'?s?\s+day\b/i, "Happy Father's Day"],
];

const OCCASION_TAGLINES = [
  [/\bdiwali\b/i, "Festival of Lights"],
  [/\bchristmas\b/i, "Season's Greetings"],
  [/\bnew\s+year\b/i, "A bright new year"],
  [/\beid\b/i, "Eid Mubarak"],
  [/\bhanukkah\b/i, "Festival of Lights"],
  [/\bthanksgiving\b/i, "Grateful hearts"],
  [/\bbirthday\b/i, "Celebrate with us"],
];

const OCCASION_MESSAGES = [
  [/\bdiwali\b/i, "Wishing you light, joy, and prosperity this Diwali."],
  [/\bchristmas\b/i, "Wishing you warmth, joy, and a merry Christmas."],
  [/\bnew\s+year\b/i, "Wishing you a bright and joyful new year."],
  [/\beid\b/i, "Wishing you peace, joy, and blessings this Eid."],
  [/\bthanksgiving\b/i, "Wishing you a warm and grateful Thanksgiving."],
  [/\bbirthday\b/i, "Wishing you a day filled with joy and celebration."],
];

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Words that carry no copy identity. Repetition of these across regions is
 * grammar, not a duplicated message, so the strict repetition check ignores
 * them (two regions can both say "the" without reading as the same line).
 */
const COPY_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "to", "of", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "you", "your",
  "we", "our", "us", "they", "their", "them", "i", "me", "my", "he", "she",
  "his", "her", "not", "no", "so", "if", "then", "than", "too", "very",
  "can", "will", "just", "now", "new", "more", "most", "all", "any", "each",
  "every", "into", "over", "under", "about", "after", "before", "up", "down",
  "out", "off", "again", "also", "only", "own", "same", "such", "via", "per",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "here", "there", "what", "when", "where", "who", "why", "how",
]);

/** Lowercased words with punctuation stripped — the unit of the repeat guard. */
export function contentWords(value) {
  const text = normalizeCopyLines(value).join(" ").toLowerCase();
  return (text.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || []).map((word) =>
    word.replace(/['’]s$/, ""),
  );
}

/** Distinctive content words in one region — the vocabulary the repeat guard tracks. */
export function distinctiveWords(value, allowed = null) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed || []);
  return [
    ...new Set(
      contentWords(value).filter(
        (word) => word.length >= 3 && !COPY_STOPWORDS.has(word) && !allowedSet.has(word),
      ),
    ),
  ];
}

/**
 * Content words shared with an existing used-word set. Stopwords, numbers and
 * greeting/brand vocabulary are allowed to repeat; everything else is a
 * duplicate of copy already shipped in another region.
 */
export function repeatedContentWords(value, usedWords, allowed = null) {
  const seen = usedWords instanceof Set ? usedWords : new Set(usedWords || []);
  return distinctiveWords(value, allowed).filter((word) => seen.has(word));
}

/** Occasion and brand vocabulary is a sign-off, not a duplicate message. */
export function repeatableWords(goal, rawPrompt = "") {
  const shared = [
    extractGreeting(goal, rawPrompt),
    extractOccasionTagline(goal, rawPrompt),
    extractBrand(goal, rawPrompt),
  ]
    .filter(Boolean)
    .join(" ");
  return new Set(contentWords(shared).filter((word) => word.length >= 3));
}

/**
 * Strict repetition report over rendered regions. Any content word shared by
 * two regions is flagged, so "New AI Assistant" and "New AI Assistant Product
 * Launch" can no longer both ship just because the strings differ. Returns a
 * Map of region id -> message (both sides of a collision are reported).
 */
export function findCopyRepetitions(regions, goal = null, rawPrompt = "") {
  if (!FEATURES.copy.strictRepetition) return new Map();
  const allowed = repeatableWords(goal, rawPrompt);
  const owners = new Map(); // word -> region id
  const reported = new Map();
  const flag = (id, message) => {
    const list = reported.get(id) || [];
    if (!list.includes(message)) list.push(message);
    reported.set(id, list);
  };
  for (const region of regions || []) {
    const id = String(region?.id || "");
    const text = String(region?.text || "");
    if (!id || !text.trim()) continue;
    const words = distinctiveWords(text, allowed);
    const shared = words.filter((word) => owners.has(word));
    if (shared.length) {
      const prev = owners.get(shared[0]);
      const message = `repeats ${shared.map((word) => `"${word}"`).join(", ")} from region "${prev}"`;
      flag(id, message);
      flag(prev, message);
    }
    for (const word of words) if (!owners.has(word)) owners.set(word, id);
  }
  return reported;
}



/** One string or an array of strings -> a clean array of copy lines. */
export function normalizeCopyLines(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map(normalize).filter(Boolean);
}

function clamp(text, maxChars) {
  const value = normalize(text);
  if (!maxChars || value.length <= maxChars) return value;
  let cut = value.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor(maxChars * 0.55)) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:—–-]+$/, "").trim();
}

export function briefText(goal, rawPrompt = "") {
  return [
    goal?.summary,
    goal?.subject,
    goal?.purpose,
    goal?.tone,
    goal?.style,
    goal?.designType,
    ...(Array.isArray(goal?.keywords) ? goal.keywords : []),
    ...(Array.isArray(goal?.mustInclude) ? goal.mustInclude : []),
    ...(Array.isArray(goal?.avoid) ? goal.avoid : []),
    rawPrompt,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
}

function titleGreeting(value) {
  return normalize(value).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function extractGreeting(goal, rawPrompt = "") {
  const text = briefText(goal, rawPrompt);
  for (const pattern of GREETING_PATTERNS) {
    const match = text.match(pattern);
    if (match) return titleGreeting(match[1]);
  }
  for (const [pattern, greeting] of OCCASION_GREETINGS) {
    if (pattern.test(text)) return greeting;
  }
  return "";
}

/** A short occasion line for a tagline region ("Festival of Lights"). */
export function extractOccasionTagline(goal, rawPrompt = "") {
  const text = briefText(goal, rawPrompt);
  for (const [pattern, tagline] of OCCASION_TAGLINES) {
    if (pattern.test(text)) return tagline;
  }
  return "";
}

export function isGreetingContext(goal, rawPrompt = "") {
  if (extractGreeting(goal, rawPrompt)) return true;
  return /\b(diwali|christmas|holiday|new year|eid|hanukkah|thanksgiving|birthday|anniversary|valentine|festive|greeting|celebration|wishes|congratulations)\b/i.test(
    briefText(goal, rawPrompt),
  );
}

export function extractBrand(goal, rawPrompt = "") {
  const text = briefText(goal, rawPrompt);
  const stop = new Set(["For", "The", "And", "With", "At", "On", "In", "To", "Of"]);
  const values = [...text.matchAll(/\bfrom\s+([A-Z][A-Za-z0-9&'-]*(?:\s+[A-Z][A-Za-z0-9&'-]*){0,3})/g)]
    .map((match) => {
      const words = match[1].replace(/[.,;:]+$/, "").trim().split(/\s+/);
      while (words.length && stop.has(words[words.length - 1])) words.pop();
      return words.join(" ");
    })
    .filter(Boolean);
  if (!values.length) return "";
  return values.sort((a, b) => b.length - a.length)[0];
}

function isMetaCopy(text) {
  return META_COPY_PATTERNS.some((pattern) => pattern.test(text));
}

function hasStyleDescription(text) {
  return STYLE_DESCRIPTION.test(text);
}

function isUngroundedAvailability(text, brief) {
  return AVAILABILITY_CLAIM.test(text) && !AVAILABILITY_GROUND.test(brief);
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * The tiny model invents plausible-looking facts: "January 1st, 2024",
 * "Alex Johnson", "Client X". They are worse than a missing line because the
 * design now claims something the brief never said. This check only rejects
 * concrete tokens that are absent from the brief; it never rewrites prose.
 */
function factProblem(text, brief) {
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) return "placeholder name or date";
  const compactBrief = compact(brief);
  const dates = text.match(DATE_WORD) || [];
  if (dates.some((word) => !compactBrief.includes(compact(word)))) return "date not stated in the brief";
  const years = text.match(YEAR) || [];
  if (years.some((year) => !compactBrief.includes(year))) return "date not stated in the brief";
  const times = text.match(TIME) || [];
  if (times.some((time) => !compactBrief.includes(compact(time)))) return "time not stated in the brief";
  const names = text.match(/\b[A-Z][a-z][A-Za-z'-]+\b/g) || [];
  for (const name of names) {
    const base = name.replace(/'s$/i, "");
    if (COMMON_TITLE_WORDS.has(name) || COMMON_TITLE_WORDS.has(base)) continue;
    if (compactBrief.includes(base.toLowerCase())) continue;
    return `invented name "${name}"`;
  }
  return "";
}

function isAttributionComponent(component) {
  return /attribution|who said|credit|attributed to/i.test(
    `${component?.id || ""} ${component?.describe || ""}`,
  );
}

export function isRecipientComponent(component) {
  return /recipient|who this is for|audience/i.test(
    `${component?.id || ""} ${component?.describe || ""}`,
  );
}

export function isSourceDetails(component) {
  return /source|where it is from|origin/i.test(
    `${component?.id || ""} ${component?.describe || ""}`,
  );
}

function attributionProblem(text) {
  if (/^\s*for\b/i.test(text)) return true;
  return /\b(audience|clients?|community|language|hindi|english|spanish|french|german)\b/i.test(text);
}

function recipientProblem(text, component) {
  if (!isRecipientComponent(component)) return false;
  return /\b(greeting\s+card|card|poster|flyer|banner|design|announcement|graphic)\b/i.test(text);
}

function designLabelProblem(text, component) {
  if (component?.role !== "tagline" && component?.role !== "headline") return false;
  return /^(?:a |an )?(?:diwali|christmas|holiday|festive|new year|eid|hanukkah|thanksgiving|birthday|anniversary|valentine'?s?)\s+(?:greeting|card|greeting card|celebration|design)$/i.test(
    normalize(text),
  );
}

function headlineGreetingProblem(text, goal, rawPrompt) {
  if (!isGreetingContext(goal, rawPrompt)) return "";
  const greeting = extractGreeting(goal, rawPrompt).toLowerCase();
  const occasions = [
    [/diwali/, /\b(?:diwali|festival of lights|lights?|diya|lamp|joy|prosperity)\b/i],
    [/christmas/, /\b(?:christmas|holiday|season|merry)\b/i],
    [/new year/, /\b(?:new year|year|20\d{2})\b/i],
    [/eid/, /\b(?:eid|mubarak)\b/i],
    [/hanukkah/, /\b(?:hanukkah|festival of lights|lights?)\b/i],
    [/thanksgiving/, /\b(?:thanksgiving|grateful|gratitude)\b/i],
    [/birthday/, /\b(?:birthday|celebrate|joy)\b/i],
    [/anniversary/, /\b(?:anniversary|celebrate|joy)\b/i],
    [/valentine/, /\b(?:valentine|love|heart)\b/i],
  ];
  for (const [occasion, words] of occasions) {
    if (occasion.test(greeting)) {
      return words.test(text) ? "" : "headline must name the occasion";
    }
  }
  return /\b(happy|merry|wish|wishes|celebrate|celebration|festival|light|lights|joy|warm|blessings|greetings)\b/i.test(
    text,
  )
    ? ""
    : "greeting-card headline must lead with the greeting";
}

function toneTailProblem(text, goal) {
  const raw = goal?.tone;
  const toneWords = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value ?? "").split(/[,;/]+/))
    .flatMap((value) => value.trim().toLowerCase().split(/\s+/))
    .filter((word) => word.length >= 3);
  if (!toneWords.length) return "";
  const last = (normalize(text).toLowerCase().match(/[a-z']+/g) || []).pop();
  return last && toneWords.includes(last) ? `ends with the tone word "${last}"` : "";
}

export function occasionMessage(goal, rawPrompt) {
  const text = briefText(goal, rawPrompt);
  for (const [pattern, message] of OCCASION_MESSAGES) {
    if (pattern.test(text)) return message;
  }
  return "Wishing you joy and celebration.";
}

/**
 * The source/origin line on a greeting card. It is deliberately different
 * from the footer sign-off so two adjacent regions never print the same line.
 */
export function sourceMessage(goal, rawPrompt, brand = "") {
  const text = briefText(goal, rawPrompt);
  let core = "Wishing you joy";
  if (/\bdiwali\b/i.test(text)) core = "Wishing you joy and light";
  else if (/\bchristmas\b/i.test(text)) core = "Warm Christmas wishes";
  else if (/\bnew\s+year\b/i.test(text)) core = "Best wishes for the new year";
  else if (/\beid\b/i.test(text)) core = "Wishing you peace and blessings";
  return brand ? `${core} from ${brand}.` : `${core}.`;
}

/** Who the greeting is for, grounded in the brief's own audience keywords. */
export function recipientLine(goal, maxChars = 0) {
  const keywords = (Array.isArray(goal?.keywords) ? goal.keywords : [])
    .map(normalize)
    .filter(Boolean);
  const audience = keywords
    .filter((keyword) => /client|community|friend|family|customer|guest|team|people/i.test(keyword))
    .slice(0, 2);
  const options = audience.length ? audience : ["friends and family"];
  let text = `To our ${options.join(" and ")}`;
  if (maxChars && text.length > maxChars) text = `To our ${options[0]}`;
  if (maxChars && text.length > maxChars) text = "To our guests";
  return clamp(text, maxChars);
}

function footerProblem(text, goal, rawPrompt) {
  if (isGreetingContext(goal, rawPrompt)) {
    if (/^(?:details?\s+tba|tba|details?|more details|coming soon)$/i.test(text.trim())) return true;
    if (/\b(happy|merry|wishes|wishing|celebrate|joy|blessings|greetings)\b/i.test(text)) return false;
  }
  return !FOOTER_FACT.test(text) && !ACTION_WORD.test(text);
}

function keywordJoinProblem(text, goal) {
  if (!text.includes(" · ")) return false;
  const parts = text
    .split(" · ")
    .map((part) => normalize(part).toLowerCase())
    .filter(Boolean);
  const keywords = new Set(
    (Array.isArray(goal?.keywords) ? goal.keywords : [])
      .map((keyword) => normalize(keyword).toLowerCase())
      .filter(Boolean),
  );
  if (parts.length < 2) return false;
  if (keywords.size && parts.every((part) => keywords.has(part))) return true;
  // Also catch the common model failure of two title-case keywords separated
  // by a dot: "Diwali · Happy", "AI · Automation". A real date/location line
  // contains a digit or more than two words, so it is left alone.
  return (
    parts.length === 2 &&
    !ACTION_WORD.test(text) &&
    parts.every((part) => /^[a-z][a-z0-9'-]{1,20}$/.test(part))
  );
}

function leaksInstruction(text, component) {
  const value = text.toLowerCase();
  const describe = normalize(component?.describe).toLowerCase();
  const id = normalize(component?.id).toLowerCase();
  if (!value) return true;
  if (id && (value === id || value.startsWith(`${id} `) || value.startsWith(`${id};`))) return true;
  if (describe && (value.includes(describe) || describe.includes(value))) return true;
  const sample = normalize(component?.sample).toLowerCase();
  if (sample && value === sample) return true;
  if (INSTRUCTION_PHRASES.some((phrase) => value.includes(phrase))) return true;
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Why a copy line is not safe to ship, or "" when it is usable. Shared by the
 * copy-deck validator and the final region guard so both judge copy the same
 * way.
 */
export function copyProblem(value, component, goal, rawPrompt = "") {
  const lines = normalizeCopyLines(value);
  if (!lines.length) return "empty copy";
  const text = lines.join(" ");
  const brief = briefText(goal, rawPrompt);
  const max = Number(component?.maxChars) || 0;
  if (max > 0 && text.length > max) return `over the ${max}-character budget`;
  if (leaksInstruction(text, component)) return "instruction leakage or template sample";
  if (isMetaCopy(text)) return "describes the design instead of addressing the reader";
  if (component?.role !== "headline" && hasStyleDescription(text)) {
    return "reads like a style note, not copy";
  }
  if (isUngroundedAvailability(text, brief)) return "claims availability not stated in the brief";
  if (isAttributionComponent(component) && attributionProblem(text)) {
    return "attribution must name the source";
  }
  if (component?.role === "footer" && footerProblem(text, goal, rawPrompt)) {
    return "footer needs a link, date, organiser, action or greeting";
  }
  if (component?.role === "cta" && !ACTION_WORD.test(text)) return "CTA has no action";
  if (isGreetingContext(goal, rawPrompt) && GREETING_FORBIDDEN.test(text)) {
    return "uses award/certificate language in a greeting card";
  }
  if (recipientProblem(text, component)) {
    return "recipient must name who the card is for, not the card";
  }
  if (component?.role === "headline") {
    const greetingProblem = headlineGreetingProblem(text, goal, rawPrompt);
    if (greetingProblem) return greetingProblem;
  }
  if (designLabelProblem(text, component)) return "repeats the design type";
  const toneTail = toneTailProblem(text, goal);
  if (toneTail) return toneTail;
  const invented = factProblem(text, brief);
  if (invented) return invented;
  if (component?.role === "tagline" && keywordJoinProblem(text, goal)) {
    return "tagline is a keyword list";
  }
  if (GENERIC_BRAND.test(text)) return "generic placeholder label";
  return "";
}

/** Matches an element's content against every approved deck line, in order. */
function approvedDeckMatcher(component) {
  const approved = normalizeCopyLines(component?.copy);
  return (content) => {
    if (!approved.length) return true;
    const lines = normalizeCopyLines(String(content).split(/\n+/));
    return lines.length === approved.length && lines.every((line, index) => line === approved[index]);
  };
}

/**
 * Text lines a region would have to regenerate: the model wrote copy that
 * fails validation and there is no approved deck line to restore. Used by the
 * L4 loop so it retries the region instead of silently substituting a generic
 * line.
 */
export function regionCopyProblems(elements, component, goal, rawPrompt = "") {
  const approved = normalizeCopyLines(component?.copy);
  const matchesApprovedDeck = approvedDeckMatcher(component);
  const problems = [];
  let textIndex = 0;
  const walk = (list) => {
    for (const element of Array.isArray(list) ? list : []) {
      if (!element || typeof element !== "object") continue;
      if (element.type === "group" && Array.isArray(element.children)) {
        walk(element.children);
        continue;
      }
      if (element.type !== "text" || typeof element.content !== "string") continue;
      const index = textIndex++;
      const approvedLine = approved[index];
      const exactApproved =
        approved.length > 0 && normalize(element.content) === approvedLine;
      const problem = copyProblem(element.content, component, goal, rawPrompt);
      if (!problem && (exactApproved || matchesApprovedDeck(element.content))) continue;
      const restorable =
        approvedLine && !copyProblem(approvedLine, component, goal, rawPrompt);
      if (!restorable) {
        problems.push({
          index,
          content: normalize(element.content),
          reason: problem || "does not match the approved deck copy",
        });
      }
    }
  };
  walk(elements);
  return problems;
}

/**
 * Returns a new element list with text content made layout-safe. IDs and all
 * non-copy props are preserved so the region remains a normal design patch.
 * Approved copy-deck lines are preferred. A text element with unusable copy
 * and no approved line is DROPPED — never replaced with generic copy. L4
 * retries copy problems (regionCopyProblems) before this runs, so dropping is
 * the final safety net, not the normal path.
 */
export function sanitizeRegionCopy(elements, component, goal, rawPrompt = "") {
  if (!Array.isArray(elements) || !elements.length) return elements;
  const approved = normalizeCopyLines(component?.copy);
  const matchesApprovedDeck = approvedDeckMatcher(component);
  let textIndex = 0;
  const walk = (list) =>
    list.flatMap((element) => {
      if (!element || typeof element !== "object") return [element];
      if (element.type === "group" && Array.isArray(element.children)) {
        const children = walk(element.children);
        // An empty group would fail validation; drop it with its text.
        if (!children.length) return [];
        return [{ ...element, children }];
      }
      if (element.type !== "text" || typeof element.content !== "string") return [element];
      const index = textIndex++;
      const approvedLine = approved[index];
      const exactApproved = approved.length > 0 && normalize(element.content) === approvedLine;
      const problem = copyProblem(element.content, component, goal, rawPrompt);
      // When the copy deck approved exact lines, L4 is a layout pass: a valid
      // but rewritten line ("Graphilla Technology — Happy Diwali", "1. To our
      // clients…") is still a deviation. Put the approved line back.
      if (!problem && (exactApproved || matchesApprovedDeck(element.content))) return [element];
      const replacement =
        approvedLine && !copyProblem(approvedLine, component, goal, rawPrompt) ? approvedLine : "";
      const clamped = replacement ? clamp(replacement, component?.maxChars) : "";
      if (!clamped) {
        console.warn(
          `[copy] dropping invalid text in ${component?.id || "?"}: ${problem || "not approved"} — "${normalize(element.content)}"`,
        );
        return [];
      }
      return clamped === element.content ? [element] : [{ ...element, content: clamped }];
    });
  return walk(elements);
}
