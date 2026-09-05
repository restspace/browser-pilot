import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillStore } from '../src/skills/store.js';
import type { SpecFlow, SpecSegment, SpecStep } from '../src/spec/ir.js';
import { flowToSpec } from '../src/spec/ir.js';
import { describeSpecChanges, diffSpecChanges, foldPatchedVariants, reloadStaged, stageRepair } from '../src/spec/repair.js';

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
