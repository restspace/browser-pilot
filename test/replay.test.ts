/**
 * Browser-backed replay tests: record an instruction on the fixture page,
 * compile it, then replay it against a fresh load — unperturbed, and under
 * the perturbations the plan calls for (renamed control → locator fallback;
 * removed control → stop and hand off; inserted dialog → stop and hand off).
 *
 *   BP_BROWSER_TESTS=1 npx vitest run test/replay.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInstruction } from '../src/agent/loop.js';
import type { ChatMessage, Completion, Provider, ToolDef } from '../src/agent/llm.js';
import { executeTool } from '../src/agent/tools.js';
import { BrowserSession } from '../src/daemon/browser.js';
import { SessionState } from '../src/daemon/state.js';
import { compileSkill } from '../src/skills/compile.js';
import { learnFromInstruction } from '../src/skills/learn.js';
import type { Skill } from '../src/skills/store.js';

const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;

const fixtureUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'page.html')).href;

const INSTRUCTION = "fill the form with name 'Ada Lovelace' and quantity 42, submit it, and report the banner text";
const REPORT = {
  status: 'success' as const,
  summary: "Submitted the form for 'Ada Lovelace' (qty 42); the banner says 'Saved Ada Lovelace!'.",
  evidence: { values: { banner: 'Saved Ada Lovelace!' } },
};

/** Provider that plays back scripted tool calls. */
function scripted(script: Array<{ name: string; args: Record<string, unknown> }[]>): Provider {
  let i = 0;
  return {
    model: 'stub',
    async complete(_m: ChatMessage[], _t: ToolDef[]): Promise<Completion> {
      const calls = script[Math.min(i++, script.length - 1)].map((c, j) => ({
        id: `c${i}-${j}`,
        name: c.name,
        args: c.args,
        rawArgs: JSON.stringify(c.args),
      }));
      return {
        text: null,
        toolCalls: calls,
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.rawArgs } })),
        },
        usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 0 },
      };
    },
  };
}

