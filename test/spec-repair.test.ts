import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillStore } from '../src/skills/store.js';
import type { SpecFlow, SpecSegment, SpecStep } from '../src/spec/ir.js';
import { flowToSpec } from '../src/spec/ir.js';
import {
  describeSpecChanges,
  diffSpecChanges,
  foldPatchedVariants,
  foldTicketEvidence,
  orderByEvidence,
  reloadStaged,
  reorderByEvidence,
  stageRepair,
  ticketIsNews,
} from '../src/spec/repair.js';
import { candidateExpr, type LocatorCandidate } from '../src/daemon/recorder.js';
import type { DriftTicket } from '../src/skills/repair.js';

// The repair summary is a pure function of two IRs, so every interesting case
// — a fallback promoted, a model-proposed locator, a re-pin to a variant, an
// expectation dropped — is reachable by hand-building the before/after specs.
// The live loop (daemon run, drift drain, converge gate) is a manual demo
// against the bench app; what is unit-tested here is everything that does not
// need a browser.

function chain(...exprs: Array<Record<string, unknown>>) {
  return exprs as never;
}

function segment(id: string, extra: Partial<SpecSegment> = {}): SpecSegment {
  return {
    id,
    template: 'add a part named {{v1}}',
    params: { v1: { example: 'Part A', usedIn: [1] } },
    preconditions: { urlPattern: 'http://127.0.0.1:4180/#/tickets/:id' },
    steps: [
      {
        tool: 'click',
        args: { target: 'Add part' },
        expect: { addedContains: ['Part A'] },
        locators: {
          target: chain(
            { kind: 'testid', attr: 'data-testid', value: 'add-part' },
            { kind: 'role', role: 'button', name: 'Add part' },
            { kind: 'css', selector: '#view > section > header > button' },
          ),
        },
      },
      {
        tool: 'fill',
        args: { target: 'Part name', value: '{{v1}}' },
        locators: { target: chain({ kind: 'testid', attr: 'data-testid', value: 'field-name' }, { kind: 'label', label: 'Part name *' }) },
      },
    ],
    ...extra,
  };
}

