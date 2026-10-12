import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);

const ids = () => page.evaluate(() => {
  const app = window.__oovi?.app;
  let json;
  try {
    json = (JSON.parse(document.getElementById('json-preview').textContent || '{}').elements || []).map((e) => e.id).sort().join(',');
  } catch { json = 'PARSE-FAIL'; }
  return JSON.stringify({
    json,
    objs: app?.editor.canvas?.getObjects().length,
    undo: app?.editor.history.undoStack.length,
    redo: app?.editor.history.redoStack.length,
  });
});
const keys = (key, code) => page.keyboard.press(key, { delay: 30 });
console.log('EMPTY ' + JSON.stringify(await ids()));

// insert rect + circle via Insert tab buttons
await page.click('[data-insert="rectangle"]');
await page.waitForTimeout(400);
await page.click('[data-insert="circle"]');
await page.waitForTimeout(400);
console.log('TWO ' + JSON.stringify(await ids()));

// undo once -> circle gone, rect stays (first undo must visibly revert)
await keys('ControlOrMeta+z');
await page.waitForTimeout(400);
console.log('UNDO1 ' + JSON.stringify(await ids()));

// undo again -> empty canvas, redo available
await keys('ControlOrMeta+z');
await page.waitForTimeout(400);
console.log('UNDO2 ' + JSON.stringify(await ids()));

// undo at floor -> no-op, still empty
await keys('ControlOrMeta+z');
await page.waitForTimeout(400);
console.log('UNDO3-FLOOR ' + JSON.stringify(await ids()));

// redo -> rect back
await keys('ControlOrMeta+y');
await page.waitForTimeout(400);
console.log('REDO1 ' + JSON.stringify(await ids()));

// redo -> both back
await keys('ControlOrMeta+y');
await page.waitForTimeout(400);
console.log('REDO2 ' + JSON.stringify(await ids()));

// new action clears redo: undo once, insert line, redo must no-op
await keys('ControlOrMeta+z');
await page.waitForTimeout(400);
await page.click('[data-insert="line"]');
await page.waitForTimeout(400);
console.log('NEWACTION ' + JSON.stringify(await ids()));
await keys('ControlOrMeta+y');
await page.waitForTimeout(400);
console.log('REDO-CLEARED ' + JSON.stringify(await ids()));

await browser.close();
console.log('HISTORY CHECK DONE');
