import { describe, expect, it } from 'vitest';
import {
  applyRelabelToEntries,
  applyRelabelToSkills,
  relabelCases,
  validateRelabelPlan,
  type RelabelCase,
} from '../src/skills/relabel.js';
import type { RecordedEntry } from '../src/daemon/recorder.js';
import type { Skill } from '../src/skills/store.js';

const entries = (): RecordedEntry[] =>
  [
    { k: 'instruction', text: 'Create a quotation' },
    { k: 'report', status: 'success', summary: 'created S00021', values: { h1: 'S00021', unit_price: '85.00' }, skill: 's_aaa' },
    { k: 'instruction', text: 'Verify the order' },
    { k: 'report', status: 'success', summary: 'verified', values: { role_radiogroup_aria_che: 'Sales Order' } },
    { k: 'instruction', text: 'A failed one' },
    { k: 'report', status: 'blocked', summary: 'nope', values: { x: '1' } },
  ] as unknown as RecordedEntry[];

describe('relabelCases', () => {
  it('one case per successful report with values, indexed by instruction order', () => {
    const cases = relabelCases(entries());
    expect(cases.map((c) => c.index)).toEqual([1, 2]);
    expect(cases[0]).toMatchObject({ instruction: 'Create a quotation', values: { h1: 'S00021', unit_price: '85.00' }, skill: 's_aaa' });
  });
});

describe('validateRelabelPlan', () => {
  const cases: RelabelCase[] = [{ index: 1, instruction: 'x', values: { h1: 'S00021', unit_price: '85.00', partB: 'RAM' } }];

  it('keeps safe renames and drops unsafe ones with a reason', () => {
    const { plan, dropped } = validateRelabelPlan(
      {
        renames: [
          { i: 1, from: 'h1', to: 'order_reference' },
          { i: 1, from: 'nope', to: 'anything' },
          { i: 1, from: 'unit_price', to: 'not a name!' },
          { i: 1, from: 'unit_price', to: 'h1' }, // collides with an existing key
        ],
      },
      cases,
    );
    expect(plan.get(1)).toEqual({ h1: 'order_reference' });
    expect(dropped).toHaveLength(3);
  });

  it('accepts camelCase — the validator must not be stricter than the names that already stand', () => {
    const { plan, dropped } = validateRelabelPlan({ renames: [{ i: 1, from: 'partB', to: 'partBName' }] }, cases);
    expect(plan.get(1)).toEqual({ partB: 'partBName' });
    expect(dropped).toEqual([]);
  });

  it('two renames may not converge on one name', () => {
    const { plan, dropped } = validateRelabelPlan(
      { renames: [{ i: 1, from: 'h1', to: 'ref' }, { i: 1, from: 'unit_price', to: 'ref' }] },
      cases,
    );
    expect(plan.get(1)).toEqual({ h1: 'ref' });
    expect(dropped).toHaveLength(1);
  });

  it('a malformed answer is an empty plan, not a crash', () => {
    expect(validateRelabelPlan(undefined, cases).plan.size).toBe(0);
    expect(validateRelabelPlan({ renames: 'ha' }, cases).plan.size).toBe(0);
    expect(validateRelabelPlan({ renames: [null, {}] }, cases).plan.size).toBe(0);
  });
});

describe('applyRelabelToEntries', () => {
  it('renames keys in place, preserving order and untouched reports', () => {
    const es = entries();
    const plan = new Map([
      [1, { h1: 'order_reference' }],
      [2, { role_radiogroup_aria_che: 'order_status' }],
    ]);
    expect(applyRelabelToEntries(es, plan)).toBe(2);
    const reports = es.filter((e): e is Extract<RecordedEntry, { k: 'report' }> => e.k === 'report');
    expect(Object.keys(reports[0].values)).toEqual(['order_reference', 'unit_price']);
    expect(reports[1].values).toEqual({ order_status: 'Sales Order' });
    expect(reports[2].values).toEqual({ x: '1' }); // blocked report untouched: not in the plan
    // The durable trace: each renamed report records what the pass did to it.
    expect(reports[0].relabel).toEqual({ h1: 'order_reference' });
    expect(reports[1].relabel).toEqual({ role_radiogroup_aria_che: 'order_status' });
    expect(reports[2].relabel).toBeUndefined();
  });
});

