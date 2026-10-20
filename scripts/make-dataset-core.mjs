/**
 * Dataset core (bundled by scripts/make-dataset.mjs).
 *
 * Every record is one production call:
 *
 *   choice  prompt = buildTemplateChoicePrompt(...)   target = {template, why}
 *   tune    prompt = buildTuningPrompt(...)           target = {tuning patch}
 *   copy    prompt = buildComponentPrompt(...)        target = {elements:[...]}
 *
 * The first two are the user-facing "{prompt -> template id + tuning patch}"
 * task, kept split because production makes two calls; both records of one
 * brief share `group`, so a single-call dataset can be joined on it later.
 *
 * Training data is SYNTHETIC but not random: a curated occasion table per
 * template seeds the brief, retrieval decides the shortlist exactly as in
 * production (the chosen template must be in it, or the record is dropped),
 * tuning comes from the same bounded knobs sanitizeTuning accepts, and the
 * copy target is a different example of the same slot than the one shown.
 *
 * Reproducible: seeded RNG, no model calls.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getTemplate,
  instantiateTemplate,
  sanitizeTuning,
  templateSlots,
  TEMPLATES,
  TEMPLATE_IDS,
  sizeClassOf,
} from "../src/layout/templates";
import { PALETTES, lookupPalette } from "../src/layout/palettes";
import { ensurePaletteRoles, paletteColor, textRoleFor } from "../src/layout/paletteRoles";
import { retrieveTemplates, RETRIEVAL_LIMIT, templateDocument } from "../src/layout/retrieve";
import { buildTemplateChoicePrompt, buildTuningPrompt, TEMPLATE_RULES } from "../src/ai/templatePrompt";
import { buildComponentPrompt } from "../src/ai/architectPrompt";
import { DESIGN_CORE } from "../src/ai/layerPrompt";
import { validateDesign } from "../src/design/designValidator";

// ---------------------------------------------------------------------------
// CLI + plumbing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
  return fallback;
};

const OUT_DIR = path.resolve(process.cwd(), flag("out", "data"));
const NUM_BRIEFS = Number(flag("briefs", "800")) || 800;
const NUM_COPY = Number(flag("copy", "900")) || 900;

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry32(20261019);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickSome = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
};
const stableHash = (text) => createHash("sha1").update(String(text)).digest("hex");
// 1-in-16 by group hash, plus the forced held-out occasions (~50 groups),
// which lands the total eval share near 12% instead of the older flat 10%.
const isEvalGroup = (group) => parseInt(stableHash(group).slice(0, 6), 16) % 16 === 0;

// ---------------------------------------------------------------------------
// Occasion table: 2 seeds per template. Fields:
//   subject, designType, industry, composition, audience, purpose, tone,
//   mustInclude[], omit[] (optional slots this design has no content for)
// ---------------------------------------------------------------------------

const ARCHETYPES = {
  "hero-split": [
    ["design studio open day", "poster", "design", "hero-left", "local designers and students", "invite people to the open day", "creative, welcoming", ["studio name and year", "open day date", "three activities", "rsvp line"], []],
    ["indie arts festival", "poster", "arts and culture", "hero-right", "festival goers", "announce the lineup", "bold, celebratory", ["festival name and year", "dates and venue", "three acts", "ticket link"], []],
  ],
  "hero-top": [
    ["quarterly magazine feature", "cover", "publishing", "stacked", "subscribers", "preview the cover story", "editorial, considered", ["issue number", "cover story title", "three highlights"], ["audience-who"]],
    ["season preview programme", "cover", "arts and culture", "stacked", "members and guests", "present the new season", "elegant, cultural", ["season name", "three productions", "booking line"], []],
  ],
  "centered-poster": [
    ["annual general meeting notice", "notice", "civic", "centered", "members and residents", "notify members and invite attendance", "formal, clear", ["meeting title and year", "date and venue", "agenda line", "rsvp line"], []],
    ["farewell reception invitation", "invitation", "community", "centered", "colleagues and guests", "invite guests to the reception", "warm, formal", ["reception title", "date and time", "venue", "rsvp line"], []],
  ],
  "editorial-columns": [
    ["weekly roundup newsletter", "newsletter", "publishing", "split", "subscribers", "summarise the week's stories", "editorial, friendly", ["issue number", "three story headlines", "subscribe line"], []],
    ["programme highlights bulletin", "newsletter", "arts and culture", "split", "members", "show the programme highlights", "lively, informative", ["season title", "three highlights", "booking line"], []],
  ],
  "banner-strip": [
    ["tech conference speaker banner", "banner", "technology", "banner", "developers and managers", "announce the conference", "bold, professional", ["conference name", "dates", "three speakers", "venue"], []],
    ["festival save-the-date strip", "banner", "arts and culture", "banner", "festival goers", "save the date", "energetic, bright", ["festival name", "date", "venue", "ticket line"], []],
  ],
  "card-grid": [
    ["workshop programme cards", "menu", "education", "grid", "adults booking classes", "sell workshops", "warm, practical", ["programme title", "three workshop cards", "booking line"], []],
    ["pricing plan cards", "comparison", "technology", "grid", "teams choosing a plan", "compare plans", "clear, confident", ["plan names", "three feature lists", "cta line"], []],
  ],
  "story-stack": [
    ["gallery opening social post", "social-post", "arts and culture", "stacked", "followers and art lovers", "announce the opening night", "bold, inviting", ["exhibition title", "opening date", "venue"], []],
    ["product teaser story", "story", "technology", "stacked", "early adopters", "tease the launch", "modern, minimal", ["product name", "teaser line", "launch date"], []],
  ],
  "statement-quote": [
    ["quote card from an interview", "quote", "publishing", "type-only", "readers", "share one strong quote", "editorial, calm", ["the quote", "speaker name", "publication line"], []],
    ["single statement poster", "statement", "nonprofit", "centered", "passers-by", "make one clear point", "urgent, plain-spoken", ["statement line", "supporting line", "action line"], []],
  ],
  "event-listing": [
    ["hackathon schedule listing", "listing", "technology", "split", "student developers", "show the weekend schedule", "energetic, technical", ["event title", "when and where facts", "programme rows", "registration line"], []],
    ["festival programme listing", "listing", "arts and culture", "split", "festival goers", "list the day's programme", "lively, clear", ["festival name", "date and venue", "four programme rows"], []],
  ],
  "feature-cta": [
    ["analytics app launch", "product-launch", "technology", "hero-left", "product teams", "announce the launch", "confident, modern", ["app name and tagline", "launch date", "three benefits", "sign-up line"], []],
    ["new feature announcement", "product-launch", "software", "hero-right", "existing customers", "explain the new feature", "clean, technical", ["feature name", "benefit line", "three details", "cta line"], []],
  ],
  "sidebar-rail": [
    ["workshop poster with facts rail", "poster", "education", "split", "local makers", "fill the workshop", "crafted, friendly", ["workshop title", "three facts", "date and venue", "booking line"], []],
    ["lecture poster with speaker rail", "poster", "education", "split", "students and faculty", "pack the lecture", "academic, serious", ["lecture title", "speaker line", "date and venue"], []],
  ],
  "magazine-cover": [
    ["monthly magazine cover", "cover", "publishing", "stacked", "readers", "sell the new issue", "editorial, bold", ["issue number", "cover line", "three teasers"], ["audience-who"]],
    ["annual report cover", "cover", "finance", "stacked", "shareholders", "open the annual report", "corporate, restrained", ["report title and year", "three highlights", "publisher line"], []],
  ],
  "three-band": [
    ["three-part programme poster", "poster", "arts and culture", "stacked", "visitors", "show the day in three parts", "bold, cultural", ["event title", "three programme blocks", "date and venue"], []],
    ["event poster with note and action", "poster", "community", "split", "local residents", "invite the neighbourhood", "warm, direct", ["event title", "note line", "date and venue", "cta line"], []],
  ],
  "photo-grid": [
    ["photo exhibition grid", "gallery", "arts and culture", "grid", "visitors", "show the exhibition photographs", "gallery, minimal", ["exhibition title", "four photo captions", "date and venue"], []],
    ["community event gallery", "gallery", "community", "grid", "residents", "show moments from the event", "warm, documentary", ["event name", "four captions", "credit line"], []],
  ],
  "quote-card": [
    ["testimonial card", "quote", "technology", "type-only", "prospective customers", "share a customer quote", "clean, credible", ["the testimonial", "customer name", "company line"], []],
    ["author quote card", "quote", "publishing", "type-only", "readers", "share a line from the book", "literary, quiet", ["the quote", "author name", "book title"], []],
  ],
  "timeline": [
    ["project timeline", "timeline", "business", "stacked", "stakeholders", "show the project phases", "clear, corporate", ["project name", "three phases", "dates"], []],
    ["three-step process", "timeline", "education", "stacked", "new participants", "explain the process", "friendly, simple", ["process title", "three steps", "start line"], []],
  ],
  "comparison": [
    ["pricing comparison", "comparison", "technology", "split", "buyers comparing tools", "show where we win", "clear, confident", ["three plan columns", "feature rows", "cta line"], []],
    ["before and after comparison", "comparison", "health", "split", "new patients", "show the difference", "calm, factual", ["before column", "after column", "booking line"], []],
  ],
  "team-roster": [
    ["team roster with portraits", "team", "sports", "grid", "supporters", "introduce the squad", "energetic, proud", ["team name", "three player roles", "fixture line"], []],
    ["speaker roster", "team", "technology", "grid", "conference attendees", "introduce the speakers", "professional, modern", ["event name", "three speaker names", "session line"], []],
  ],
  "poster-rail": [
    ["community notice poster", "poster", "civic", "centered", "local residents", "share a community notice", "clear, civic", ["notice title", "date and venue", "contact line"], []],
    ["recruitment poster", "poster", "business", "split", "job seekers", "attract applicants", "direct, confident", ["role title", "three requirements", "apply line"], []],
  ],
  "ticket": [
    ["theatre ticket", "ticket", "arts and culture", "split", "season ticket holders", "admit one to the play", "playful, theatrical", ["play title", "performance date", "seat and price placeholders"], []],
    ["festival day ticket", "ticket", "music", "split", "festival goers", "admit one for the day", "bold, musical", ["festival name", "day and date", "gate and price placeholders"], []],
  ],
  "agenda": [
    ["conference agenda", "schedule", "technology", "stacked", "attendees", "show the day's sessions", "professional, clear", ["conference name", "three timed rows", "venue line"], []],
    ["club night schedule", "schedule", "music", "stacked", "club regulars", "list the night's sets", "nocturnal, cool", ["club name", "three timed rows", "door line"], []],
  ],
  "map-card": [
    ["venue map card", "map", "events", "split", "guests", "help guests find the venue", "clear, practical", ["venue name", "map area", "address line"], []],
    ["festival site map", "map", "arts and culture", "split", "festival goers", "show the site layout", "friendly, clear", ["festival name", "map area", "three locations"], []],
  ],
  "product-shelf": [
    ["product shelf with prices", "product", "retail", "grid", "shoppers", "show the product range", "clean, commercial", ["store name", "three products", "price placeholders"], []],
    ["cafe product menu", "menu", "food and drink", "grid", "customers", "show drinks and bakes", "warm, appetising", ["cafe name", "three items", "price placeholders"], []],
  ],
  "certificate": [
    ["volunteer certificate", "certificate", "civic", "centered", "volunteers being recognised", "recognise service", "formal, grateful", ["award title", "recipient placeholder", "date and signature line"], []],
    ["course completion certificate", "certificate", "education", "centered", "course graduates", "certify completion", "formal, proud", ["course name", "recipient placeholder", "date and signature line"], []],
  ],
  "social-post": [
    ["square announcement post", "social-post", "retail", "stacked", "followers", "announce the opening", "bright, friendly", ["shop name", "opening date", "address line"], []],
    ["new menu social post", "social-post", "food and drink", "stacked", "customers", "announce the new menu", "warm, appetising", ["restaurant name", "three new dishes", "visit line"], []],
  ],
  "newsletter": [
    ["monthly newsletter cover", "newsletter", "publishing", "stacked", "members", "round up the month", "editorial, friendly", ["issue number", "three story teasers", "subscribe line"], []],
    ["members' bulletin", "newsletter", "nonprofit", "stacked", "members and donors", "share the latest updates", "warm, informative", ["bulletin name", "three updates", "contact line"], []],
  ],
  "statement-split": [
    ["membership appeal", "statement", "nonprofit", "split", "prospective members", "ask people to join", "warm, persuasive", ["appeal line", "benefit line", "join line"], []],
    ["public health notice", "statement", "health", "split", "local residents", "share a public health message", "calm, factual", ["notice line", "detail line", "contact line"], []],
  ],
  "metrics-panel": [
    ["fundraising results panel", "metrics", "nonprofit", "stacked", "donors and board members", "show impact at a glance", "proud, factual", ["campaign name", "three figures", "one note per figure"], []],
    ["quarterly metrics panel", "metrics", "business", "stacked", "stakeholders", "report the quarter", "sober, precise", ["quarter label", "three figures", "source line"], []],
  ],
  "menu-sheet": [
    ["autumn dinner menu", "menu", "food and drink", "stacked", "diners", "show the seasonal menu", "warm, appetising", ["restaurant name", "three courses", "price placeholders"], []],
    ["cafe drinks menu", "menu", "food and drink", "stacked", "customers", "show the drinks list", "relaxed, warm", ["cafe name", "three drinks", "price placeholders"], []],
  ],
  "class-schedule": [
    ["yoga class timetable", "schedule", "wellness", "grid", "students", "show the weekly timetable", "calm, clear", ["studio name", "three class rows", "booking line"], []],
    ["weekend workshop schedule", "schedule", "education", "grid", "attendees", "show the weekend programme", "friendly, practical", ["programme name", "three timed rows", "venue line"], []],
  ],
};

/**
 * Held-out occasions: these archetypes are reserved for eval and never appear
 * in train. The cap keeps the split near the requested ~10-15% while still
 * giving every held-out theme several briefs. When the cap is reached the
 * other archetype of the same template is used, so generation keeps going.
 */
