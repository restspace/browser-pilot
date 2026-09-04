/**
 * Browser-backed component-recipe tests, on fixture stand-ins that reproduce
 * the interaction shape of the real widgets (focus-redirecting monaco-alike,
 * a portal-rendered combobox, a plain contenteditable). The real-library
 * validation is the grafana bench sweep.
 *
 *   BP_BROWSER_TESTS=1 npx vitest run test/components.browser.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/daemon/browser.js';
import { executeTool } from '../src/agent/tools.js';
import { ComponentStore, recognize } from '../src/skills/components.js';

const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;

const fixtureUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'components.html')).href;

d('component recipes (fixture widgets)', () => {
  let home: string;
  let session: BrowserSession;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-comp-br-'));
    process.env.SITELOOPER_HOME = home;
    process.env.SITELOOPER_COMPONENTS_FILE = path.join(home, 'components.json');
    session = new BrowserSession({ session: 'comp', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    delete process.env.SITELOOPER_COMPONENTS_FILE;
    delete process.env.SITELOOPER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('recognizes the monaco-alike from its inner textarea', async () => {
    const page = await session.getPage();
    const rec = await recognize(page.locator('#mon textarea'));
    expect(rec?.family.id).toBe('monaco');
  });

  it('fill on the monaco-alike goes through the recipe and verifies', async () => {
    const res = await run('fill', { target: '#mon textarea', value: 'notes for run x77' });
    expect(res.isError).toBe(false);
    expect(res.result).toContain('via recipe monaco/set-value');
    const page = await session.getPage();
    const shown = await page.locator('#mon .view-lines').innerText();
    expect(shown.replace(/ /g, ' ')).toContain('notes for run x77');
    // the outcome fed the lifecycle
    const monaco = new ComponentStore().list().find((r) => r.family === 'monaco' && r.intent === 'set-value')!;
    expect(monaco.stats.successes).toBeGreaterThanOrEqual(1);
  });

  it('fill on a contenteditable goes through its recipe', async () => {
    const res = await run('fill', { target: '#ce', value: 'replaced body x88' });
    expect(res.result).toContain('via recipe contenteditable/set-value');
    const page = await session.getPage();
    expect(await page.locator('#ce').innerText()).toContain('replaced body x88');
  });

  it('select on the combobox types, then clicks the portal option', async () => {
    const res = await run('select', { target: '#combo', option: 'apricot x1' });
    expect(res.result).toContain('via recipe aria-combobox/select-option');
    const page = await session.getPage();
    expect(await page.locator('#picked').innerText()).toBe('picked:apricot x1');
  });

  it('a plain input stays on the naive fill path', async () => {
    const res = await run('fill', { target: '#combo', value: 'banana' });
    // combobox family has no set-value recipe → naive fill
    expect(res.result.startsWith('filled')).toBe(true);
    expect(res.result).not.toContain('via recipe');
  });
});