describe('applyRelabelToSkills', () => {
  const skill = (): Skill =>
    ({
      id: 's_aaa',
      origin: 'http://x',
      template: 'create {{v1}}',
      params: {
        v1: { example: 'S00021', usedIn: [1], binding: 'output:i1:h1' },
        v2: { example: 'other', usedIn: [2], binding: 'output:i9:kept' },
      },
      steps: [
        { tool: 'read', args: {}, locators: {}, label: 'h1' },
        { tool: 'loop', args: {}, locators: {}, body: [{ tool: 'read', args: {}, locators: {}, label: 'h1' }] },
      ],
      reportTemplate: { summary: 's', values: { h1: '{{v1}}', unit_price: '85.00' } },
      stats: { uses: 0 },
      status: 'candidate',
      provenance: { session: 's', instruction: 'x', created: 'now' },
    }) as unknown as Skill;

  it('renames labels (into loop bodies), reportTemplate keys, and matching bindings', () => {
    const sk = skill();
    const plan = new Map([[1, { h1: 'order_reference' }]]);
    const changed = applyRelabelToSkills([sk], plan, new Map([['s_aaa', 1]]));
    expect(changed).toEqual(['s_aaa']);
    expect(sk.steps[0].label).toBe('order_reference');
    expect(sk.steps[1].body?.[0].label).toBe('order_reference');
    expect(Object.keys(sk.reportTemplate!.values)).toEqual(['order_reference', 'unit_price']);
    expect(sk.params.v1.binding).toBe('output:i1:order_reference');
    expect(sk.params.v2.binding).toBe('output:i9:kept'); // different instruction: untouched
  });

  it('bindings are checked against the whole plan, not only the skill\'s own instruction', () => {
    const sk = skill();
    // The skill belongs to no instruction in the plan, but its param binds to i1's output.
    const plan = new Map([[1, { h1: 'order_reference' }]]);
    const changed = applyRelabelToSkills([sk], plan, new Map());
    expect(changed).toEqual(['s_aaa']);
    expect(sk.params.v1.binding).toBe('output:i1:order_reference');
    expect(sk.steps[0].label).toBe('h1'); // label untouched: not this skill's rename
  });
});

describe('persisting the renamed skill (the fwkb1 no-op-put bug)', () => {
  it('SkillStore.get returns a fresh disk read, so the persist must put the object applyRelabelToSkills MUTATED', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SkillStore } = await import('../src/skills/store.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-relabel-store-'));
    try {
      const store = new SkillStore(tmp);
      const sk = {
        id: 's_kb1', origin: 'http://x', template: 'open the board', params: {},
        preconditions: {}, steps: [{ tool: 'read', args: {}, locators: {}, label: 'table_tr_first_child_th' }],
        stats: { uses: 1 }, status: 'candidate', provenance: { session: 's', instruction: 'x', created: 'now' },
      } as unknown as Skill;
      store.put(sk);
      const plan = new Map([[1, { table_tr_first_child_th: 'column_2' }]]);
      const skills = [store.get('s_kb1')!];
      const changed = applyRelabelToSkills(skills, plan, new Map([['s_kb1', 1]]));
      expect(changed).toEqual(['s_kb1']);
      // The trap: get() re-reads from disk, so re-fetching here hands back the
      // PRISTINE skill and putting it discards the rename — which is exactly
      // what exportFlow did, and why fwkb1's flow said {{01-open.column_3}}
      // while its skill kept publishing table_tr_first_child_th.
      expect(store.get('s_kb1')!.steps[0].label).toBe('table_tr_first_child_th');
      // The fix: put the mutated object itself.
      store.put(skills[0]);
      expect(store.get('s_kb1')!.steps[0].label).toBe('column_2');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
