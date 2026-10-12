import { evaluateDesign } from '../src/ai/quality.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok: ' + name);
  else { console.error('FAIL: ' + name + ' ' + extra); failures++; }
};
const codes = (report) => report.issues.map((i) => i.severity + ':' + i.code);

// 1. Sparse poster (the reported failure shape)
const sparse = {
  canvas: { width: 1200, height: 630, background: '#2563EB' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Hacktoberfest 2026', x: 48, y: 60, width: 600, fontSize: 40, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'sub', type: 'text', role: 'body', content: 'Come build with us', x: 48, y: 140, width: 400, fontSize: 20, fontWeight: 400, fill: '#FFFFFF' },
    { id: 'date', type: 'text', role: 'details', content: 'Oct 31', x: 48, y: 200, width: 200, fontSize: 16, fontWeight: 400, fill: '#FFFFFF' },
    { id: 'mark', type: 'image', role: 'hero', x: 900, y: 60, width: 128, height: 128, src: 'data:image/png;base64,xx' },
    { id: 'rule', type: 'line', x: 48, y: 300, x2: 600, y2: 300, stroke: '#FFFFFF', strokeWidth: 2 },
  ],
};
const r1 = evaluateDesign(sparse, { plannedIds: ['headline', 'sub', 'date', 'mark', 'rule'], renderedIds: ['headline', 'sub', 'date', 'mark', 'rule'], expectHero: true });
check('sparse poster scores below healthy', r1.score < 90, 'score=' + r1.score);
check('sparse flagged', codes(r1).includes('error:sparse'), JSON.stringify(codes(r1)));
check('undersized hero flagged', codes(r1).some((c) => c === 'warn:hero'), JSON.stringify(codes(r1)));

// 2. Text past the edge
const overflow = {
  canvas: { width: 800, height: 600, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Big Title Here', x: 700, y: 60, width: 400, fontSize: 60, fontWeight: 800, fill: '#111111' },
  ],
};
const r2 = evaluateDesign(overflow, {});
check('overflow is an error', codes(r2).includes('error:overflow'), JSON.stringify(codes(r2)));

// 3. Overlapping text
const overlap = {
  canvas: { width: 800, height: 600, background: '#FFFFFF' },
  elements: [
    { id: 'a', type: 'text', content: 'First line of copy', x: 50, y: 50, width: 400, fontSize: 40, fontWeight: 700, fill: '#111111' },
    { id: 'b', type: 'text', content: 'Second line of copy', x: 60, y: 60, width: 400, fontSize: 40, fontWeight: 400, fill: '#111111' },
  ],
};
check('text overlap errors', codes(evaluateDesign(overlap, {})).includes('error:overlap'));

// 4. Weak contrast
const contrast = {
  canvas: { width: 800, height: 600, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Hello World Test', x: 50, y: 50, width: 500, fontSize: 60, fontWeight: 800, fill: '#999999' },
  ],
};
const r4 = evaluateDesign(contrast, {});
check('weak contrast flagged', codes(r4).some((c) => c.startsWith('error:contrast') || c.startsWith('warn:contrast')), JSON.stringify(codes(r4)));

// 5. Healthy poster scores high with no errors
const good = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'kicker', type: 'text', role: 'header', content: 'HACKTOBERFEST 2026', x: 64, y: 48, width: 500, fontSize: 24, fontWeight: 700, fill: '#FFC400' },
    { id: 'headline', type: 'text', role: 'headline', content: 'Ship Something Spooky', x: 64, y: 100, width: 560, fontSize: 84, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'tagline', type: 'text', role: 'tagline', content: 'One month of open source, tricks included', x: 64, y: 320, width: 520, fontSize: 24, fontWeight: 400, fill: '#FFFFFF' },
    { id: 'date', type: 'text', role: 'details', content: 'October 1 to 31, online everywhere', x: 64, y: 380, width: 520, fontSize: 20, fontWeight: 600, fill: '#FFC400' },
    { id: 'hero', type: 'image', role: 'hero', x: 700, y: 80, width: 440, height: 440, src: 'data:image/png;base64,xx' },
    { id: 'footer', type: 'text', role: 'footer', content: 'Register free at hacktoberfest dot com', x: 64, y: 560, width: 560, fontSize: 18, fontWeight: 400, fill: '#FFFFFF' },
    { id: 'frame', type: 'rectangle', role: 'decoration', x: 0, y: 0, width: 24, height: 630, fill: '#FFC400' },
  ],
};
const r5 = evaluateDesign(good, { plannedIds: ['a', 'b'], renderedIds: ['a', 'b'], expectHero: true });
check('healthy poster scores high', r5.score >= 80, 'score=' + r5.score);
check('healthy poster has no errors', !r5.issues.some((i) => i.severity === 'error'), JSON.stringify(r5.issues));

