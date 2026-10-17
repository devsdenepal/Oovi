import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1000);
const w = () => page.evaluate(() => ({
  center: document.querySelector('.center-col')?.clientWidth,
  frame: document.querySelector('.canvas-frame')?.clientWidth,
  holder: document.querySelector('#canvas-holder')?.clientWidth,
  collapsed: document.getElementById('app').classList.contains('side-collapsed'),
}));
console.log('OPEN ' + JSON.stringify(await w()));
await page.click('#sidebar-toggle');
await page.waitForTimeout(600);
console.log('COLLAPSED ' + JSON.stringify(await w()));
await page.click('#sidebar-toggle');
await page.waitForTimeout(600);
console.log('REOPENED ' + JSON.stringify(await w()));
await browser.close();
console.log('COLLAPSE CHECK DONE');
