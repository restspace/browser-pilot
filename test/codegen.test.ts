import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateScript } from '../src/daemon/codegen.js';
import { ScriptRecorder, isStableId, q, type RecordedEntry } from '../src/daemon/recorder.js';

let tmpHome: string;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-codegen-'));
  process.env.SITELOOPER_HOME = tmpHome;
});
afterAll(() => {
  delete process.env.SITELOOPER_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const loc = (expr: string, verified = true) => ({ expr, verified, raw: '@e1' });

function step(tool: string, args: Record<string, unknown>, expr = "page.getByTestId('t')", result?: string): RecordedEntry {
  return { k: 'step', tool, args, locators: args.target ? { target: loc(expr) } : {}, ...(result ? { result } : {}) };
}

describe('generateScript', () => {
  it('emits a runnable spec with one test.step per instruction', () => {
    const src = generateScript(
      [
        step('goto', { url: 'https://example.test/app' }),
        { k: 'instruction', text: 'log in as alice' },
        step('fill', { target: '@e1', value: 'alice@example.test' }, "page.getByLabel('Email')"),
        step('click', { target: '@e2' }, "page.getByRole('button', { name: 'Sign in' })"),
        step('wait_for', { target: '@e3', state: 'visible' }, "page.getByTestId('dashboard')"),
      ],
      { session: 'demo' },
    );

    expect(src).toContain("import { expect, test } from '@playwright/test';");
    expect(src).toContain("test('demo (recorded)', async ({ page }) => {");
    expect(src).toContain("await page.goto('https://example.test/app');");
    expect(src).toContain("await test.step('log in as alice', async () => {");
    expect(src).toContain("await page.getByLabel('Email').fill('alice@example.test');");
    expect(src).toContain("await page.getByRole('button', { name: 'Sign in' }).click();");
    expect(src).toContain("await expect(page.getByTestId('dashboard')).toBeVisible();");
    // steps recorded before any instruction stay at test level, not inside a step
    expect(src.indexOf('await page.goto')).toBeLessThan(src.indexOf('await test.step'));
    expect(src.trimEnd().endsWith('});')).toBe(true);
    // balanced braces is the cheapest proxy for "this parses"
    expect((src.match(/\{/g) ?? []).length).toBe((src.match(/\}/g) ?? []).length);
  });

  it('maps each action tool onto its Playwright equivalent', () => {
    const src = generateScript(
      [
        step('dblclick', { target: '@e1' }),
        step('right_click', { target: '@e1' }),
        step('modifier_click', { target: '@e1', modifiers: ['Shift', 'Control'] }),
        step('type', { target: '@e1', text: 'abc', delay_ms: 50 }),
        step('press', { target: '@e1', key: 'Enter' }),
        step('press', { key: 'Escape' }),
        step('select', { target: '@e1', option: 'Green' }),
        step('check', { target: '@e1' }),
        step('check', { target: '@e1', checked: false }),
        step('hover', { target: '@e1' }),
        step('scroll_into_view', { target: '@e1' }),
        step('upload', { target: '@e1', paths: ['/tmp/a.png'] }),
        step('back', {}),
        step('set_viewport', { width: 800, height: 600 }),
        step('set_offline', { offline: true }),
        step('eval', { expression: 'document.title' }),
        step('screenshot', { path: 'shot.jpg', full_page: true }),
        step('dialog_expect', { action: 'accept', prompt_text: 'yes' }),
      ],
      { session: 's' },
    );

    expect(src).toContain("await page.getByTestId('t').dblclick();");
    expect(src).toContain("await page.getByTestId('t').click({ button: 'right' });");
    expect(src).toContain("await page.getByTestId('t').click({ modifiers: ['Shift', 'Control'] });");
    expect(src).toContain("await page.getByTestId('t').pressSequentially('abc', { delay: 50 });");
    expect(src).toContain("await page.getByTestId('t').press('Enter');");
    expect(src).toContain("await page.keyboard.press('Escape');");
    expect(src).toContain("await page.getByTestId('t').selectOption({ label: 'Green' });");
    expect(src).toContain("await page.getByTestId('t').check();");
    expect(src).toContain("await page.getByTestId('t').uncheck();");
    expect(src).toContain("await page.getByTestId('t').hover();");
    expect(src).toContain("await page.getByTestId('t').scrollIntoViewIfNeeded();");
    expect(src).toContain("await page.getByTestId('t').setInputFiles(['/tmp/a.png']);");
    expect(src).toContain('await page.goBack();');
    expect(src).toContain('await page.setViewportSize({ width: 800, height: 600 });');
    expect(src).toContain('await page.context().setOffline(true);');
    expect(src).toContain("await page.evaluate('document.title');");
    expect(src).toContain("await page.screenshot({ path: 'shot.jpg', fullPage: true });");
    expect(src).toContain("page.once('dialog', (dialog) => dialog.accept('yes'));");
  });

  it('turns waits into assertions and keeps a non-default timeout', () => {
    const src = generateScript(
      [
        step('wait_for', { target: '@e1', state: 'hidden' }),
        step('wait_for', { target: '@e1', state: 'text_equals', text: 'Saved' }),
        step('wait_for', { target: '@e1', state: 'text_contains', text: 'Sav', timeout_ms: 30000 }),
        step('wait_for', { target: '@e1', state: 'count', count: 3 }),
      ],
      { session: 's' },
    );
    expect(src).toContain('await expect(page.getByTestId(\'t\')).toBeHidden();');
    expect(src).toContain("await expect(page.getByTestId('t')).toHaveText('Saved');");
    expect(src).toContain("await expect(page.getByTestId('t')).toContainText('Sav', { timeout: 30000 });");
    expect(src).toContain("await expect(page.getByTestId('t')).toHaveCount(3);");
  });

  it('emits reads as commented-out assertions carrying the observed value', () => {
    const src = generateScript(
      [
        step('read', { target: '@e1', what: 'text' }, "page.getByTestId('t')", '"Saved Ada!"'),
        step('read', { target: '@e1', what: 'value' }, "page.getByTestId('t')", '"42"'),
        step('read', { target: '@e1', what: 'attr', attr: 'href' }, "page.getByTestId('t')", '"/next"'),
        step('read', { target: '@e1', what: 'count' }, "page.getByTestId('t')", '3'),
        step('read_all', { target: '@e1', what: 'text' }, "page.getByTestId('t')", '["a","b"]'),
      ],
      { session: 's' },
    );
    expect(src).toContain("// await expect(page.getByTestId('t')).toHaveText('Saved Ada!');");
    expect(src).toContain("// await expect(page.getByTestId('t')).toHaveValue('42');");
    expect(src).toContain("// await expect(page.getByTestId('t')).toHaveAttribute('href', '/next');");
    expect(src).toContain("// await expect(page.getByTestId('t')).toHaveCount(3);");
    expect(src).toContain("// await expect(page.getByTestId('t')).toHaveText(['a', 'b']);");
    // reads are observations, not assertions the agent asked for — never active code
    expect(src).not.toMatch(/^\s*await expect\(.*toHaveValue/m);
  });

  it('flags a locator it could not verify, and never invents one it could not derive', () => {
    const src = generateScript(
      [
        { k: 'step', tool: 'click', args: { target: '@e9' }, locators: { target: loc('page.locator(\'div > button\')', false) } },
        { k: 'step', tool: 'click', args: { target: '@e8' }, locators: { target: { expr: '', verified: false, raw: '@e8' } } },
      ],
      { session: 's' },
    );
    expect(src).toContain('// TODO: unverified locator');
    expect(src).toContain("await page.locator('div > button').click();");
    expect(src).toContain('// TODO: no durable selector for click on "@e8"');
    // the underivable step contributes a TODO and nothing executable
    expect(src.match(/\.click\(\)/g)).toHaveLength(1);
    expect(src).toContain('2 step(s) carry an unverified locator');
  });

  it('generates unique variable names for repeated downloads', () => {
    const src = generateScript([step('download', { target: '@e1' }), step('download', { target: '@e1' })], {
      session: 's',
    });
    expect(src).toContain("const downloadPromise1 = page.waitForEvent('download');");
    expect(src).toContain('const download1 = await downloadPromise1;');
    expect(src).toContain('const download2 = await downloadPromise2;');
    expect(src).toContain('await download1.saveAs(`downloads/${download1.suggestedFilename()}`);');
  });

  it('leaves tab switches as a TODO rather than silently rewriting the page handle', () => {
    const src = generateScript([step('tabs', { switch_to: 1 })], { session: 's' });
    expect(src).toContain('// TODO: the agent switched to tab 1');
    expect(src).toContain('// const page1 = page.context().pages()[1];');
  });

  it('escapes quotes and newlines in generated string literals', () => {
    expect(q("it's \\ fine\nyes")).toBe("'it\\'s \\\\ fine\\nyes'");
    const src = generateScript([step('fill', { target: '@e1', value: "O'Brien" })], { session: 's' });
    expect(src).toContain("fill('O\\'Brien')");
  });
});

describe('ScriptRecorder persistence', () => {
  it('appends entries to script.jsonl and reloads them in a fresh recorder', () => {
    const rec = new ScriptRecorder('persist');
    rec.beginInstruction('do the thing');
    rec.commit({ k: 'step', tool: 'click', args: { target: '@e1' }, locators: { target: loc('page.getByTestId(\'x\')') } }, 'clicked');
    rec.commit(null, 'ignored'); // non-recordable tools prepare to null

    const reloaded = new ScriptRecorder('persist');
    expect(reloaded.entries).toHaveLength(2);
    expect(reloaded.entries[0]).toEqual({ k: 'instruction', text: 'do the thing' });
    expect(generateScript(reloaded.entries, { session: 'persist' })).toContain(
      "await page.getByTestId('x').click();",
    );

    reloaded.clear();
    expect(reloaded.entries).toHaveLength(0);
    expect(new ScriptRecorder('persist').entries).toHaveLength(0);
  });

  it('survives a half-written trailing line from a killed daemon', () => {
    const rec = new ScriptRecorder('torn');
    rec.beginInstruction('first');
    fs.appendFileSync(path.join(tmpHome, 'sessions', 'torn', 'script.jsonl'), '{"k":"step","too');
    expect(new ScriptRecorder('torn').entries).toEqual([{ k: 'instruction', text: 'first' }]);
  });

  it('only keeps the tool result for tools whose output becomes an assertion', () => {
    const rec = new ScriptRecorder('results');
    const mk = (tool: string) => ({ k: 'step' as const, tool, args: { target: '@e1' }, locators: {} });
    rec.commit(mk('read'), '"seen"');
    rec.commit(mk('click'), 'clicked');
    expect(rec.entries).toEqual([
      { k: 'step', tool: 'read', args: { target: '@e1' }, locators: {}, result: '"seen"' },
      { k: 'step', tool: 'click', args: { target: '@e1' }, locators: {} },
    ]);
  });
});

describe('isStableId', () => {
  it('rejects framework-minted ids and accepts hand-written ones', () => {
    expect(isStableId('submit-button')).toBe(true);
    expect(isStableId(':r3:')).toBe(false);
    expect(isStableId('3col')).toBe(false);
    expect(isStableId('input-a1b2c3d4e5')).toBe(false);
    expect(isStableId('radix-:r0:')).toBe(false);
    expect(isStableId('x'.repeat(65))).toBe(false);
  });
});
