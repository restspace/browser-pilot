import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto('http://127.0.0.1:7080/iframe');
await p.waitForTimeout(2500);
let s; try { s = await p.locator('body').ariaSnapshot({ mode: 'ai' }); } catch { s = await p.locator('body').ariaSnapshot(); }
console.log('--- page ariaSnapshot: does it contain iframe content? ---');
console.log(s.split('\n').filter(l => /iframe|application|textbox|Your content/i.test(l)).join('\n') || '(nothing iframe-ish)');
console.log('frames on page:', p.frames().length, p.frames().map(f => f.url()).join(' | '));
// Can we act inside the frame?
const fl = p.frameLocator('#mce_0_ifr').locator('body#tinymce');
console.log('frameLocator body count:', await fl.count());
console.log('frame text:', (await fl.innerText().catch(e => 'ERR ' + e.message)).slice(0, 60));
// Can a plain page.locator reach it?
console.log('page.locator into frame count:', await p.locator('body#tinymce').count());
await b.close();
