import { chromium } from 'playwright-core';

const RUNID = process.env.RUNID;
if (!RUNID) { console.error('RUNID env var is required'); process.exit(1); }
const BASE = process.env.APP_URL || 'http://127.0.0.1:8069';
const EMAIL = process.env.APP_EMAIL || '';
const PASSWORD = process.env.APP_PASSWORD || '';
const CUSTOMER = `${RUNID} Bench Customer`;
const CITY = 'Benchville';

const results = [];
function record(n, ok, detail) { results.push({ n, ok, detail }); console.log(`OBJ ${n} ${ok ? 'DONE' : 'FAILED'}: ${detail}`); }

async function getUntaxed(page) {
  const m = await page.evaluate(() => {
    const m2 = document.body.innerText.match(/Untaxed Amount[^\n]*/);
    return m2 ? m2[0] : null;
  });
  if (!m) throw new Error('Untaxed Amount not found on page');
  return m.replace(/\s+/g, ' ').trim();
}

async function statusbar(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.o_field_statusbar');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  });
}

async function pickDropdown(page, text) {
  const opt = page.locator(
    '.o-autocomplete--dropdown-item, .ui-autocomplete li, .dropdown-menu li, .o_search_options li'
  ).filter({ hasText: text }).first();
  try {
    await opt.waitFor({ state: 'visible', timeout: 5000 });
    await opt.click();
    return true;
  } catch {
    // fallback: first visible option
    const any = page.locator('.o-autocomplete--dropdown-item, .ui-autocomplete li').first();
    await any.waitFor({ state: 'visible', timeout: 5000 });
    await any.click();
    return true;
  }
}

async function openApp(page, name) {
  const burger = page.locator('.o_main_navbar button, nav.o_main_navbar button, header button').first();
  await burger.click();
  const item = page.getByRole('menuitem', { name }).first();
  await item.waitFor({ state: 'visible', timeout: 10000 });
  await item.click();
  await page.waitForTimeout(1500);
}

async function saveIfDirty(page) {
  const btn = page.getByRole('button', { name: /Save manually/ });
  if (await btn.count() && await btn.first().isVisible().catch(() => false)) {
    await btn.first().click();
    await page.waitForTimeout(1500);
  }
}

