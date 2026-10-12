import { chromium } from 'playwright';

const OUT = 'C:/Users/Dev/AppData/Local/Temp/opencode';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(1200);

const snap = (tag) => page.evaluate((t) => {
  const q = (s) => document.querySelector(s);
  const r = (el) => (el ? { w: el.clientWidth, h: el.clientHeight, sh: el.scrollHeight } : null);
  const cs = (el, props) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const o = {};
    props.forEach((p) => { o[p] = s.getPropertyValue(p); });
    return o;
  };
  const P = ['display', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-basis', 'min-height', 'min-width', 'overflow', 'align-items', 'height'];
  const cols = Array.from(document.querySelectorAll('#app > .container-fluid > .row > div'));
  return {
    tag: t,
    bodySH: document.body.scrollHeight,
    winH: window.innerHeight,
    app: r(q('#app')),
    row: r(q('#app > .container-fluid > .row')),
    colC: r(cols[1]),
    main: r(q('.canvas-area')),
    head: r(q('.canvas-head')),
    frame: r(q('.canvas-frame')),
    holder: r(q('#canvas-holder')),
    zoom: q('[data-tb="zoom-fit"]')?.textContent,
    csRow: cs(q('#app > .container-fluid > .row'), P),
    csCol: cs(cols[1], P),
    csMain: cs(q('.canvas-area'), P),
    csFrame: cs(q('.canvas-frame'), P),
  };
});

console.log('BASE ' + JSON.stringify(await snap('base')));
await page.screenshot({ path: OUT + '/z-base.png' });

await page.click('[data-tb="zoom-in"]');
await page.waitForTimeout(700);
console.log('ZIN1 ' + JSON.stringify(await snap('zin1')));

await page.click('[data-tb="zoom-in"]');
await page.waitForTimeout(700);
console.log('ZIN2 ' + JSON.stringify(await snap('zin2')));
await page.screenshot({ path: OUT + '/z-zin2.png' });

await page.click('[data-tb="zoom-100"]');
await page.waitForTimeout(700);
console.log('Z100 ' + JSON.stringify(await snap('z100')));

await page.click('[data-tb="zoom-fit"]');
await page.waitForTimeout(700);
console.log('FIT ' + JSON.stringify(await snap('fit')));

await browser.close();
console.log('PROBE DONE');