d('skill replay (fixture page)', () => {
  let home: string;
  let session: BrowserSession;
  let skill: Skill;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-replay-'));
    process.env.BROWSER_PILOT_HOME = home;
    process.env.BROWSER_PILOT_SKILLS_DIR = path.join(home, 'skills');
    session = new BrowserSession({ session: 'replay', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);

    // Record the instruction the way the agent would have driven it, through
    // @refs from a snapshot, so the locators are the derived ones.
    const recorder = session.script!;
    const mark = recorder.mark();
    recorder.beginInstruction(INSTRUCTION, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const ref = (label: RegExp) => label.exec(snap)![1];
    await run('fill', { target: ref(/textbox "Name" \[(@e\d+)\]/), value: 'Ada Lovelace' });
    await run('fill', { target: ref(/spinbutton "Qty" \[(@e\d+)\]/), value: '42' });
    await run('click', { target: ref(/button "Submit" \[(@e\d+)\]/) });
    // The hidden banner already reads "Saved!", so wait for the name to be in it.
    await run('wait_for', { target: '#banner', state: 'text_contains', text: 'Saved Ada Lovelace', timeout_ms: 3000 });
    await run('read', { target: '#banner', what: 'text' });
    const compiled = compileSkill({ entries: recorder.entriesSince(mark), instruction: INSTRUCTION, report: REPORT, session: 'replay' });
    expect(compiled).toBeTruthy();
    skill = compiled!;
    session.learn!.put(skill);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    delete process.env.BROWSER_PILOT_SKILLS_DIR;
    delete process.env.BROWSER_PILOT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('compiled a parameterised skill with locator chains and a labelled read', () => {
    expect(skill.template).toContain("name '{{v1}}' and quantity {{v2}}");
    expect(skill.params.v1.example).toBe('Ada Lovelace');
    expect(skill.params.v2.example).toBe('42');
    expect(skill.steps.map((s) => s.tool)).toEqual(['fill', 'fill', 'click', 'wait_for', 'read']);
    expect(skill.steps[0].args.value).toBe('{{v1}}');
    // the Submit button has several ways to be found: role+name first, id as a fallback
    const chain = skill.steps[2].locators.target;
    expect(chain[0]).toEqual({ kind: 'role', role: 'button', name: 'Submit' });
    expect(chain.some((c) => c.kind === 'id' && c.selector === '#submit')).toBe(true);
    expect(skill.steps[4].label).toBe('banner');
    // the wait_for text carries the slot too, so a new name is waited for, not the old one
    expect(skill.steps[3].args.text).toBe('Saved {{v1}}');
    expect(skill.steps[0].expect?.addedContains?.some((l) => l.includes('{{v1}}'))).toBe(true);
  });

  it('replays end to end on a fresh page with new parameters, reading back live values', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const out = await run('run_skill', { id: skill.id, params: { v1: 'Grace Hopper', v2: '7' } });
    expect(out.isError).toBe(false);
    expect(out.replay?.ok).toBe(true);
    expect(out.replay?.stepsRun).toBe(5);
    expect(out.replay?.fallthroughs).toBe(0);
    expect(out.replay?.values.banner).toBe('Saved Grace Hopper!');
    expect(out.result).toContain('replayed ' + skill.id + ': 5/5 steps ok');
    expect(out.result).toContain('banner="Saved Grace Hopper!"');
    expect(await page.inputValue('#qty')).toBe('7');
    // every replayed step was recorded, attributed to the skill
    const recorded = session.script!.entries.filter((e) => e.k === 'step' && e.via?.skill === skill.id);
    expect(recorded).toHaveLength(5);
  }, 30_000);

  it('refuses to run from the wrong page or with missing params — nothing is touched', async () => {
    const page = await session.getPage();
    await page.goto('about:blank');
    const wrongPage = await run('run_skill', { id: skill.id, params: { v1: 'x', v2: '1' } });
    expect(wrongPage.isError).toBe(true);
    expect(wrongPage.result).toContain('not on the page');
    await page.goto(fixtureUrl);
    const missing = await run('run_skill', { id: skill.id, params: { v1: 'x' } });
    expect(missing.isError).toBe(true);
    expect(missing.result).toContain('missing params: v2');
    expect(await page.inputValue('#name')).toBe('');
  }, 30_000);

  it('perturbation: a renamed button is found through the locator chain (no repair needed)', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      document.getElementById('submit')!.textContent = 'Save';
    });
    const out = await run('run_skill', { id: skill.id, params: { v1: 'Ada Lovelace', v2: '3' } });
    expect(out.replay?.ok).toBe(true);
    expect(out.replay?.fallthroughs).toBe(1);
    expect(out.result).toContain('used fallback');
    expect(out.replay?.values.banner).toBe('Saved Ada Lovelace!');
  }, 30_000);

  it('perturbation: a removed field stops the replay and hands back exactly what ran', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => document.getElementById('qty')!.remove());
    const out = await run('run_skill', { id: skill.id, params: { v1: 'Ada Lovelace', v2: '3' } });
    expect(out.isError).toBe(false); // the page has changed — not an "error" to the agent
    expect(out.replay?.ok).toBe(false);
    expect(out.replay?.stepsRun).toBe(1);
    expect(out.replay?.failedAt).toBe(2);
    expect(out.result).toContain('FAILED at step 2');
    expect(out.result).toContain('not run: steps 3-5');
    expect(out.result).toContain('Steps 1-1 HAVE run');
    expect(await page.inputValue('#name')).toBe('Ada Lovelace');
    expect(await page.isHidden('#banner')).toBe(true); // submit was never clicked
  }, 30_000);

  it('perturbation: an inserted confirm() on submit stops the replay at the expectation', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      const btn = document.getElementById('submit')!;
      btn.addEventListener('click', (e) => {
        if (!confirm('Submit?')) e.stopImmediatePropagation();
      }, true);
    });
    // unarmed dialogs are dismissed, so the click "works" but the banner never appears
    const out = await run('run_skill', { id: skill.id, params: { v1: 'Ada Lovelace', v2: '3' } });
    expect(out.replay?.ok).toBe(false);
    expect(out.replay?.failedAt).toBe(4); // wait_for on the banner
    expect(out.result).toMatch(/native dialogs: confirm\("Submit\?"\) → dismiss/);
  }, 30_000);

  it('fails a step that ran but did not surface the parameter it was recorded to surface', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    // Sabotage: the Name field silently drops input, so the filled value never
    // shows in the page signature. The fill "works"; the expectation does not.
    await page.evaluate(() => {
      const name = document.getElementById('name') as HTMLInputElement;
      name.addEventListener('input', () => setTimeout(() => (name.value = ''), 0));
    });
    const out = await run('run_skill', { id: skill.id, params: { v1: 'Grace Hopper', v2: '7' } });
    expect(out.replay?.ok).toBe(false);
    expect(out.replay?.failedAt).toBe(1);
    expect(out.result).toContain('did not show');
    expect(out.result).toContain('Grace Hopper');
  }, 30_000);

  it('end to end through the loop: the agent is offered the skill, replays it, and a repair is learned', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    // Perturb: Qty field gone → replay stops at step 2, the scripted "agent" finishes by hand.
    await page.evaluate(() => document.getElementById('qty')!.remove());
    const state = new SessionState('replay-loop');
    const provider = scripted([
      [{ name: 'run_skill', args: { id: skill.id, params: { v1: 'Ada Lovelace', v2: '5' } } }],
      [{ name: 'click', args: { target: '#submit' } }],
      [{ name: 'wait_for', args: { target: '#banner', state: 'text_contains', text: 'Saved' } }],
      [{ name: 'read', args: { target: '#banner', what: 'text' } }],
      [{ name: 'report', args: { status: 'success', summary: 'done', evidence: { values: { banner: 'Saved Ada Lovelace!' } } } }],
    ]);
    const mark = session.script!.mark();
    const result = await runInstruction(provider, session, state, INSTRUCTION.replace('42', '5'), {
      maxTurns: 8,
      timeoutMs: 30_000,
      screenshotDir: dir,
    });
    expect(result.report.status).toBe('success');
    // the first user message offered the skill
    expect(String(state.messages[0].content)).toContain(`[skills]`);
    expect(String(state.messages[0].content)).toContain(skill.id);
    expect(result.skill).toMatchObject({ invoked: skill.id, stepsReplayed: 1, stepsTotal: 5, repaired: true, tier: 'B' });
    expect(result.skill!.deterministicActions).toBe(1);
    expect(result.skill!.totalActions).toBe(4); // 1 replayed + click + wait_for + read

    const learned = learnFromInstruction(session.learn!, {
      result,
      instruction: INSTRUCTION.replace('42', '5'),
      entries: session.script!.entriesSince(mark),
      session: 'replay',
    });
    expect(learned?.variantOf).toBe(skill.id);
    const variant = session.learn!.get(learned!.compiled!)!;
    // the variant is the replayed prefix plus the repair, and the original counts the failure
    expect(variant.steps.map((s) => s.tool)).toEqual(['fill', 'click', 'wait_for', 'read']);
    expect(variant.steps[0].via).toEqual({ skill: skill.id, step: 1 });
    expect(variant.steps[1].via).toBeUndefined();
    expect(session.learn!.get(skill.id)!.stats.failedAtStep).toEqual({ '2': 1 });
  }, 60_000);
});

