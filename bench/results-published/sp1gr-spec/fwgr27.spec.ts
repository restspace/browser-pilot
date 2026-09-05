import { test, expect } from '@playwright/test';
import { runFlow, steps, DRIFT } from './fwgr27.flow';

test('fwgr27', async ({ page }) => {
  const outputs = await runFlow(page, { runid: process.env.RUNID ?? '' });
  // Add your own assertions here; this file is yours and sitelooper never rewrites it.
  // `outputs` holds every value the flow read back, keyed "<stepId>.<output>";
  // `steps` lets you run one step on its own. `DRIFT` accumulates one line per
  // recorded locator that missed and fell through to a later candidate — attach
  // it to the report if you want it visible without reading stderr:
  //   if (DRIFT.length) await test.info().attach('sitelooper-drift', { body: DRIFT.join('\n') });
  expect(Object.keys(outputs).length >= 0).toBe(true);
  void steps;
});