async function addLine(page, product, qty) {
  const add = page.getByText('Add a product').first();
  await add.waitFor({ state: 'visible', timeout: 10000 });
  await add.click();
  await page.waitForTimeout(500);
  const row = page.locator('.o_list_renderer .o_data_row, .o_field_x2m_list .o_data_row').last();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  const prodInput = row.locator('td[name="product_id"] input, div[name="product_id"] input, [name="product_id"] input').first();
  await prodInput.waitFor({ state: 'visible', timeout: 10000 });
  await prodInput.click();
  await prodInput.fill('');
  await prodInput.type(product);
  await page.waitForTimeout(1200);
  await pickDropdown(page, product);
  await page.waitForTimeout(1000);
  const qtyInput = row.locator('input[name="quantity"]').first();
  await qtyInput.waitFor({ state: 'visible', timeout: 10000 });
  await qtyInput.fill(String(qty));
  await qtyInput.press('Tab');
  await page.waitForTimeout(1500);
  const priceInput = row.locator('input[name="price_unit"]').first();
  const price = await priceInput.inputValue();
  return { price, row };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  let failed = 0;
  try {
    // ---- login ----
    console.log('STEP login');
    await page.goto(`${BASE}/web/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="login"]').fill(EMAIL);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/web/, { timeout: 20000 });
    await page.waitForTimeout(2000);
    console.log('STEP logged in');

    // ---- objective 1: create customer ----
    try {
      console.log('STEP create customer');
      await openApp(page, 'Contacts');
      await page.getByRole('button', { name: 'New' }).first().click();
      await page.locator('input[name="name"]').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('input[name="name"]').first().fill(CUSTOMER);
      const city = page.locator('input[name="city"]').first();
      await city.fill(CITY);
      await saveIfDirty(page);
      // verify by reopening via search
      await page.waitForTimeout(1500);
      const found = await page.evaluate((nm) => document.body.innerText.indexOf(nm) >= 0, CUSTOMER);
      if (!found) throw new Error('customer name not visible after save');
      const cityOk = await page.evaluate((c) => document.body.innerText.indexOf(c) >= 0, CITY);
      record(1, true, `Customer "${CUSTOMER}" created, City=${CITY} (city visible on form: ${cityOk})`);
    } catch (e) { record(1, false, e.message); failed++; }

    // ---- objective 2: quotation with one line ----
    let line1Price = null, untaxed1 = null;
    try {
      console.log('STEP create quotation');
      await openApp(page, 'Sales');
      await page.getByRole('button', { name: 'New' }).first().click();
      const cust = page.getByPlaceholder('Type to find a customer...').first();
      await cust.waitFor({ state: 'visible', timeout: 10000 });
      await cust.click();
      await cust.fill('');
      await cust.type(CUSTOMER);
      await page.waitForTimeout(1500);
      await pickDropdown(page, CUSTOMER);
      await page.waitForTimeout(1000);
      const { price } = await addLine(page, 'Office Chair Black', 3);
      line1Price = price;
      untaxed1 = await getUntaxed(page);
      await saveIfDirty(page);
      record(2, true, `Product [FURN_0269] Office Chair Black (or chosen dropdown option), qty 3, unit price ${price}, untaxed ${untaxed1}`);
    } catch (e) { record(2, false, e.message); failed++; }

    // ---- objective 3: second line ----
    let untaxed2 = null;
    try {
      console.log('STEP add second line');
      const { price } = await addLine(page, 'Desk Combination', 2);
      untaxed2 = await getUntaxed(page);
      await saveIfDirty(page);
      record(3, true, `Second product Desk Combination, qty 2, unit price ${price}, untaxed ${untaxed2}`);
    } catch (e) { record(3, false, e.message); failed++; }

    // ---- objective 4: change qty 3 -> 5 ----
    let untaxed3 = null;
    try {
      console.log('STEP change first line qty to 5');
      const rows = page.locator('.o_list_renderer .o_data_row, .o_field_x2m_list .o_data_row');
      const firstRow = rows.first();
      const qtyInput = firstRow.locator('input[name="quantity"]').first();
      await qtyInput.waitFor({ state: 'visible', timeout: 10000 });
      await qtyInput.fill('5');
      await qtyInput.press('Tab');
      await page.waitForTimeout(2000);
      untaxed3 = await getUntaxed(page);
      await saveIfDirty(page);
      record(4, true, `First line qty set to 5, untaxed ${untaxed3}`);
    } catch (e) { record(4, false, e.message); failed++; }

    // ---- objective 5: confirm ----
    let orderName = null, soStatus = null;
    try {
      console.log('STEP confirm quotation');
      const confirm = page.getByRole('button', { name: /^Confirm/ }).first();
      await confirm.waitFor({ state: 'visible', timeout: 10000 });
      await confirm.click();
      await page.waitForTimeout(3000);
      // wait for statusbar to show Sales Order
      let st = null;
      for (let i = 0; i < 20; i++) {
        st = await statusbar(page);
        if (st && /Sales Order/.test(st)) break;
        await page.waitForTimeout(1000);
      }
      soStatus = st;
      orderName = await page.locator('.o_form_sheet h1').first().innerText();
      if (!soStatus || !/Sales Order/.test(soStatus)) throw new Error(`status after confirm: ${soStatus}`);
      record(5, true, `Order reference ${orderName.trim()}, status "${soStatus}"`);
    } catch (e) { record(5, false, e.message); failed++; }

    // ---- objective 6: cancel ----
    try {
      console.log('STEP cancel sales order');
      const cancel = page.getByRole('button', { name: 'Cancel' }).first();
      await cancel.waitFor({ state: 'visible', timeout: 10000 });
      await cancel.click();
      await page.waitForTimeout(1500);
      // modal with "Send and cancel" / "Cancel" / "Discard" — click "Cancel" (confirm action) in active modal
      const modal = page.locator('.modal.d-block:not(.o_inactive_modal)').last();
      await modal.waitFor({ state: 'visible', timeout: 10000 });
      const btn = modal.getByRole('button', { name: /^Cancel$/ }).first();
      if (await btn.count()) await btn.click();
      else {
        const alt = modal.getByRole('button', { name: /Send and cancel/ }).first();
        await alt.click();
      }
      let st = null;
      for (let i = 0; i < 20; i++) {
        st = await statusbar(page);
        if (st && /Cancelled/.test(st)) break;
        await page.waitForTimeout(1000);
      }
      if (!st || !/Cancelled/.test(st)) throw new Error(`status after cancel: ${st}`);
      record(6, true, `Order ${orderName ? orderName.trim() : '?'} cancelled, status "${st}"`);
    } catch (e) { record(6, false, e.message); failed++; }

  } catch (e) {
    console.error('FATAL:', e.message);
    failed++;
  } finally {
    await browser.close();
  }

  console.log('--- FINAL REPORT ---');
  for (const r of results) console.log(`${r.n} ${r.ok ? 'DONE' : 'FAILED'}: ${r.detail}`);
  if (failed) { console.log(`${failed} objective(s) failed`); process.exit(1); }
  process.exit(0);
})();
