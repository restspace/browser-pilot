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
import type { LocatorCandidate } from '../src/daemon/recorder.js';
import { BrowserSession } from '../src/daemon/browser.js';
import { SessionState } from '../src/daemon/state.js';
import { compileSkill, compileSkills } from '../src/skills/compile.js';
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
    process.env.SITELOOPER_HOME = home;
    process.env.SITELOOPER_SKILLS_DIR = path.join(home, 'skills');
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
    delete process.env.SITELOOPER_SKILLS_DIR;
    delete process.env.SITELOOPER_HOME;
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
    // and where it was, last of all: a box in document coordinates plus the viewport
    const last = chain[chain.length - 1];
    expect(last.kind).toBe('point');
    if (last.kind === 'point') {
      expect(last.role).toBe('button');
      expect(last.w).toBeGreaterThan(0);
      expect(last.vw).toBeGreaterThan(0);
    }
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

  /** A hand-built click skill on the fixture page, for the SPA-resilience cases. */
  const clickSkill = (id: string, steps: Array<{ name: string; role: 'button' | 'link'; added: string[] }>): Skill => ({
    id,
    origin: new URL(fixtureUrl).origin,
    template: 'open the menu and create',
    params: {},
    preconditions: { urlPattern: fixtureUrl },
    steps: steps.map((s) => ({
      tool: 'click',
      args: { target: '@e1' },
      locators: { target: [{ kind: 'role', role: s.role, name: s.name }] },
      expect: { urlPattern: fixtureUrl, addedContains: s.added },
    })),
    stats: { uses: 1, successes: 1, partial: 0, created: 't', failedAtStep: {}, fallthroughs: 0 },
    status: 'validated',
    provenance: { session: 's', instruction: 'i', created: 't' },
  });

  /**
   * fwgr26's create head: three recorded clicks on Grafana's "New" (a menu
   * toggle) then the "New dashboard" link inside the menu. Replayed
   * literally, the third click shut the menu and the link was gone. A click
   * whose recorded popup is already showing is skipped as already in effect.
   */
  it('skips a toggle click whose recorded popup is already open', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'New';
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Actions');
      menu.hidden = true;
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'New dashboard';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const h = document.createElement('h2');
        h.textContent = 'Created';
        document.body.append(h);
      });
      menu.append(link);
      btn.addEventListener('click', () => (menu.hidden = !menu.hidden));
      document.body.append(btn, menu);
    });
    const skill = clickSkill('s_toggle', [
      { name: 'New', role: 'button', added: ['- menu "Actions"'] },
      { name: 'New', role: 'button', added: ['- menu "Actions"'] },
      { name: 'New dashboard', role: 'link', added: ['- heading "Created"'] },
    ]);
    session.learn!.put(skill);
    const out = await run('run_skill', { id: skill.id, params: {} });
    session.learn!.remove(skill.id);
    expect(out.replay?.ok).toBe(true);
    expect(out.replay?.warnings.some((w) => /already in effect/.test(w))).toBe(true);
    expect(await page.locator('h2', { hasText: 'Created' }).count()).toBe(1);
  }, 30_000);

  /**
   * A React control re-mounted between frames can swallow the click that
   * landed on its old node. A click that changed NOTHING while the recording
   * shows an effect is retried once after the DOM settles; a click that
   * changed anything is never repeated.
   */
  it('retries once a click that produced no change at all', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Flaky';
      let clicks = 0;
      btn.addEventListener('click', () => {
        if (++clicks < 2) return; // the first click lands on a node React is replacing
        const h = document.createElement('h2');
        h.textContent = 'Opened';
        document.body.append(h);
      });
      document.body.append(btn);
    });
    const skill = clickSkill('s_flaky', [{ name: 'Flaky', role: 'button', added: ['- heading "Opened"'] }]);
    session.learn!.put(skill);
    const out = await run('run_skill', { id: skill.id, params: {} });
    session.learn!.remove(skill.id);
    expect(out.replay?.ok).toBe(true);
    expect(out.replay?.warnings.some((w) => /retried once/.test(w))).toBe(true);
    expect(await page.locator('h2', { hasText: 'Opened' }).count()).toBe(1);
  }, 30_000);

  /**
   * fwgr26's sign-in skill carried a stray recorded click on a target=_blank
   * "Support" link. On the offline bench box that tab was a browser error
   * page, the daemon adopted it as the active page, and every later step of
   * the create segment was asked of chrome-error://chromewebdata/ (diaggr1,
   * rpgr13, rpgr14). Two rules: a replay keeps its page whatever tabs open,
   * and a tab that lands on an error page is closed and the opener restored.
   */
  it('a replay keeps its page when a replayed click opens a tab', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'blank-link';
      a.href = 'about:blank';
      a.target = '_blank';
      a.textContent = 'Elsewhere';
      document.body.append(a);
    });
    const skill = clickSkill('s_popup', [{ name: 'Elsewhere', role: 'link', added: [] }]);
    session.learn!.put(skill);
    const out = await run('run_skill', { id: skill.id, params: {} });
    session.learn!.remove(skill.id);
    expect(out.replay?.stepsRun).toBe(1);
    expect((await session.getPage()).url()).toBe(page.url());
    for (const p of await session.listPages()) if (p !== page) await p.close();
  }, 30_000);

  it('closes a new tab that lands on a browser error page and restores the opener', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'dead-link';
      a.href = 'http://127.0.0.1:9/'; // nothing listens there
      a.target = '_blank';
      a.textContent = 'Dead';
      document.body.append(a);
    });
    await run('click', { target: '#dead-link' });
    // the popup reaches its error page, then the rule closes it
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await session.listPages()).length > 1) await new Promise((r) => setTimeout(r, 100));
    expect((await session.listPages()).length).toBe(1);
    expect((await session.getPage()).url()).toBe(page.url());
  }, 30_000);

  /**
   * fwat2's sign-in: the click answered at "/" and the app routed to
   * /project-manager a moment later; the url gate judged too early and sent
   * the step to recovery on every replay. A navigation in flight gets the
   * resolve window.
   */
  it('gives a recorded url that is still on its way the resolve window', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Sign in late';
      btn.addEventListener('click', () => setTimeout(() => (location.hash = '#landed'), 900));
      document.body.append(btn);
    });
    const skill = clickSkill('s_lateurl', [{ name: 'Sign in late', role: 'button', added: [] }]);
    skill.steps[0].expect = { urlPattern: `${fixtureUrl}#landed` };
    session.learn!.put(skill);
    const out = await run('run_skill', { id: skill.id, params: {} });
    session.learn!.remove(skill.id);
    expect(out.replay?.ok).toBe(true);
    expect(page.url()).toBe(`${fixtureUrl}#landed`);
  }, 30_000);

  it('a goto-first procedure navigates itself: no start-page refusal', async () => {
    const page = await session.getPage();
    await page.goto('about:blank');
    const nav: Skill = structuredClone(skill);
    nav.id = 's_navself';
    nav.steps.unshift({ tool: 'goto', args: { url: fixtureUrl }, locators: {} });
    session.learn!.put(nav);
    const out = await run('run_skill', { id: nav.id, params: { v1: 'Nav Ada', v2: '9' } });
    expect(out.replay?.refused).toBeFalsy();
    expect(out.replay?.ok).toBe(true);
    expect(out.replay?.values.banner).toBe('Saved Nav Ada!');
    session.learn!.remove(nav.id);
  }, 30_000);

  it('an echo read (reads back a value the skill itself set) is flagged and dropped from confident values', async () => {
    // Record a skill that fills #name and then reads #name back — the read
    // returns exactly what was typed, confirming the control, not persistence.
    // This is the shape of grafana's time picker: click 'Last 6 hours', then
    // read 'Last 6 hours' off the same control.
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const rec = session.script!;
    const mark = rec.mark();
    const instr = "set the name to 'Echoville Boulevard' and read the name field and the banner";
    rec.beginInstruction(instr, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const nameRef = /textbox "Name" \[(@e\d+)\]/.exec(snap)![1];
    await run('fill', { target: nameRef, value: 'Echoville Boulevard' });
    // Read the same input back — pure echo of the fill value.
    await run('read', { target: '#name', what: 'value', label: 'name_field' });
    // A non-echo read for contrast: the fixed heading text.
    await run('read', { target: 'h1', what: 'text', label: 'heading' });
    const echoSkill = compileSkill({
      entries: rec.entriesSince(mark),
      instruction: instr,
      report: { status: 'success', summary: 'set name', evidence: { values: { name_field: 'Echoville Boulevard', heading: 'Fixture form' } } },
      session: 'replay',
    })!;
    session.learn!.put(echoSkill);

    await page.goto(fixtureUrl);
    const out = await run('run_skill', { id: echoSkill.id, params: { v1: 'Replayville Avenue' } });
    expect(out.replay?.ok).toBe(true);
    // The name read echoes the fill value → flagged; the heading does not.
    expect(out.replay?.echoedValues).toContain('name_field');
    expect(out.replay?.echoedValues).not.toContain('heading');
    expect(out.replay?.warnings.some((w) => /echo|set\/selected/i.test(w))).toBe(true);
    session.learn!.remove(echoSkill.id);
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
    // drift telemetry: the miss is recorded structurally, not just as prose
    expect(out.replay?.misses).toHaveLength(1);
    expect(out.replay?.misses[0].used).toBeTruthy();
    expect(out.replay?.misses[0].key).toBe('target');
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
    process.env.SITELOOPER_HOME = home;
    process.env.SITELOOPER_SKILLS_DIR = path.join(home, 'skills');
    process.env.SITELOOPER_FLOWS_DIR = path.join(home, 'flows');
    session = new BrowserSession({ session: 'flowt', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
  }, 60_000);
  afterAll(async () => {
    await session?.close();
    for (const k of ['SITELOOPER_FLOWS_DIR', 'SITELOOPER_SKILLS_DIR', 'SITELOOPER_HOME']) delete process.env[k];
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

d('ancestor-anchored fallback candidate (fixture page)', () => {
  it("captures [ancestor-testid] input between the element's own semantics and the bare path", async () => {
    const { describeTarget, positionalExpr, candidateExpr } = await import('../src/daemon/recorder.js');
    const { snapshot } = await import('../src/daemon/refs.js');
    const session = new BrowserSession({ session: 'anchorcand', persist: false });
    try {
      const page = await session.getPage();
      // The grafana panel-title shape: an input whose own semantics can drift,
      // inside a stable testid-bearing pane, deep in anonymous divs.
      await page.setContent(`
        <div data-testid="options pane">
          <div><div><div>
            <input data-testid="field input Title" aria-label="Panel Title" value="" />
          </div></div></div>
        </div>`);
      const snap = await snapshot(page, { full: true } as any);
      const ref = /textbox "[^"]*" \[(@e\d+)\]/.exec(snap)![1];
      const described = await describeTarget(page, ref);
      const exprs = described.chain!.map((c: any) => candidateExpr(c));
      const anchoredIdx = exprs.findIndex((e) => e.includes('[data-testid="options pane"] input'));
      expect(anchoredIdx).toBeGreaterThan(0); // present, behind the element's own semantics
      expect(positionalExpr(exprs[anchoredIdx])).toBe(false); // and NOT judged positional
      // It sits ahead of the bare structural path, so a drift in the input's
      // own attributes falls to the anchored rung, not to position from root.
      const bareIdx = exprs.findIndex((e) => positionalExpr(e));
      if (bareIdx !== -1) expect(anchoredIdx).toBeLessThan(bareIdx);
      // Simulate the drift fwgr17-n3 hit: the input's own testid and name are
      // gone. The anchored candidate still resolves the element.
      await page.evaluate(() => {
        const input = document.querySelector('input')!;
        input.removeAttribute('data-testid');
        input.removeAttribute('aria-label');
      });
      const { resolveChain } = await import('../src/skills/replay.js');
      const hit = await resolveChain(page, described.chain! as any, {});
      expect(hit).toBeTruthy();
      expect(candidateExpr(hit!.candidate)).toContain('[data-testid="options pane"] input');
    } finally {
      await session.close();
    }
  }, 30_000);
});

d('interactive-ancestor retargeting (fixture page)', () => {
  it('a click on an inert span inside a testid button records the BUTTON', async () => {
    const { describeTarget, candidateExpr } = await import('../src/daemon/recorder.js');
    const { snapshot } = await import('../src/daemon/refs.js');
    const session = new BrowserSession({ session: 'ancestorclick', persist: false });
    try {
      const page = await session.getPage();
      // fwgr18's TimePicker shape: the visible text lives in nested spans whose
      // structure churns between renders; the button carries the identity.
      await page.setContent(`
        <button data-testid="TimePicker Open Button" aria-label="Time range picker">
          <div><span><span>Last 6 hours</span></span></div>
        </button>`);
      const snap = await snapshot(page, { full: true } as any);
      const ref = /text: Last 6 hours \[(@e\d+)\]/.exec(snap) ?? /"Last 6 hours" \[(@e\d+)\]/.exec(snap);
      // The snapshot may fold the text into the button; click the inner span
      // via a raw handle path instead when no separate ref exists.
      let described;
      if (ref) {
        described = await describeTarget(page, ref[1], true);
      } else {
        // Address the innermost span directly and go through the same
        // describe path a recorded click takes.
        const { describeLocator } = await import('../src/daemon/recorder.js');
        described = await describeLocator(page, page.locator('button span span'), 'button span span', true);
      }
      const exprs = described.chain!.map((c: any) => candidateExpr(c));
      // The chain leads with the CONTROL's identity, not the span's path.
      expect(exprs[0]).toContain('TimePicker Open Button');
      // The span's structural path survives as the last-resort fallback.
      expect(exprs.some((e) => /span/.test(e))).toBe(true);
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
    process.env.SITELOOPER_HOME = home;
    process.env.SITELOOPER_SKILLS_DIR = path.join(home, 'skills');
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
    delete process.env.SITELOOPER_SKILLS_DIR;
    delete process.env.SITELOOPER_HOME;
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

d('segment chains (two fixture pages)', () => {
  let home: string;
  let session: BrowserSession;
  let segs: Skill[];
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);
  const INSTR = "fill the form with name 'Zed', open the detail page, save note 'hello zed', and report the detail banner";
  const SEG_REPORT = {
    status: 'success' as const,
    summary: "Saved note 'hello zed' on the detail page; the banner says 'Noted hello zed!'.",
    evidence: { values: { dbanner: 'Noted hello zed!' } },
  };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seg-'));
    process.env.SITELOOPER_HOME = home;
    process.env.SITELOOPER_SKILLS_DIR = path.join(home, 'skills');
    session = new BrowserSession({ session: 'segchain', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);

    const recorder = session.script!;
    const mark = recorder.mark();
    recorder.beginInstruction(INSTR, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const ref = (label: RegExp) => label.exec(snap)![1];
    await run('fill', { target: ref(/textbox "Name" \[(@e\d+)\]/), value: 'Zed' });
    await run('click', { target: ref(/link "Open detail" \[(@e\d+)\]/) });
    const snap2 = (await run('snapshot', {})).result;
    const ref2 = (label: RegExp) => label.exec(snap2)![1];
    await run('fill', { target: ref2(/textbox "Note" \[(@e\d+)\]/), value: 'hello zed' });
    await run('click', { target: ref2(/button "Save note" \[(@e\d+)\]/) });
    await run('wait_for', { target: '#dbanner', state: 'text_contains', text: 'Noted hello zed', timeout_ms: 3000 });
    await run('read', { target: '#dbanner', what: 'text' });
    segs = compileSkills({ entries: recorder.entriesSince(mark), instruction: INSTR, report: SEG_REPORT, session: 'segchain' });
    for (const s of segs) session.learn!.put(s);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    delete process.env.SITELOOPER_SKILLS_DIR;
    delete process.env.SITELOOPER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('the recording splits at the navigation into a linked chain with a live fingerprint seam', () => {
    expect(segs).toHaveLength(2);
    const [a, b] = segs;
    expect(a.seq?.index).toBe(0);
    expect(b.seq?.index).toBe(1);
    expect(a.seq?.chain).toBe(b.seq?.chain);
    expect(a.preconditions.urlPattern).toContain('page.html');
    expect(b.preconditions.urlPattern).toContain('detail.html');
    // the recorder captured a real fingerprint at the seam
    expect(b.preconditions.fingerprint?.length).toBeGreaterThan(0);
    expect(b.steps.map((s) => s.tool)).toEqual(['fill', 'click', 'wait_for', 'read']);
  });

  it('segment 2 refuses on the wrong page; the chain replays cleanly in order', async () => {
    const [a, b] = segs;
    const params = { v1: 'Ada', v2: 'from ada' };
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    // gating: the tail must refuse before touching anything on page 1
    const refused = await run('run_skill', { id: b.id, params });
    expect(refused.replay?.refused).toBe(true);
    // composition: head then tail, each on its own page
    const first = await run('run_skill', { id: a.id, params });
    expect(first.replay?.ok).toBe(true);
    expect(page.url()).toContain('detail.html');
    const second = await run('run_skill', { id: b.id, params });
    expect(second.replay?.ok).toBe(true);
    expect(second.replay?.values.dbanner).toBe('Noted from ada!');
  }, 60_000);
});

/**
 * Record identity: a read taken inside a record's row must be re-read from
 * THAT record's row on replay, not from the row that happens to sit in the
 * same position. fwrd10-n2 (cloud) failed exactly here — its read-backs were
 * pinned to `#ticket-rows > tr:nth-of-type(1)`, the run's own ticket was not
 * row 1 that time, and the flow published a SEED ticket's reference as the
 * run's identity, sending every later step to the wrong ticket.
 */
d('identity-scoped locators (fixture page)', () => {
  let home: string, session: BrowserSession;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ident-'));
    process.env.SITELOOPER_HOME = home;
    process.env.SITELOOPER_SKILLS_DIR = path.join(home, 'skills');
    session = new BrowserSession({ session: 'ident', persist: false, learn: true });
    await (await session.getPage()).goto(fixtureUrl);
  }, 60_000);
  afterAll(async () => {
    await session?.close();
    for (const k of ['SITELOOPER_SKILLS_DIR', 'SITELOOPER_HOME'] as const) delete process.env[k];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('anchors a row read to the record it belongs to, and re-reads it after the rows move', async () => {
    const { setIdentityHints } = await import('../src/daemon/recorder.js');
    const { compileSkill } = await import('../src/skills/compile.js');
    const { replaySkill } = await import('../src/skills/replay.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const rec = session.script!;
    const mark = rec.mark();
    const instr = "report the button label on the row for 'Part Two'";
    setIdentityHints(['Part Two']);
    rec.beginInstruction(instr, { url: page.url() });
    // Read the Remove button's text from Part Two's row — row 2 at record
    // time — through a snapshot ref, the way the agent actually acts.
    const snap = (await run('snapshot', {})).result;
    const refs = [...snap.matchAll(/button "Remove" \[(@e\d+)\]/g)].map((m) => m[1]);
    expect(refs.length).toBe(3);
    await run('read', { target: refs[1], what: 'text' });
    const skill = compileSkill({
      entries: rec.entriesSince(mark),
      instruction: instr,
      report: { status: 'success', summary: "the row for 'Part Two' shows Remove", evidence: { values: { label: 'Remove' } } },
      session: 'ident',
      knownValues: { record: 'Part Two' },
    })!;
    // The recorded locator names the RECORD, not the row number.
    const chain = skill.steps[0].locators.target ?? [];
    expect(chain[0].kind).toBe('scoped');
    expect(JSON.stringify(chain[0])).toContain('{{v1}}');

    // Now the rows move: Part Two is no longer second.
    await page.evaluate(() => {
      const list = document.getElementById('dellist')!;
      list.insertBefore(list.children[1], list.children[0]);
      (list.children[1].querySelector('span') as HTMLElement).textContent = 'Part Nine';
    });
    const out = await replaySkill(skill, { v1: 'Part Two' }, {
      page,
      exec: async (tool, args, resolved) => ({ result: JSON.stringify(await resolved.target.first().innerText()) }),
    });
    expect(out.ok).toBe(true);
    // It re-read from Part Two's row (now first) — a positional locator would
    // have read the row that took its place.
    const row = await page.locator('#dellist > div', { hasText: 'Part Two' }).getAttribute('data-row');
    expect(row).toBe('2');
    expect(out.fallthroughs).toBe(0);
  }, 30_000);

  /** Record a read on Part Two's Remove button, anchored by `hints`. */
  const recordRowRead = async (hints: string[], known: Record<string, string>) => {
    const { setIdentityHints } = await import('../src/daemon/recorder.js');
    const { compileSkill } = await import('../src/skills/compile.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const rec = session.script!;
    const mark = rec.mark();
    const instr = "report the button label on the row for 'Part Two'";
    setIdentityHints(hints);
    rec.beginInstruction(instr, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const refs = [...snap.matchAll(/button "Remove" \[(@e\d+)\]/g)].map((m) => m[1]);
    await run('read', { target: refs[1], what: 'text' });
    const skill = compileSkill({
      entries: rec.entriesSince(mark),
      instruction: instr,
      report: { status: 'success', summary: "the row for 'Part Two' shows Remove", evidence: { values: { label: 'Remove' } } },
      session: 'ident',
      knownValues: known,
    })!;
    return { skill, page };
  };

  it('narrows an anchor that would match every row to the cell naming the record', async () => {
    // "Part" is true of all three rows. Anchoring on it records clean (the
    // handle is simply one of the matches) and then reads as drift at replay.
    const { skill } = await recordRowRead(['Part'], { record: 'Part' });
    const chain = skill.steps[0].locators.target ?? [];
    expect(chain[0].kind).toBe('scoped');
    // Narrowed to the cell — and the known value inside it is still slotted,
    // so the anchor parameterises: "{{v1}} Two" resolves to "Part Two".
    const hasText = (chain[0] as { hasText: string }).hasText;
    expect(hasText).toBe('{{v1}} Two');
    expect(hasText.replace('{{v1}}', skill.params.v1.example)).toBe('Part Two');
  }, 30_000);

  it('drops an anchor it cannot make unique rather than recording an ambiguous one', async () => {
    // Every row's button cell reads "Remove", and no cell narrows it further.
    const { skill } = await recordRowRead(['Remove'], { record: 'Remove' });
    const chain = skill.steps[0].locators.target ?? [];
    expect(chain.some((c) => c.kind === 'scoped')).toBe(false);
    expect(chain.length).toBeGreaterThan(0);
  }, 30_000);

  it('waits for a record that has not been painted yet instead of reading it as absent', async () => {
    const { replaySkill } = await import('../src/skills/replay.js');
    const { skill, page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    expect((skill.steps[0].locators.target ?? [])[0].kind).toBe('scoped');

    // The app defers its repaint the way repair-desk does after a create: the
    // row is gone when replay looks, and lands ~1.2s later.
    await page.evaluate(() => {
      const list = document.getElementById('dellist')!;
      const row = list.children[1];
      row.remove();
      setTimeout(() => list.insertBefore(row, list.children[1] ?? null), 1_200);
    });
    const reads: string[] = [];
    const out = await replaySkill(skill, { v1: 'Part Two' }, {
      page,
      exec: async (tool, args, resolved) => {
        const text = await resolved.target.first().innerText();
        reads.push(text);
        return { result: JSON.stringify(text) };
      },
    });
    expect(out.ok).toBe(true);
    expect(reads).toEqual(['Remove']); // the read happened, not skipped
    expect(out.warnings).toEqual([]);
    expect(out.fallthroughs).toBe(0);
  }, 30_000);

  /**
   * The cascade behind fwrd19l 01-open/02-open, isolated at the resolver.
   *
   * A sweep cannot prove this: the recording is model-driven, and the three
   * `wait_for` steps with `text="..."` targets that fwrd19l produced simply
   * did not reappear in fwrd20l or fwrd21l — the agent chose @refs instead.
   * So the shape has to be constructed, not waited for.
   */
  it('holds a record-naming primary through a deferred repaint instead of taking the row beneath it', async () => {
    const { resolveChain } = await import('../src/skills/replay.js');
    const { page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    const defer = async () => {
      await page.evaluate(() => {
        const list = document.getElementById('dellist')!;
        const row = list.querySelector('[data-row="2"]')!;
        row.remove();
        setTimeout(() => list.insertBefore(row, list.children[1] ?? null), 1_200);
      });
    };
    // What the agent typed as `text="Part Two"`, now recorded as a text
    // candidate — followed by the positional fallback the recorder always
    // appends, which resolves INSTANTLY against the row that sorted into
    // that slot ("Part One").
    const chain: LocatorCandidate[] = [
      { kind: 'text', text: 'Part Two' },
      { kind: 'css', selector: '#dellist > div:nth-of-type(1)' },
    ];

    await defer();
    const guarded = await resolveChain(page, chain, { requireIdentity: ['Part Two'], waitMs: 3_000 });
    expect(guarded?.index).toBe(0);
    expect(await guarded!.locator.first().innerText()).toContain('Part Two');

    // And the pre-fix state, for the causal claim: typed `css`, the primary
    // advertises no identity (identityOfPrimary skips css by design), so the
    // guard is empty, the positional candidate is waved through on the first
    // pass, and the wait never runs — landing on the WRONG record without a
    // single warning.
    await defer();
    const unguarded = await resolveChain(page, chain, { waitMs: 3_000 });
    // Since rpgr13 a positional guess is held for the window whenever the
    // chain names the element, so even with the guard disarmed the name wins
    // once the row is back. With NO window the guess still takes the row
    // beneath — that is the pre-fix state, kept for the causal claim.
    expect(unguarded?.index).toBe(0);
    expect(await unguarded!.locator.first().innerText()).toContain('Part Two');
    await defer();
    const instant = await resolveChain(page, chain, { waitMs: 0 });
    expect(instant?.index).toBe(1);
    expect(await instant!.locator.first().innerText()).toContain('Part One');
  }, 30_000);

  /**
   * diaggr1 (fwgr26 replay): `link "New dashboard"` did not resolve because
   * its menu had been toggled shut, so the chain fell to the structural
   * `div > … > a:nth-of-type(1)`, which matched Grafana's footer link to
   * grafana.com. The offline box answered with an error page and the whole
   * create step went to recovery. A candidate that leaves the recorded
   * origin cannot be the recorded control.
   */
  it('never takes a fallback that resolves to a link leaving the recorded origin', async () => {
    const { resolveChain } = await import('../src/skills/replay.js');
    const { page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    await page.evaluate(() => {
      const ext = document.createElement('a');
      ext.id = 'support';
      ext.href = 'https://grafana.example/products/enterprise/?utm_source=grafana_footer';
      ext.textContent = 'Support';
      const int = document.createElement('a');
      int.id = 'home';
      int.href = '#top';
      int.textContent = 'Home';
      document.body.append(ext, int);
    });
    const external: LocatorCandidate[] = [
      { kind: 'role', role: 'link', name: 'New dashboard' },
      { kind: 'css', selector: '#support' },
    ];
    const internal: LocatorCandidate[] = [
      { kind: 'role', role: 'link', name: 'New dashboard' },
      { kind: 'css', selector: '#home' },
    ];
    const origin = 'file://';
    expect(await resolveChain(page, external, { stayOnOrigin: origin })).toBeNull();
    expect((await resolveChain(page, internal, { stayOnOrigin: origin }))?.index).toBe(1);
    // without the recorded origin the old behaviour stands (the pre-fix state)
    expect((await resolveChain(page, external, {}))?.index).toBe(1);
    // a recorded primary that IS such a link is the recording's business
    // (rpgr12-r2: a stray click on the "Support" footer link in a sign-in
    // skill); only a guess is held to the origin
    const recorded: LocatorCandidate[] = [{ kind: 'css', selector: '#support', nth: 0 }]; // structural head: a guess
    expect((await resolveChain(page, recorded, { stayOnOrigin: origin }))?.index).toBeUndefined();
    const named: LocatorCandidate[] = [{ kind: 'role', role: 'link', name: 'Support' }, { kind: 'css', selector: '#support' }];
    expect((await resolveChain(page, named, { stayOnOrigin: origin }))?.index).toBe(0);
  }, 30_000);

  /**
   * rpgr13, both replays: the panel editor's `toggle-viz-picker` test id was
   * not rendered yet, and the structural `div > … > button` fallback matched
   * a header button that opens grafana.com. A positional guess is held for
   * the whole window when the chain names the element; it stands only when
   * no name came.
   */
  it('holds a positional guess until the named candidate has had the window', async () => {
    const { resolveChain } = await import('../src/skills/replay.js');
    const { page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'late';
      const wrong = document.createElement('button');
      wrong.type = 'button';
      wrong.textContent = 'Docs';
      box.append(wrong);
      document.body.append(box);
      setTimeout(() => {
        const right = document.createElement('button');
        right.type = 'button';
        right.setAttribute('data-testid', 'toggle-viz-picker');
        right.textContent = 'Change visualization';
        box.prepend(right);
      }, 700);
    });
    const chain: LocatorCandidate[] = [
      { kind: 'testid', attr: 'data-testid', value: 'toggle-viz-picker' },
      { kind: 'css', selector: '#late > button:nth-of-type(1)' },
    ];
    const held = await resolveChain(page, chain, { waitMs: 3_000 });
    expect(held?.index).toBe(0);
    expect(await held!.locator.innerText()).toBe('Change visualization');
    // and with no window the guess stands, as before
    await page.evaluate(() => document.querySelector('[data-testid="toggle-viz-picker"]')?.remove());
    const bare = await resolveChain(page, chain, { waitMs: 0 });
    expect(bare?.index).toBe(1);
  }, 30_000);

  /**
   * Geometry as a locator kind. The element under a recorded point, walked
   * up to its actionable ancestor, is a final candidate — accepted only when
   * it is the KIND of thing recorded, so it is a locator, not a blind click.
   */
  it('resolves a point candidate to the actionable element there, only if the role matches', async () => {
    const { resolveChain } = await import('../src/skills/replay.js');
    const { page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    const geom = await page.evaluate(() => {
      const b = document.getElementById('submit')!;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2 + window.scrollX), y: Math.round(r.top + r.height / 2 + window.scrollY), w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
    });
    const asButton: LocatorCandidate[] = [
      { kind: 'role', role: 'button', name: 'Gone' },
      { kind: 'point', ...geom, role: 'button', tag: 'button' },
    ];
    const hit = await resolveChain(page, asButton, { waitMs: 0 });
    expect(hit?.index).toBe(1);
    expect(await hit!.locator.getAttribute('id')).toBe('submit');
    // the same place, but the recording had a link there: not the same kind
    const asLink: LocatorCandidate[] = [{ kind: 'point', ...geom, role: 'link', tag: 'a' }];
    expect(await resolveChain(page, asLink, { waitMs: 0 })).toBeNull();
    // fwgr27: every heading point missed because the element under the
    // point was the title's inner span. The walk climbs to the recorded kind.
    const hgeom = await page.evaluate(() => {
      const h = document.createElement('h2');
      h.id = 'panel-title';
      const span = document.createElement('span');
      span.textContent = 'Request rate';
      h.append(span);
      document.body.append(h);
      const r = span.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2 + window.scrollX), y: Math.round(r.top + r.height / 2 + window.scrollY), w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
    });
    const asHeading: LocatorCandidate[] = [
      { kind: 'role', role: 'heading', name: 'Gone' },
      { kind: 'point', ...hgeom, role: 'heading', tag: 'h2' },
    ];
    const heading = await resolveChain(page, asHeading, { waitMs: 0 });
    expect(await heading!.locator.getAttribute('id')).toBe('panel-title');
  }, 30_000);

  it('orders a point candidate behind every path at compile and at replay', async () => {
    const { specOf } = await import('../src/skills/replay.js');
    const { stableFirst } = await import('../src/skills/compile.js');
    const point: LocatorCandidate = { kind: 'point', x: 1, y: 1, w: 1, h: 1, role: 'heading', tag: 'h2', vw: 100, vh: 100 };
    const chain: LocatorCandidate[] = [
      { kind: 'role', role: 'heading', name: '{{v6}}' },
      point,
      { kind: 'css', selector: '[data-testid="header-container"] h2' },
      { kind: 'css', selector: 'div:nth-of-type(1) > section > h2' },
    ];
    expect(stableFirst(chain).at(-1)).toBe(point);
    expect(specOf(chain).path.at(-1)).toBe(point);
  });

  /**
   * rpgr13: `div > … > button` resolved a header button for a control that
   * sat in the editor's side pane. With the recorded box in the chain, a
   * positional guess that lands far from it is a different element.
   */
  it('refuses a structural guess that resolves far from the recorded box', async () => {
    const { resolveChain } = await import('../src/skills/replay.js');
    const { page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    const geom = await page.evaluate(() => {
      const far = document.createElement('div');
      far.id = 'far';
      far.style.cssText = 'position:absolute;top:3000px;left:0';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Docs';
      far.append(b);
      document.body.append(far);
      const r = document.getElementById('submit')!.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2 + window.scrollX), y: Math.round(r.top + r.height / 2 + window.scrollY), w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
    });
    const chain: LocatorCandidate[] = [
      { kind: 'testid', attr: 'data-testid', value: 'toggle-viz-picker' }, // not on this page
      { kind: 'css', selector: '#far > button:nth-of-type(1)' }, // resolves at once, 3000px away
      { kind: 'point', ...geom, role: 'button', tag: 'button' },
    ];
    const hit = await resolveChain(page, chain, { waitMs: 0 });
    expect(hit?.index).toBe(2);
    expect(await hit!.locator.getAttribute('id')).toBe('submit');
    expect(hit?.missed).toContain(1);
  }, 30_000);

  it('takes identity from anywhere in the chain, not just its head', async () => {
    const { identityOfPrimary } = await import('../src/skills/replay.js');
    const skill = { params: { v5: { example: 'x7 RD Bench Ticket', usedIn: [], known: true as const } } } as unknown as Skill;
    // fwrd26l: the agent's raw target was an XPath, stored as `css` because
    // the recorder does not parse selector strings. Reading only chain[0] saw
    // no identity, disarmed the guard, and let `tr:nth-of-type(1)` take the
    // step — while the anchor right behind it named the record perfectly.
    const chain: LocatorCandidate[] = [
      { kind: 'css', selector: "//tr[contains(., '{{v5}}')]" },
      { kind: 'scoped', container: '#ticket-rows tr', hasText: '{{v5}}' },
      { kind: 'css', selector: '#ticket-rows > tr:nth-of-type(1)' },
    ];
    expect(identityOfPrimary([chain[0]], skill, { v5: 'n2 RD Bench Ticket' })).toEqual([]);
    expect(identityOfPrimary(chain, skill, { v5: 'n2 RD Bench Ticket' })).toEqual(['n2 RD Bench Ticket']);
  }, 30_000);

  it('pins a value that lives in a form control, not just in a text node', async () => {
    const { captureReadBack } = await import('../src/daemon/recorder.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.fill('#name', '[FURN_7777] Office Chair');

    // getByText cannot see an input's value, so the text path finds nothing.
    expect(await page.getByText('[FURN_7777] Office Chair', { exact: true }).count()).toBe(0);

    // odoo reported six values off its order form and this pinned NONE of
    // them, so every later step referencing one lost its zero-model path.
    const step = await captureReadBack(page, '[FURN_7777] Office Chair');
    expect(step).toBeTruthy();
    // Stored as a VALUE read, or the replay would re-read the label instead.
    expect(step!.args.what).toBe('value');
    expect(JSON.parse(step!.result!)).toBe('[FURN_7777] Office Chair');
    // And it must not locate the field BY the value it is there to read.
    const chain = step!.locators.target.chain ?? [];
    expect(chain.length).toBeGreaterThan(0);
    expect(JSON.stringify(chain)).not.toContain('Office Chair');
  }, 30_000);

  it('pins an ambiguous value only when a row anchor names the record', async () => {
    const { captureReadBack, setIdentityHints } = await import('../src/daemon/recorder.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    // fwrd27l reported part_A_supplier and part_B_supplier as the SAME
    // supplier name; both matched twice and neither was pinned. Accepting
    // ambiguity outright then broke odoo (fwod9), which keeps every run's
    // records: by run 2 the page held n1's customer too and `.first()` was
    // the wrong one. The anchor is what makes it safe — it re-binds per run.
    setIdentityHints(['Part One']); // names the row the first match sits in
    await page.evaluate(() => {
      for (const row of document.querySelectorAll('#dellist .prow')) {
        const cell = document.createElement('span');
        cell.className = 'supplier';
        cell.textContent = 'Bench Supplier Co';
        row.appendChild(cell);
      }
    });
    expect(await page.getByText('Bench Supplier Co', { exact: true }).count()).toBe(3);
    const step = await captureReadBack(page, 'Bench Supplier Co');
    expect(step).toBeTruthy();
    expect(JSON.parse(step!.result!)).toBe('Bench Supplier Co');
    // Won by a row anchor, so a later run re-binds to ITS record; and never
    // circular — a field is not located by the string it exists to report.
    const chain = step!.locators.target.chain ?? [];
    expect(chain[0].kind).toBe('scoped');
    expect(JSON.stringify(chain)).not.toContain('Bench Supplier Co');
  }, 30_000);

  it('refuses an ambiguous value with no anchor, rather than pinning the wrong record', async () => {
    const { captureReadBack, setIdentityHints } = await import('../src/daemon/recorder.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    setIdentityHints([]); // nothing names a record
    await page.evaluate(() => {
      for (const t of ['a', 'b']) {
        const el = document.createElement('p');
        el.id = `loose-${t}`;
        el.textContent = 'Acme Holdings';
        document.body.appendChild(el);
      }
    });
    // Two loose matches, no row to scope to: pinning `.first()` would bind
    // this run's report to whichever record happens to sort first NEXT run.
    expect(await captureReadBack(page, 'Acme Holdings')).toBeNull();
  }, 30_000);

  it('pins an ambiguous value shown in exactly one heading — the page names its own record', async () => {
    const { captureReadBack, setIdentityHints } = await import('../src/daemon/recorder.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    setIdentityHints([]);
    // fwod26's shape: an app-minted reference in both the breadcrumb and the
    // form's <h1>. The unique-text pin bails (two matches, no row anchor),
    // but the heading names the record THIS page displays, so a replay that
    // navigated to its own record reads its own reference there.
    await page.evaluate(() => {
      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb';
      crumb.textContent = 'S00021';
      const h1 = document.createElement('h1');
      const inner = document.createElement('span');
      inner.textContent = 'S00021';
      h1.appendChild(inner);
      document.body.append(crumb, h1);
    });
    const step = await captureReadBack(page, 'S00021', 'quotation_reference');
    expect(step).toBeTruthy();
    expect(step!.label).toBe('quotation_reference');
    expect(JSON.parse(step!.result!)).toBe('S00021');
    // and never located BY the value it exists to re-read
    expect(JSON.stringify(step!.locators.target.chain)).not.toContain('S00021');
  }, 30_000);

  it('refuses an ambiguous form value rather than pinning the wrong control', async () => {
    const { captureReadBack } = await import('../src/daemon/recorder.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    // A genuine second text control: #qty is type=number and coerces a
    // non-numeric value straight back to empty, which is not ambiguity.
    await page.evaluate(() => {
      (document.getElementById('name') as HTMLInputElement).value = 'same';
      const extra = document.createElement('input');
      extra.type = 'text';
      extra.value = 'same';
      document.body.appendChild(extra);
    });
    // Same rule as the text path: two matches is not a pin.
    expect(await captureReadBack(page, 'same')).toBeNull();
  }, 30_000);

  it('records the match index of an AMBIGUOUS candidate, including index 0', async () => {
    const { setIdentityHints } = await import('../src/daemon/recorder.js');
    const { compileSkill } = await import('../src/skills/compile.js');
    const { replaySkill } = await import('../src/skills/replay.js');
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const rec = session.script!;
    const mark = rec.mark();
    const instr = 'edit the first item';
    setIdentityHints([]); // no identity to anchor on: both rows read "Edit"
    rec.beginInstruction(instr, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const refs = [...snap.matchAll(/button "Edit" \[(@e\d+)\]/g)].map((m) => m[1]);
    expect(refs.length).toBe(2); // ambiguous by construction
    await run('click', { target: refs[0] });
    const skill = compileSkill({
      entries: rec.entriesSince(mark),
      instruction: instr,
      report: { status: 'success', summary: 'removed', evidence: { values: {} } },
      session: 'ident',
      knownValues: {},
    })!;
    const chain = skill.steps[0].locators.target ?? [];
    const role = chain.find((c) => c.kind === 'role');
    // The button matched at index 0 of three. Before this, `match === 0` meant
    // "no nth needed", so replay saw three matches, read it as drift, and fell
    // through to a structural path onto a record row.
    expect(role?.nth).toBe(0);

    // And it resolves back to that row rather than falling through.
    await page.goto(fixtureUrl);
    const clicked: string[] = [];
    const out = await replaySkill(skill, {}, {
      page,
      exec: async (_tool, _args, resolved) => {
        clicked.push(await resolved.target.first().evaluate((el: Element) => el.closest('.erow')?.getAttribute('data-row') ?? '?'));
        return { result: 'ok' };
      },
    });
    expect(out.ok).toBe(true);
    expect(clicked).toEqual(['1']);
    expect(out.fallthroughs).toBe(0);
  }, 30_000);

  it('tries the record-naming candidate before a structural one that sits ahead of it', async () => {
    const { resolveChain } = await import('../src/skills/replay.js');
    const { page } = await recordRowRead(['Part Two'], { record: 'Part Two' });
    // Head-of-chain is structural and resolves instantly against the WRONG
    // row. Resolution order is no longer array position, so the anchor behind
    // it still wins — and `index` is still the stored index, so drift keeps
    // reporting which recorded candidate took the step.
    const chain: LocatorCandidate[] = [
      { kind: 'css', selector: '#dellist > div:nth-of-type(1)' },
      { kind: 'scoped', container: '.prow', hasText: 'Part Two' },
    ];
    const hit = await resolveChain(page, chain, {});
    expect(hit?.index).toBe(1);
    expect(await hit!.locator.first().innerText()).toContain('Part Two');
  }, 30_000);
});

// Pure functions — no browser needed, always run.
describe('positionalExpr — one judgement of "found by position" shared with repair and verify-artifacts', () => {
  it('flags structural chains, nth selections, and deep child paths', async () => {
    const { positionalExpr } = await import('../src/daemon/recorder.js');
    expect(positionalExpr("page.locator('div:nth-of-type(1) > div:nth-of-type(2) > div > div > div > input')")).toBe(true);
    expect(positionalExpr("page.getByRole('button', { name: 'Edit' }).nth(1)")).toBe(true);
    expect(positionalExpr("page.locator('#view > div > section > button')")).toBe(true);
  });
  it('accepts semantic locators, anchored-region selectors, and identity-scoped chains', async () => {
    const { positionalExpr } = await import('../src/daemon/recorder.js');
    expect(positionalExpr("page.getByTestId('save-button')")).toBe(false);
    expect(positionalExpr("page.locator('[data-testid=\"options pane\"] input')")).toBe(false);
    expect(positionalExpr("page.locator('#rows tr', { hasText: 'x7 Ticket' }).locator('td:nth-of-type(2)')")).toBe(false);
  });
});

describe('consequentialExpectations — a fill echo is no evidence the RIGHT element changed', () => {
  it('drops echo lines when consequential ones exist (fwgr17-n3 panel-title shape)', async () => {
    const { consequentialExpectations, isEchoLine } = await import('../src/skills/replay.js');
    const lines = ['- heading "My Title"', '- button "Menu for panel with title My Title"', '- textbox "": My Title'];
    expect(isEchoLine('- textbox "": My Title', 'My Title')).toBe(true);
    expect(isEchoLine('- heading "My Title"', 'My Title')).toBe(false);
    expect(consequentialExpectations(lines, 'My Title')).toEqual(lines.slice(0, 2));
  });
  it('keeps the echo when it is all the recording has (a lone search-box fill)', async () => {
    const { consequentialExpectations } = await import('../src/skills/replay.js');
    const only = ['- searchbox "Search": widgets'];
    expect(consequentialExpectations(only, 'widgets')).toEqual(only);
    expect(consequentialExpectations(only, undefined)).toEqual(only);
  });
});
