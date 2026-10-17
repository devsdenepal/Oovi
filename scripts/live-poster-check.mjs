import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { evaluateDesign } from '../src/ai/quality.js';

const PORT = process.env.OOVI_PORT || 5174;
const OUT_PNG = (process.env.OOVI_OUT || 'C:/Users/Dev/AppData/Local/Temp/opencode') + '/poster-live.png';
const OUT_JSON = (process.env.OOVI_OUT || 'C:/Users/Dev/AppData/Local/Temp/opencode') + '/poster-live.json';

const PROMPT = 'An event announcement for event: Hacktoberfest 2026, use pixel designs, funky designs, add info yourself i.e. date time and location, have footer and header (generate image)';

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)));
// Forward the app's [ai]/[build]/[tidy] console trail so chain hops
// (rung -> rung fallthrough) are visible in run output.
page.on('console', (m) => {
  const t = m.text();
  if (/^\[(ai|build|tidy)\]/.test(t)) console.log('CONSOLE: ' + t.slice(0, 300));
});
await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });
console.log('boot ok');

console.log('generating (real AI, may take minutes)…');
const chatTail = await page.evaluate(async (prompt) => {
  const app = window.__oovi.app;
  await app.onGenerateArchitected(prompt);
  const mount = document.getElementById('assistant-mount');
  return (mount ? mount.innerText : '').slice(-3000);
}, PROMPT, { timeout: 3600000 });
console.log('=== assistant tail ===');
console.log(chatTail);
console.log('=== end assistant ===');

const design = await page.evaluate(() => window.__oovi.app.editor.toDesign());
writeFileSync(OUT_JSON, JSON.stringify(design, null, 1));
console.log(`design: ${design.elements.length} top-level elements on ${design.canvas.width}x${design.canvas.height}`);

const report = evaluateDesign(design, { expectHero: true });
console.log(`QUALITY ${report.score}/100`);
for (const i of report.issues) console.log(` - ${i.severity}: [${i.code}] ${i.message}`);

// Real export path first (may fail on hotlinked/CORS-tainted canvas).
const shot = await page.evaluate(() => {
  try {
    const url = window.__oovi.app.editor.canvas.toDataURL({ format: 'png', multiplier: 1 });
    return { ok: true, url };
  } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
}, { timeout: 120000 });
if (shot.ok) {
  writeFileSync(OUT_PNG, Buffer.from(shot.url.split(',')[1], 'base64'));
  console.log('export path: toDataURL ok -> ' + OUT_PNG);
} else {
  console.log('export path BLOCKED: ' + shot.err);
  const box = await page.locator('#canvas-holder').boundingBox();
  await page.screenshot({ path: OUT_PNG, clip: box });
  console.log('fallback: clipped page screenshot -> ' + OUT_PNG);
}

await browser.close();
console.log('LIVE POSTER CHECK DONE');
