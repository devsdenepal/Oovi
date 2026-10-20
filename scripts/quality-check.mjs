import { contrastRatio, evaluateDesign } from '../src/ai/quality.js';
import { register } from 'node:module';

// src/ uses extensionless relative imports — resolve them for plain node.
register(new URL('./ext-loader.mjs', import.meta.url));
const { validateDesign } = await import('../src/design/designValidator.js');

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

// 12. Group children (center frame) flatten to the packed origin.
const grouped = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Grouped Poster Title Here', x: 400, y: 60, width: 500, fontSize: 72, fontWeight: 800, fill: '#111111' },
    { id: 'card', type: 'group', x: 100, y: 300, children: [
      { id: 'card-bg', type: 'rectangle', x: -150, y: -50, width: 300, height: 100, fill: '#EEEEEE' },
      { id: 'card-tx', type: 'text', content: 'Card label', x: -140, y: -40, width: 280, fontSize: 28, fontWeight: 400, fill: '#111111' },
    ] },
  ],
};
const r12 = evaluateDesign(grouped, {});
check(
  'group flattens to packed origin',
  !codes(r12).some((c) => c.startsWith('error:overflow') || c === 'error:overlap'),
  JSON.stringify(codes(r12)),
);

// 13. Off-palette fills warn (accent rationed, freelance hues flagged).
const offPalette = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Palette Test Title Here', x: 48, y: 60, width: 600, fontSize: 72, fontWeight: 800, fill: '#111111' },
    { id: 'rogue-rect', type: 'rectangle', x: 700, y: 60, width: 200, height: 100, fill: '#00FF00' },
    { id: 'rogue-text', type: 'text', content: 'Off palette line', x: 48, y: 300, width: 300, fontSize: 24, fontWeight: 400, fill: '#123456' },
  ],
};
const r13 = evaluateDesign(offPalette, { palette: { background: '#FFFFFF', ink: '#111111', accent: '#FFC400' } });
check('off-palette warns', codes(r13).filter((c) => c === 'warn:palette').length >= 2, JSON.stringify(codes(r13)));

// 14. Three typefaces warn (two max: display + text).
const threeFonts = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Font Title', x: 48, y: 60, width: 500, fontSize: 72, fontWeight: 800, fill: '#111111' },
    { id: 'sub-a', type: 'text', content: 'Georgia subline here', x: 48, y: 200, width: 400, fontSize: 28, fontWeight: 400, fill: '#111111', fontFamily: 'Georgia' },
    { id: 'sub-b', type: 'text', content: 'Mono subline here', x: 48, y: 260, width: 400, fontSize: 24, fontWeight: 400, fill: '#111111', fontFamily: 'Courier New' },
  ],
};
check('three fonts warn', codes(evaluateDesign(threeFonts, {})).includes('warn:typography'));

// 15. Dead-center hero warns (backdrop exempt, thirds rule).
const centeredHero = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Centered Hero Title', x: 350, y: 40, width: 500, fontSize: 60, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'hero', type: 'image', role: 'hero', x: 400, y: 115, width: 400, height: 400, src: 'data:image/png;base64,xx' },
  ],
};
check('dead-center hero warns', codes(evaluateDesign(centeredHero, { expectHero: true })).includes('warn:focal'));

// 16. Competing dominants warn (big hero AND big headline).
const twoGiants = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Giant Headline Title', x: 600, y: 60, width: 520, fontSize: 72, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'hero', type: 'image', role: 'hero', x: 60, y: 60, width: 520, height: 320, src: 'data:image/png;base64,xx' },
  ],
};
check('competing dominants warn', codes(evaluateDesign(twoGiants, { expectHero: true })).includes('warn:focal'));

// 17. Spacious but structured: sparse demotes to warn, no errors.
const spacious = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Spacious Poster Title', x: 64, y: 80, width: 520, fontSize: 64, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'tagline', type: 'text', role: 'tagline', content: 'A calm supporting line of text', x: 64, y: 280, width: 480, fontSize: 24, fontWeight: 400, fill: '#FFFFFF' },
    { id: 'details', type: 'text', role: 'details', content: 'October, somewhere, sometime', x: 64, y: 340, width: 480, fontSize: 20, fontWeight: 400, fill: '#FFC400' },
    { id: 'hero', type: 'image', role: 'hero', x: 800, y: 100, width: 280, height: 280, src: 'data:image/png;base64,xx' },
  ],
};
const r17 = evaluateDesign(spacious, {
  expectHero: true,
  palette: { background: '#14101F', ink: '#FFFFFF', accent: '#FFC400' },
});
check(
  'spacious downgrades to warn',
  codes(r17).includes('warn:sparse') && !r17.issues.some((i) => i.severity === 'error'),
  JSON.stringify(codes(r17)),
);

