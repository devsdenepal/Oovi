import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type().toUpperCase() + ': ' + m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);
await page.click('[data-ltab="reference"]');
await page.waitForTimeout(400);
await page.click('#generate-btn');
await page.waitForFunction(() => {
  const el = document.getElementById('gen-status');
  return el && /editable/i.test(el.textContent || '');
}, null, { timeout: 60000 });
await page.click('[data-ltab="layers"]');
await page.waitForTimeout(400);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.layer-item')];
  rows.find((li) => li.querySelector('.layer-thumb, .fa-image'))?.click();
});
await page.waitForTimeout(500);
await page.click('[data-ctx="bgremove"]');
await page.waitForTimeout(90000);
const state = await page.evaluate(() => ({
  toasts: document.getElementById('toast-zone')?.innerText,
  genStatus: document.getElementById('gen-status')?.textContent,
}));
console.log('TOASTS ' + JSON.stringify(state.toasts));
console.log('GENSTATUS ' + JSON.stringify(state.genStatus));
console.log('CONSOLE ' + JSON.stringify(logs.slice(0, 10)));
await browser.close();
console.log('BGREMOVE DEBUG DONE');
