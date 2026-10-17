import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);
await page.fill('#insert-search', 'mountains');
await page.click('#insert-search-btn');
await page.waitForSelector('.insert-thumb', { timeout: 30000 });
const n = await page.evaluate(() => document.querySelectorAll('.insert-thumb').length);
console.log('RESULTS ' + n);
await page.locator('.insert-thumb').first().click();
await page.waitForFunction(() => {
  try {
    const d = JSON.parse(document.getElementById('json-preview').textContent || '{}');
    return (d.elements || []).some((e) => e.type === 'image');
  } catch { return false; }
}, null, { timeout: 120000 });
const info = await page.evaluate(() => {
  const d = JSON.parse(document.getElementById('json-preview').textContent || '{}');
  const img = d.elements?.find((e) => e.type === 'image');
  return { srcHead: (img?.src || '').slice(0, 30), w: img?.width, chat: document.getElementById('asst-log')?.innerText };
});
console.log('INSERTED ' + JSON.stringify({ srcHead: info.srcHead, w: info.w }));
console.log('CHAT ' + JSON.stringify(info.chat));
await browser.close();
console.log('PHOTO CHECK DONE');