const HELD_OUT = new Set([
  "hero-top:1",          // season preview programme
  "event-listing:1",     // festival programme listing
  "ticket:1",            // festival day ticket
  "menu-sheet:1",        // cafe drinks menu
  "photo-grid:1",        // community event gallery
  "timeline:1",          // three-step process
  "metrics-panel:1",     // quarterly metrics panel
  "certificate:1",       // course completion certificate
  "map-card:1",          // festival site map
  "class-schedule:1",    // weekend workshop schedule
]);
const HELD_OUT_CAP = 50;

// Phrasing frames. Non-English frames write the brief's summary in that
// language while keywords stay English (the retrieval vocabulary), which is
// what a bilingual L1 answer looks like in practice.
const FRAMES = [
  { lang: "en", make: (a) => `Design a ${a.designType} for ${a.subject}` },
  { lang: "en", make: (a) => `${cap(a.subject)} — a ${a.tone} ${a.designType} for ${a.audience}` },
  { lang: "en", make: (a) => `We need a ${a.designType} announcing ${a.subject}` },
  { lang: "en", make: (a) => `${cap(a.subject)}: ${a.tone} ${a.designType}, aimed at ${a.audience}` },
  { lang: "en", make: (a) => `Create a ${a.designType} for ${a.subject}, ${a.purpose}` },
  { lang: "en", make: (a) => `Create a ${a.tone} ${a.designType} for ${a.subject}` },
  { lang: "en", make: (a) => `${cap(a.subject)} ${a.designType} — ${a.purpose}` },
  { lang: "en", make: (a) => `${cap(a.audience)} need a ${a.designType} for ${a.subject}` },
  { lang: "es", make: (a) => `Diseña un póster para ${a.subject}` },
  { lang: "hi", make: (a) => `${a.subject} के लिए एक पोस्टर बनाइए` },
  { lang: "fr", make: (a) => `Créez une affiche pour ${a.subject}` },
  { lang: "de", make: (a) => `Erstelle ein Poster für ${a.subject}` },
  { lang: "ja", make: (a) => `${a.subject}のポスターを作成してください` },
];

