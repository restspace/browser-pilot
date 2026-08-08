/**
 * Browser-backed primitive tests. Need an installed Chrome/Edge, so they are
 * opt-in:  BP_BROWSER_TESTS=1 npx vitest run test/browser.test.ts
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/daemon/browser.js';
import { executeTool } from '../src/agent/tools.js';

const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;

const fixtureUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'page.html'),
).href;

d('browser primitives (fixture page)', () => {
  let session: BrowserSession;
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, os.tmpdir());

  beforeAll(async () => {
    process.env.BROWSER_PILOT_HOME = path.join(os.tmpdir(), `bp-browser-test-${Date.now()}`);
    session = new BrowserSession({ session: 'fixture', persist: false });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  it('snapshot returns the form with refs or roles', async () => {
    const out = await run('snapshot', {});
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/button/i);
    expect(out.result).toMatch(/Submit/);
  });

  it('@ref targets from a snapshot resolve to live elements', async () => {
    const snap = await run('snapshot', {});
    const match = /button "Submit" \[(@e\d+)\]/.exec(snap.result);
    expect(match, 'snapshot should carry refs (needs Playwright 1.61+ ai mode)').toBeTruthy();
    const read = await run('read', { target: match![1], what: 'text' });
    expect(read.isError).toBe(false);
    expect(read.result).toContain('Submit');
  });

  it('fill is React-safe: fires input+change and clear-then-sets number inputs', async () => {
    await run('fill', { target: '#name', value: 'Ada' });
    await run('fill', { target: '#qty', value: '42' });
    const page = await session.getPage();
    const seen = await page.evaluate(() => (window as any).__seenEvents as string[]);
    expect(await page.inputValue('#name')).toBe('Ada');
    expect(await page.inputValue('#qty')).toBe('42'); // not "342" (append bug)
    expect(seen).toContain('name:Ada');
    expect(seen.some((s) => s.startsWith('name:change'))).toBe(true);
    expect(seen).toContain('qty:42');
  });

  it('select matches by label', async () => {
    const out = await run('select', { target: '#colour', option: 'Green' });
    expect(out.result).toContain('g');
    const page = await session.getPage();
    expect(await page.inputValue('#colour')).toBe('g');
  });

  it('wait_for text_contains sees the async banner after click', async () => {
    await run('click', { target: '#submit' });
    const out = await run('wait_for', { target: '#banner', state: 'text_contains', text: 'Saved Ada' });
    expect(out.isError).toBe(false);
  });

  it('dialog_expect accept drives confirm() and captures the message', async () => {
    await run('dialog_expect', { action: 'accept' });
    const out = await run('click', { target: '#confirm-btn' });
    expect(out.result).toContain('Really delete?');
    const page = await session.getPage();
    expect(await page.innerText('#events')).toBe('deleted');
  });

  it('unarmed dialogs default to dismiss and are still captured', async () => {
    const out = await run('click', { target: '#confirm-btn' });
    expect(out.result).toContain('dismiss');
    const page = await session.getPage();
    expect(await page.innerText('#events')).toBe('kept');
  });

  it('read is a cheap spot check', async () => {
    const out = await run('read', { target: '#banner', what: 'text' });
    expect(out.result).toContain('Saved Ada');
  });

  it('read_all returns a value across every matching element in one call', async () => {
    const texts = await run('read_all', { target: '#rows .row', what: 'text' });
    expect(JSON.parse(texts.result)).toEqual(['Row Alpha', 'Row Beta', 'Row Gamma']);
    const attrs = await run('read_all', { target: '#rows .row', what: 'attr', attr: 'data-name' });
    expect(JSON.parse(attrs.result)).toEqual(['alpha', 'beta', 'gamma']);
    const count = await run('read_all', { target: '#rows .row', what: 'count' });
    expect(count.result).toBe('3');
  });

  it('a multi-match action returns a concise disambiguation hint, not a raw strict-mode dump', async () => {
    const out = await run('click', { target: '.dup' });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/matched 2 elements/);
    expect(out.result).toMatch(/nth=0/);
    expect(out.result).not.toMatch(/strict mode violation/i);
    // and the caller can act on it in one step
    const fixed = await run('click', { target: '.dup >> nth=0' });
    expect(fixed.isError).toBe(false);
  });

  it('click recovers a non-normally-clickable element via the dispatch fallback', async () => {
    // Zero-size element: normal click times out (~10s) → force throws → dispatch fires the handler.
    const out = await run('click', { target: '#covered-btn' });
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/dispatched/);
    const page = await session.getPage();
    expect(await page.innerText('#covered-result')).toBe('covered-clicked');
  }, 20_000);

  it('wait_for flags an unsatisfiable condition instead of just timing out silently', async () => {
    const out = await run('wait_for', {
      target: '#rows .row',
      state: 'count',
      count: 99,
      timeout_ms: 600,
    });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/never changed/);
  });
});
