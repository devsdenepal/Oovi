import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(800);
await page.click('#sidebar-toggle');
await page.waitForTimeout(500);
await page.locator('.sidebar-left').screenshot({ path: 'C:/Users/Dev/AppData/Local/Temp/opencode/side-collapsed.png' });
await page.click('[data-ltab="layers"]');
await page.waitForTimeout(500);
const reopened = await page.evaluate(() => !document.getElementById('app').classList.contains('side-collapsed'));
console.log('REOPENED-BY-TAB ' + reopened);
await browser.close();
