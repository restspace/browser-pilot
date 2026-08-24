import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstructionResult } from '../src/agent/loop.js';
import type { RecordedEntry, RecordedStep } from '../src/daemon/recorder.js';
import { coalesceControls, compileSkill, compileSkills, discoverSlots, fillParams, foldLoops, isIdLike, sameProcedure, stableFirst, substitute, urlMatches, urlPattern } from '../src/skills/compile.js';
import type { LocatorCandidate } from '../src/daemon/recorder.js';
import type { SkillStep } from '../src/skills/store.js';
import { learnFromInstruction, matchTemplate, selectCandidates, synthesizeReport } from '../src/skills/learn.js';
import { candidatesFor, renderCandidates } from '../src/skills/replay.js';
import { SkillStore, originOf, originSlug, type Skill } from '../src/skills/store.js';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-skills-'));
  process.env.BROWSER_PILOT_SKILLS_DIR = tmp;
});
afterAll(() => {
  delete process.env.BROWSER_PILOT_SKILLS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ORIGIN = 'http://127.0.0.1:4180';
const INSTRUCTION =
  "On the ticket detail page for ticket RD-1015 (url http://127.0.0.1:4180/#/tickets/t15), add a part named exactly 'x7 RD Part A' with cost 100 and markup 25. Report the price the app computes.";

function step(tool: string, args: Record<string, unknown>, chain: RecordedStep['locators']['target']['chain'] = [], extra: Partial<RecordedStep> = {}): RecordedStep {
  return {
    k: 'step',
    tool,
    args,
    locators: args.target ? { target: { expr: 'x', verified: true, raw: String(args.target), chain } } : {},
    ...extra,
  };
}

/** A recording of the add-part instruction as the agent would have produced it. */
function recording(): RecordedEntry[] {
  return [
    { k: 'instruction', text: INSTRUCTION, url: `${ORIGIN}/#/tickets/t15`, fingerprint: [1, 0, 0] },
    step('click', { target: '@e3' }, [{ kind: 'role', role: 'button', name: 'Add part' }], {
      diff: { url: `${ORIGIN}/#/tickets/t15`, alerts: [], added: ['- dialog "New part"', '- textbox "Name"'] },
    }),
    step('fill', { target: '@e10', value: 'x7 RD Part A' }, [{ kind: 'label', label: 'Name' }, { kind: 'css', selector: 'form > input:nth-of-type(1)' }]),
    step('fill', { target: '@e11', value: '100' }, [{ kind: 'label', label: 'Cost' }]),
    step('fill', { target: '@e12', value: '25' }, [{ kind: 'label', label: 'Markup %' }]),
    step('click', { target: '@e13' }, [{ kind: 'role', role: 'button', name: 'Save' }], {
      diff: { url: `${ORIGIN}/#/tickets/t15`, alerts: ['Part x7 RD Part A added'], added: ['- row "x7 RD Part A 100 25% 125.00"'] },
    }),
    step('wait_for', { target: 'table.parts', state: 'text_contains', text: 'x7 RD Part A' }, [{ kind: 'css', selector: 'table.parts' }]),
    step('read', { target: 'tr:has-text("x7 RD Part A") td.price', what: 'text' }, [{ kind: 'css', selector: 'tr:has-text("x7 RD Part A") td.price' }], {
      result: '"125.00"',
    }),
  ];
}

const report = {
  status: 'success' as const,
  summary: "Added part 'x7 RD Part A' (cost 100, markup 25); the app computed price 125.00.",
  evidence: { values: { partName: 'x7 RD Part A', partPrice: '125.00' } },
};

describe('url patterns', () => {
  it('reduces id-like segments and drops the query', () => {
    expect(urlPattern('http://h:1/app/tickets/t15?x=1#/tickets/RD-1015')).toBe('http://h:1/app/tickets/:id#/tickets/:id');
    expect(urlPattern('http://h:1/products/8f3a9c2e1b/details')).toBe('http://h:1/products/:id/details');
    expect(urlPattern('http://h:1/users/123e4567-e89b-12d3-a456-426614174000')).toBe('http://h:1/users/:id');
    expect(urlPattern('http://h:1/about')).toBe('http://h:1/about');
  });
  it('keeps ordinary words', () => {
    expect(isIdLike('tickets')).toBe(false);
    expect(isIdLike('new')).toBe(false);
    expect(isIdLike('t15')).toBe(true);
    expect(isIdLike('RD-1015')).toBe(true);
  });
  it('turns slot values in the url into markers and matches them back', () => {
    const slots = new Map([['v1', 'acme']]);
    const p = urlPattern('http://h:1/orgs/acme/settings', slots);
    expect(p).toBe('http://h:1/orgs/{{v1}}/settings');
    expect(urlMatches(p, 'http://h:1/orgs/globex/settings', { v1: 'globex' })).toBe(true);
    expect(urlMatches(p, 'http://h:1/orgs/globex/billing', { v1: 'globex' })).toBe(false);
  });
  it('matches a live url with a different id', () => {
    expect(urlMatches('http://h:1/#/tickets/:id', 'http://h:1/#/tickets/t99')).toBe(true);
    expect(urlMatches('http://h:1/#/tickets/:id', 'http://h:1/#/tickets')).toBe(false);
  });
});

describe('parameterisation', () => {
  it('finds the literals the agent typed that occur as whole tokens in the instruction', () => {
    const slots = discoverSlots(INSTRUCTION, recording().filter((e): e is RecordedStep => e.k === 'step'));
    expect([...slots.values()]).toEqual(['x7 RD Part A', '100', '25']);
  });
  it('parameterises a navigation locator that identifies a record', () => {
    const instr = "On ticket RD-1015, add a part named 'x7 Part A'";
    const steps = [
      // a click whose ONLY record reference is the link name RD-1015 (not in any arg)
      step('click', { target: '@e1' }, [{ kind: 'role', role: 'link', name: 'RD-1015' }, { kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' }]),
      step('fill', { target: '@e2', value: 'x7 Part A' }, [{ kind: 'label', label: 'Name' }]),
    ];
    const slots = discoverSlots(instr, steps);
    // RD-1015 (record id, digit) and 'x7 Part A' (typed value) both become slots
    expect([...slots.values()]).toContain('RD-1015');
    expect([...slots.values()]).toContain('x7 Part A');
  });

  it('does NOT parameterise a plain UI-label locator that happens to match a word', () => {
    const instr = 'Add a part and save it';
    const steps = [step('click', { target: '@e1' }, [{ kind: 'role', role: 'button', name: 'Add' }, { kind: 'role', role: 'button', name: 'save' }])];
    // "Add"/"save" are stable affordances (no digit, not id-like) → stay literal
    expect([...discoverSlots(instr, steps).values()]).toEqual([]);
  });

  it('substitutes on token boundaries only', () => {
    const slots = new Map([['v1', '25']]);
    expect(substitute('markup 25 in li:nth-of-type(25) and 250', slots)).toBe('markup {{v1}} in li:nth-of-type(25) and 250');
    expect(fillParams('markup {{v1}}', { v1: '30' })).toBe('markup 30');
  });
  it('ignores a literal that is not in the instruction', () => {
    const steps = [step('fill', { target: '@e1', value: 'Some Customer' })];
    expect(discoverSlots('create a ticket', steps).size).toBe(0);
  });

  it('refuses a slot for a literal that appears twice in different roles', () => {
    // Odoo's demo credentials are admin/admin. One slot cannot stand for two
    // roles: bindSkill emits a capture group per occurrence, so a shared name
    // binds to the LAST group and the password lands in the email field.
    const instr = 'sign in with email admin and password admin';
    const steps = [
      step('fill', { target: '@e1', value: 'admin' }, [{ kind: 'label', label: 'Email' }]),
      step('fill', { target: '@e2', value: 'admin' }, [{ kind: 'label', label: 'Password' }]),
    ];
    expect([...discoverSlots(instr, steps).values()]).toEqual([]);
  });

  it('still parameterises a value that appears once alongside a repeated one', () => {
    const instr = "sign in as admin with password admin then open project 'Apollo'";
    const steps = [
      step('fill', { target: '@e1', value: 'admin' }, [{ kind: 'label', label: 'User' }]),
      step('fill', { target: '@e2', value: 'admin' }, [{ kind: 'label', label: 'Password' }]),
      step('fill', { target: '@e3', value: 'Apollo' }, [{ kind: 'label', label: 'Project' }]),
    ];
    expect([...discoverSlots(instr, steps).values()]).toEqual(['Apollo']);
  });
});

describe('foldLoops', () => {
  const sstep = (tool: string, target?: LocatorCandidate[], args: Record<string, unknown> = {}): SkillStep => ({ tool, args, locators: target ? { target } : {} });
  // Two "delete the part / confirm" groups that differ only in a per-record testid.
  const deleteGroup = (id: string): SkillStep[] => [
    sstep('click', [
      { kind: 'role', role: 'button', name: 'Delete' },
      { kind: 'testid', attr: 'data-testid', value: `part-delete-${id}` },
    ]),
    sstep('click', [{ kind: 'css', selector: 'button:has-text("Delete part")' }]),
  ];

  it('folds a run of identical action groups that differ only in a per-record id', () => {
    const folded = foldLoops([...deleteGroup('p18'), ...deleteGroup('p19')]);
    expect(folded).toHaveLength(1);
    expect(folded[0].tool).toBe('loop');
    expect(folded[0].body).toHaveLength(2);
    expect(folded[0].while?.[0]).toMatchObject({ kind: 'role', name: 'Delete' });
    expect(folded[0].max).toBe(2 * 2 + 3);
  });

  it('does NOT fold distinct form fields that merely share a role', () => {
    const steps = [
      sstep('fill', [{ kind: 'role', role: 'textbox', name: 'Title *' }], { value: 'A' }),
      sstep('fill', [{ kind: 'role', role: 'textbox', name: 'Customer' }], { value: 'B' }),
    ];
    expect(foldLoops(steps)).toHaveLength(2);
  });

  it('does NOT fold consecutive read-backs (observations never iterate)', () => {
    // Three synthetic read-backs whose locators differ only in a per-record id —
    // the same superficial shape as delete iteration, but reads must never fold.
    const reads = ['p18', 'p19', 'p20'].map((id) => sstep('read', [{ kind: 'testid', attr: 'data-testid', value: `part-price-${id}` }], { target: '(read-back)' }));
    expect(foldLoops(reads).every((s) => s.tool === 'read')).toBe(true);
  });

  it('does NOT fold a control that is simply hit twice identically (no per-record id)', () => {
    const twice = [sstep('click', [{ kind: 'role', role: 'button', name: 'Next' }]), sstep('click', [{ kind: 'role', role: 'button', name: 'Next' }])];
    expect(foldLoops(twice)).toHaveLength(2);
  });

  it('leaves surrounding steps in place and folds only the repeated middle', () => {
    const folded = foldLoops([sstep('goto', undefined, { url: '/x' }), ...deleteGroup('p18'), ...deleteGroup('p19'), sstep('read', undefined, { target: '(read-back)' })]);
    expect(folded.map((s) => s.tool)).toEqual(['goto', 'loop', 'read']);
  });

  it('coalesces redundant dialog_expect arming so an uneven delete run still folds', () => {
    const de = () => sstep('dialog_expect', undefined, { action: 'accept' });
    // The shape the recorder actually produced: one arm before the first delete,
    // two before the second — enough to misalign the groups on its own.
    const raw = [de(), ...deleteGroup('p18'), de(), de(), ...deleteGroup('p19'), de()];
    const folded = foldLoops(coalesceControls(raw));
    const loops = folded.filter((s) => s.tool === 'loop');
    expect(loops).toHaveLength(1);
    // The loop repeats the two delete clicks, guarded by the Delete button.
    expect(loops[0].body?.filter((b) => b.tool === 'click')).toHaveLength(2);
    expect(loops[0].while?.[0]).toMatchObject({ kind: 'role', name: 'Delete' });
  });
});

describe('compileSkill', () => {
  it('puts id-bearing selectors behind the semantic candidates', () => {
    expect(
      stableFirst([
        { kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' },
        { kind: 'role', role: 'link', name: '{{v3}}' },
        { kind: 'css', selector: '#list > li:nth-of-type(3) > a' },
      ]),
    ).toEqual([
      { kind: 'role', role: 'link', name: '{{v3}}' },
      { kind: 'css', selector: '#list > li:nth-of-type(3) > a' },
      { kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' },
    ]);
    // nothing stable → order untouched
    expect(stableFirst([{ kind: 'id', selector: '#row-1042' }])).toEqual([{ kind: 'id', selector: '#row-1042' }]);
    // a link named by a record id goes behind a positional path; a parameterised name stays first
    expect(stableFirst([{ kind: 'role', role: 'link', name: 'RD-1017' }, { kind: 'css', selector: '#rows > tr:nth-of-type(1) > a' }])[0]).toEqual({
      kind: 'css',
      selector: '#rows > tr:nth-of-type(1) > a',
    });
    expect(stableFirst([{ kind: 'role', role: 'link', name: '{{v1}}' }, { kind: 'css', selector: 'a' }])[0].kind).toBe('role');
  });

  it('produces a parameterised, replayable skill from a recording', () => {
    const skill = compileSkill({ entries: recording(), instruction: INSTRUCTION, report, session: 's', model: 'm', now: '2026-08-23T00:00:00Z' });
    expect(skill).toBeTruthy();
    const s = skill!;
    expect(s.origin).toBe(ORIGIN);
    expect(s.template).toContain("add a part named exactly '{{v1}}' with cost {{v2}} and markup {{v3}}");
    expect(s.preconditions.urlPattern).toBe(`${ORIGIN}/#/tickets/:id`);
    expect(s.preconditions.fingerprint).toEqual([1, 0, 0]);
    expect(Object.keys(s.params)).toEqual(['v1', 'v2', 'v3']);
    expect(s.params.v1).toEqual({ example: 'x7 RD Part A', usedIn: [2, 6, 7] });
    // args, locators and expectations all carry the slot
    expect(s.steps[1].args.value).toBe('{{v1}}');
    expect(s.steps[6].locators.target[0]).toEqual({ kind: 'css', selector: 'tr:has-text("{{v1}}") td.price' });
    expect(s.steps[4].expect?.alertContains).toBe('Part {{v1}} added');
    expect(s.steps[4].expect?.addedContains).toEqual(['- row "{{v1}} {{v2}} {{v3}}% 125.00"']);
    // a step that did not change the url still records where it left the browser
    expect(s.steps[0].expect?.urlPattern).toBe(`${ORIGIN}/#/tickets/:id`);
    // the read that supplied a report value is labelled with that key
    expect(s.steps[6].label).toBe('partPrice');
    expect(s.reportTemplate?.values).toEqual({ partName: '{{v1}}', partPrice: '125.00' });
    expect(s.status).toBe('provisional');
    expect(s.stats).toMatchObject({ uses: 1, successes: 1 });
  });
  it('strips inspection-only steps (eval, screenshot, unreported reads) but keeps actions and read-backs', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: INSTRUCTION, url: `${ORIGIN}/#/tickets/t15`, fingerprint: [1, 0, 0] },
      step('eval', { expression: 'document.querySelector("#f-title")' }),
      step('fill', { target: '@e10', value: 'x7 RD Part A' }, [{ kind: 'label', label: 'Name' }]),
      step('screenshot', { full_page: true }),
      step('read', { target: '#scratch', what: 'text' }, [{ kind: 'css', selector: '#scratch' }], { result: '"nobody reports this"' }),
      step('read', { target: '(read-back)', what: 'text' }, [{ kind: 'css', selector: '#price' }], { result: '"125.00"' }),
    ];
    const s = compileSkill({ entries, instruction: INSTRUCTION, report, session: 's' })!;
    const tools = s.steps.map((st) => st.tool);
    expect(tools).not.toContain('eval');
    expect(tools).not.toContain('screenshot');
    expect(tools).toEqual(['fill', 'read']); // the fill action + the read-back that supplies partPrice
    expect(s.steps[1].args.target).toBe('(read-back)');
  });
  it('drops slots no step uses, and returns null with nothing to replay', () => {
    const entries: RecordedEntry[] = [{ k: 'instruction', text: 'open the list', url: `${ORIGIN}/` }];
    expect(compileSkill({ entries, instruction: 'open the list', report, session: 's' })).toBeNull();
  });
});

describe('SkillStore', () => {
  const mk = (template: string, extra: Partial<Skill> = {}): Skill => ({
    id: 's_' + Math.random().toString(16).slice(2, 8),
    origin: ORIGIN,
    template,
    params: {},
    preconditions: { urlPattern: `${ORIGIN}/#/tickets/:id` },
    steps: [{ tool: 'click', args: { target: '@e1' }, locators: { target: [{ kind: 'role', role: 'button', name: 'Go' }] } }],
    stats: { uses: 1, successes: 1, partial: 0, created: 't', failedAtStep: {}, fallthroughs: 0 },
    status: 'provisional',
    provenance: { session: 's', instruction: template, created: 't' },
    ...extra,
  });

  it('persists per origin and round-trips', () => {
    const store = new SkillStore(path.join(tmp, 'a'));
    const s = mk('do a thing');
    store.put(s);
    expect(store.list(ORIGIN).map((x) => x.id)).toEqual([s.id]);
    expect(store.get(s.id)?.template).toBe('do a thing');
    expect(store.origins()).toEqual([ORIGIN]);
    expect(store.remove(s.id)).toBe(true);
    expect(store.all()).toEqual([]);
    expect(originSlug('http://127.0.0.1:4180')).toBe('127.0.0.1_4180');
    expect(originOf('file:///C:/x.html')).toBe('file://');
  });

  it('promotes on the second clean replay and demotes on two strikes at one step', () => {
    const store = new SkillStore(path.join(tmp, 'b'));
    const s = mk('promote me');
    store.put(s);
    expect(store.recordOutcome(s.id, { ok: true, instructionSucceeded: true })?.status).toBe('validated');
    // a success inside a failed instruction does not count as a success
    const t = mk('strict');
    store.put(t);
    expect(store.recordOutcome(t.id, { ok: true, instructionSucceeded: false })?.stats.successes).toBe(1);
    // same step failing twice in a row → demoted; a different step resets the strike
    const d = mk('demote me');
    store.put(d);
    store.recordOutcome(d.id, { ok: false, failedAt: 3, instructionSucceeded: true });
    expect(store.get(d.id)?.status).toBe('provisional');
    store.recordOutcome(d.id, { ok: false, failedAt: 2, instructionSucceeded: true });
    expect(store.get(d.id)?.status).toBe('provisional');
    store.recordOutcome(d.id, { ok: false, failedAt: 2, instructionSucceeded: false });
    expect(store.get(d.id)?.status).toBe('demoted');
    expect(store.get(d.id)?.stats.failedAtStep).toEqual({ '3': 1, '2': 2 });
  });

  it('lists candidates for a page: validated first, demoted never, wrong page never', () => {
    const v = mk('validated one', { status: 'validated', stats: { uses: 4, successes: 4, partial: 0, created: 't', failedAtStep: {}, fallthroughs: 0 } });
    const p = mk('provisional one');
    const d = mk('demoted one', { status: 'demoted' });
    const elsewhere = mk('other page', { preconditions: { urlPattern: `${ORIGIN}/#/settings` } });
    const list = candidatesFor([p, d, elsewhere, v], `${ORIGIN}/#/tickets/t42`);
    expect(list.map((s) => s.template)).toEqual(['validated one', 'provisional one']);
    const text = renderCandidates(list);
    expect(text).toContain('[skills]');
    expect(text).toContain('validated 4/4');
    expect(text).toContain('unverified');
  });
});

describe('learnFromInstruction', () => {
  const result = (status: 'success' | 'failure', skill?: InstructionResult['skill']): InstructionResult => ({
    report: { ...report, status },
    turns: 3,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    screenshots: [],
    ...(skill ? { skill } : {}),
  });
  const noSkill = { listed: [], stepsReplayed: 0, stepsTotal: 0, repaired: false, refused: false, fallthroughs: 0, similarity: null, deterministicActions: 0, totalActions: 5 };

  it('compiles on success, merges the same template on the next run, never compiles a failure', () => {
    const store = new SkillStore(path.join(tmp, 'c'));
    const first = learnFromInstruction(store, { result: result('success', noSkill), instruction: INSTRUCTION, entries: recording(), session: 's', now: '2026-01-01T00:00:00Z' });
    expect(first?.compiled).toBeTruthy();
    expect(store.all()).toHaveLength(1);

    // a second run on a different runid: same template → merged and promoted
    const again = INSTRUCTION.replaceAll('x7', 'q2');
    const entries = JSON.parse(JSON.stringify(recording()).replaceAll('x7', 'q2')) as RecordedEntry[];
    const second = learnFromInstruction(store, { result: result('success', noSkill), instruction: again, entries, session: 's', now: '2026-01-02T00:00:00Z' });
    expect(second?.merged).toBe(first!.compiled);
    expect(store.all()).toHaveLength(1);
    expect(store.get(first!.compiled!)?.status).toBe('validated');

    expect(learnFromInstruction(store, { result: result('failure', noSkill), instruction: 'x', entries: recording(), session: 's' })).toBeNull();
    expect(store.all()).toHaveLength(1);
  });

  it('records a full replay as an outcome without compiling, and a repair as a variant', () => {
    const store = new SkillStore(path.join(tmp, 'd'));
    const base = compileSkill({ entries: recording(), instruction: INSTRUCTION, report, session: 's', now: '2026-01-01T00:00:00Z' })!;
    store.put(base);

    const full = learnFromInstruction(store, {
      result: result('success', { ...noSkill, invoked: base.id, stepsReplayed: 7, stepsTotal: 7, deterministicActions: 7, totalActions: 7 }),
      instruction: INSTRUCTION,
      entries: recording(),
      session: 's',
    });
    expect(full).toEqual({ outcome: { skill: base.id, status: 'validated', ok: true } });
    expect(store.all()).toHaveLength(1);

    // replay stopped at step 5, agent finished: variant stored, original's failure counted
    const repaired = learnFromInstruction(store, {
      result: result('success', { ...noSkill, invoked: base.id, stepsReplayed: 4, stepsTotal: 7, repaired: true, deterministicActions: 4, totalActions: 7 }),
      instruction: INSTRUCTION,
      entries: recording(),
      session: 's',
      now: '2026-01-03T00:00:00Z',
    });
    expect(repaired?.compiled).toBeTruthy();
    expect(repaired?.variantOf).toBe(base.id);
    expect(store.get(base.id)?.stats.failedAtStep).toEqual({ '5': 1 });
    const variant = store.get(repaired!.compiled!)!;
    expect(variant.variantOf).toBe(base.id);

    // once the variant validates, it supersedes the original
    const promoted = learnFromInstruction(store, {
      result: result('success', { ...noSkill, invoked: variant.id, stepsReplayed: 7, stepsTotal: 7 }),
      instruction: INSTRUCTION,
      entries: recording(),
      session: 's',
    });
    expect(promoted?.superseded).toBe(base.id);
    expect(store.get(base.id)?.status).toBe('demoted');
    expect(store.get(variant.id)?.status).toBe('validated');
  });
});

describe('zero-model template match', () => {
  it('binds params from a word-for-word instruction and refuses near misses', () => {
    const skill = compileSkill({ entries: recording(), instruction: INSTRUCTION, report, session: 's' })!;
    skill.status = 'validated';
    const same = INSTRUCTION.replaceAll('x7 RD Part A', 'z9 RD Part B').replace('cost 100', 'cost 300').replace('markup 25', 'markup 40');
    const m = matchTemplate([skill], same, `${ORIGIN}/#/tickets/t77`);
    expect(m?.params).toEqual({ v1: 'z9 RD Part B', v2: '300', v3: '40' });
    // different wording → no match; provisional → no match; wrong page → no match
    expect(matchTemplate([skill], 'add a part named z9 with cost 300', `${ORIGIN}/#/tickets/t77`)).toBeNull();
    expect(matchTemplate([{ ...skill, status: 'provisional' }], same, `${ORIGIN}/#/tickets/t77`)).toBeNull();
    expect(matchTemplate([skill], same, `${ORIGIN}/#/settings`)).toBeNull();
  });
  it('synthesises a report from live read-backs, never from the stored value', () => {
    const skill = compileSkill({ entries: recording(), instruction: INSTRUCTION, report, session: 's' })!;
    const r = synthesizeReport(skill, { v1: 'z9 RD Part B', v2: '300', v3: '40' }, { partPrice: '375.00' });
    expect(r.status).toBe('success');
    expect(r.evidence?.values).toEqual({ partName: 'z9 RD Part B', partPrice: '375.00' });
    expect(r.summary).toContain('z9 RD Part B');
    expect(r.summary).toContain('375.00');
    expect(r.summary).not.toContain('125.00');
  });
  it('sameProcedure compares tools and primary locators', () => {
    const a = compileSkill({ entries: recording(), instruction: INSTRUCTION, report, session: 's' })!;
    const b = compileSkill({ entries: recording(), instruction: 'totally different words x7 RD Part A 100 25', report, session: 's' })!;
    expect(sameProcedure(a, b)).toBe(true);
    expect(sameProcedure(a, { ...b, steps: b.steps.slice(1) })).toBe(false);
  });
});

describe('selectCandidates (lifecycle-gated adoption)', () => {
  const make = (status: Skill['status'], stats?: Partial<Skill['stats']>): Skill => {
    const s = compileSkill({ entries: recording(), instruction: INSTRUCTION, report, session: 's' })!;
    s.status = status;
    Object.assign(s.stats, stats);
    return { ...s, id: `s_${status}_${s.stats.uses}_${Math.abs(JSON.stringify(stats ?? {}).length)}` };
  };
  const same = INSTRUCTION.replaceAll('x7 RD Part A', 'z9 RD Part B').replace('cost 100', 'cost 300').replace('markup 25', 'markup 40');

  it('orders validated before provisional, excludes demoted, and never needs the hint', () => {
    const validated = make('validated', { uses: 4, successes: 4 });
    const provisional = make('provisional', { uses: 1, successes: 1 });
    const demoted = make('demoted', { uses: 5, successes: 5 });
    const out = selectCandidates([provisional, demoted, validated], undefined, same);
    expect(out.map((c) => c.skill.id)).toEqual([validated.id, provisional.id]);
    expect(out[0].params).toEqual({ v1: 'z9 RD Part B', v2: '300', v3: '40' });
  });

  it('a fragile pinned provisional does not outrank a proven validated sibling', () => {
    const original = make('validated', { uses: 4, successes: 4 });
    const pinnedVariant = make('provisional', { uses: 1, successes: 1 });
    const out = selectCandidates([pinnedVariant, original], pinnedVariant.id, same, { v1: 'z9 RD Part B', v2: '300', v3: '40' });
    expect(out[0].skill.id).toBe(original.id);
    expect(out[1].skill.id).toBe(pinnedVariant.id);
  });

  it('ranks by success rate within a status tier', () => {
    const shaky = make('validated', { uses: 4, successes: 2 });
    const solid = make('validated', { uses: 4, successes: 4 });
    const out = selectCandidates([shaky, solid], undefined, same);
    expect(out[0].skill.id).toBe(solid.id);
  });

  it('a sameProcedure sibling with different wording inherits the pinned bindings', () => {
    const hint = make('provisional');
    const sibling = compileSkill({ entries: recording(), instruction: 'totally different words x7 RD Part A 100 25', report, session: 's' })!;
    sibling.status = 'validated';
    const params = { v1: 'z9 RD Part B', v2: '300', v3: '40' };
    const out = selectCandidates([hint, sibling], hint.id, same, params);
    expect(out.map((c) => c.skill.id)).toEqual([sibling.id, hint.id]);
    expect(out[0].params).toEqual(params);
  });
});

describe('segmentation (one skill per page-template segment)', () => {
  const SIGNIN = `${ORIGIN}/#/signin`;
  const LIST = `${ORIGIN}/#/tickets`;
  const INSTR = "Sign in as bench@example.com with password hunter2, then create a ticket titled 'Seg Ticket' and report its reference.";
  const segReport = {
    status: 'success' as const,
    summary: "Signed in and created ticket 'Seg Ticket' (RD-1015).",
    evidence: { values: { ticket_ref: 'RD-1015', ticket_title: 'Seg Ticket' } },
  };
  function twoPageRecording(): RecordedEntry[] {
    return [
      { k: 'instruction', text: INSTR, url: SIGNIN, fingerprint: [1, 0, 0] },
      step('fill', { target: '@e1', value: 'bench@example.com' }, [{ kind: 'label', label: 'Email' }]),
      step('fill', { target: '@e2', value: 'hunter2' }, [{ kind: 'label', label: 'Password' }]),
      step('click', { target: '@e3' }, [{ kind: 'role', role: 'button', name: 'Sign in' }], {
        diff: { url: LIST, alerts: [], added: ['- heading "Tickets"'] },
        fingerprintAfter: [0, 1, 0],
      }),
      step('click', { target: '@e4' }, [{ kind: 'role', role: 'button', name: 'New ticket' }], {
        diff: { url: LIST, alerts: [], added: ['- dialog "New ticket"'] },
      }),
      step('fill', { target: '@e5', value: 'Seg Ticket' }, [{ kind: 'label', label: 'Title' }]),
      step('click', { target: '@e6' }, [{ kind: 'role', role: 'button', name: 'Create' }], {
        diff: { url: LIST, alerts: [], added: ['- row "RD-1015 Seg Ticket"'] },
      }),
    ];
  }

  it('splits at the url-pattern seam into a linked chain with per-segment preconditions', () => {
    const skills = compileSkills({ entries: twoPageRecording(), instruction: INSTR, report: segReport, session: 's' });
    expect(skills).toHaveLength(2);
    const [a, b] = skills;
    expect(a.seq).toEqual({ chain: a.seq!.chain, index: 0, of: 2 });
    expect(b.seq).toEqual({ chain: a.seq!.chain, index: 1, of: 2 });
    expect(a.template).toBe(b.template);
    expect(a.id).not.toBe(b.id);
    expect(a.preconditions.urlPattern).toContain('/#/signin');
    expect(a.preconditions.fingerprint).toEqual([1, 0, 0]);
    expect(b.preconditions.urlPattern).toContain('/#/tickets');
    expect(b.preconditions.fingerprint).toEqual([0, 1, 0]);
    expect(a.steps).toHaveLength(3);
    expect(b.steps).toHaveLength(3);
    // report vouching only from the last segment
    expect(a.reportTemplate).toBeUndefined();
    expect(b.reportTemplate).toBeDefined();
    // the shared slot set: every segment carries the union so one binding fits all
    expect(Object.keys(a.params)).toEqual(Object.keys(b.params));
    expect(Object.keys(a.params).length).toBeGreaterThan(0);
  });

  it('a same-template recording with no seam still compiles to one skill', () => {
    const skills = compileSkills({ entries: recording(), instruction: INSTRUCTION, report, session: 's' });
    expect(skills).toHaveLength(1);
    expect(skills[0].seq).toBeUndefined();
  });

  it('learnFromInstruction stores all segments and merges a repeat run into the same chain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seg-'));
    const store = new SkillStore(dir);
    const result = { report: segReport, turns: 3, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 }, screenshots: [] } as unknown as InstructionResult;
    const first = learnFromInstruction(store, { result, instruction: INSTR, entries: twoPageRecording(), session: 's1' });
    expect(first?.compiledAll).toHaveLength(2);
    const second = learnFromInstruction(store, { result, instruction: INSTR.replace('Seg Ticket', 'Seg Ticket'), entries: twoPageRecording(), session: 's2' });
    expect(second?.merged).toBe(first?.compiled);
    const all = store.all();
    expect(all).toHaveLength(2);
    // both segments were bumped and promoted together
    for (const s of all) {
      expect(s.stats.successes).toBe(2);
      expect(s.status).toBe('validated');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matchTemplate and selectCandidates never start a chain mid-way', () => {
    const skills = compileSkills({ entries: twoPageRecording(), instruction: INSTR, report: segReport, session: 's' });
    for (const s of skills) s.status = 'validated';
    const [head, tail] = skills;
    // on the tail's page, the tail must not be offered as an entry point
    expect(matchTemplate([tail], INSTR, LIST)).toBeNull();
    expect(matchTemplate([head], INSTR, SIGNIN)?.skill.id).toBe(head.id);
    expect(selectCandidates([tail, head], undefined, INSTR).map((c) => c.skill.id)).toEqual([head.id]);
  });
});
