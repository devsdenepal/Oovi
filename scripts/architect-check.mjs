import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/?mock=1#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);
await page.click('[data-ltab="reference"]');
await page.click('#generate-btn');
await page.waitForTimeout(5000);
const r = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  return {
    status: q('#gen-status')?.textContent,
    layers: [...document.querySelectorAll('.layer-item')].map((li) => li.querySelector('.layer-name')?.textContent),
    chat: q('#asst-log')?.innerText,
    json: (() => { try { return JSON.parse(q('#json-preview')?.textContent || '{}').elements?.length; } catch { return -1; } })(),
  };
});
console.log('LAYERS ' + JSON.stringify(r.layers));
console.log('STATUS ' + r.status);
console.log('CHAT ' + JSON.stringify(r.chat));
console.log('JSON-ELEMENTS ' + r.json);
await page.screenshot({ path: 'C:/Users/Dev/AppData/Local/Temp/opencode/architect-mock.png' });
await browser.close();
console.log('ARCHITECT CHECK DONE');