function specOf(segments: SpecSegment[], stepExtra: Partial<SpecStep> = {}): SpecFlow {
  return {
    version: 1,
    name: 'demo',
    origin: 'http://127.0.0.1:4180',
    startUrl: 'http://127.0.0.1:4180/',
    vars: ['runid'],
    steps: [{ id: '02-add', instruction: 'add a part', params: { v1: '{{runid}} Part A' }, outputs: ['part_price'], segments, ...stepExtra }],
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('describeSpecChanges', () => {
  it('says "no change" for an untouched step', () => {
    const before = specOf([segment('s_1')]);
    expect(describeSpecChanges(before, clone(before))).toEqual(['02-add: no change']);
  });

  it('names a promoted fallback with the chain position it came from', () => {
    const before = specOf([segment('s_1')]);
    const after = clone(before);
    const c = after.steps[0].segments[0].steps[0].locators.target;
    c.unshift(c.splice(1, 1)[0]); // promoteFallback's own move: fallback #1 to primary
    const lines = describeSpecChanges(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('02-add: candidate promoted:');
    expect(lines[0]).toContain("page.getByRole('button', { name: 'Add part', exact: true })");
    expect(lines[0]).toContain('now primary (was #1)');
    expect(lines[0]).toContain('s_1 step 1 target');
  });

  it('reports a locator that was never in the chain as model-proposed', () => {
    const before = specOf([segment('s_1')]);
    const after = clone(before);
    after.steps[0].segments[0].steps[0].locators.target.unshift({ kind: 'testid', attr: 'data-testid', value: 'part-attach' } as never);
    const lines = describeSpecChanges(before, after);
    expect(lines[0]).toContain("new locator: page.getByTestId('part-attach') (model-proposed)");
  });

  it('reports a re-pin to a variant, and attributes the new locator to it', () => {
    const before = specOf([segment('s_1')]);
    const after = specOf([segment('s_1~repair')]);
    after.steps[0].segments[0].steps[0].locators.target.unshift({ kind: 'testid', attr: 'data-testid', value: 'part-attach' } as never);
    const lines = describeSpecChanges(before, after);
    expect(lines[0]).toBe('02-add: step re-pinned to variant s_1~repair (was s_1)');
    expect(lines[1]).toContain('(model-proposed variant s_1~repair)');
  });

  it('walks loop bodies, so a chain that drifted inside a loop is still named', () => {
    const looped = segment('s_1', {
      steps: [
        {
          tool: 'loop',
          args: {},
          locators: {},
          while: chain({ kind: 'css', selector: '.part-row' }),
          max: 20,
          body: [
            {
              tool: 'click',
              args: { target: 'Delete' },
              locators: { target: chain({ kind: 'testid', attr: 'data-testid', value: 'part-delete' }, { kind: 'role', role: 'button', name: 'Delete' }) },
            },
          ],
        },
      ],
    });
    const before = specOf([looped]);
    const after = clone(before);
    const c = after.steps[0].segments[0].steps[0].body![0].locators.target;
    c.unshift(c.splice(1, 1)[0]);
    const lines = describeSpecChanges(before, after);
    expect(lines[0]).toContain('s_1 step 1.body.1 target');
    expect(lines[0]).toContain('now primary (was #1)');
  });

  it('flags a dropped expectation as a refusal, not a diff line', () => {
    const before = specOf([segment('s_1')]);
    const after = clone(before);
    delete after.steps[0].segments[0].steps[0].expect;
    const diff = diffSpecChanges(before, after);
    expect(diff.droppedExpectations).toHaveLength(1);
    expect(diff.droppedExpectations[0]).toContain('no longer asserts anything about the page it produced');
    expect(diff.lines[0]).toContain('EXPECTATION DROPPED');
  });

  it('flags a weakened, not merely changed, expectation', () => {
    const before = specOf([segment('s_1')]);
    const kept = clone(before);
    kept.steps[0].segments[0].steps[0].expect = { addedContains: ['Part A', 'Part B'] };
    expect(diffSpecChanges(before, kept).droppedExpectations).toEqual([]); // adding is fine
    const weakened = clone(before);
    weakened.steps[0].segments[0].steps[0].expect = { addedContains: [] };
    expect(diffSpecChanges(before, weakened).droppedExpectations[0]).toContain('page text "Part A"');
  });

  it('notices a step that lost or gained a segment rather than mis-aligning the rest', () => {
    const before = specOf([segment('s_1'), segment('s_2')]);
    const after = specOf([segment('s_1')]);
    expect(describeSpecChanges(before, after)[0]).toBe('02-add: procedure now has 1 segment(s) (was 2)');
  });

  it('reports steps that appeared or vanished between the two IRs', () => {
    const before = specOf([segment('s_1')]);
    const after = clone(before);
    after.steps.push({ id: '03-verify', instruction: 'check', params: {}, outputs: [], segments: [] });
    expect(describeSpecChanges(before, after)).toContain('03-verify: new step');
    expect(describeSpecChanges(after, before)).toContain('03-verify: step is gone from the repaired flow');
  });
});

describe('stageRepair / reloadStaged', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-repair-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('writes the lowered flow and its skills into an ISOLATED store, and nowhere else', () => {
    const spec = specOf([segment('s_1'), segment('s_2')]);
    const dir = tmp();
    const staged = stageRepair(spec, dir);
    expect(staged.skillsDir).toBe(path.join(dir, 'skills'));
    expect(fs.existsSync(staged.flowFile)).toBe(true);
    // The store the run will mutate is the staged one — a fresh SkillStore
    // opened on that dir sees exactly the spec's segments and nothing else.
    const store = new SkillStore(staged.skillsDir);
    expect(store.list(spec.origin).map((s) => s.id).sort()).toEqual(['s_1', 's_2']);
    expect(store.origins()).toEqual([spec.origin]);
    const flow = JSON.parse(fs.readFileSync(staged.flowFile, 'utf8'));
    expect(flow.name).toBe('demo');
    expect(flow.steps[0].skill).toBe('s_1'); // the chain starts at segment 0
  });

  it('round-trips: reloading an untouched staged workspace reproduces the spec', () => {
    const spec = specOf([segment('s_1'), segment('s_2')]);
    const staged = stageRepair(spec, tmp());
    const { spec: back, warnings } = reloadStaged(staged);
    expect(warnings).toEqual([]);
    expect(back).toEqual(spec);
    expect(describeSpecChanges(spec, back)).toEqual(['02-add: no change']);
  });

  it('sees a promotion made in the staged store, exactly as the repair pass would', () => {
    const spec = specOf([segment('s_1')]);
    const staged = stageRepair(spec, tmp());
    // What promoteFallback does to the store, done by hand: the run proved the
    // role fallback resolves, so it becomes the primary.
    const store = new SkillStore(staged.skillsDir);
    const skill = store.get('s_1')!;
    const c = skill.steps[0].locators.target;
    c.unshift(c.splice(1, 1)[0]);
    store.put(skill);
    const after = reloadStaged(staged).spec;
    const lines = describeSpecChanges(spec, after);
    expect(lines[0]).toContain("candidate promoted: page.getByRole('button', { name: 'Add part', exact: true }) now primary (was #1)");
  });

  it('sees a re-pin the run wrote back into the staged flow file', () => {
    const spec = specOf([segment('s_1')]);
    const staged = stageRepair(spec, tmp());
    const store = new SkillStore(staged.skillsDir);
    const variant = JSON.parse(JSON.stringify(store.get('s_1')!));
    variant.id = 's_1~repair';
    variant.status = 'validated';
    variant.variantOf = 's_1';
    variant.steps[0].locators.target.unshift({ kind: 'testid', attr: 'data-testid', value: 'part-attach' });
    store.put(variant);
    // runFlow's own write-back: the flow file's step now points at the variant.
    const flow = JSON.parse(fs.readFileSync(staged.flowFile, 'utf8'));
    flow.steps[0].skill = 's_1~repair';
    fs.writeFileSync(staged.flowFile, JSON.stringify(flow, null, 2));

    const after = reloadStaged(staged).spec;
    const lines = describeSpecChanges(spec, after);
    expect(lines[0]).toBe('02-add: step re-pinned to variant s_1~repair (was s_1)');
    expect(lines[1]).toContain("new locator: page.getByTestId('part-attach') (model-proposed variant s_1~repair)");
  });

  it('carries a store the emitted IR can be rebuilt from without the original spec object', () => {
    const spec = specOf([segment('s_1')]);
    const staged = stageRepair(spec, tmp());
    const flow = JSON.parse(fs.readFileSync(staged.flowFile, 'utf8'));
    const { spec: rebuilt } = flowToSpec(flow, new SkillStore(staged.skillsDir));
    expect(rebuilt).toEqual(spec);
  });
});

// The `repair` command itself drives a browser, so what can be checked without
// one is its wiring: the same source-level approach test/spec-cli.test.ts takes
// (importing src/cli.ts would run main()).
describe('cli: repair command wiring', () => {
  const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf8');

  it('documents the command in USAGE', () => {
    expect(cliSource).toMatch(/sitelooper repair <name\.flow\.ts> \[--var k=v \.\.\.\] \[--out <file>\] \[--converge <n>\]/);
  });

  it('takes --converge as a value flag', () => {
    const valueFlags = cliSource.match(/const valueFlags = new Set\(\[([\s\S]*?)\]\);/);
    expect(valueFlags![1]).toMatch(/'converge'/);
  });

  it('dispatches "repair" before any session is spawned, like compile', () => {
    const dispatch = cliSource.indexOf("if (command === 'repair')");
    const spawnPoint = cliSource.indexOf('const conn = await connectOrSpawn(session, {');
    expect(dispatch).toBeGreaterThan(0);
    expect(dispatch).toBeLessThan(spawnPoint);
  });

  it('refuses a hand-edited file with the contracted message and exit 2', () => {
    expect(cliSource).toMatch(
      /this file was edited by hand or is not a sitelooper flow file; refusing to repair[\s\S]{0,40}, 2\)/,
    );
  });

  it('points the run at the staged store, never the user store', () => {
    expect(cliSource).toMatch(/process\.env\.SITELOOPER_SKILLS_DIR = staged\.skillsDir;/);
  });

  it('exits 3 without writing when the converge gate fails', () => {
    expect(cliSource).toMatch(/not converged: \$\{bad\.join\(', '\)\}/);
    expect(cliSource).toMatch(/console\.error\(`not converged[\s\S]{0,80}process\.exit\(3\)/);
  });

  it('never writes the .spec.ts — only the owned .flow.ts', () => {
    const body = cliSource.slice(cliSource.indexOf('async function repairFlowCommand'));
    expect(body).not.toMatch(/emitSpecFile|\.spec\.ts'/);
    expect(body).toMatch(/fs\.writeFileSync\(outFile, emitted\.source\)/);
  });
});

describe('mintVars', () => {
  it('replaces every {n} in a var value with the run number and leaves other values alone', async () => {
    const { mintVars } = await import('../src/spec/repair.js');
    expect(mintVars({ runid: 'fix-{n}', other: 'x' }, 0)).toEqual({ runid: 'fix-0', other: 'x' });
    expect(mintVars({ runid: '{n}-{n}' }, 3)).toEqual({ runid: '3-3' });
  });
});

// The in-session drain: `repair` asks the DAEMON to drain, on the same
// connection, before the session stops — a cold browser gets the login page
// for every authenticated url and cannot reach a run-minted one at all. Source
// level, like the tests above: importing src/cli.ts runs main().
describe('in-session drain wiring', () => {
  const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf8');
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../src/daemon/server.ts'), 'utf8');
  const protocolSource = fs.readFileSync(path.resolve(__dirname, '../src/shared/protocol.ts'), 'utf8');
  const skillsRepair = fs.readFileSync(path.resolve(__dirname, '../src/skills/repair.js'.replace('.js', '.ts')), 'utf8');

  it('"patch" is a protocol command and a daemon case', () => {
    expect(protocolSource).toMatch(/\|\s*'patch'/);
    expect(serverSource).toMatch(/case 'patch': \{/);
  });

  it('the daemon drains on ITS store and ITS live page', () => {
    const body = serverSource.slice(serverSource.indexOf("case 'patch': {"), serverSource.indexOf("case 'stop': {"));
    expect(body).toMatch(/const store = this\.browser\.learn;/);
    expect(body).toMatch(/const page = await this\.browser\.getPage\(\);/);
    expect(body).toMatch(/propose: llmProposer\(provider\)/);
    expect(body).toMatch(/this\.recoveryProvider\(model\)/); // --model M reaches the proposer
  });

  it('the run writes the concrete url onto every ticket it files', () => {
    expect(serverSource).toMatch(/const pageUrl = sk\.replayUrl;/);
    expect(serverSource).toMatch(/\.\.\.\(pageUrl \? \{ pageUrl \} : \{\}\)/);
  });

  it('the drain helpers live in skills/repair.ts, shared by all three callers', () => {
    expect(skillsRepair).toMatch(/export async function drainDrift/);
    expect(skillsRepair).toMatch(/export function llmProposer/);
    expect(skillsRepair).toMatch(/export function repairPageUrl/);
    expect(cliSource).toMatch(/import \{ drainDrift, llmProposer, triage, type DrainSummary, type DriftTicket \} from '\.\/skills\/repair\.js';/);
    // ...and no longer in cli.ts.
    expect(cliSource).not.toMatch(/^async function drainDrift/m);
    expect(cliSource).not.toMatch(/^function llmProposer/m);
  });

  it('repair patches on the SAME connection, before the session is stopped', () => {
    const body = cliSource.slice(cliSource.indexOf('async function runStagedFlow'), cliSource.indexOf('function notConverged'));
    const runAt = body.indexOf("request(conn, 'run'");
    const patchAt = body.indexOf("'patch',");
    const stopAt = body.indexOf('stopSessionQuietly(session)');
    expect(runAt).toBeGreaterThan(0);
    expect(patchAt).toBeGreaterThan(runAt);
    expect(stopAt).toBeGreaterThan(patchAt);
  });

  it('passes --dry-run and --model through to the drain', () => {
    expect(cliSource).toMatch(/drain: \{ dryRun, model: flags\.get\('model'\) \? String\(flags\.get\('model'\)\) : undefined \}/);
    expect(cliSource).toMatch(/dryRun: opts\.drain\.dryRun, model: opts\.drain\.model/);
  });

  it('the standalone --drift path says it is the cold one', () => {
    expect(cliSource).toMatch(/in a COLD browser/);
    expect(cliSource).toMatch(/Prefer "sitelooper repair"/);
  });
});

describe('expectation loss on a repair variant', () => {
  it('is reported for review, not refused — patchSegment drops it by construction', () => {
    const before = specOf([segment('s_1')]);
    // A variant: new id, model-proposed locator first, and the recorded
    // page-change expectation gone (it named the control that moved).
    const after = specOf([segment('s_1~repair')]);
    after.steps[0].segments[0].steps[0].locators.target.unshift({ kind: 'testid', attr: 'data-testid', value: 'part-attach' } as never);
    delete after.steps[0].segments[0].steps[0].expect;
    const diff = diffSpecChanges(before, after);
    expect(diff.droppedExpectations).toEqual([]);
    expect(diff.weakenedByVariant).toHaveLength(1);
    expect(diff.lines.some((l) => l.includes('REVIEW — the repair variant no longer asserts'))).toBe(true);
  });

  it('but the same loss with no variant behind it stays a refusal', () => {
    const before = specOf([segment('s_1')]);
    const after = clone(before);
    delete after.steps[0].segments[0].steps[0].expect;
    const diff = diffSpecChanges(before, after);
    expect(diff.weakenedByVariant).toEqual([]);
    expect(diff.droppedExpectations).toHaveLength(1);
  });
});

describe('foldPatchedVariants', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-fold-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A staged workspace whose skill has been patched: variant stored beside the original. */
  const staged = () => {
    const spec = specOf([segment('s_1')]);
    const st = stageRepair(spec, tmp());
    const store = new SkillStore(st.skillsDir);
    const variant = JSON.parse(JSON.stringify(store.get('s_1')!));
    variant.id = 's_1~repair';
    variant.variantOf = 's_1';
    variant.status = 'provisional';
    delete variant.steps[0].expect; // patchSegment drops it
    variant.steps[0].locators.target.unshift({ kind: 'testid', attr: 'data-testid', value: 'part-attach' });
    store.put(variant);
    return { spec, st, store };
  };

  it('puts the proposal first in the REAL chain and drops the variant', () => {
    const { spec, st, store } = staged();
    const lines = foldPatchedVariants(store, [{ skill: 's_1', step: '1', key: 'target', variant: 's_1~repair' }]);
    expect(lines[0]).toContain("page.getByTestId('part-attach') folded in as primary");
    expect(store.get('s_1~repair')).toBeNull();
    const after = reloadStaged(st).spec;
    // One segment, not two: the whole point — a mid-chain variant used to
    // compile as an extra segment beside the drifted one.
    expect(after.steps[0].segments).toHaveLength(1);
    const chain = after.steps[0].segments[0].steps[0].locators.target;
    expect(chain.map((c) => (c as { kind: string }).kind)).toEqual(['testid', 'testid', 'role', 'css']);
    expect((chain[0] as { value: string }).value).toBe('part-attach');
    expect(describeSpecChanges(spec, after)[0]).toContain("new locator: page.getByTestId('part-attach') (model-proposed)");
  });

  it('keeps the dead candidate in the chain, and the step expectation intact', () => {
    const { spec, st, store } = staged();
    foldPatchedVariants(store, [{ skill: 's_1', step: '1', key: 'target', variant: 's_1~repair' }]);
    const after = reloadStaged(st).spec;
    expect(after.steps[0].segments[0].steps[0].expect).toEqual(spec.steps[0].segments[0].steps[0].expect);
    expect(diffSpecChanges(spec, after).droppedExpectations).toEqual([]);
    expect(diffSpecChanges(spec, after).weakenedByVariant).toEqual([]);
  });

  it('is idempotent and says so when the ticket no longer maps', () => {
    const { st, store } = staged();
    const rows = [{ skill: 's_1', step: '1', key: 'target', variant: 's_1~repair' }];
    foldPatchedVariants(store, rows);
    expect(foldPatchedVariants(store, rows)[0]).toContain('could not fold');
    expect(reloadStaged(st).spec.steps[0].segments[0].steps[0].locators.target).toHaveLength(4);
  });
});

// The evidence codemod is the one repair action PLAN-self-updating-spec.md
// calls "cheap, no model": reorder / retire from sidecar evidence, never a
// guess. Every rule it has is stated here directly, because the live proof
// (fwrd42's 06-report, which filed the same ticket on every run until the
// chronically-missing candidate was retired) costs a browser and ten minutes.
describe('orderByEvidence', () => {
  const c = (over: Record<string, unknown>) => ({ kind: 'role', role: 'button', name: 'x', ...over }) as never as LocatorCandidate;
  const scoped = (over: Record<string, unknown> = {}) => c({ kind: 'scoped', container: 'tr', hasText: 'A', selector: 'button', ...over });
  const css = (selector: string, over: Record<string, unknown> = {}) => c({ kind: 'css', selector, ...over });
  const names = (list: LocatorCandidate[]) => list.map((x) => candidateExpr(x));

  it('leaves a chain with no evidence exactly as recorded', () => {
    const chain = [scoped(), c({ name: 'Delete' }), css('tr:nth-of-type(1) button')];
    expect(orderByEvidence(chain)).toEqual(chain);
  });

  it('sorts a demonstrated-volatile candidate last: never hit, missed twice', () => {
    const dead = c({ name: 'Delete', seen: { hit: 0, miss: 2 } });
    const chain = [dead, c({ name: 'Remove' }), css('td button')];
    expect(names(orderByEvidence(chain))).toEqual([
      "page.getByRole('button', { name: 'Remove', exact: true })",
      "page.locator('td button')",
      "page.getByRole('button', { name: 'Delete', exact: true })",
    ]);
  });

  it('keeps a candidate that missed ONCE where it was — one miss is a transient', () => {
    const chain = [c({ name: 'Delete', seen: { hit: 0, miss: 1 } }), c({ name: 'Remove' })];
    expect(orderByEvidence(chain)).toEqual(chain);
  });

  it('puts a candidate that has resolved ahead of one that has only missed', () => {
    const chain = [c({ name: 'Delete', seen: { hit: 0, miss: 2 } }), c({ name: 'Remove', seen: { hit: 3, miss: 0 } })];
    expect(names(orderByEvidence(chain))[0]).toBe("page.getByRole('button', { name: 'Remove', exact: true })");
  });

  it('breaks an evidence tie by specOf class, then by recorded order', () => {
    // All three carry the same verdict, so nothing may move: identity first,
    // handle next, path last is both specOf's order and the recorded one.
    const chain = [scoped(), c({ name: 'Delete' }), css('div > button')];
    expect(orderByEvidence(chain)).toEqual(chain);
    // Same verdict, recorded the other way round: the class order decides.
    const shuffled = [css('div > button'), c({ name: 'Delete' }), scoped()];
    expect(names(orderByEvidence(shuffled))).toEqual([
      "page.locator('tr', { hasText: 'A' }).locator('button')",
      "page.getByRole('button', { name: 'Delete', exact: true })",
      "page.locator('div > button')",
    ]);
  });

  it('never floats a structural path over an identity/handle candidate that has hits', () => {
    // The structural path is the ONLY thing with a recorded hit, and it still
    // does not become primary: a css path names a position, not a control, and
    // promoting one on evidence is how a chain stops testing what it says it
    // tests (fwrd26l retired two identity anchors that way).
    const anchor = c({ name: 'Delete', seen: { hit: 2, miss: 0 } });
    const path = css('tr:nth-of-type(1) button', { seen: { hit: 5, miss: 0 } });
    expect(names(orderByEvidence([anchor, path]))[0]).toBe("page.getByRole('button', { name: 'Delete', exact: true })");
    expect(names(orderByEvidence([path, anchor]))[0]).toBe("page.getByRole('button', { name: 'Delete', exact: true })");
  });

  it('lets a structural path rise only when nothing non-structural has ever resolved', () => {
    const path = css('tr:nth-of-type(1) button', { seen: { hit: 1, miss: 0 } });
    const dead = c({ name: 'Delete', seen: { hit: 0, miss: 2 } });
    expect(names(orderByEvidence([dead, path]))[0]).toBe("page.locator('tr:nth-of-type(1) button')");
  });
});

describe('foldTicketEvidence / reorderByEvidence', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-evidence-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const ticket = (over: Partial<DriftTicket> = {}): DriftTicket => ({
    flow: 'demo',
    step: '02-add',
    skill: 's_1',
    atStep: '1',
    key: 'target',
    similarity: 1,
    missedLocator: "page.getByTestId('add-part')",
    fallbackUsed: null,
    recovered: false,
    ...over,
  });

  const staged = () => {
    const s = stageRepair(specOf([segment('s_1')]), tmp());
    return new SkillStore(s.skillsDir);
  };

  it('banks a miss for a DEAD chain — the case replay itself banks nothing for', () => {
    const store = staged();
    expect(foldTicketEvidence(store, [ticket()])).toBe(1);
    expect(store.get('s_1')!.steps[0].locators.target[0].seen).toEqual({ hit: 0, miss: 1 });
  });

  it('banks a miss when a STRUCTURAL fallback won: the win is not trusted, the miss still happened', () => {
    const store = staged();
    const t = ticket({ fallbackUsed: "page.locator('#view > section > header > button')", fallbackIndex: 2 });
    expect(foldTicketEvidence(store, [t])).toBe(1);
    expect(store.get('s_1')!.steps[0].locators.target[0].seen).toEqual({ hit: 0, miss: 1 });
  });

  it('never invents a hit — only ever a miss', () => {
    const store = staged();
    foldTicketEvidence(store, [ticket(), ticket(), ticket()]);
    const seen = store.get('s_1')!.steps[0].locators.target.map((c) => c.seen);
    expect(seen.every((s) => (s?.hit ?? 0) === 0)).toBe(true);
  });

  it('leaves a non-structural fallthrough alone — replay already banked that one', () => {
    const store = staged();
    const t = ticket({ fallbackUsed: "page.getByRole('button', { name: 'Add part', exact: true })", fallbackIndex: 1 });
    expect(foldTicketEvidence(store, [t])).toBe(0);
    expect(store.get('s_1')!.steps[0].locators.target[0].seen).toBeUndefined();
  });

  it('counts one miss per RUN, not one per loop iteration', () => {
    const store = staged();
    // A folded loop files the same ticket under 1.1.x, 1.2.x, ... — the same
    // bad locator seen once, not nine times.
    expect(foldTicketEvidence(store, [ticket(), ticket(), ticket()])).toBe(1);
    expect(store.get('s_1')!.steps[0].locators.target[0].seen).toEqual({ hit: 0, miss: 1 });
  });

  it('matches a ticket against a SLOTTED candidate, whose expression carries {{v1}}', () => {
    const store = staged();
    const skill = store.get('s_1')!;
    skill.steps[0].locators.target.unshift({ kind: 'text', text: '{{v1}}' } as never);
    store.put(skill);
    // The ticket recorded the expression with this run's parameter filled in.
    const n = foldTicketEvidence(store, [ticket({ missedLocator: "page.getByText('Part A', { exact: true })" })]);
    expect(n).toBe(1);
    expect(store.get('s_1')!.steps[0].locators.target[0].seen).toEqual({ hit: 0, miss: 1 });
  });

  it('retires a chronic candidate on its SECOND run and says so in the change list', () => {
    const store = staged();
    foldTicketEvidence(store, [ticket()]);
    expect(reorderByEvidence(store)).toEqual([]); // one miss is a transient
    foldTicketEvidence(store, [ticket()]);
    const lines = reorderByEvidence(store);
    // The chain also reordered: the retired testid is now behind the two that
    // still have no verdict against them.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "candidate retired: page.getByTestId('add-part') — missed 2 run(s), never hit; now last — s_1 step 1 target",
    );
    const chain = store.get('s_1')!.steps[0].locators.target;
    expect(candidateExpr(chain[chain.length - 1])).toBe("page.getByTestId('add-part')");
  });

  it('reports a retirement even when nothing can move — a chain of one', () => {
    // The fwrd42 case exactly: `wait_for` on one text candidate. Nothing to
    // reorder, and the retirement is the whole news, because from the next run
    // on that miss stops counting against the converge gate.
    const store = staged();
    const skill = store.get('s_1')!;
    skill.steps[0].locators.target = [{ kind: 'text', text: 'Part A' }] as never;
    store.put(skill);
    const t = ticket({ missedLocator: "page.getByText('Part A', { exact: true })" });
    foldTicketEvidence(store, [t]);
    foldTicketEvidence(store, [t]);
    expect(reorderByEvidence(store)).toEqual([
      "candidate retired: page.getByText('Part A', { exact: true }) — missed 2 run(s), never hit; now last — s_1 step 1 target",
    ]);
  });

  it('says each retirement once across a whole repair, not once per run', () => {
    const store = staged();
    const reported = new Set<string>();
    foldTicketEvidence(store, [ticket()]);
    foldTicketEvidence(store, [ticket()]);
    expect(reorderByEvidence(store, reported)).toHaveLength(1);
    // A third run re-observes the same miss; the change list has said it.
    foldTicketEvidence(store, [ticket()]);
    expect(reorderByEvidence(store, reported)).toEqual([]);
  });

  it('is idempotent: a second pass over an already-ordered store moves nothing', () => {
    const store = staged();
    foldTicketEvidence(store, [ticket()]);
    foldTicketEvidence(store, [ticket()]);
    const reported = new Set<string>();
    expect(reorderByEvidence(store, reported)).toHaveLength(1);
    const order = store.get('s_1')!.steps[0].locators.target.map((c) => candidateExpr(c));
    reorderByEvidence(store, reported);
    expect(store.get('s_1')!.steps[0].locators.target.map((c) => candidateExpr(c))).toEqual(order);
  });
});

describe('ticketIsNews (the converge gate rule)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const staged = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-gate-test-'));
    dirs.push(d);
    return new SkillStore(stageRepair(specOf([segment('s_1')]), d).skillsDir);
  };
  const ticket = (over: Partial<DriftTicket> = {}): DriftTicket => ({
    flow: 'demo', step: '02-add', skill: 's_1', atStep: '1', key: 'target',
    similarity: 1, missedLocator: "page.getByTestId('add-part')", fallbackUsed: null, recovered: false, ...over,
  });

  it('is not news for a step that was recorded without any locator', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitelooper-news-'));
    const store = new SkillStore(dir);
    store.put({
      id: 's_r', origin: 'http://app.test', template: 'verify', params: {},
      preconditions: { urlPattern: 'http://app.test/' },
      steps: [{ tool: 'read', args: { target: '(read-back)', what: 'text' }, locators: { target: [] } }],
      stats: { uses: 1, successes: 1, partial: 0, created: 'now', failedAtStep: {}, fallthroughs: 0 },
      status: 'validated', provenance: { session: 's', instruction: 'verify', created: 'now' },
    });
    expect(ticketIsNews(store, { flow: 'f', step: '07', skill: 's_r', atStep: '1', key: 'target', similarity: null, missedLocator: '(none recorded)', fallbackUsed: null, recovered: false })).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('counts a first miss: two runs is the cheapest evidence that is not one bad afternoon', () => {
    const store = staged();
    expect(ticketIsNews(store, ticket())).toBe(true);
    foldTicketEvidence(store, [ticket()]);
    expect(ticketIsNews(store, ticket())).toBe(true);
  });

  it('stops counting once the candidate is retired BY EVIDENCE — that is no longer drift', () => {
    const store = staged();
    foldTicketEvidence(store, [ticket()]);
    foldTicketEvidence(store, [ticket()]);
    reorderByEvidence(store);
    expect(ticketIsNews(store, ticket())).toBe(false);
  });

  it('still counts a miss on a candidate that has ever resolved', () => {
    const store = staged();
    const skill = store.get('s_1')!;
    skill.steps[0].locators.target[0].seen = { hit: 1, miss: 9 };
    store.put(skill);
    expect(ticketIsNews(store, ticket())).toBe(true);
  });

  it('counts a recovery with no locator to blame — very much news', () => {
    const store = staged();
    expect(ticketIsNews(store, ticket({ missedLocator: null, recovered: true, fellBack: 'no matching skill' }))).toBe(true);
  });

  it('counts a ticket it cannot map onto the store at all', () => {
    const store = staged();
    expect(ticketIsNews(store, ticket({ skill: 's_gone' }))).toBe(true);
    expect(ticketIsNews(store, ticket({ atStep: '99' }))).toBe(true);
  });
});

describe('cli: --reset-cmd and the evidence codemod wiring', () => {
  const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf8');

  it('takes --reset-cmd as a value flag, so the whole shell command survives parsing', () => {
    expect(cliSource).toMatch(/'converge',\s*\n\s*'reset-cmd',/);
  });

  it('documents it next to {n}, the other answer to run-to-run state', () => {
    expect(cliSource).toContain('--reset-cmd, which runs a shell command before run 1 and');
  });

  it('runs it through a shell and refuses to continue when it fails', () => {
    expect(cliSource).toMatch(/spawnSync\(cmd, \{ shell: true/);
    expect(cliSource).toContain('refusing to run against an app that was not reset');
  });

  it('resets before run 1 AND before every converge run', () => {
    expect(cliSource).toContain("runResetCmd(resetCmd, 'run 1', say)");
    expect(cliSource).toMatch(/for \(let i = 1; i <= converge; i\+\+\) \{\s*\n\s*runResetCmd\(resetCmd, `converge/);
  });

  it('folds ticket evidence and reorders after run 1 and after each converge run', () => {
    expect(cliSource.match(/foldTicketEvidence\(staged\.store/g)).toHaveLength(2);
    expect(cliSource.match(/reorderByEvidence\(staged\.store, retirementsReported\)/g)).toHaveLength(2);
  });

  it('carries ONE retirement set across the whole repair, so each is said once', () => {
    expect(cliSource).toContain('const retirementsReported = new Set<string>();');
  });

  it('prints the failing tickets, not just the step ids, when the gate does not hold', () => {
    expect(cliSource).toContain('for (const t of checkTickets) {');
  });

  it('gates the converge run on the store, so a retired candidate stops counting', () => {
    expect(cliSource).toContain('notConverged(check, dryRun ? undefined : staged.store)');
    expect(cliSource).toContain('if (store && !ticketIsNews(store, t)) continue;');
  });

  it('puts the tickets themselves in the --json report, not just how many', () => {
    expect(cliSource).toMatch(/\r?\n    tickets,\r?\n/);
  });
});