// 18. White text on a white bar (dark canvas) errors on the backdrop.
const barWash = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Bar Wash Title Here', x: 64, y: 60, width: 500, fontSize: 64, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'bar', type: 'rectangle', x: 48, y: 280, width: 500, height: 80, fill: '#FFFFFF' },
    { id: 'washed', type: 'text', content: 'Dissolved line of text', x: 64, y: 296, width: 400, fontSize: 28, fontWeight: 400, fill: '#FFFFFF' },
  ],
};
check('white-on-white bar errors', codes(evaluateDesign(barWash, {})).includes('error:contrast'), JSON.stringify(codes(evaluateDesign(barWash, {}))));

// 19. Dark text on a dark bar errors.
const barDark = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Dark Bar Title Here', x: 64, y: 60, width: 500, fontSize: 64, fontWeight: 800, fill: '#111111' },
    { id: 'bar', type: 'rectangle', x: 48, y: 280, width: 500, height: 80, fill: '#1A1A2E' },
    { id: 'sunk', type: 'text', content: 'Sunk line of text', x: 64, y: 296, width: 400, fontSize: 28, fontWeight: 400, fill: '#14101F' },
  ],
};
check('dark-on-dark bar errors', codes(evaluateDesign(barDark, {})).includes('error:contrast'));

// 20. Text failing across a whole gradient errors.
const barGradBad = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Gradient Bar Title', x: 64, y: 60, width: 500, fontSize: 64, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'bar', type: 'rectangle', x: 48, y: 280, width: 500, height: 80, fill: '#FFFFFF',
      gradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#F0F0F0' }] } },
    { id: 'washed', type: 'text', content: 'Dissolved on gradient', x: 64, y: 296, width: 400, fontSize: 28, fontWeight: 400, fill: '#FFFFFF' },
  ],
};
check('gradient wash errors', codes(evaluateDesign(barGradBad, {})).includes('error:contrast'));

// 21. Dark text on a light gradient passes clean.
const barGradGood = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Gradient Bar Title', x: 64, y: 60, width: 500, fontSize: 64, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'bar', type: 'rectangle', x: 48, y: 280, width: 500, height: 80, fill: '#FFFFFF',
      gradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#FFC400' }] } },
    { id: 'crisp', type: 'text', content: 'Crisp on gradient', x: 64, y: 296, width: 400, fontSize: 28, fontWeight: 400, fill: '#111111' },
  ],
};
{
  const cs = codes(evaluateDesign(barGradGood, {}));
  check('good gradient contrast clean', !cs.some((c) => c.startsWith('error:contrast') || c.startsWith('warn:contrast')), JSON.stringify(cs));
}

// 22. Text over artwork warns exactly once.
const onArt = {
  canvas: { width: 1200, height: 630, background: '#14101F' },
  elements: [
    { id: 'headline', type: 'text', role: 'headline', content: 'Art Backdrop Title', x: 64, y: 60, width: 500, fontSize: 64, fontWeight: 800, fill: '#FFFFFF' },
    { id: 'photo', type: 'image', role: 'hero', x: 600, y: 100, width: 400, height: 400, src: 'data:image/png;base64,xx' },
    { id: 'cap-a', type: 'text', content: 'Caption one here', x: 650, y: 200, width: 300, fontSize: 24, fontWeight: 400, fill: '#FFFFFF' },
    { id: 'cap-b', type: 'text', content: 'Caption two here', x: 650, y: 260, width: 300, fontSize: 24, fontWeight: 400, fill: '#FFFFFF' },
  ],
};
{
  const cs = codes(evaluateDesign(onArt, { expectHero: true }));
  check('artwork backdrop warns once', cs.filter((c) => c === 'warn:contrast').length === 1, JSON.stringify(cs));
}

// 23. Validator: group-relative negatives + off-canvas positions open.
// (Save persists them — Fabric children are group-relative, drags go
// off-canvas — so rejecting them bricked saved projects.)
const negGroup = {
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'g', type: 'group', x: -20, y: 100, children: [
      { id: 'g-bg', type: 'rectangle', x: -150, y: -50, width: 300, height: 100, fill: '#EEEEEE' },
      { id: 'g-tx', type: 'text', content: 'Card label here', x: -140, y: -40, width: 280, fontSize: 24, fontWeight: 400, fill: '#111111' },
    ] },
    { id: 'off', type: 'rectangle', x: -30, y: 500, width: 200, height: 80, fill: '#FFC400' },
  ],
};
{
  const v = validateDesign(negGroup);
  check('negative group children + off-canvas open', v.ok === true, JSON.stringify(v.errors || []));
}
check('negative width still rejected', validateDesign({
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [
    { id: 'bad', type: 'rectangle', x: 10, y: 10, width: -50, height: 80, fill: '#FFC400' },
  ],
}).ok === false);
check('empty design still rejected (AI must produce something)', validateDesign({
  canvas: { width: 1200, height: 630, background: '#FFFFFF' },
  elements: [],
}).ok === false);

