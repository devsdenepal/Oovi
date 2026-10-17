import { chromium } from 'playwright';

// Opens a previously-unopenable saved design (negative group origin +
// negative group-relative children) and proves it loads onto the canvas
// with no error toast. Run with OOVI_DESIGN=<uuid>, defaults to the design
// that first exposed the bricked-open bug.
const PORT = process.env.OOVI_PORT || 5174;
const ID = process.env.OOVI_DESIGN || 'cc1ca114-805f-40fc-b7fb-7993fc3e749b';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(`http://localhost:${PORT}/#/design/${ID}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });

// loadProject is async (backend fetch) — wait for objects, not just boot.
await page.waitForFunction(() => window.__oovi.app.editor.canvas.getObjects().length > 0, { timeout: 30000 });
await page.waitForTimeout(1000);

const result = await page.evaluate(() => {
  const toasts = [...document.querySelectorAll('#toast-zone .studio-toast-error')].map((t) => t.innerText);
  return {
    objects: window.__oovi.app.editor.canvas.getObjects().length,
    errorToasts: toasts,
  };
});
console.log(`objects=${result.objects} errorToasts=${JSON.stringify(result.errorToasts)}`);

let failed = false;
if (result.objects === 0) { console.error('FAIL: nothing rendered'); failed = true; }
if (result.errorToasts.some((t) => t.includes("Couldn't open project"))) {
  console.error('FAIL: open error toasted');
  failed = true;
}
await browser.close();
console.log(failed ? 'OPEN CHECK: FAILURES' : 'OPEN CHECK DONE');
process.exit(failed ? 1 : 0);
