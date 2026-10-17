import { chromium } from 'playwright';

const PORT = process.env.OOVI_PORT || 5174;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });
await page.click('[data-ltab="reference"]');
await page.waitForTimeout(800);

const data = await page.evaluate(() => {
  const out = {};
  const doc = document.documentElement;
  out.viewport = [window.innerWidth, window.innerHeight];
  out.bodyScroll = [document.body.scrollWidth, document.body.clientWidth];
  for (const sel of ['#app > .container-fluid > .row', '.left-col', '.center-col', '.col-lg-3', '#topbar-mount', '.sidebar-left', '.left-panels', '.inspector', '.canvas-area', '.influence-row', '#assistant-mount', '.side-block', '.prompt-input', '.assistant-suggest', '.gen-status', '.canvas-head', '#designtype-mount']) {
    const el = document.querySelector(sel);
    if (el) out[sel] = [el.scrollWidth, el.clientWidth, el.scrollHeight, el.clientHeight];
  }
  // Top offenders anywhere in #app.
  const bad = [];
  document.querySelectorAll('#app *').forEach((el) => {
    const over = el.scrollWidth - el.clientWidth;
    if (over > 4 && bad.length < 400) {
      bad.push({ over, cls: (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 60), id: el.id || '' });
    }
  });
  bad.sort((a, b) => b.over - a.over);
  out.topOffenders = bad.slice(0, 8);
  return out;
});
console.log(JSON.stringify(data, null, 1));
await browser.close();
console.log('MEASURE DONE');
