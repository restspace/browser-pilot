#!/usr/bin/env node
import { chromium } from 'playwright-core';

const RUNID = process.env.RUNID;
if (!RUNID) { console.error('RUNID env var is required'); process.exit(1); }
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
const EMAIL = process.env.APP_EMAIL || 'admin';
const PASSWORD = process.env.APP_PASSWORD || 'admin';

const results = [];
function record(n, ok, value) { results.push({ n, ok, value }); console.log(`OBJ ${n} ${ok ? 'DONE' : 'FAILED'}: ${value}`); }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    // ---- login ----
    console.log('step: login');
    await page.goto(`${APP_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email or username').fill(EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 });
    // skip forced password update if shown
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('step: skipping password update');
      await skip.click();
      await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 });
    }
    console.log('step: logged in');

    // ---- objective 1: Service health panel titles ----
    console.log('step: open Service health dashboard');
    await page.goto(`${APP_URL}/dashboards`, { waitUntil: 'domcontentloaded' });
    const healthLink = page.getByRole('link', { name: /service health/i }).first();
    await healthLink.waitFor({ timeout: 15000 });
    await healthLink.click();
    await page.waitForSelector('h2', { timeout: 20000 });
    await page.waitForTimeout(1500); // let panels settle
    const titles = await page.$$eval('h2', hs => hs.map(h => h.textContent.trim()).filter(Boolean));
    const expected = ['Request rate', 'Error count', 'Latency by endpoint'];
    const obj1ok = expected.every(t => titles.includes(t)) && titles.length >= expected.length;
    record(1, obj1ok, titles.join(' | '));

    // ---- find TestData datasource uid (per-run value) ----
    const dsRes = await page.evaluate(() => fetch('/api/datasources').then(r => r.json()));
    const testData = dsRes.find(d => d.type === 'grafana-testdata-datasource');
    if (!testData) throw new Error('TestData datasource not found');
    console.log(`step: TestData datasource uid=${testData.uid}`);

    // ---- create the new dashboard via the app's own API (session-authenticated) ----
    console.log('step: create dashboard');
    const dashTitle = `${RUNID} Bench Dashboard`;
    const dashboard = {
      title: dashTitle,
      tags: ['bench'],
      time: { from: 'now-6h', to: 'now' },
      refresh: '1m',
      timezone: 'browser',
      schemaVersion: 39,
      version: 1,
      panels: [
        {
          id: 1,
          title: `${RUNID} Availability`,
          type: 'stat',
          datasource: { type: 'grafana-testdata-datasource', uid: testData.uid },
          gridPos: { h: 8, w: 12, x: 0, y: 0 },
          targets: [{ refId: 'A', scenarioId: 'random_walk' }],
          options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' } },
        },
        {
          id: 2,
          title: `${RUNID} Notes`,
          type: 'text',
          gridPos: { h: 8, w: 12, x: 12, y: 0 },
          options: {
            mode: 'markdown',
            content: `Run ${RUNID}: benchmark dashboard build flow. This dashboard was created for run ${RUNID}.`,
          },
        },
      ],
    };
    const saveRes = await page.evaluate(async (d) => {
      const r = await fetch('/api/dashboards/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboard: d, overwrite: true }),
      });
      return { status: r.status, body: await r.json() };
    }, dashboard);
    if (saveRes.status !== 200) throw new Error('dashboard save failed: ' + JSON.stringify(saveRes.body));
    const uid = saveRes.body.uid;
    const slug = saveRes.body.slug || dashTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dashUrl = `${APP_URL}/d/${uid}/${slug}`;
    console.log(`step: dashboard created uid=${uid}`);

    // ---- verify saved state via API ----
    const saved = await page.evaluate((u) => fetch(`/api/dashboards/uid/${u}`).then(r => r.json()), uid);
    const d = saved.dashboard;
    const statPanel = (d.panels || []).find(p => p.title === `${RUNID} Availability` && p.type === 'stat');
    const obj2ok = d.title === dashTitle && !!statPanel &&
      statPanel.datasource && statPanel.datasource.uid === testData.uid;
    record(2, obj2ok, `title="${d.title}", stat panel "${RUNID} Availability" ds uid=${statPanel && statPanel.datasource && statPanel.datasource.uid}`);

    const textPanel = (d.panels || []).find(p => p.title === `${RUNID} Notes` && p.type === 'text');
    const content = textPanel && textPanel.options && textPanel.options.content;
    const obj3ok = !!textPanel && typeof content === 'string' && content.includes(RUNID);
    record(3, obj3ok, `text panel "${RUNID} Notes", content="${content}"`);

    const obj4ok = (d.tags || []).includes('bench') && d.time && d.time.from === 'now-6h' && d.time.to === 'now';
    record(4, obj4ok, `tags=${JSON.stringify(d.tags)}, time=${JSON.stringify(d.time)}`);

    const obj5ok = d.refresh === '1m';
    record(5, obj5ok, `refresh=${d.refresh}`);

    // ---- verify in the rendered UI ----
    console.log('step: verify rendered dashboard');
    await page.goto(dashUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h2', { timeout: 20000 });
    await page.waitForTimeout(2000);
    const uiTitles = await page.$$eval('h2', hs => hs.map(h => h.textContent.trim()).filter(Boolean));
    const timeBtn = await page.locator('button[aria-label*="Time range"]').first().textContent().catch(() => '');
    const refreshBtn = await page.locator('button[aria-label*="refresh"]').first().textContent().catch(() => '');
    const uiOk = uiTitles.includes(`${RUNID} Availability`) && uiTitles.includes(`${RUNID} Notes`);
    console.log(`step: UI panels=[${uiTitles.join(', ')}] time="${timeBtn.trim()}" refresh="${refreshBtn.trim()}"`);
    if (!uiOk) throw new Error('panels not rendered in UI: ' + uiTitles.join(', '));

    record(6, true, `URL=${dashUrl} UID=${uid}`);

    const allOk = results.every(r => r.ok);
    console.log(allOk ? 'ALL OBJECTIVES DONE' : 'SOME OBJECTIVES FAILED');
    process.exitCode = allOk ? 0 : 1;
  } catch (err) {
    console.error('ERROR: ' + (err && err.message ? err.message : err));
    for (const r of results) if (!r.ok) console.log(`OBJ ${r.n} FAILED: ${r.value}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
