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

const GENERIC_BRAND =
  /^(?:team members|our team|audience|brand name|your brand|placeholder)[.!]?$/i;
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
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi;
const NUMBER = /\b\d[\d,.]*\b/g;
const NAME_INTRO =
  /\b(?:by|from|featuring|speaker|hosted\s+by|host|presenter|author|artist|contact)\s+([A-Z][a-z][A-Za-z'-]*(?:\s+[A-Z][a-z][A-Za-z'-]*)+)/g;
const NAME_PAIR = /\b[A-Z][a-z][A-Za-z'-]*(?:\s+[A-Z][a-z][A-Za-z'-]*)+/g;
const FACT_REGION =
  /\b(?:date|time|when|deadline|venue|location|address|name|speaker|host|presenter|author|artist|attribution|recipient|contact\s+person)\b/i;
const ACTION_WORD =
  /\b(get|join|learn|discover|start|try|book|register|download|explore|meet|see|claim|reserve|shop|watch|read|visit|rsvp|reply|order|buy|apply|send|share|celebrate|greet|call|contact|email|message|follow|subscribe|enquire|inquire|request|donate|nominate|vote|comment)\b/i;
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
  "can", "will", "just", "more", "most", "all", "any", "each",
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
 * Content words shared with an existing used-word set. Stopwords and numbers
 * are ignored by distinctiveWords(); every other word is unique to one region.
 */
export function repeatedContentWords(value, usedWords, allowed = null) {
  const seen = usedWords instanceof Set ? usedWords : new Set(usedWords || []);
  return distinctiveWords(value, allowed).filter((word) => seen.has(word));
}

/**
 * No content word is repeatable. The brand, the occasion and the greeting are
 * all ordinary copy: if they appear in one region they may not appear in
 * another. Stopwords and numbers are filtered earlier, so grammar still works;
 * everything else must be unique across the deck.
 */
