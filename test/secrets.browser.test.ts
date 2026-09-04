/**
 * Browser-backed secrets tests: a {{env:NAME}} marker resolves only at the
 * tool layer — the browser receives the real value, while the recording, the
 * tool results, and the page-diff lines all keep (or are scrubbed back to)
 * the marker, even when the page echoes the typed value.
 *
 *   BP_BROWSER_TESTS=1 npx vitest run test/secrets.browser.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/daemon/browser.js';
import { executeTool } from '../src/agent/tools.js';
import type { RecordedStep } from '../src/daemon/recorder.js';
import { clearSecretLedger } from '../src/shared/secrets.js';

const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;

const fixtureUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'page.html')).href;
const SECRET = 'xk9-e2e-secret-value';

d('secret markers (fixture page)', () => {
  let home: string;
  let session: BrowserSession;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-secrets-'));
    process.env.SITELOOPER_HOME = home;
    process.env.BP_E2E_SECRET = SECRET;
    clearSecretLedger();
    session = new BrowserSession({ session: 'secrets', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    delete process.env.BP_E2E_SECRET;
    delete process.env.SITELOOPER_HOME;
    clearSecretLedger();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('the browser gets the value; the recording and results keep the marker', async () => {
    const fill = await run('fill', { target: '#name', value: '{{env:BP_E2E_SECRET}}' });
    expect(fill.isError).toBe(false);
    expect(fill.result).not.toContain(SECRET);

    const page = await session.getPage();
    expect(await page.locator('#name').inputValue()).toBe(SECRET);

    // The recorded step (what skills/flows compile from) holds the marker.
    const steps = session.script!.entries.filter((e): e is RecordedStep => e.k === 'step' && e.tool === 'fill');
    const last = steps[steps.length - 1];
    expect(last.args.value).toBe('{{env:BP_E2E_SECRET}}');
    expect(JSON.stringify(last)).not.toContain(SECRET);
  });

  it('a page that echoes the value is scrubbed back to the marker', async () => {
    await run('fill', { target: '#qty', value: '42' });
    const submit = await run('click', { target: '#submit' });
    // The banner reads "Saved <secret>!"; every channel that saw it is scrubbed.
    expect(submit.result).not.toContain(SECRET);
    const read = await run('read', { target: '#banner', what: 'text' });
    expect(read.result).toContain('{{env:BP_E2E_SECRET}}');
    expect(read.result).not.toContain(SECRET);
    // The recorded diff of the submit step is scrubbed too.
    const clicks = session.script!.entries.filter((e): e is RecordedStep => e.k === 'step' && e.tool === 'click');
    const withDiff = clicks.filter((c) => c.diff);
    if (withDiff.length) expect(JSON.stringify(withDiff)).not.toContain(SECRET);
  });

  it('an unset variable is a clear tool error, not a literal keystroke', async () => {
    const res = await run('fill', { target: '#name', value: '{{env:BP_E2E_NOT_SET}}' });
    expect(res.isError).toBe(true);
    expect(res.result).toContain('BP_E2E_NOT_SET');
    const page = await session.getPage();
    expect(await page.locator('#name').inputValue()).not.toContain('BP_E2E_NOT_SET');
  });
});
