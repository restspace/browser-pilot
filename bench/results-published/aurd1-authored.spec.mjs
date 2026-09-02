#!/usr/bin/env node
import { chromium } from 'playwright-core';

const RUNID = process.env.RUNID;
if (!RUNID) throw new Error('RUNID env var is required');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4180/';
const EMAIL = process.env.APP_EMAIL;
const PASSWORD = process.env.APP_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('APP_EMAIL and APP_PASSWORD env vars are required');

const TITLE = `${RUNID} RD Bench Ticket`;
const PART_A = `${RUNID} RD Part A`;
const PART_B = `${RUNID} RD Part B`;

const results = [];
function record(n, ok, detail) {
  results.push({ n, ok, detail });
  console.log(`${n}. ${ok ? 'DONE' : 'FAILED'} — ${detail}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

async function step(msg) { console.log(msg); }

try {
  // Sign in
  step('Signing in…');
  await page.goto(APP_URL);
  await page.getByRole('textbox', { name: 'Email address' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Repair tickets' }).waitFor();
  step('Signed in.');

  // Objective 1: create ticket
  step('Creating ticket…');
  await page.getByRole('button', { name: 'New ticket' }).click();
  await page.getByRole('textbox', { name: /Title/ }).fill(TITLE);
  await page.getByRole('textbox', { name: 'Customer' }).fill('Bench Customer');
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await page.getByRole('heading', { level: 1, name: TITLE }).waitFor();
  const ref = await page.locator('nav[aria-label="Breadcrumb"]').innerText();
  const refMatch = ref.match(/RD-\d+/);
  const refId = refMatch ? refMatch[0] : 'unknown';
  record(1, true, `Ticket ${refId} "${TITLE}" created and visible.`);

  // Helper: add a part
  async function addPart(name, cost, markup) {
    await page.getByRole('button', { name: 'Add part' }).click();
    await page.getByRole('textbox', { name: /Part name/ }).fill(name);
    await page.getByRole('spinbutton', { name: /Cost/ }).fill(String(cost));
    await page.getByRole('spinbutton', { name: /Markup %/ }).fill(String(markup));
    await page.getByRole('button', { name: 'Add part' }).click();
    await page.getByRole('row', { name: new RegExp(name) }).waitFor();
  }

  async function priceOf(name) {
    const row = page.getByRole('row', { name: new RegExp(name) });
    await row.waitFor();
    const text = await row.innerText();
    const m = text.match(/\$([\d,]+\.\d{2})/g);
    if (!m) throw new Error(`No price found for ${name}: ${text}`);
    return m[m.length - 1];
  }

  // Objective 2: Part A
  step('Adding Part A…');
  await addPart(PART_A, 100, 25);
  const priceA = await priceOf(PART_A);
  record(2, true, `${PART_A}: cost 100, markup 25, computed price $${priceA}.`);

  // Objective 3: Part B
  step('Adding Part B…');
  await addPart(PART_B, 200, 25);
  const priceB = await priceOf(PART_B);
  record(3, true, `${PART_B}: cost 200, markup 25, computed price $${priceB}.`);

  // Objective 4: edit Part A cost to 150
  step('Editing Part A cost to 150…');
  await page.getByRole('row', { name: new RegExp(PART_A) }).getByRole('button', { name: 'Edit' }).click();
  const costBox = page.getByRole('spinbutton', { name: /Cost/ });
  await costBox.waitFor();
  await costBox.fill('150');
  await page.getByRole('button', { name: 'Save part' }).click();
  await page.getByRole('row', { name: new RegExp(PART_A) }).getByRole('button', { name: 'Edit' }).waitFor();
  const priceA2 = await priceOf(PART_A);
  record(4, true, `After cost change to 150, ${PART_A} price is $${priceA2}.`);

  // Objective 5: discover preconditions for Ready
  step('Attempting Mark Ready to discover preconditions…');
  await page.getByRole('button', { name: 'Mark Ready' }).click();
  // Wait for either the error banner or success
  await page.waitForFunction(() => {
    const b = document.body.innerText;
    return b.includes('Ticket is not ready') || b.includes('Status') && (b.includes('Ready') && !b.includes('Mark Ready'));
  }, { timeout: 10000 });
  let preconditions = 'none required';
  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('Ticket is not ready')) {
    const lines = bodyText.split('\n').filter(l => l.includes('has no supplier') || l.includes('must') || l.includes('required'));
    preconditions = lines.join(' | ');
    step(`Preconditions discovered: ${preconditions}`);
    // Satisfy: give each part a supplier
    for (const partName of [PART_A, PART_B]) {
      await page.getByRole('row', { name: new RegExp(partName) }).getByRole('button', { name: 'Edit' }).click();
      const sup = page.getByRole('textbox', { name: 'Supplier' });
      await sup.waitFor();
      await sup.fill('Bench Supplier');
      await page.getByRole('button', { name: 'Save part' }).click();
      await page.getByRole('row', { name: new RegExp(partName) }).getByRole('button', { name: 'Edit' }).waitFor();
      step(`Set supplier on ${partName}.`);
    }
    await page.getByRole('button', { name: 'Mark Ready' }).click();
  }
  await page.getByRole('button', { name: 'Mark Draft' }).waitFor({ timeout: 10000 });
  const statusText = await page.locator('body').innerText();
  const readyOk = /Status\s*\n?\s*Ready/.test(statusText) && statusText.includes('Mark Draft');
  record(5, readyOk, `Status Ready achieved. Required: ${preconditions}`);

  // Objective 6: delete both parts, archive
  step('Deleting parts…');
  for (const partName of [PART_A, PART_B]) {
    const row = page.getByRole('row', { name: new RegExp(partName) });
    await row.waitFor();
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete part' }).waitFor();
    await page.getByRole('button', { name: 'Delete part' }).click();
    await row.waitFor({ state: 'detached', timeout: 10000 });
    step(`Deleted ${partName}.`);
  }
  await page.getByText('No parts on this ticket yet.').waitFor();
  const partsGone = !(await page.getByRole('row', { name: new RegExp(PART_A) }).count()) &&
                    !(await page.getByRole('row', { name: new RegExp(PART_B) }).count());

  step('Archiving ticket…');
  await page.getByRole('button', { name: 'Archive ticket' }).click();
  await page.getByRole('button', { name: 'Unarchive ticket' }).waitFor({ timeout: 10000 });
  // Verify in list with archived shown
  await page.getByRole('link', { name: 'Tickets' }).first().click();
  await page.getByRole('heading', { level: 1, name: 'Repair tickets' }).waitFor();
  await page.getByRole('checkbox', { name: 'Show archived' }).check();
  await page.getByRole('row', { name: new RegExp(TITLE) }).waitFor({ timeout: 10000 });
  const rowText = await page.getByRole('row', { name: new RegExp(TITLE) }).innerText();
  const archivedOk = partsGone && rowText.includes('Archived') && /Ready/.test(rowText) && /\b0\b/.test(rowText);
  record(6, archivedOk, `Parts removed ("No parts on this ticket yet."), ticket archived. List row: ${rowText.replace(/\s+/g, ' | ')}`);
} catch (err) {
  console.error('ERROR:', err.message);
  // Record failure for any objective not yet recorded
  for (let i = 1; i <= 6; i++) {
    if (!results.find(r => r.n === i)) record(i, false, `Not completed: ${err.message}`);
  }
} finally {
  await browser.close();
}

console.log('\n=== FINAL REPORT ===');
let allOk = true;
for (const r of results) {
  console.log(`${r.n}. ${r.ok ? 'DONE' : 'FAILED'} — ${r.detail}`);
  if (!r.ok) allOk = false;
}
process.exit(allOk ? 0 : 1);