// 6. Planned but missing
const r6 = evaluateDesign(good, { plannedIds: ['a', 'b', 'ghost'], renderedIds: ['a', 'b'] });
check('missing component errors', codes(r6).includes('error:missing'), JSON.stringify(codes(r6)));

// 7. Tiny text warns
const tiny = {
  canvas: { width: 800, height: 600, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Big Enough Title', x: 50, y: 50, width: 500, fontSize: 60, fontWeight: 800, fill: '#111111' },
    { id: 'fine', type: 'text', content: 'Fine print here', x: 50, y: 200, width: 300, fontSize: 10, fontWeight: 400, fill: '#111111' },
  ],
};
check('tiny text warns', codes(evaluateDesign(tiny, {})).includes('warn:tiny-text'));

// 8. Left-bunched layout warns on balance (coverage high enough to count)
const bunched = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'panel', type: 'rectangle', role: 'decoration', x: 0, y: 0, width: 500, height: 630, fill: '#EEF0FF' },
    { id: 'headline', type: 'text', role: 'headline', content: 'Left Side Only Title', x: 48, y: 60, width: 400, fontSize: 56, fontWeight: 800, fill: '#111111' },
    { id: 'body', type: 'text', role: 'body', content: 'Everything sits on the left half here', x: 48, y: 200, width: 400, fontSize: 20, fontWeight: 400, fill: '#111111' },
  ],
};
check('bunched layout warns balance', codes(evaluateDesign(bunched, {})).includes('warn:balance'), JSON.stringify(codes(evaluateDesign(bunched, {}))));

// 9. Planned section with almost nothing inside warns
const thinSec = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'acts-label', type: 'text', role: 'sections', content: 'Activities', x: 700, y: 100, width: 200, fontSize: 24, fontWeight: 700, fill: '#111111' },
  ],
};
const r9 = evaluateDesign(thinSec, { components: [{ id: 'acts', kind: 'dsl', role: 'sections', box: { x: 650, y: 80, width: 450, height: 300 } }] });
check('thin section warns', codes(r9).some((c) => c === 'warn:thin-section' || c === 'warn:empty-section'), JSON.stringify(codes(r9)));

// 10. Oversized header warns on hierarchy
const bigHeader = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'site', type: 'text', role: 'header', content: 'Some Company Name Here', x: 48, y: 40, width: 600, fontSize: 60, fontWeight: 700, fill: '#111111' },
    { id: 'headline', type: 'text', role: 'headline', content: 'Main Headline Wins', x: 48, y: 200, width: 600, fontSize: 64, fontWeight: 800, fill: '#111111' },
  ],
};
check('oversized header warns', codes(evaluateDesign(bigHeader, {})).includes('warn:hierarchy'));

// 11. Small hero-role box warns even without image kind
const smallHero = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Title Triumphs Over All', x: 48, y: 60, width: 600, fontSize: 72, fontWeight: 800, fill: '#111111' },
  ],
};
const r11 = evaluateDesign(smallHero, { components: [{ id: 'hero-art', kind: 'image', role: 'hero', box: { x: 1000, y: 60, width: 100, height: 100 } }] });
check('small hero box warns', codes(r11).includes('warn:hero'), JSON.stringify(codes(r11)));

console.log(failures === 0 ? 'QUALITY CHECK DONE' : `QUALITY CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