const SIZES = [
  { name: "wide", canvas: { width: 1200, height: 630 } },
  { name: "landscape", canvas: { width: 1200, height: 800 } },
  { name: "square", canvas: { width: 1080, height: 1080 } },
  { name: "portrait", canvas: { width: 1080, height: 1350 } },
  { name: "tall", canvas: { width: 900, height: 1600 } },
];

const AVOIDS = [
  ["invented names or dates", "cluttered centre"],
  ["low-contrast text", "tiny details"],
  ["invented prices", "generic stock imagery"],
  ["unreadable type", "overlapping elements"],
];

// ---------------------------------------------------------------------------
// Brief facts
//
// A copy model that only ever sees example copy learns to paraphrase the
// example. Real jobs carry names, dates, places and prices in the brief, and
// the copy must use THOSE. Every brief therefore gets concrete facts, they are
// written into mustInclude (so they are in the production prompt text), and
// the copy target is built from them — never from the one-shot example.
// ---------------------------------------------------------------------------

const NAMES = [
  "Harbour", "Field Notes", "Northline", "Marigold", "Kestrel", "Bluebird", "Atlas",
  "Lumen", "Copperline", "Verdant", "Night Shift", "Long Table", "Open House",
  "Assembly", "Salt & Pine", "Cedar", "Morrow", "Beacon", "Common Ground", "Foundry",
];

