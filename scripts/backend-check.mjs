import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:5173/#/design/new', { waitUntil: 'networkidle' });
await page.waitForSelector('#canvas-holder', { timeout: 20000 });
await page.waitForTimeout(800);

const r = await page.evaluate(async () => {
  const mod = await import('/src/ai/pollinations.js');
  const out = {};
  try {
    await mod.fetchAssetViaBackend('test', { width: 64, height: 64 });
    out.backend = 'UNEXPECTED-SUCCESS';
  } catch (e) {
    out.backend = 'throws as designed (' + e.message + ')';
  }
  const url = mod.assetUrl('flat star icon', { width: 128, height: 128, asset: 'icon' });
  out.keyless = !url.includes('key=');
  out.model = url.includes('model=turbo');
  try {
    const src = await mod.fetchAssetDataUrl(url);
    out.direct = `dataURL ok (${src.length} chars, ${src.slice(5, 20)})`;
  } catch (e) {
    out.direct = 'FAILED (' + e.message + ')';
  }
  return out;
});
console.log('BACKEND ' + r.backend);
console.log('KEYLESS-URL ' + r.keyless + ' TURBO ' + r.model);
console.log('DIRECT-FETCH ' + r.direct);
await browser.close();
console.log('BACKEND CHECK DONE');
