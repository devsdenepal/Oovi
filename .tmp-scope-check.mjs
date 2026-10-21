import { retrieveTemplates } from "./src/layout/retrieve";
const canvas = { width: 1200, height: 630 };
const base = {
  summary: "a new analytics app",
  subject: "analytics app",
  purpose: "announce the launch",
  keywords: ["product", "launch", "analytics"],
};
const scoped = retrieveTemplates({ ...base, designType: "product-launch", composition: "hero-right" }, canvas);
console.log(scoped.source, scoped.coverage, scoped.candidates);
for (const s of scoped.scored) console.log(s.id, s.baseCoverage?.toFixed(3), s.coverage?.toFixed(3), s.scope);