const ORGS = {
  design: ["Field Studio", "Northline Design"],
  "arts and culture": ["Harbour Arts", "The Assembly Rooms"],
  publishing: ["Northline Press", "Folio House"],
  civic: ["Leeds City Council", "North Ward Trust"],
  community: ["Riverside Community Trust", "The Old Foundry"],
  education: ["Riverside College", "The Workshop School"],
  technology: ["PulseWorks", "Northline Labs"],
  software: ["PulseWorks", "Kestrel Systems"],
  events: ["Harbour Events", "The Assembly Rooms"],
  music: ["Bluebird Records", "The Night Shift"],
  "food and drink": ["Marigold Kitchen", "The Copper Pot"],
  finance: ["Atlas Partners", "Northline Capital"],
  nonprofit: ["Open Hands Foundation", "The Good Neighbour Fund"],
  business: ["Atlas Partners", "Kestrel & Co"],
  health: ["Civic Health", "Riverside Wellbeing"],
  sports: ["Riverside FC", "Northside Runners"],
  retail: ["Kestrel & Co", "Marigold Store"],
  hospitality: ["The Grand Hall", "Marigold Kitchen"],
  wellness: ["Still Point Studio", "Riverside Wellbeing"],
};

const DATES = [
  "Sat 14 March 2026", "Fri 12 June 2026", "Thu 5 November 2026", "Sun 20 September 2026",
  "Wed 8 April 2026", "Sat 3 October 2026", "Fri 22 May 2026", "Tue 1 December 2026",
];
const TIMES = ["6:30 pm", "10:00 am", "7:00 pm", "2:00 pm"];
const VENUES = [
  "Riverside Hall, Leeds", "The Old Foundry, Bristol", "Civic Centre, Manchester",
  "Harbour Studio, Liverpool", "The Assembly Rooms, Bath", "Northline Gallery, Sheffield",
  "The Grand Hall, Birmingham", "Kestrel House, London",
];
const LINKS = [
  "example.org/register", "example.org/tickets", "example.org/book",
  "hello@harbour-arts.example", "example.org/menu", "example.org/join",
];
const PRICES = ["£32", "£12", "£45", "Free"];

const ITEMS = {
  menu: ["Roast squash soup", "Brown butter gnocchi", "Pear almond tart", "Smoked beetroot", "Lemon sole", "Blackberry pavlova"],
  drinks: ["Flat white", "Filter coffee", "Cocoa", "Lemonade", "Loose-leaf tea", "Cold brew"],
  performance: ["Harbour Lights", "The Night Shift", "Mara Cole", "Low Tide", "DJ Fen", "Open mic"],
  schedule: ["09:30 Registration", "10:00 Keynote", "11:30 Workshops", "13:00 Lunch", "14:30 Panels", "16:00 Close"],
  workshop: ["Bookbinding", "Letterpress", "Zine making", "Book arts", "Screen printing", "Drop-in session"],
  gallery: ["Harbour at dawn", "Low tide", "Studio window", "Night ferry", "Salt marsh", "The long room"],
  product: ["Canvas tote", "Enamel mug", "Field notebook", "Wool throw", "Cedar soap", "Pocket knife"],
  team: ["Coach — A. Mensah", "Forward — J. Cole", "Keeper — R. Silva", "Captain — M. Okafor", "Physio — L. Chen"],
  comparison: ["Starter", "Studio", "Team", "Billed yearly", "Cancel anytime", "Free trial"],
  metrics: ["1,240 members", "£86k raised", "92% attendance", "18 partners", "4.7 rating", "3 new sites"],
  timeline: ["Phase 1 — Research", "Phase 2 — Build", "Phase 3 — Launch", "Prototype", "Test", "Ship"],
  map: ["Main stage", "Workshops", "Food court", "Quiet room", "Box office", "First aid"],
  ticket: ["Admit one", "Doors 19:00", "Row C, Seat 12", "£12", "Under 16s free"],
  quote: ["A room of one's own", "The work speaks first", "Make it plain"],
  certificate: ["For outstanding service", "Completed 12 sessions", "Awarded by the committee"],
  wellness: ["Morning flow", "Breathwork", "Deep stretch", "Restorative", "Open level"],
  default: ["Opening night", "Artist talk", "Family workshop", "Live music", "Late opening"],
};

// The SUBJECT decides what the items are; designType alone conflates, e.g.
// "workshop programme cards" (designType menu) with an actual restaurant menu.
const ITEM_THEMES = [
  [/(festival|concert|club|jazz|music|theatre|play|performance|lineup|gig)/, "performance"],
  [/(workshop|class|bookbinding|craft)/, "workshop"],
  [/(hackathon|conference|agenda|schedule|timetable|programme)/, "schedule"],
  [/(drinks|coffee|cafe)/, "drinks"],
  [/(menu|dinner|dish|food|bake|restaurant)/, "menu"],
  [/(gallery|photo|exhibition|art)/, "gallery"],
  [/(product|shelf|shop|retail|store)/, "product"],
  [/(team|roster|speaker|squad)/, "team"],
  [/(metric|fundraising|report|quarter)/, "metrics"],
  [/(timeline|process|phase)/, "timeline"],
  [/(map|site)/, "map"],
  [/(certificate|course|award)/, "certificate"],
  [/(yoga|wellness)/, "wellness"],
];

