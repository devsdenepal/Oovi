import { chromium } from 'playwright';

const PORT = process.env.OOVI_PORT || 5174;
const WIDTHS = (process.env.SWEEP_WIDTHS || '1024,1280,1366,1440,1600,1920').split(',').map(Number);
const browser = await chromium.launch({ headless: true });
for (const vw of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: vw, height: 768 } });
  await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });
  await page.click('[data-ltab="reference"]');
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const over = (el) => el ? el.scrollWidth - el.clientWidth : -1;
    const row = q('#app > .container-fluid > .row');
    const cols = [...row.children].map((c) => [c.className.match(/col-\w+-\d+/g)?.join(' ') || c.className.slice(0, 20), c.getBoundingClientRect().width | 0]);
    const bad = [];
    document.querySelectorAll('#app *').forEach((el) => {
      const o = el.scrollWidth - el.clientWidth;
      if (o > 4) bad.push([o, el.id || '', (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 40)]);
    });
    bad.sort((a, b) => b[0] - a[0]);
    return { body: over(document.body), row: over(row), cols, bad: bad.slice(0, 5) };
  });
  console.log(`vw=${vw} bodyOver=${r.body} rowOver=${r.row} cols=${JSON.stringify(r.cols)} offenders=${JSON.stringify(r.bad)}`);
  await page.close();
}
await browser.close();
console.log('SWEEP DONE');
