import { chromium } from 'playwright';

const OUT = 'C:/Users/Dev/AppData/Local/Temp/opencode';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('[data-ltab="reference"]');
await page.waitForTimeout(600);
await page.locator('.sidebar-left').screenshot({ path: OUT + '/ai-tab.png' });
console.log('SHOT DONE');
await browser.close();
