import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dash = await ctx.newPage();
dash.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
dash.on('dialog', (d) => d.accept());
await dash.goto('http://localhost:5173/#/', { waitUntil: 'networkidle' });
await dash.waitForSelector('.dash-hero', { timeout: 20000 });
await dash.waitForTimeout(800);
console.log('EMPTY-STATE ' + JSON.stringify((await dash.locator('#dash-status').innerText()).slice(0, 60)));

await dash.fill('#dash-prompt', 'Probe journey design');
const [editor] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15000 }),
  dash.click('[data-dash="create"]'),
]);
editor.on('dialog', (d) => d.accept());
await editor.waitForSelector('#canvas-holder', { timeout: 20000 });
await editor.waitForTimeout(1000);
const prefill = await editor.locator('#prompt-textarea').inputValue();
console.log('PREFILL ' + JSON.stringify(prefill.slice(0, 30)));
console.log('HASH-NEW ' + JSON.stringify(await editor.evaluate(() => location.hash)));

await editor.click('[data-insert="rectangle"]');
await editor.waitForTimeout(5000); // persist debounce (2.5s) + margin
const hash = await editor.evaluate(() => location.hash);
console.log('HASH-SAVED ' + JSON.stringify(hash));
await editor.reload({ waitUntil: 'networkidle' });
await editor.waitForSelector('#canvas-holder', { timeout: 20000 });
await editor.waitForTimeout(1200);
const after = await editor.evaluate(() => {
  try {
    const d = JSON.parse(document.getElementById('json-preview').textContent || '{}');
    return (d.elements || []).map((e) => e.type).join(',');
  } catch { return 'PARSE-FAIL'; }
});
console.log('RELOADED-ELEMENTS ' + after);

await dash.reload({ waitUntil: 'networkidle' });
await dash.waitForTimeout(1500);
const base = await dash.locator('.dash-card').count();
console.log('BASELINE-CARDS ' + base);
const cards = await dash.evaluate(() => ({
  n: document.querySelectorAll('.dash-card').length,
  title: document.querySelector('.dash-title')?.textContent,
  thumb: !!document.querySelector('.dash-thumb img'),
}));
console.log('DASH ' + JSON.stringify(cards));

// rename
await dash.dblclick('.dash-title');
await dash.fill('.dash-rename', 'Renamed Probe');
await dash.press('.dash-rename', 'Enter');
await dash.waitForTimeout(1200);
console.log('RENAMED ' + JSON.stringify(await dash.locator('.dash-title').first().innerText()));

// duplicate then delete both
await dash.click('.dash-btns [data-act="duplicate"]');
await dash.waitForTimeout(1200);
console.log('AFTER-DUP ' + (await dash.locator('.dash-card').count()));
const dels = await dash.locator('.dash-btns [data-act="delete"]').count();
for (let i = 0; i < dels; i++) {
  await dash.locator('.dash-btns [data-act="delete"]').first().click();
  await dash.waitForTimeout(1200);
}
console.log('AFTER-DEL ' + (await dash.locator('.dash-card').count()) + ' (baseline was ' + base + ')');
await browser.close();
console.log('DASHBOARD CHECK DONE');