d('structural fingerprint (fixture page)', () => {
  it('is stable across loads, tolerant of text changes, and far from a different page', async () => {
    const { fingerprintPage, cosine, FINGERPRINT_DIMS } = await import('../src/daemon/fingerprint.js');
    const session = new BrowserSession({ session: 'fp', persist: false });
    try {
      const page = await session.getPage();
      await page.goto(fixtureUrl);
      const a = await fingerprintPage(page);
      expect(a).toHaveLength(FINGERPRINT_DIMS);
      await page.goto(fixtureUrl);
      const b = await fingerprintPage(page);
      expect(cosine(a!, b!)).toBeGreaterThanOrEqual(0.999);
      // same template, different data: text and values change, structure does not
      await page.evaluate(() => {
        document.querySelector('h1')!.textContent = 'Another title';
        for (const li of document.querySelectorAll('li')) li.textContent = 'Row ' + Math.random();
        (document.getElementById('name') as HTMLInputElement).value = 'x';
      });
      expect(cosine(a!, (await fingerprintPage(page))!)).toBeGreaterThanOrEqual(0.99);
      // an extra row is a small structural change
      await page.evaluate(() => document.getElementById('rows')!.appendChild(document.createElement('li')));
      const c = cosine(a!, (await fingerprintPage(page))!)!;
      expect(c).toBeGreaterThan(0.95);
      expect(c).toBeLessThan(1);
      // a different page entirely
      await page.setContent('<html><body><nav><a href="#">x</a></nav><main><article><h2>t</h2><p>p</p><p>q</p></article></main></body></html>');
      expect(cosine(a!, (await fingerprintPage(page))!)!).toBeLessThan(0.5);
    } finally {
      await session.close();
    }
  }, 60_000);
});

