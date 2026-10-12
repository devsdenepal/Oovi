import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = 'C:/Users/Dev/AppData/Local/Temp/opencode';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);

// non-empty canvas: insert a rectangle
await page.click('[data-ltab="insert"]');
await page.click('[data-insert="rectangle"]');
await page.waitForTimeout(600);
console.log('OBJECTS ' + await page.evaluate(() => window.__app ? 'n/a' : document.querySelectorAll('canvas').length));

for (const fmt of ['png', 'jpg', 'svg', 'pdf']) {
  await page.click('[data-tb="export-menu"]');
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click(`[data-tb-export="${fmt}"]`),
  ]);
  const path = OUT + '/exp-' + (await dl.suggestedFilename());
  await dl.saveAs(path);
  const st = fs.statSync(path);
  const head = Buffer.alloc(8);
  fs.readFileSync(path, { flag: 'r' }).copy(head, 0, 0, 8);
  console.log(`DL ${fmt} file=${dl.suggestedFilename()} size=${st.size} magic=${head.toString('latin1').replace(/[^ -~]/g, '.')}`);
}

// preview backdrop check
await page.click('[data-tb="preview"]');
await page.waitForTimeout(500);
const pv = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  return {
    navHidden: getComputedStyle(q('nav')).display === 'none',
    areaBg: getComputedStyle(q('.canvas-area')).backgroundColor,
    exitVisible: !q('#exit-preview').hidden,
  };
});
console.log('PREVIEW ' + JSON.stringify(pv));
await page.screenshot({ path: OUT + '/preview-mode.png' });
await browser.close();
console.log('EXPORT CHECK DONE');