function itemsFor(subject, designType) {
  const theme = ITEM_THEMES.find(([pattern]) => pattern.test(subject));
  return ITEMS[theme ? theme[1] : designType] || ITEMS.default;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function makeFacts(archetype) {
  const [subject, designType, industry, , audience] = archetype;
  const name = pick(NAMES);
  return {
    eventName: `${name}${rng() < 0.35 ? " 2026" : ""}`,
    subject,
    organizer: pick(ORGS[industry] || ORGS.business),
    date: pick(DATES),
    time: pick(TIMES),
    venue: pick(VENUES),
    link: pick(LINKS),
    price: pick(PRICES),
    audience,
    items: pickSome(itemsFor(subject, designType), 4),
  };
}

/** Words a copy target can legitimately take from the brief's facts. */
function factTokens(facts) {
  const values = [
    facts.eventName, facts.organizer, facts.date, facts.time, facts.venue,
    facts.link, facts.price, facts.audience, ...facts.items,
  ];
  const stop = new Set(["the", "and", "for", "with", "from", "one", "two", "free", "2026"]);
  return new Set(
    values
      .flatMap((v) => String(v).toLowerCase().split(/[^a-z0-9]+/))
      .filter((w) => w.length >= 4 && !stop.has(w)),
  );
}

function hasFact(content, tokens) {
  return String(content)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => tokens.has(w));
}

/** Copy lines per slot role, all grounded in this brief's own facts. */
function factCopyCandidates(role, facts) {
  const items = facts.items;
  const when = `${facts.date} · ${facts.time}`;
  const list = {
    header: [facts.organizer, facts.eventName],
    headline: [facts.eventName, `${facts.organizer} — ${facts.eventName}`, facts.eventName.replace(/\s+\d{4}$/, "")],
    tagline: [`${items[0]} · ${items[1]}`, `${facts.venue} · ${facts.date}`, `For ${facts.audience} · ${facts.venue}`],
    details: [`${when} · ${facts.venue}`, `${facts.date} · ${facts.venue}`, when, facts.venue],
    sections: [
      items.slice(0, 4).join("\n"),
      items.slice(0, 3).join("\n"),
      items.slice(0, 2).join("\n"),
      items.slice(0, 2).join(" · "),
    ],
    footer: [`${facts.organizer} · ${facts.link}`, facts.link, `${facts.organizer} · ${facts.venue}`],
    audience: [`For ${facts.audience}`, `${facts.audience} · ${facts.venue}`, `${facts.venue} · ${facts.date}`],
    cta: [`Book at ${facts.link}`, `Join us — ${facts.link}`, facts.link],
    hero: [`${items[0]} · ${items[1]}`, facts.eventName, `${facts.venue} · ${facts.date}`],
  }[role] || [facts.eventName, `${facts.date} · ${facts.venue}`, items[0]];
  return list.filter(Boolean);
}

