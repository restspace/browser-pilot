/**
 * Post-session repair (SLOW MODE): triage a run's drift tickets, promote
 * proven fallbacks without a model, patch a dead locator via a proposer on
 * the live page, and flag redesigns for re-record.
 *
 * The browser-gated block closes the loop on the fixture page: perturb the
 * page → replay records the drift → tickets → repair → replay is clean.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeTool } from '../src/agent/tools.js';
import { BrowserSession } from '../src/daemon/browser.js';
import { compileSkill } from '../src/skills/compile.js';
import { LOCALIZED_SIMILARITY, patchSegment, promoteFallback, stepByTag, triage, type DriftTicket } from '../src/skills/repair.js';
import { SkillStore, type Skill } from '../src/skills/store.js';

const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;

const fixtureUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'page.html')).href;

function ticket(over: Partial<DriftTicket>): DriftTicket {
  return {
    flow: 'f', step: '01-step', skill: 's_x', atStep: '1', key: 'target',
    similarity: 0.97, missedLocator: 'role=button[name="Submit"]', fallbackUsed: null,
    recovered: false, ...over,
  };
}

describe('triage', () => {
  it('classifies by similarity and by whether the chain self-healed', () => {
    const actions = triage([
      ticket({ fallbackUsed: 'css=#submit', fallbackIndex: 2 }),
      ticket({ atStep: '2', fallbackUsed: null }),
      ticket({ atStep: '3', similarity: LOCALIZED_SIMILARITY - 0.2 }),
      ticket({ atStep: '4', missedLocator: null, recovered: true, reason: 'reference could not be threaded' }),
      ticket({ atStep: '5', similarity: null, fallbackUsed: 'css=#x', fallbackIndex: 1 }),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(['promote-fallback', 'patch-segment', 're-record', 'skip', 'promote-fallback']);
  });

  it('dedupes repeat misses of the same locator across a sweep', () => {
    const t = ticket({ fallbackUsed: 'css=#submit', fallbackIndex: 1 });
    expect(triage([t, { ...t }, { ...t, flow: 'other-run' }])).toHaveLength(1);
  });

  it('never promotes a POSITIONAL fallback — that is a symptom, not a self-heal', () => {
    // fwgr17-n3's exact shape: the testid missed and a bare structural chain
    // took the step. Promoting it would put "wherever sorted into that slot"
    // first in the chain — enshrining what verify-artifacts flags.
    const t = ticket({
      missedLocator: "page.getByTestId('data-testid Panel editor option pane field input Title')",
      fallbackUsed: "page.locator('div:nth-of-type(1) > div:nth-of-type(2) > div > div > div > input')",
      fallbackIndex: 2,
    });
    expect(triage([t])[0].kind).toBe('patch-segment');
    // .nth() is position too, even on a semantic base.
    const nth = ticket({ atStep: '9', fallbackUsed: "page.getByRole('button', { name: 'Edit' }).nth(1)", fallbackIndex: 1 });
    expect(triage([nth])[0].kind).toBe('patch-segment');
    // An identity-scoped fallback names the record first: still a self-heal.
    const scoped = ticket({ atStep: '10', fallbackUsed: "page.locator('#rows tr', { hasText: 'x7 Ticket' }).locator('td:nth-of-type(2)')", fallbackIndex: 1 });
    expect(triage([scoped])[0].kind).toBe('promote-fallback');
  });
});

describe('promoteFallback', () => {
  const mkSkill = (): Skill => ({
    id: 's_x', origin: 'http://x', template: 'do the thing', params: {},
    preconditions: { urlPattern: 'http://x/' },
    steps: [
      { tool: 'click', args: { target: '@e1' }, locators: { target: [
        { kind: 'role', role: 'button', name: 'Submit' },
        { kind: 'text', text: 'Submit' },
        { kind: 'id', selector: '#submit' },
      ] } },
    ],
    stats: { uses: 3, successes: 3, partial: 0, created: 'now', failedAtStep: {}, fallthroughs: 2 },
    status: 'validated',
    provenance: { session: 's', instruction: 'do the thing', created: 'now' },
  });

  it('moves the proven fallback to the front of the chain, keeping the old primary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-repair-'));
    const store = new SkillStore(dir);
    store.put(mkSkill());
    expect(promoteFallback(store, ticket({ fallbackUsed: "page.locator('#submit')", fallbackIndex: 2 }))).toBe(true);
    const chain = store.get('s_x')!.steps[0].locators.target;
    expect(chain.map((c) => c.kind)).toEqual(['id', 'role', 'text']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when the ticket no longer maps onto the skill', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-repair-'));
    const store = new SkillStore(dir);
    store.put(mkSkill());
    expect(promoteFallback(store, ticket({ skill: 's_gone', fallbackIndex: 1 }))).toBe(false);
    // a ticket naming a candidate that is no longer at that index is refused
    expect(promoteFallback(store, ticket({ fallbackUsed: "page.locator('#other')", fallbackIndex: 1 }))).toBe(false);
    expect(promoteFallback(store, ticket({ fallbackIndex: 9 }))).toBe(false);
    expect(promoteFallback(store, ticket({ fallbackIndex: undefined }))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stepByTag reaches loop-body steps', () => {
    const s = mkSkill();
    s.steps.push({ tool: 'loop', args: {}, locators: {}, body: [s.steps[0]], while: s.steps[0].locators.target, max: 5 });
    expect(stepByTag(s, '2.3.1')).toBe(s.steps[1].body![0]);
    expect(stepByTag(s, '1')).toBe(s.steps[0]);
    expect(stepByTag(s, '9')).toBeNull();
  });
});

d('repair on the fixture page (closed loop)', () => {
  let home: string;
  let session: BrowserSession;
  let skill: Skill;
  let store: SkillStore;
  const dir = os.tmpdir();
  const run = (name: string, args: Record<string, unknown>) => executeTool(session, name, args, dir);
  const INSTR = "fill the form with name 'Ada Lovelace' and quantity 42, submit it, and report the banner text";
  const REPORT = {
    status: 'success' as const,
    summary: "Submitted the form for 'Ada Lovelace' (qty 42); the banner says 'Saved Ada Lovelace!'.",
    evidence: { values: { banner: 'Saved Ada Lovelace!' } },
  };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-repairfix-'));
    process.env.SLEEP_WALKER_HOME = home;
    process.env.SLEEP_WALKER_SKILLS_DIR = path.join(home, 'skills');
    session = new BrowserSession({ session: 'repairfix', persist: false, learn: true });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const recorder = session.script!;
    const mark = recorder.mark();
    recorder.beginInstruction(INSTR, { url: page.url() });
    const snap = (await run('snapshot', {})).result;
    const ref = (label: RegExp) => label.exec(snap)![1];
    await run('fill', { target: ref(/textbox "Name" \[(@e\d+)\]/), value: 'Ada Lovelace' });
    await run('fill', { target: ref(/spinbutton "Qty" \[(@e\d+)\]/), value: '42' });
    await run('click', { target: ref(/button "Submit" \[(@e\d+)\]/) });
    await run('wait_for', { target: '#banner', state: 'text_contains', text: 'Saved Ada Lovelace', timeout_ms: 3000 });
    await run('read', { target: '#banner', what: 'text' });
    skill = compileSkill({ entries: recorder.entriesSince(mark), instruction: INSTR, report: REPORT, session: 'repairfix' })!;
    store = session.learn!;
    store.put(skill);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    delete process.env.SLEEP_WALKER_SKILLS_DIR;
    delete process.env.SLEEP_WALKER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('fallthrough drift → ticket → promoteFallback → the next replay is clean', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      document.getElementById('submit')!.textContent = 'Store';
    });
    const drifted = await run('run_skill', { id: skill.id, params: { v1: 'Ada', v2: '5' } });
    expect(drifted.replay?.ok).toBe(true);
    const miss = drifted.replay!.misses[0];
    expect(miss.usedIndex).toBeGreaterThan(0);
    // the ticket runFlow would emit for this miss
    const t = ticket({ skill: skill.id, atStep: miss.step, key: miss.key, missedLocator: miss.primary, fallbackUsed: miss.used, fallbackIndex: miss.usedIndex });
    const [action] = triage([t]);
    expect(action.kind).toBe('promote-fallback');
    expect(promoteFallback(store, t)).toBe(true);
    // same perturbed page: the promoted primary now resolves first — no fallthrough
    const again = await run('run_skill', { id: skill.id, params: { v1: 'Eve', v2: '6' } });
    expect(again.replay?.ok).toBe(true);
    expect(again.replay?.fallthroughs).toBe(0);
  }, 60_000);

  it('dead chain → patchSegment stores a verified provisional variant that replays', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    // remove the recorded control entirely and provide a differently-named stand-in
    await page.evaluate(() => {
      const old = document.getElementById('qty')!;
      const input = document.createElement('input');
      input.id = 'quantity-field';
      input.type = 'number';
      input.setAttribute('data-testid', 'quantity');
      const label = document.createElement('label');
      label.append('Amount ', input);
      old.closest('label')!.replaceWith(label);
    });
    const drifted = await run('run_skill', { id: skill.id, params: { v1: 'Ada', v2: '7' } });
    expect(drifted.replay?.ok).toBe(false);
    const miss = drifted.replay!.misses.find((m) => m.used === null)!;
    const t = ticket({ skill: skill.id, atStep: miss.step, key: miss.key, missedLocator: miss.primary, fallbackUsed: null });
    expect(triage([t])[0].kind).toBe('patch-segment');
    // proposer stub standing in for the repair model — sees the live snapshot
    const res = await patchSegment(store, t, page, async ({ snapshot }) => {
      expect(snapshot).toContain('testid=quantity');
      return { kind: 'testid', attr: 'data-testid', value: 'quantity' };
    });
    expect(res.outcome).toBe('patched');
    const variant = store.get(res.variant!)!;
    expect(variant.status).toBe('provisional');
    expect(variant.variantOf).toBe(skill.id);
    // the variant replays on the drifted page; the original stays untouched
    const healed = await run('run_skill', { id: variant.id, params: { v1: 'Eve', v2: '8' } });
    expect(healed.replay?.ok).toBe(true);
    expect(await page.inputValue('#quantity-field')).toBe('8');
    expect(store.get(skill.id)!.steps.length).toBe(skill.steps.length);
  }, 60_000);

  it('a proposal that does not resolve on the live page is rejected, nothing stored', async () => {
    const page = await session.getPage();
    await page.goto(fixtureUrl);
    const t = ticket({ skill: skill.id, atStep: '2', key: 'target', missedLocator: 'x', fallbackUsed: null });
    const before = store.all().length;
    const res = await patchSegment(store, t, page, async () => ({ kind: 'id', selector: '#does-not-exist' }));
    expect(res.outcome).toBe('proposal-does-not-resolve');
    expect(store.all().length).toBe(before);
  }, 30_000);
});
