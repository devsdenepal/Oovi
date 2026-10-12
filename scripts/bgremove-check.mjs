import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);
await page.click('[data-ltab="reference"]');
await page.waitForTimeout(400);
await page.click('#generate-btn');
await page.waitForFunction(() => {
  const el = document.getElementById('gen-status');
  return el && /editable/i.test(el.textContent || '');
}, { timeout: 30000 });

// select the image layer via layers tab
await page.click('[data-ltab="layers"]');
await page.waitForTimeout(400);
const imgId = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.layer-item')];
  const row = rows.find((li) => li.querySelector('.layer-thumb, .fa-image'));
  if (row) row.click();
  return row?.dataset.id || null;
});
console.log('SELECTED-IMAGE ' + imgId);
await page.waitForTimeout(500);
const ctxVisible = await page.evaluate(() => {
  const bar = document.querySelector('.context-toolbar');
  const btn = document.querySelector('[data-ctx="bgremove"]');
  return { barHidden: bar?.hidden, btnHidden: btn?.hidden };
});
console.log('CTX ' + JSON.stringify(ctxVisible));

const before = await page.evaluate(() => JSON.parse(document.getElementById('json-preview').textContent || '{}').elements?.find((e) => e.type === 'image')?.src?.slice(0, 30));
await page.click('[data-ctx="bgremove"]');
await page.waitForFunction(() => {
  try {
    const d = JSON.parse(document.getElementById('json-preview').textContent || '{}');
    const src = d.elements?.find((e) => e.type === 'image')?.src || '';
    return src.startsWith('data:image/png');
  } catch { return false; }
}, null, { timeout: 300000 });
const after = await page.evaluate(() => JSON.parse(document.getElementById('json-preview').textContent || '{}').elements?.find((e) => e.type === 'image')?.src?.slice(0, 30));
console.log('SRC-BEFORE ' + before);
console.log('SRC-AFTER ' + after);
await browser.close();
console.log('BGREMOVE CHECK DONE');
