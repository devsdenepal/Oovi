import { chromium } from 'playwright';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok: ' + name);
  else { console.error('FAIL: ' + name + ' ' + extra); failures++; }
};

const PORT = process.env.OOVI_PORT || 5174;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });
await page.waitForTimeout(500);

const depth = () => page.evaluate(() => window.__oovi.app.editor.history.undoStack.length);
const u0 = await depth();

// Double-click empty canvas -> textbox + inline editing.
const box = await page.locator('#canvas-holder').boundingBox();
await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
const u1 = await depth();
check('insert is one entry', u1 === u0 + 1, `u0=${u0} u1=${u1}`);

// Type fast: 5 keystrokes must NOT snapshot each.
await page.keyboard.type('hello');
await page.waitForTimeout(300);
const u2 = await depth();
check('no snapshot while typing', u2 === u1, `u1=${u1} u2=${u2}`);

// Trailing snapshot lands once.
await page.waitForTimeout(1200);
const u3 = await depth();
check('one snapshot after pause', u3 === u1 + 1, `u1=${u1} u3=${u3}`);

// Undo reverts the typing, keeps the box.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press('ControlOrMeta+z');
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  undo: window.__oovi.app.editor.history.undoStack.length,
  texts: window.__oovi.app.editor.canvas.getObjects().filter((o) => (o.elementType || o.type || '').includes('text')).length,
}));
check('undo drops one entry, box stays', after.undo === u3 - 1 && after.texts >= 1, JSON.stringify(after));

await browser.close();
console.log(failures === 0 ? 'TYPE CHECK DONE' : `TYPE CHECK: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
