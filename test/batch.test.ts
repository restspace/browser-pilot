import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeTool, TOOL_DEFS } from '../src/agent/tools.js';
import { BrowserSession } from '../src/daemon/browser.js';

const nullSession = () => ({}) as unknown as BrowserSession;
const validate = (steps: unknown) =>
  executeTool(nullSession(), 'batch', { steps }, os.tmpdir());

describe('batch validation (rejected before anything runs)', () => {
  it('is declared with a 2-step minimum', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'batch');
    expect(def).toBeTruthy();
    expect((def!.parameters as Record<string, any>).properties.steps.minItems).toBe(2);
  });

  it('rejects a single-step batch', async () => {
    const out = await validate([{ tool: 'click', args: { target: '#a' } }]);
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/at least 2 steps/);
  });

  it('rejects more than 10 steps, naming the cap', async () => {
    const steps = Array.from({ length: 11 }, () => ({ tool: 'click', args: { target: '#a' } }));
    const out = await validate(steps);
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/at most 10 steps/);
    expect(out.result).toMatch(/Nothing was executed/);
  });

  // The session here has no browser at all, so a disallowed tool that slipped
  // through to execution would throw instead of returning this message.
  it('rejects a disallowed inner tool, identifying the step', async () => {
    const out = await validate([
      { tool: 'fill', args: { target: '#a', value: 'x' } },
      { tool: 'goto', args: { url: 'https://example.test/' } },
    ]);
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/step 2: "goto" cannot be used inside a batch/);
    expect(out.result).toMatch(/Nothing was executed/);
  });

  it('rejects a nested batch and a report step', async () => {
    for (const tool of ['batch', 'report', 'snapshot', 'eval', 'screenshot']) {
      const out = await validate([
        { tool: 'fill', args: { target: '#a', value: 'x' } },
        { tool, args: {} },
      ]);
      expect(out.isError, tool).toBe(true);
      expect(out.result).toContain(`"${tool}" cannot be used inside a batch`);
    }
  });
});

/**
 * Browser-backed: needs an installed Chrome/Edge, so opt-in like browser.test.ts.
 *   BP_BROWSER_TESTS=1 npx vitest run test/batch.test.ts
 */
const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>Batch fixture</title></head><body>
<h1>Batch fixture</h1>
<form id="f">
  <input id="name" placeholder="Name">
  <input id="email" placeholder="Email">
  <select id="freq"><option>Daily</option><option>Weekly</option></select>
  <button type="button" id="submit">Submit</button>
</form>
<button type="button" id="ask">Ask</button>
<div id="out"></div>
<div id="asked"></div>
<script>
  document.getElementById('submit').addEventListener('click', () => {
    document.getElementById('out').innerHTML =
      '<div role="alert">Saved ' + document.getElementById('name').value + '</div>';
  });
  document.getElementById('ask').addEventListener('click', () => {
    const ok = confirm('Delete everything?');
    document.getElementById('asked').innerHTML =
      '<div role="status">answered ' + ok + '</div>';
  });
</script>
</body></html>`;

const pageUrl = 'data:text/html,' + encodeURIComponent(PAGE);

d('batch execution (real page)', () => {
  let session: BrowserSession;
  const run = (steps: unknown[]) => executeTool(session, 'batch', { steps }, os.tmpdir());
  const reset = async () => (await session.getPage()).goto(pageUrl);

  beforeAll(async () => {
    process.env.BROWSER_PILOT_HOME = path.join(os.tmpdir(), `bp-batch-test-${Date.now()}`);
    session = new BrowserSession({ session: 'batch', persist: false });
    await reset();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  it('runs every step and emits one combined state diff', async () => {
    await reset();
    const out = await run([
      { tool: 'fill', args: { target: '#name', value: 'Ada' } },
      { tool: 'fill', args: { target: '#email', value: 'ada@test.dev' } },
      { tool: 'select', args: { target: '#freq', option: 'Weekly' } },
      { tool: 'click', args: { target: '#submit' } },
    ]);

    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/^1\. fill .* → filled$/m);
    expect(out.result).toMatch(/^2\. fill .* → filled$/m);
    expect(out.result).toMatch(/3\. select .* → selected \["Weekly"\]/);
    expect(out.result).toMatch(/4\. click .* → clicked/);
    expect(out.result).not.toMatch(/not run/);
    // exactly one combined diff, carrying the form's outcome
    expect(out.result.match(/\[state:/g)).toHaveLength(1);
    expect(out.result).toContain('Saved Ada');
  }, 60_000);

  it('stops at the first failing step and reports the partial run', async () => {
    await reset();
    const out = await run([
      { tool: 'fill', args: { target: '#name', value: 'Grace' } },
      { tool: 'wait_for', args: { target: '#nope', state: 'visible', timeout_ms: 500 } },
      { tool: 'fill', args: { target: '#email', value: 'never@test.dev' } },
      { tool: 'click', args: { target: '#submit' } },
    ]);

    // partial execution must NOT read as "nothing happened"
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/1\. fill .* → filled/);
    expect(out.result).toMatch(/2\. wait_for .* → ERROR:/);
    expect(out.result).toContain('[stopped at step 2; steps 3-4 not run]');
    expect(out.result).not.toMatch(/^3\./m);
    expect(out.result.match(/\[state:/g)).toHaveLength(1);
    expect(out.result).toContain('Grace');
    expect(await (await session.getPage()).locator('#email').inputValue()).toBe('');
  }, 60_000);

  it('is an error result when the FIRST step fails (nothing ran)', async () => {
    await reset();
    const out = await run([
      { tool: 'wait_for', args: { target: '#nope', state: 'visible', timeout_ms: 500 } },
      { tool: 'fill', args: { target: '#name', value: 'never' } },
    ]);
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/1\. wait_for .* → ERROR:/);
    expect(out.result).toContain('[stopped at step 1; step 2 not run]');
    expect(await (await session.getPage()).locator('#name').inputValue()).toBe('');
  }, 60_000);

  it('arms dialog_expect for the following step in the same batch', async () => {
    await reset();
    const out = await run([
      { tool: 'dialog_expect', args: { action: 'accept' } },
      { tool: 'click', args: { target: '#ask' } },
      { tool: 'read', args: { target: '#asked', what: 'text' } },
    ]);
    expect(out.isError).toBe(false);
    expect(out.result).toContain('Delete everything?');
    expect(out.result).toMatch(/3\. read .* → "answered true"/);
  }, 60_000);
});
