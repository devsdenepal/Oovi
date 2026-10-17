import { chromium } from 'playwright';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok: ' + name);
  else { console.error('FAIL: ' + name + ' ' + extra); failures++; }
};

const PORT = process.env.OOVI_PORT || 5173;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 20000 });
await page.waitForTimeout(500);

const api = (expr) => page.evaluate(expr);
// Add two overlapping top-level texts plus one text hanging off the edge.
const setup = await page.evaluate(() => {
  const app = window.__oovi?.app;
  if (!app) return { err: 'no-app' };
  const W = app.editor.canvas.width;
  const H = app.editor.canvas.height;
  const before = app.editor.history.undoStack.length;
  app.editor.applyPatchOps([
    { op: 'add', element: { id: 't1', type: 'text', content: 'First line of overlapping copy here', x: 100, y: 60, width: 460, fontSize: 40, fontWeight: 800, fill: '#111111' } },
  ]);
  app.editor.applyPatchOps([
    { op: 'add', element: { id: 't2', type: 'text', content: 'Second line of overlapping copy here', x: 120, y: 120, width: 460, fontSize: 40, fontWeight: 400, fill: '#111111' } },
  ]);
  app.editor.applyPatchOps([
    { op: 'add', element: { id: 't3', type: 'text', content: 'Hanging off the right edge', x: W - 100, y: H - 110, width: 400, fontSize: 28, fontWeight: 400, fill: '#111111' } },
  ]);
  // Group card hanging off the right edge (overflow must move the whole card).
  app.editor.applyPatchOps([
    { op: 'add', element: { id: 'g1', type: 'group', x: W - 150, y: 300, children: [
      { id: 'g1-bg', type: 'rectangle', x: 0, y: 0, width: 300, height: 100, fill: '#EEEEEE' },
      { id: 'g1-tx', type: 'text', content: 'Card label inside group', x: 10, y: 10, width: 280, fontSize: 28, fontWeight: 400, fill: '#111111' },
    ] } },
  ]);
  // Text overlapping a plain shape: the TEXT must move, the shape must not.
  app.editor.applyPatchOps([
    { op: 'add', element: { id: 's1', type: 'rectangle', x: 100, y: 360, width: 260, height: 100, fill: '#CCCCCC' } },
    { op: 'add', element: { id: 't4', type: 'text', content: 'Text sitting on top of the shape below', x: 150, y: 385, width: 300, fontSize: 32, fontWeight: 400, fill: '#111111' } },
  ]);
  return { before, W, H };
});
check('setup ran', !setup.err, JSON.stringify(setup));

// Snapshot positions before the tidy (s1 must never move).
const beforePos = await page.evaluate(() => {
  const m = {};
  for (const e of window.__oovi.app.editor.toDesign().elements) m[e.id] = [e.x, e.y];
  return m;
});
// Group children serialize center-relative (Fabric native frame:
// a child emitted at x stores left = x - groupW/2). Assert that frame.
const gkids = await page.evaluate(() => {
  const g = window.__oovi.app.editor.toDesign().elements.find((e) => e.id === 'g1');
  return (g.children || []).map((k) => [k.id, k.x, k.y]);
});
check(
  'group children keep center frame',
  JSON.stringify(gkids) === JSON.stringify([['g1-bg', -150, -50], ['g1-tx', -140, -40]]),
  JSON.stringify(gkids),
);

// Run the deterministic tidy.
const fix = await page.evaluate(() => window.__oovi.app.editor.resolveCollisions());
check('resolver moved pieces', fix.moved.length >= 3, JSON.stringify(fix));
check('nothing unresolvable', fix.unresolvable.length === 0, JSON.stringify(fix.unresolvable));

// Exactly one new history entry for the whole tidy.
const depths = await page.evaluate(() => ({
  now: window.__oovi.app.editor.history.undoStack.length,
}));
check('tidy is one undo step', depths.now === setup.before + 6, JSON.stringify({ ...depths, ...setup }));

// No text-on-text overlap and no edge overflow remain (measured live).
const geom = await page.evaluate(() => {
  const objs = window.__oovi.app.editor.canvas.getObjects().filter((o) => (o.elementType === 'text'));
  const rs = objs.map((o) => ({ id: o.designId, r: o.getBoundingRect() }));
  let overlap = false;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i].r, b = rs[j].r;
      const ox = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const oy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      const smaller = Math.min(a.width * a.height, b.width * b.height);
      if (ox > 0 && oy > 0 && (ox * oy) / smaller > 0.15) overlap = true;
    }
  }
  const W = window.__oovi.app.editor.canvas.width;
  const H = window.__oovi.app.editor.canvas.height;
  const outside = rs.filter(({ r }) => r.left < -1 || r.top < -1 || r.left + r.width > W + 1 || r.top + r.height > H + 1).map(({ id }) => id);
  return { overlap, outside };
});
check('no text overlap remains', geom.overlap === false, JSON.stringify(geom));
check('no text outside canvas', geom.outside.length === 0, JSON.stringify(geom));

// Group card pulled inside; shape untouched.
const post = await page.evaluate(() => {
  const app = window.__oovi.app;
  const m = {};
  for (const e of app.editor.toDesign().elements) m[e.id] = [e.x, e.y];
  const g = app.editor.canvas.getObjects().find((o) => o.designId === 'g1');
  return { pos: m, gbox: g ? g.getBoundingRect() : null, W: app.editor.canvas.width, H: app.editor.canvas.height };
});
check('shape s1 never moved', JSON.stringify(post.pos.s1) === JSON.stringify(beforePos.s1), JSON.stringify({ before: beforePos.s1, after: post.pos.s1 }));
check(
  'group g1 back inside canvas',
  post.gbox && post.gbox.left >= -1 && post.gbox.top >= -1 &&
  post.gbox.left + post.gbox.width <= post.W + 1 && post.gbox.top + post.gbox.height <= post.H + 1,
  JSON.stringify(post.gbox),
);
// Selection-proof serialization: every object moved by exactly its planned
// delta, everything else bit-identical (kills the relativized-coords bug).
{
  const deltas = {};
  for (const m of fix.moved) deltas[m.id] = [m.dx, m.dy];
  const bad = [];
  for (const id of Object.keys(beforePos)) {
    if (!post.pos[id]) { bad.push(id + ':vanished'); continue; }
    const dx = post.pos[id][0] - beforePos[id][0];
    const dy = post.pos[id][1] - beforePos[id][1];
    const want = deltas[id] || [0, 0];
    if (Math.abs(dx - want[0]) > 1.5 || Math.abs(dy - want[1]) > 1.5) {
      bad.push(`${id}: moved [${dx.toFixed(1)},${dy.toFixed(1)}] want [${want}]`);
    }
  }
  check('toDesign stable under selection', bad.length === 0, JSON.stringify(bad.slice(0, 4)));
}

// One Ctrl+Z reverts the whole tidy but keeps the three texts.
await page.keyboard.press('ControlOrMeta+z', { delay: 30 });
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  ids: window.__oovi.app.editor.toDesign().elements.map((e) => e.id).sort().join(','),
  undo: window.__oovi.app.editor.history.undoStack.length,
  redo: window.__oovi.app.editor.history.redoStack.length,
}));
check('undo keeps all texts', after.ids === 'g1,s1,t1,t2,t3,t4', JSON.stringify(after));
check('undo depth back by one', after.undo === depths.now - 1 && after.redo === 1, JSON.stringify(after));

await browser.close();
console.log(failures === 0 ? 'RESOLVE CHECK DONE' : `RESOLVE CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
