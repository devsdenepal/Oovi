import { chromium } from 'playwright';

// Renders ONLY the suspect gradient rect from the bricked design and prints
// the full stack of the createLinearGradient failure.
const PORT = process.env.OOVI_PORT || 5174;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR STACK:\n' + (e.stack || e.message).slice(0, 2000)));
await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });

await page.evaluate(() => {
  const { canvas } = window.__oovi.app.editor;
  canvas.clear();
  window.__oovi.app.editor.loadDesign({
    canvas: { width: 1200, height: 630, background: '#FFFFFF' },
    elements: [
      { id: 'g', type: 'group', x: -200, y: -39, children: [
        { id: 'r', type: 'rectangle', x: -250, y: -98.208, width: 500, height: 120, fill: '#FF6F61',
          gradient: { type: 'linear', stops: [{ color: '#FF6F61', offset: 0 }, { color: '#0F0F15', offset: 1 }], coords: [0, 0, 500, 120] } },
      ] },
    ],
  });
  canvas.renderAll();
  const rect = canvas.getObjects()[0].getObjects()[0];
  console.log('RECT-INFO w=' + rect.width + ' h=' + rect.height + ' fillType=' + (rect.fill && rect.fill.type));
});
await page.waitForTimeout(1500);
await browser.close();
console.log('GRADIENT STACK DONE');
