import { chromium } from 'playwright';

// Trash flow with strictly scoped cleanup (only touches rows it creates).
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dash = await ctx.newPage();
dash.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
dash.on('dialog', (d) => d.accept());
await dash.goto('http://localhost:5173/#/', { waitUntil: 'networkidle' });
await dash.waitForSelector('.dash-hero', { timeout: 20000 });
await dash.waitForTimeout(1000);

const ids = () => dash.evaluate(() => [...document.querySelectorAll('#dash-grid .dash-card')].map((c) => c.querySelector('.dash-title')?.textContent));
const trashIds = () => dash.evaluate(() => [...document.querySelectorAll('#dash-trash-grid .dash-card')].map((c) => c.querySelector('.dash-title')?.textContent));

// create one probe row via UI
await dash.fill('#dash-prompt', 'Trash probe design');
const [editor] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15000 }),
  dash.click('[data-dash="create"]'),
]);
await editor.waitForSelector('#canvas-holder', { timeout: 20000 });
await editor.waitForTimeout(800);
await editor.close();
await dash.reload({ waitUntil: 'networkidle' });
await dash.waitForTimeout(1500);
console.log('AFTER-CREATE ' + JSON.stringify(await ids()));

// delete ONLY the probe row (match by title)
const cards = dash.locator('#dash-grid .dash-card');
const n = await cards.count();
let target = -1;
for (let i = 0; i < n; i++) {
  const t = await cards.nth(i).locator('.dash-title').innerText();
  if (t === 'Trash probe design') target = i;
}
if (target < 0) throw new Error('probe row not found');
await cards.nth(target).locator('[data-act="delete"]').click();
await dash.waitForTimeout(1500);
console.log('AFTER-TRASH ' + JSON.stringify(await ids()));
console.log('TRASH-CONTENTS ' + JSON.stringify(await trashIds()));

// restore it from trash
await dash.click('#dash-trash > summary');
await dash.waitForTimeout(400);
const trows = dash.locator('#dash-trash-grid .dash-card');
const tn = await trows.count();
let ttarget = -1;
for (let i = 0; i < tn; i++) {
  const t = await trows.nth(i).locator('.dash-title').innerText();
  if (t === 'Trash probe design') ttarget = i;
}
if (ttarget < 0) throw new Error('probe row not in trash');
await trows.nth(ttarget).locator('[data-act="restore"]').click();
await dash.waitForTimeout(1500);
console.log('AFTER-RESTORE ' + JSON.stringify(await ids()));

// open it in a new tab to prove content survived the round trip
const [ed2] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15000 }),
  (async () => {
    const all = dash.locator('#dash-grid .dash-card');
    const m = await all.count();
    for (let i = 0; i < m; i++) {
      const t = await all.nth(i).locator('.dash-title').innerText();
      if (t === 'Trash probe design') { await all.nth(i).locator('[data-open]').click(); break; }
    }
  })(),
]);
await ed2.waitForSelector('#canvas-holder', { timeout: 20000 });
await ed2.waitForTimeout(1000);
console.log('REOPEN-HASH ' + JSON.stringify(await ed2.evaluate(() => location.hash.slice(0, 20))));
await ed2.close();

// permanent delete via trash destroy button
await dash.reload({ waitUntil: 'networkidle' });
await dash.waitForTimeout(1500);
await dash.click('#dash-trash > summary');
await dash.waitForTimeout(400);
const cards2 = dash.locator('#dash-grid .dash-card');
const m2 = await cards2.count();
for (let i = 0; i < m2; i++) {
  const t = await cards2.nth(i).locator('.dash-title').innerText();
  if (t === 'Trash probe design') { await cards2.nth(i).locator('[data-act="delete"]').click(); break; }
}
await dash.waitForTimeout(1500);
const trows2 = dash.locator('#dash-trash-grid .dash-card');
const tm2 = await trows2.count();
for (let i = 0; i < tm2; i++) {
  const t = await trows2.nth(i).locator('.dash-title').innerText();
  if (t === 'Trash probe design') { await trows2.nth(i).locator('[data-act="destroy"]').click(); break; }
}
await dash.waitForTimeout(1500);
console.log('AFTER-DESTROY recents=' + JSON.stringify(await ids()));
console.log('AFTER-DESTROY trash=' + JSON.stringify(await trashIds()));
await browser.close();
console.log('TRASH CHECK DONE');