d('flow record and run (fixture page)', () => {
  let home: string, session: BrowserSession;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-flowtest-'));
    process.env.BROWSER_PILOT_HOME = home;
    process.env.BROWSER_PILOT_SKILLS_DIR = path.join(home, 'skills');
    process.env.BROWSER_PILOT_FLOWS_DIR = path.join(home, 'flows');
    session = new BrowserSession({ session: 'flowt', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
  }, 60_000);
  afterAll(async () => {
    await session?.close();
    for (const k of ['BROWSER_PILOT_FLOWS_DIR', 'BROWSER_PILOT_SKILLS_DIR', 'BROWSER_PILOT_HOME']) delete process.env[k];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('records a session into a replayable flow and runs it zero-model with new params', async () => {
    const { buildFlow, saveFlow, loadFlow, resolveInstruction } = await import('../src/skills/flow.js');
    const { compileSkill } = await import('../src/skills/compile.js');
    const { bindSkill, synthesizeReport } = await import('../src/skills/learn.js');
    const rec = session.script!;
    const page = await session.getPage();

    // Record one instruction the way the loop would: instruction + steps + report.
    const mark = rec.mark();
    const instr = "fill the form with name 'Ada Lovelace' and quantity 42 and submit";
    rec.beginInstruction(instr, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const ref = (re: RegExp) => re.exec(snap)![1];
    await run('fill', { target: ref(/textbox "Name" \[(@e\d+)\]/), value: 'Ada Lovelace' });
    await run('fill', { target: ref(/spinbutton "Qty" \[(@e\d+)\]/), value: '42' });
    await run('click', { target: ref(/button "Submit" \[(@e\d+)\]/) });
    const skill = compileSkill({ entries: rec.entriesSince(mark), instruction: instr, report: { status: 'success', summary: 'submitted', evidence: { values: {} } }, session: 'flowt' })!;
    session.learn!.put(skill);
    rec.endInstruction({ status: 'success', summary: 'submitted', values: {}, skill: skill.id });

    // Build + save the flow with `name` as a declared var.
    const flow = buildFlow(rec.entries, { name: 'formflow', origin: new URL(fixtureUrl).origin, startUrl: fixtureUrl, vars: { name: 'Ada Lovelace' }, session: 'flowt' })!;
    expect(flow.steps[0].skill).toBe(skill.id);
    expect(flow.steps[0].instruction).toContain('{{name}}');
    saveFlow(flow);
    expect(loadFlow('formflow')!.name).toBe('formflow');

    // Now replay the step's pinned skill directly, as `run` does — new name, no model.
    const step = flow.steps[0];
    const { text } = resolveInstruction(step, { name: 'Grace Hopper' }, {});
    expect(text).toContain('Grace Hopper');
    await page.goto(fixtureUrl);
    const params = bindSkill(session.learn!.get(step.skill!)!, text)!;
    expect(params.v1).toBe('Grace Hopper');
    const replay = await run('run_skill', { id: step.skill!, params });
    expect(replay.replay?.ok).toBe(true);
    expect(await page.inputValue('#name')).toBe('Grace Hopper');
    expect(await page.inputValue('#qty')).toBe('42');
    // synthesized report carries the new name, never a stale recorded value
    const report = synthesizeReport(session.learn!.get(step.skill!)!, params, replay.replay!.values);
    expect(JSON.stringify(report.evidence!.values)).not.toContain('Ada Lovelace');
  }, 60_000);
});

d('record-link retargeting (fixture page)', () => {
  it('describes a row-click by the record link inside it, not the row text', async () => {
    const { describeTarget } = await import('../src/daemon/recorder.js');
    const { snapshot } = await import('../src/daemon/refs.js');
    const session = new BrowserSession({ session: 'retarget', persist: false });
    try {
      const page = await session.getPage();
      await page.setContent(`
        <table id="rows"><tbody>
          <tr id="r1" data-testid="ticket-row-t15" onclick="location.hash='#/t/15'">
            <td><a href="#/t/15" data-testid="ticket-link-t15">RD-1015</a></td>
            <td>Draft</td><td>2026-08-23</td>
          </tr>
        </tbody></table>`);
      const snap = await snapshot(page, { full: true } as any);
      const rowRef = /row "[^"]*" \[(@e\d+)\]/.exec(snap)![1];
      // retarget on (click semantics): the durable locator should be the link inside the row
      const described = await describeTarget(page, rowRef, true);
      const identities = described.chain!.map((c: any) => c.name ?? c.value ?? c.text ?? c.selector ?? '');
      // the record link (name RD-1015) is in the chain; the row's css path is a fallback
      expect(identities.some((v) => v === 'RD-1015')).toBe(true);
      // a structural fallback to the row itself is kept (last, not the link path)
      expect(described.chain!.some((c: any) => c.kind === 'css' && !/>\s*a$/.test(c.selector))).toBe(true);
      // and NEVER the whole volatile row text ("RD-1015 Draft 2026-08-23")
      expect(identities.some((v) => /Draft|2026/.test(v))).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);
});

d('read-back synthesis (fixture page)', () => {
  it('captures a durable NON-value locator for a reported value, so it can be re-read', async () => {
    const { captureReadBack } = await import('../src/daemon/recorder.js');
    const session = new BrowserSession({ session: 'rb', persist: false });
    try {
      const page = await session.getPage();
      // A record id shown in a cell that carries a stable testid, and a computed
      // value in a plain cell. Both are read-back candidates.
      await page.setContent(`
        <table><tr>
          <td data-testid="ticket-ref">RD-1015</td>
          <td class="price">125.00</td>
        </tr></table>`);
      const ref = await captureReadBack(page, 'RD-1015');
      expect(ref).toBeTruthy();
      expect(ref!.tool).toBe('read');
      expect(JSON.parse(ref!.result!)).toBe('RD-1015');
      // located by the testid, NOT by the text "RD-1015" (which would be circular)
      const kinds = ref!.locators.target.chain!.map((c) => c.kind);
      expect(kinds).toContain('testid');
      const identities = ref!.locators.target.chain!.map((c: any) => c.value ?? c.name ?? c.text ?? c.selector);
      expect(identities).not.toContain('RD-1015');

      // the price cell has no testid → a structural css locator, still not the value
      const price = await captureReadBack(page, '125.00');
      expect(price).toBeTruthy();
      expect(price!.locators.target.chain!.every((c: any) => (c.text ?? '') !== '125.00')).toBe(true);

      // a value that appears nowhere → nothing to capture
      expect(await captureReadBack(page, 'RD-9999')).toBeNull();
    } finally {
      await session.close();
    }
  }, 30_000);
});

d('delete-loop replay (fixture page)', () => {
  let home: string;
  let session: BrowserSession;
  let skill: Skill;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);
  const DEL_INSTRUCTION = 'remove every part from the list';

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-loop-'));
    process.env.BROWSER_PILOT_HOME = home;
    process.env.BROWSER_PILOT_SKILLS_DIR = path.join(home, 'skills');
    session = new BrowserSession({ session: 'loop', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const recorder = session.script!;
    const mark = recorder.mark();
    recorder.beginInstruction(DEL_INSTRUCTION, { url: page.url() });
    // Record deleting the first two rows — two identical actions that differ
    // only in a per-row testid. That is exactly the shape foldLoops collapses.
    await run('click', { target: 'button[data-testid="del-1"]' });
    await run('click', { target: 'button[data-testid="del-2"]' });
    const report = { status: 'success' as const, summary: 'Removed the parts.', evidence: { values: {} } };
    skill = compileSkill({ entries: recorder.entriesSince(mark), instruction: DEL_INSTRUCTION, report, session: 'loop' })!;
    session.learn!.put(skill);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    delete process.env.BROWSER_PILOT_SKILLS_DIR;
    delete process.env.BROWSER_PILOT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('folds the two deletions into a single loop step', () => {
    const loops = skill.steps.filter((s) => s.tool === 'loop');
    expect(loops).toHaveLength(1);
    expect(loops[0].body?.some((b) => b.tool === 'click')).toBe(true);
    expect(loops[0].while?.length).toBeGreaterThan(0);
  });

  it('replays the loop to clear a list LONGER than the one recorded (2 → 3 rows)', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl); // a fresh list of THREE rows
    expect(await page.locator('#dellist > .prow').count()).toBe(3);
    const out = await run('run_skill', { id: skill.id, params: {} });
    expect(out.isError).toBe(false);
    expect(out.replay?.ok).toBe(true);
    // the loop kept going until the list was empty — past the two it saw recorded
    expect(await page.locator('#dellist > .prow').count()).toBe(0);
  }, 30_000);
});
