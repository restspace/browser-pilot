import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto('http://127.0.0.1:7080/iframe');
await p.waitForTimeout(2500);
await p.locator('body').ariaSnapshot({ mode: 'ai' }); // establishes refs
for (const ref of ['f1e2', 'e9']) {
  try {
    const loc = p.locator(`aria-ref=${ref}`);
    console.log(ref, '-> count', await loc.count(), '| text:', (await loc.innerText().catch(() => '(n/a)')).slice(0, 40));
  } catch (e) { console.log(ref, '-> ERR', e.message.split('\n')[0].slice(0, 90)); }
}
await b.close();