function truncateCopy(text, maxChars) {
  if (!(maxChars > 0) || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return (space > maxChars * 0.5 ? cut.slice(0, space) : cut).trim();
}

function factCopyFor(role, facts, maxChars) {
  const tokens = factTokens(facts);
  const candidates = factCopyCandidates(role, facts);
  const fits = candidates.filter((c) => (!maxChars || c.length <= maxChars) && hasFact(c, tokens));
  if (fits.length) return fits.sort((a, b) => b.length - a.length)[0];
  for (const candidate of candidates) {
    const cut = truncateCopy(candidate, maxChars);
    if (hasFact(cut, tokens)) return cut;
  }
  return null;
}

/** Fact values written into mustInclude, parsed back by verify(). */
function factLines(facts) {
  return [
    `name: ${facts.eventName}`,
    `organiser: ${facts.organizer}`,
    `date: ${facts.date}, ${facts.time}`,
    `venue: ${facts.venue}`,
    `book: ${facts.link}`,
    `items: ${facts.items.join(" · ")}`,
  ];
}

const COMPOSITION_TOKENS = {
  "hero-left": ["left"],
  "hero-right": ["right"],
  centered: ["center"],
  split: ["facts", "side", "split", "left"],
  stacked: ["stack", "top", "up"],
  grid: ["grid", "up"],
  banner: ["strip", "centered"],
  "type-only": ["text", "quote", "plain"],
};

function variantFor(template, composition) {
  const variants = (template.variants || []).map((v) => v.id);
  if (!variants.length) return null;
  for (const token of COMPOSITION_TOKENS[composition] || []) {
    const hit = variants.find((id) => id.includes(token));
    if (hit) return hit;
  }
  return variants[0];
}

/** Distinctive words from the template's own retrieval document. */
function docWords(template) {
  const stop = new Set([
    "with", "from", "that", "this", "your", "their", "into", "over", "under", "each", "plus", "and",
    "the", "for", "one", "two", "three", "four", "five", "six", "row", "rows", "line", "lines", "block",
    "left", "right", "top", "bottom", "wide", "short", "large", "small", "main", "area", "column", "columns",
    "layout", "template", "region", "design", "text", "title", "headline", "copy", "content",
  ]);
  return [...new Set(String(templateDocument(template)).split(/[^a-z0-9]+/))].filter(
    (w) => w.length > 3 && !stop.has(w),
  );
}

function paletteFor(goal) {
  const found = lookupPalette(goal) || PALETTES[parseInt(stableHash(goal.summary).slice(0, 4), 16) % PALETTES.length];
  const palette = {
    id: found.id,
    background: found.background,
    ink: found.ink,
    accent: found.accent,
    style: found.style,
  };
  return { ...palette, roles: ensurePaletteRoles(palette) };
}

function makeGoal(archetype, frame, keywords, facts) {
  const [subject, designType, industry, composition, audience, purpose, tone, mustInclude, omit] = archetype;
  const base = { subject, designType, industry, composition, audience, purpose, tone };
  return {
    summary: frame.make({ ...base, designType: designType.replace(/-/g, " ") }),
    subject,
    audience,
    purpose,
    tone,
    designType,
    industry,
    keywords,
    composition,
    // The template guidelines ask for 4-8 checklist items. Facts replace any
    // overflow rather than pushing the list past eight.
    mustInclude: [...mustInclude.slice(0, 2), ...factLines(facts)].slice(0, 8),
    avoid: pick(AVOIDS),
    style: "",
    _omit: omit,
    _facts: facts,
  };
}

function tuningFor(template, goal) {
  const slots = templateSlots(template);
  const byId = new Map(slots.map((s) => [s.id, s]));
  const variant = variantFor(template, goal.composition);
  const density = pick(["normal", "normal", "normal", "tight", "airy"]);
  const hide = (goal._omit || []).filter((id) => byId.get(id)?.optional).slice(0, 3);
  const scale = [];
  const align = [];
  // One occasional bounded knob, so the patch is not always a no-op.
  const roll = rng();
  if (roll < 0.12) {
    const target = slots.find((s) => s.kind === "image" && !s.optional);
    if (target) scale.push({ id: target.id, factor: Number((1 + (rng() * 0.16 - 0.08)).toFixed(2)) });
  } else if (roll < 0.24) {
    const target = slots.find((s) => s.role === "headline");
    if (target) align.push({ id: target.id, value: goal.composition === "centered" ? "center" : "left" });
  }
  const tuning = { variant, density, hide, scale, align };
  // The target must be exactly what sanitizeTuning accepts, or the model is
  // being taught values production would silently repair.
  const clean = sanitizeTuning(tuning, template);
  return { ...clean, _ok: clean.variant === variant };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const records = [];
const stats = {
  attempts: { briefs: 0, briefsAccepted: 0, briefsSkipped: 0, briefsBoosted: 0, heldOutCapped: 0, copyAttempts: 0, copyAccepted: 0, copySkipped: 0 },
  drops: {},
  choice: {},
  tune: {},
  copy: {},
};
const seenPrompts = new Set();
const langCounts = {};
const sizeCounts = {};
const heldOutGroups = new Set();
const heldOutStats = { archetypes: [...HELD_OUT], cap: HELD_OUT_CAP, briefs: {}, records: 0 };
let heldOutBriefs = 0;
let briefSeq = 0;

function drop(reason) {
  stats.drops[reason] = (stats.drops[reason] || 0) + 1;
}

function addRecord(task, group, prompt, target) {
  const key = `${task}:${stableHash(prompt)}`;
  if (seenPrompts.has(key)) {
    drop(`${task}:duplicate-prompt`);
    return false;
  }
  seenPrompts.add(key);
  records.push({ task, group, prompt, target });
  return true;
}

function generateBriefs(limit) {
  const ids = TEMPLATES.map((t) => t.id);
  let round = 0;
  while (stats.attempts.briefsAccepted < limit && round < limit * 8) {
    const templateId = ids[round % ids.length];
    const template = getTemplate(templateId);
    const family = ARCHETYPES[templateId];
    let archetypeIndex = Math.floor(round / ids.length) % family.length;
    let heldOutKey = `${templateId}:${archetypeIndex}`;
    let heldOut = HELD_OUT.has(heldOutKey);
    if (heldOut && heldOutBriefs >= HELD_OUT_CAP) {
      // Cap reached: use the sibling occasion, which is train-eligible.
      archetypeIndex = (archetypeIndex + 1) % family.length;
      heldOutKey = `${templateId}:${archetypeIndex}`;
      heldOut = HELD_OUT.has(heldOutKey);
      stats.attempts.heldOutCapped++;
    }
    const archetype = family[archetypeIndex] || family[0];
    const frame = FRAMES[round % FRAMES.length];
    const size = pick(SIZES);
    round++;
    stats.attempts.briefs++;

    if (!template.sizes.includes(sizeClassOf(size.canvas))) {
      drop("brief:size-not-supported");
      continue;
    }

    const facts = makeFacts(archetype);
    const seedKeywords = [...String(archetype[0]).split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 2), archetype[2]];
    let goal = makeGoal(archetype, frame, seedKeywords, facts);
    let found = retrieveTemplates(goal, size.canvas, { limit: RETRIEVAL_LIMIT });
    if (!found.candidates.includes(templateId)) {
      const boost = pickSome(docWords(template), 4);
      goal = makeGoal(archetype, frame, [...seedKeywords, ...boost], facts);
      found = retrieveTemplates(goal, size.canvas, { limit: RETRIEVAL_LIMIT });
      stats.attempts.briefsBoosted++;
    }
    if (!found.candidates.includes(templateId)) {
      stats.attempts.briefsSkipped++;
      drop("brief:template-not-in-shortlist");
      continue;
    }

    const palette = paletteFor(goal);
    goal.style = palette.style;
    const tuning = tuningFor(template, goal);
    if (!tuning._ok) {
      drop("brief:tuning-repaired");
      continue;
    }

    stats.attempts.briefsAccepted++;
    langCounts[frame.lang] = (langCounts[frame.lang] || 0) + 1;
    sizeCounts[size.name] = (sizeCounts[size.name] || 0) + 1;
    const group = `b${String(++briefSeq).padStart(4, "0")}`;
    if (heldOut) {
      heldOutBriefs++;
      heldOutGroups.add(group);
      const label = `${templateId}: ${archetype[0]}`;
      heldOutStats.briefs[label] = (heldOutStats.briefs[label] || 0) + 1;
    }
    const why = `${template.type} layout: ${template.blurb}`;
    const choicePrompt = buildTemplateChoicePrompt(goal, palette, size.canvas, found.scored);
    const okChoice = addRecord("choice", group, choicePrompt, { template: templateId, why });
    const tunePrompt = buildTuningPrompt(template, goal, palette, size.canvas);
    const tuningTarget = {
      variant: tuning.variant,
      density: tuning.density,
      hide: tuning.hide,
      // sanitizeTuning keeps these as maps (handy for instantiateTemplate);
      // the model-facing schema is the array form, so that is what we teach.
      scale: Object.entries(tuning.scale || {}).map(([id, factor]) => ({ id, factor })),
      align: Object.entries(tuning.align || {}).map(([id, value]) => ({ id, value })),
    };
    const okTune = addRecord("tune", group, tunePrompt, tuningTarget);

    if (okChoice) {
      const bucket = stats.choice[templateId] || (stats.choice[templateId] = { n: 0 });
      bucket.n++;
    }
    if (okTune) {
      const bucket = stats.tune[templateId] || (stats.tune[templateId] = { n: 0 });
      bucket.n++;
    }

    // Remember the brief for copy generation: the same goal/palette/tuning
    // keeps the copy prompt in the exact context production would have.
    copyContexts.push({ group, template, goal, palette, tuning, canvas: size.canvas, frame });
  }
}

const copyContexts = [];

function makeTextElement(component, content, palette) {
  const role = textRoleFor(component.role);
  let fill = "#111111";
  try {
    fill = paletteColor(palette, role);
  } catch {
    fill = palette.ink || "#111111";
  }
  const fontSize = Math.max(12, Math.min(120, component.fontSize || Math.round(component.box.height * 0.5)));
  // Same closed shape COMPONENTS_SCHEMA forces at inference: every optional
  // key present, null where unused. A target missing keys would train the
  // model to omit fields the decoder will not let it omit.
  return {
    id: `${component.id}-text`,
    role: null,
    stroke: null,
    strokeWidth: null,
    angle: null,
    opacity: null,
    visible: null,
    locked: null,
    type: "text",
    content,
    x: component.box.x,
    y: component.box.y,
    width: component.box.width,
    fontSize,
    fontWeight: component.role === "headline" ? 700 : 500,
    fill,
    textAlign: null,
    lineHeight: null,
    fontFamily: null,
    charSpacing: null,
    gradient: null,
  };
}

function generateCopy(limit) {
  let cursor = 0;
  let guard = 0;
  while (stats.attempts.copyAccepted < limit && guard < limit * 12) {
    if (!copyContexts.length) break;
    const ctx = copyContexts[cursor++ % copyContexts.length];
    guard++;
    stats.attempts.copyAttempts++;
    const template = ctx.template;

    const built = instantiateTemplate(template, ctx.tuning, ctx.canvas);
    if (!built.ok) {
      stats.attempts.copySkipped++;
      drop(`copy:${built.reason}`);
      continue;
    }
    const slots = built.components.filter((c) => c.kind !== "image" && c.role !== "decoration" && c.fontSize > 0);
    if (!slots.length) {
      stats.attempts.copySkipped++;
      drop("copy:no-text-slot");
      continue;
    }
    const withExamples = slots.filter((c) => {
      const options = template.examples?.[c.id];
      return Array.isArray(options) && options.length >= 2;
    });
    if (!withExamples.length) {
      stats.attempts.copySkipped++;
      drop("copy:no-examples");
      continue;
    }
    const component = withExamples[guard % withExamples.length];
    // The one-shot example is still shown in the prompt by the production
    // builder; the target uses this brief's own facts instead of paraphrasing
    // the example. No fact that fits the slot => no training example.
    const target = factCopyFor(component.role, ctx.goal._facts, component.maxChars);
    if (!target) {
      stats.attempts.copySkipped++;
      drop(`copy:no-fact-copy:${component.role}`);
      continue;
    }

    const plan = {
      palette: ctx.palette,
      style: ctx.palette.style,
      template: template.id,
      components: built.components,
    };
    const prompt = buildComponentPrompt(component, ctx.canvas, plan, ctx.goal);
    const element = makeTextElement(component, target, ctx.palette);
    let check;
    try {
      check = validateDesign({ canvas: ctx.canvas, elements: [element] });
    } catch (error) {
      check = { ok: false, errors: [error.message] };
    }
    if (!check.ok) {
      stats.attempts.copySkipped++;
      drop("copy:target-invalid");
      continue;
    }
    if (!addRecord("copy", ctx.group, prompt, { elements: [element] })) {
      stats.attempts.copySkipped++;
      continue;
    }
    stats.attempts.copyAccepted++;
    const bucket = stats.copy[template.id] || (stats.copy[template.id] = { n: 0, slots: {} });
    bucket.n++;
    bucket.slots[component.id] = (bucket.slots[component.id] || 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Split + write
// ---------------------------------------------------------------------------

/** The fact lines this generator wrote into mustInclude. */
function promptFactLines(prompt) {
  const line = String(prompt).match(/Must include: ([^\n]+)/);
  if (!line) return [];
  return line[1]
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^(name|organiser|date|venue|book|items):/i.test(s));
}

function copyLimitFromPrompt(prompt) {
  const match = String(prompt).match(/Copy limit: at most (\d+) characters/);
  return match ? Number(match[1]) : 0;
}

/**
 * Self-checks on the written data, because a dataset bug is invisible at
 * training time: wrong target shape trains wrong answers. Every check is
 * something production would reject if it saw it at inference.
 */
function verify(train, evalSet, heldOut) {
  const problems = [];
  const seen = new Set();
  let choiceTargets = 0;
  let tuneArrays = 0;
  let copyValid = 0;
  let copyGrounded = 0;
  let copyWithinLimit = 0;
  let prefixOk = 0;
  for (const r of [...train, ...evalSet]) {
    const key = `${r.task}:${stableHash(r.prompt)}`;
    if (seen.has(key)) problems.push(`duplicate ${r.task} ${r.group}`);
    seen.add(key);
    const okPrefix =
      r.task === "copy" ? r.prompt.startsWith(DESIGN_CORE + "\n") : r.prompt.startsWith(TEMPLATE_RULES + "\n");
    if (!okPrefix) problems.push(`prefix ${r.task} ${r.group}`);
    else prefixOk++;

    if (r.task === "choice") {
      if (!TEMPLATE_IDS.includes(r.target?.template)) problems.push(`choice-target ${r.group}`);
      else choiceTargets++;
    } else if (r.task === "tune") {
      const match = r.prompt.match(/tune the chosen template "([^"]+)"/);
      const template = match && getTemplate(match[1]);
      if (!template) {
        problems.push(`tune-template ${r.group}`);
      } else {
        const slots = templateSlots(template);
        const optional = new Set(slots.filter((s) => s.optional).map((s) => s.id));
        const arrays = Array.isArray(r.target?.scale) && Array.isArray(r.target?.align);
        if (!arrays) problems.push(`tune-arrays ${r.group}`);
        if (!(r.target?.hide || []).every((id) => optional.has(id))) problems.push(`tune-hide ${r.group}`);
        const clean = sanitizeTuning(r.target, template);
        if (clean.variant !== r.target?.variant) problems.push(`tune-variant ${r.group}`);
        if (arrays) tuneArrays++;
      }
    } else if (r.task === "copy") {
      const match = r.prompt.match(/Canvas: (\d+)x(\d+)/);
      const canvas = match ? { width: Number(match[1]), height: Number(match[2]) } : null;
      let ok = false;
      if (canvas) {
        try {
          ok = !!validateDesign({ canvas, elements: r.target?.elements }).ok;
        } catch {
          ok = false;
        }
      }
      if (ok) copyValid++;
      else problems.push(`copy-invalid ${r.group}`);

      const text = (r.target?.elements || [])
        .filter((e) => e?.type === "text")
        .map((e) => String(e.content || ""))
        .join("\n");
      const facts = promptFactLines(r.prompt);
      const audienceLine = String(r.prompt).match(/Audience: ([^\n]+)/);
      const factWords = new Set(
        [...facts, ...(audienceLine ? [`audience: ${audienceLine[1]}`] : [])]
          .flatMap((line) => line.replace(/^\w+:\s*/, "").toLowerCase().split(/[^a-z0-9]+/))
          .filter((w) => w.length >= 4 && w !== "2026"),
      );
      const contentWords = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
      const grounded = [...factWords].some((w) => contentWords.has(w));
      if (!facts.length) problems.push(`copy-no-facts-in-prompt ${r.group}`);
      else if (!grounded) problems.push(`copy-not-grounded ${r.group}`);
      else copyGrounded++;

      const limit = copyLimitFromPrompt(r.prompt);
      if (limit && text.length > limit) problems.push(`copy-over-limit ${r.group} ${text.length}>${limit}`);
      else if (limit) copyWithinLimit++;
    }
  }
  const trainGroups = new Set(train.map((r) => r.group));
  const evalGroups = new Set(evalSet.map((r) => r.group));
  const overlap = [...evalGroups].filter((g) => trainGroups.has(g));
  if (overlap.length) problems.push(`split-overlap groups=${overlap.length}`);
  const leak = train.filter((r) => heldOut.has(r.group)).length;
  if (leak) problems.push(`heldout-leak records=${leak}`);
  const heldOutEval = evalSet.filter((r) => heldOut.has(r.group)).length;
  if (!heldOutEval) problems.push("heldout-missing-from-eval");
  return {
    problemCount: problems.length,
    problems: problems.slice(0, 20),
    prefixOk,
    choiceTargets,
    tuneArrays,
    copyValid,
    copyGrounded,
    copyWithinLimit,
    heldOutEval,
    trainGroups: trainGroups.size,
    evalGroups: evalGroups.size,
  };
}

function promptStats(task) {
  const list = records.filter((r) => r.task === task).map((r) => r.prompt.length);
  if (!list.length) return null;
  list.sort((a, b) => a - b);
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return {
    n: list.length,
    charsMin: list[0],
    charsMean: Math.round(mean),
    charsMax: list[list.length - 1],
    approxTokensMean: Math.round(mean / 4),
  };
}

function main() {
  generateBriefs(NUM_BRIEFS);
  generateCopy(NUM_COPY);

  // Split by group (never by record), so a brief's choice/tune/copy records
  // stay together. Held-out occasion groups are forced into eval.
  const inEval = (record) => isEvalGroup(record.group) || heldOutGroups.has(record.group);
  const train = [];
  const evalSet = [];
  for (const record of records) {
    (inEval(record) ? evalSet : train).push(record);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const write = (file, list) => {
    const text = list.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(path.join(OUT_DIR, file), text + (text ? "\n" : ""));
    return { file, n: list.length, bytes: Buffer.byteLength(text) };
  };
  const trainFile = write("template-copy.train.jsonl", train);
  const evalFile = write("template-copy.eval.jsonl", evalSet);

  const byTask = {};
  for (const r of [...train, ...evalSet]) {
    byTask[r.task] = byTask[r.task] || { train: 0, eval: 0 };
    byTask[r.task][inEval(r) ? "eval" : "train"]++;
  }
  const languages = { ...langCounts };
  const sizes = { ...sizeCounts };

  const templateCoverage = {
    total: TEMPLATES.length,
    choice: Object.keys(stats.choice).length,
    copy: Object.keys(stats.copy).length,
    tune: Object.keys(stats.tune).length,
  };
  const slotCoverage = Object.values(stats.copy).reduce(
    (acc, bucket) => ({ slots: acc.slots + Object.keys(bucket.slots).length }),
    { slots: 0 },
  );
  const report = {
    generatedAt: new Date().toISOString(),
    seed: 20261019,
    briefs: NUM_BRIEFS,
    copyRequested: NUM_COPY,
    totalRecords: train.length + evalSet.length,
    train: trainFile,
    eval: evalFile,
    byTask,
    templateCoverage,
    distinctCopySlots: slotCoverage.slots,
    languages,
    sizes,
    attempts: stats.attempts,
    drops: stats.drops,
    heldOut: {
      archetypes: heldOutStats.archetypes,
      cap: heldOutStats.cap,
      briefs: heldOutStats.briefs,
      groups: heldOutGroups.size,
      records: evalSet.filter((r) => heldOutGroups.has(r.group)).length,
      byTask: ["choice", "tune", "copy"].reduce((acc, task) => {
        acc[task] = evalSet.filter((r) => r.task === task && heldOutGroups.has(r.group)).length;
        return acc;
      }, {}),
    },
    promptChars: {
      choice: promptStats("choice"),
      tune: promptStats("tune"),
      copy: promptStats("copy"),
    },
    verification: verify(train, evalSet, heldOutGroups),
  };
  writeFileSync(path.join(OUT_DIR, "template-copy.stats.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(JSON.stringify(report, null, 2));
}

main();
