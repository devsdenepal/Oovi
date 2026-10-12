import { chromium } from 'playwright';

const OUT = 'C:/Users/Dev/AppData/Local/Temp/opencode';
const TAG = process.argv[2] || process.env.SHOT_TAG || 'BEFORE';
const browser = await chromium.launch();
for (const [w, h, tag] of [[1440, 900, '1440'], [1366, 768, '1366'], [1920, 1080, '1920']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#canvas-holder', { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/polish-${TAG}-${tag}.png` });
  await page.close();
}
await browser.close();
console.log('BASELINE DONE');