export function repeatableWords() {
  return new Set();
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

export function collectTextElements(elements, out = []) {
  for (const element of elements || []) {
    if (!element || typeof element !== "object") continue;
    if (element.type === "text" && typeof element.content === "string" && element.content.trim()) {
      out.push({ id: String(element.id || ""), text: element.content.trim() });
    }
    if (element.type === "group" && Array.isArray(element.children)) {
      collectTextElements(element.children, out);
    }
  }
  return out;
}

/**
 * Text owned by a region. Region ids are top-level element ids returned by the
 * editor; a region may own a group, so keep walking children here rather than
 * assuming every text element is flat on the canvas.
 */
export function textElementsUnder(design, ids) {
  const byId = new Map();
  const index = (elements) => {
    for (const element of elements || []) {
      if (!element || typeof element !== "object") continue;
      if (typeof element.id === "string") byId.set(element.id, element);
      if (element.type === "group" && Array.isArray(element.children)) index(element.children);
    }
  };
  index(design?.elements);
  const out = [];
  const seen = new Set();
  const walk = (element) => {
    if (!element || typeof element !== "object") return;
    if (
      element.type === "text" &&
      typeof element.content === "string" &&
      element.content.trim() &&
      !seen.has(element.id)
    ) {
      seen.add(element.id);
      out.push({ id: String(element.id || ""), text: element.content.trim() });
    }
    if (element.type === "group" && Array.isArray(element.children)) {
      for (const child of element.children) walk(child);
    }
  };
  for (const id of ids || []) walk(byId.get(String(id)));
  return out;
}

/**
 * Assistant patch gate. Only changed/added text is checked, against every other
 * rendered text element. This catches a follow-up edit that reintroduces a word
 * already used elsewhere without rescanning (or rejecting) unrelated legacy
 * duplication the user did not touch.
 *
 * @returns {Map<string,string[]>} element id -> repetition messages
 */
export function findTextRepetitionsForChanged(design, changedIds) {
  if (!FEATURES.copy.strictRepetition) return new Map();
  const changed = new Set((changedIds || []).filter((id) => typeof id === "string"));
  if (!changed.size) return new Map();
  // A patch may target a group id. Expand it to the text children that were
  // actually changed instead of silently skipping the whole subtree.
  for (const entry of textElementsUnder(design, [...changed])) changed.add(entry.id);
  const texts = collectTextElements(design?.elements);
  const words = new Map(texts.map((entry) => [entry.id, distinctiveWords(entry.text)]));
  const reported = new Map();
  const flag = (id, message) => {
    const list = reported.get(id) || [];
    if (!list.includes(message)) list.push(message);
    reported.set(id, list);
  };
  for (const entry of texts) {
    if (!changed.has(entry.id)) continue;
    const own = words.get(entry.id) || [];
    for (const other of texts) {
      if (other.id === entry.id) continue;
      const shared = own.filter((word) => (words.get(other.id) || []).includes(word));
      if (!shared.length) continue;
      const message = `repeats ${shared.map((word) => `"${word}"`).join(", ")} from "${other.id}"`;
      flag(entry.id, message);
      flag(other.id, message);
    }
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
    goal?.brand,
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

export function extractBrand(goal) {
  // Brand identity is a semantic reading of the brief, not a regex shape.
  // L1 returns it; every later layer consumes that same answer.
  return normalize(goal?.brand || goal?.organizer || "");
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
 * Ground a title-case phrase against the brief. This is deliberately
 * vocabulary-agnostic: every word must either be a grammar word or appear in
 * the brief. No brand, industry or example words are hardcoded here.
 */
function groundedName(phrase, compactBrief) {
  const words = String(phrase).toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || [];
  return (
    words.length > 0 &&
    words.every((word) => COPY_STOPWORDS.has(word) || compactBrief.includes(word))
  );
}

/**
 * Concrete-fact guard. It rejects only tokens that can be verified against the
 * brief: placeholders, dates, times, numbers, links, and names in regions that
 * explicitly ask for a name/date/venue (or copy that introduces a name with a
 * role marker). Ordinary title-case marketing copy is not treated as a name.
 */
function factProblem(text, brief, component) {
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) return "placeholder name or date";
  const compactBrief = compact(brief);
  const dates = text.match(DATE_WORD) || [];
  if (dates.some((word) => !compactBrief.includes(compact(word)))) return "date not stated in the brief";
  const years = text.match(YEAR) || [];
  if (years.some((year) => !compactBrief.includes(year))) return "date not stated in the brief";
  const times = text.match(TIME) || [];
  if (times.some((time) => !compactBrief.includes(compact(time)))) return "time not stated in the brief";
  const links = text.match(LINK) || [];
  if (links.some((link) => !compactBrief.includes(compact(link)))) return "link not stated in the brief";
  const numbers = text.match(NUMBER) || [];
  if (numbers.some((number) => !compactBrief.includes(compact(number)))) {
    return "number not stated in the brief";
  }

  for (const match of text.matchAll(NAME_INTRO)) {
    const name = match[1];
    if (!groundedName(name, compactBrief)) return `invented name "${name}"`;
  }
  // A date/venue/name slot containing a name-shaped phrase is a fact error,
  // even when the phrase is title-case like the rest of the design. This is
  // semantic context, not a list of "safe" nouns.
  if (FACT_REGION.test(`${component?.id || ""} ${component?.describe || ""}`)) {
    const pairs = text.match(NAME_PAIR) || [];
    for (const pair of pairs) {
      const name = pair.replace(/'s$/i, "");
      if (!groundedName(name, compactBrief)) return `invented name "${name}"`;
    }
  }
  return "";
}

function isAttributionComponent(component) {
  return /attribution|who said|credit|attributed to/i.test(
    `${component?.id || ""} ${component?.describe || ""}`,
  );
}

export function isBrandComponent(component) {
  const text = `${component?.id || ""} ${component?.describe || ""}`;
  return (
    /\b(?:brand(?:ing)?|logo)\b/i.test(text) ||
    /\b(?:company|organi[sz]ation)\s+(?:name|identity)\b/i.test(text)
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
  const invented = factProblem(text, brief, component);
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
