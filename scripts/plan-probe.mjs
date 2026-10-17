import { chromium } from 'playwright';

const PORT = process.env.OOVI_PORT || 5174;
const PROMPT = 'An event announcement for event: Hacktoberfest 2026, use pixel designs, funky designs, add info yourself i.e. date time and location, have footer and header (generate image)';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
page.on('console', (m) => {
  const t = m.text();
  if (/^\[(ai|build|tidy)\]/.test(t)) console.log('CONSOLE: ' + t.slice(0, 300));
});
await page.goto(`http://localhost:${PORT}/#/design/new`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__oovi?.app?.editor, { timeout: 30000 });

console.log('calling planDesign (1 AI call)…');
const t0 = Date.now();
const plan = await page.evaluate(async (prompt) => {
  const mod = await import('/src/ai/aiClient.js');
  const app = window.__oovi.app;
  const canvas = { width: app.designPreset.width, height: app.designPreset.height };
  const t = Date.now();
  const p = await mod.planDesign(prompt, canvas);
  return { ms: Date.now() - t, canvas, plan: p };
}, PROMPT, { timeout: 1500000 });
console.log(`plan took ${(plan.ms / 1000).toFixed(1)}s on ${plan.canvas.width}x${plan.canvas.height}`);
console.log('source: ' + plan.plan.source);
console.log('palette: ' + JSON.stringify(plan.plan.palette));
console.log('style: ' + (plan.plan.style || '(none)'));
console.log(`components (${plan.plan.components.length}):`);
for (const c of plan.plan.components) {
  const b = c.box || {};
  console.log(` - ${c.id} [${c.kind}/${c.role || '?'}] box=${b.x},${b.y} ${b.width}x${b.height} :: ${(c.describe || '').slice(0, 90)}`);
}
if (plan.plan.warnings?.length) console.log('warnings: ' + plan.plan.warnings.join(' | '));
await browser.close();
console.log('PLAN PROBE DONE');