// 24. Pipeline regression: the sparse product announcement.
// The shape that started this work: a headline in a field of empty containers.
// This drives scope -> palette roles -> template retrieval -> instantiation ->
// worst-case content -> the real quality gate, with no model calls. If any
// stage regresses, the composition stops clearing the same gate the app uses.
{
  const { lookupPalette } = await import('../src/layout/palettes.js');
  const { retrieveTemplates } = await import('../src/layout/retrieve.js');
  const { getTemplate, instantiateTemplate } = await import('../src/layout/templates.js');
  const { ensurePaletteRoles } = await import('../src/layout/paletteRoles.js');
  const { materializePlan } = await import('../src/layout/materialize.js');
  const { correctColors } = await import('../src/ai/colorCorrect.js');

  const goal = {
    summary: 'Ship faster with Acme',
    subject: 'Acme workflow assistant',
    purpose: 'announce the product launch',
    audience: 'busy product teams',
    tone: 'confident and clean',
    designType: 'product-launch',
    industry: 'technology',
    keywords: ['product', 'launch', 'workflow', 'assistant'],
    composition: 'hero-right',
    mustInclude: ['product name', 'one-line promise', 'release date', 'call to action'],
    avoid: ['invented pricing', 'clutter'],
    style: 'clean modern, crisp blue',
  };
  const canvas = { width: 1200, height: 630 };

  const palette = lookupPalette(goal);
  check('sparse brief resolves a palette from the library', Boolean(palette), JSON.stringify(goal));
  const roles = ensurePaletteRoles(palette);
  check('palette carries semantic roles', Boolean(roles.ctaSurface && roles.ctaText && roles.surface && roles.border));
  check('primary text is readable on the canvas', (contrastRatio(roles.textPrimary, roles.background) || 0) >= 4.5);
  check('secondary text is readable on the canvas', (contrastRatio(roles.textSecondary, roles.background) || 0) >= 4.5);
  check('CTA label is readable on its surface', (contrastRatio(roles.ctaText, roles.ctaSurface) || 0) >= 4.5);

  const found = retrieveTemplates(goal, canvas);
  check('sparse brief retrieves a layout', found.source === 'retrieval' && found.candidates.length > 0, JSON.stringify(found.scored?.[0] || {}));
  const template = found.candidates.length ? getTemplate(found.candidates[0]) : null;
  check('the retrieved layout exists', Boolean(template), found.candidates.join(','));
  const built = template ? instantiateTemplate(template, {}, canvas) : { ok: false };
  check('the layout instantiates', built.ok === true, built.reason || '');
  check('every slot carries id, role, box, type and limit', (built.components || []).every((c) =>
    c.id && c.role && c.box && (c.kind === 'image' || c.role === 'decoration' || (c.fontSize > 0 && c.maxChars > 0 && ['left', 'center', 'right'].includes(c.align))),
  ));

  const design = materializePlan(built.components || [], canvas, palette);
  const report = evaluateDesign(design, {
    plannedIds: (built.components || []).map((c) => c.id),
    renderedIds: (built.components || []).map((c) => c.id),
    expectHero: (built.components || []).some((c) => c.kind === 'image'),
    components: built.components,
    palette,
  });
  const cs = codes(report);
  check('the composition clears the gate (no errors)', report.issues.filter((i) => i.severity === 'error').length === 0, JSON.stringify(cs));
  check('no planned region renders empty', !cs.some((c) => c === 'warn:empty-section' || c === 'error:empty-hero'), JSON.stringify(cs));
  const texts = design.elements.filter((e) => e.type === 'text');
  check('the composition carries supporting copy', texts.length >= 3, 'text runs=' + texts.length);
  const roleSet = new Set(Object.values(roles).map((c) => String(c).toUpperCase()));
  check('every text run uses a palette role', texts.every((t) => roleSet.has(String(t.fill).toUpperCase())), JSON.stringify(texts.map((t) => t.fill)));
  const corrected = correctColors(design, palette);
  check('L5 has nothing to re-ink', corrected.ops.every((op) => !op.props || !op.props.fill), JSON.stringify(corrected.notes));
}

console.log(failures === 0 ? 'QUALITY CHECK DONE' : `QUALITY CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);