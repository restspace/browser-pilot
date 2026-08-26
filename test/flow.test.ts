import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordedEntry } from '../src/daemon/recorder.js';
import { buildFlow, recoveryRoute, resolveInstruction, resolveStepParams, softResolveInstruction, type FlowStep } from '../src/skills/flow.js';
import { bindSkill, synthesizeReport } from '../src/skills/learn.js';
import { compileSkill } from '../src/skills/compile.js';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-flow-'));
  process.env.BROWSER_PILOT_SKILLS_DIR = tmp;
});
afterAll(() => {
  delete process.env.BROWSER_PILOT_SKILLS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ORIGIN = 'http://127.0.0.1:4180';

/** A session recording: two instructions, each with a report entry, as the loop writes them. */
function recording(): RecordedEntry[] {
  return [
    { k: 'step', tool: 'goto', args: { url: `${ORIGIN}/` }, locators: {} },
    { k: 'instruction', text: "Sign in and create a ticket titled 'fr1 RD Bench Ticket'; report its ref id.", url: `${ORIGIN}/` },
    { k: 'step', tool: 'fill', args: { target: '@e1', value: 'fr1 RD Bench Ticket' }, locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'label', label: 'Title' }] } } },
    { k: 'report', status: 'success', summary: "Created ticket 'fr1 RD Bench Ticket', ref RD-1015.", values: { ref: 'RD-1015', title: 'fr1 RD Bench Ticket' }, skill: 's_create' },
    { k: 'instruction', text: "On ticket RD-1015, add a part named 'fr1 RD Part A' with cost 100 and markup 25; report the price.", url: `${ORIGIN}/#/tickets/t15` },
    { k: 'step', tool: 'fill', args: { target: '@e2', value: 'fr1 RD Part A' }, locators: { target: { expr: 'x', verified: true, raw: '@e2', chain: [{ kind: 'label', label: 'Name' }] } } },
    { k: 'report', status: 'success', summary: 'Added part; price 125.00.', values: { price: '125.00' }, skill: 's_addpart' },
  ];
}

describe('buildFlow', () => {
  it('turns declared vars and earlier outputs into references, and pins skills', () => {
    const flow = buildFlow(recording(), {
      name: 'ticketflow',
      origin: ORIGIN,
      startUrl: `${ORIGIN}/`,
      vars: { runid: 'fr1' },
      session: 's',
      now: '2026-08-23T00:00:00Z',
    });
    expect(flow).toBeTruthy();
    expect(flow!.vars).toEqual(['runid']);
    expect(flow!.steps).toHaveLength(2);
    const [s1, s2] = flow!.steps;
    // runid became {{runid}} everywhere
    expect(s1.instruction).toBe("Sign in and create a ticket titled '{{runid}} RD Bench Ticket'; report its ref id.");
    expect(s1.skill).toBe('s_create');
    expect(s1.outputs).toEqual(['ref', 'title']);
    // step 2 referenced RD-1015 (step 1's `ref` output) → becomes {{01-....ref}}, and runid → {{runid}}
    expect(s2.instruction).toMatch(/On ticket \{\{01-\w+\.ref\}\}, add a part named '\{\{runid\}\} RD Part A'/);
    expect(s2.skill).toBe('s_addpart');
  });

  it('captures each step skill param bindings, with references, via the bind callback', () => {
    // bind() returns the slot values the skill would have been given at record time.
    const bind = (id: string, instr: string): Record<string, string> | null => {
      if (id === 's_create') return { v1: /titled '([^']+)'/.exec(instr)![1] };
      if (id === 's_addpart') {
        const m = /named '([^']+)' with cost (\d+) and markup (\d+)/.exec(instr)!;
        return { v1: m[1], v2: m[2], v3: m[3] };
      }
      return null;
    };
    const flow = buildFlow(recording(), { name: 'f', origin: ORIGIN, startUrl: `${ORIGIN}/`, vars: { runid: 'fr1' }, session: 's', bind })!;
    // create: the title slot is the runid + a constant → the runid becomes a ref
    expect(flow.steps[0].params).toEqual({ v1: '{{runid}} RD Bench Ticket' });
    // add: name carries the runid ref; cost/markup are constants kept literal
    expect(flow.steps[1].params).toEqual({ v1: '{{runid}} RD Part A', v2: '100', v3: '25' });
  });

  it('drops instructions that did not end in success', () => {
    const entries = recording();
    (entries[3] as { status: string }).status = 'blocked';
    const flow = buildFlow(entries, { name: 'f', origin: ORIGIN, startUrl: `${ORIGIN}/`, vars: {}, session: 's' });
    expect(flow!.steps).toHaveLength(1);
    expect(flow!.steps[0].skill).toBe('s_addpart');
  });
});

describe('resolveInstruction', () => {
  const step: FlowStep = {
    id: '02-add',
    instruction: "On ticket {{01-create.ref}}, add '{{runid}} RD Part A' cost {{cost}}",
    outputs: [],
    recorded: {},
  };
  it('fills vars and prior outputs, and reports what is missing', () => {
    const r = resolveInstruction(step, { runid: 'z9', cost: '100' }, { '01-create': { ref: 'RD-1099' } });
    expect(r.text).toBe("On ticket RD-1099, add 'z9 RD Part A' cost 100");
    expect(r.missing).toEqual([]);
  });
  it('halts on an unresolved reference rather than substituting nothing', () => {
    const r = resolveInstruction(step, { runid: 'z9' }, {});
    expect(r.missing).toContain('01-create.ref');
    expect(r.missing).toContain('cost');
    expect(r.text).toContain('{{01-create.ref}}'); // left intact, not blanked
  });

  it('softResolveInstruction keeps what resolves and blanks unthreaded refs', () => {
    const st: FlowStep = { id: '02', instruction: "open the ticket with reference {{01.ref}} (title '{{runid}} Bench')", outputs: [], recorded: {} };
    // ref unthreaded, runid known → the id clause blanks, the title survives
    expect(softResolveInstruction(st, { runid: 'z9' }, {})).toBe("open the ticket with reference (title 'z9 Bench')");
    // both known → fully resolved
    expect(softResolveInstruction(st, { runid: 'z9' }, { '01': { ref: 'RD-9' } })).toBe("open the ticket with reference RD-9 (title 'z9 Bench')");
  });

  it('resolveStepParams fills stored bindings from vars and prior outputs', () => {
    const withParams: FlowStep = { ...step, params: { v1: '{{runid}} RD Part A', v2: '{{01-create.ref}}' } };
    const ok = resolveStepParams(withParams, { runid: 'z9' }, { '01-create': { ref: 'RD-1099' } });
    expect(ok).toEqual({ params: { v1: 'z9 RD Part A', v2: 'RD-1099' }, missing: [] });
    const bad = resolveStepParams(withParams, {}, {});
    expect(bad!.missing).toEqual(expect.arrayContaining(['runid', '01-create.ref']));
    expect(resolveStepParams(step, {}, {})).toBeNull(); // no stored params
  });
});

describe('bindSkill', () => {
  it('binds a pinned skill by reading its template as a pattern, any status', () => {
    const skill = compileSkill({
      entries: [
        { k: 'instruction', text: "add a part named 'x7 RD Part A' with cost 100 and markup 25", url: `${ORIGIN}/#/tickets/t15` },
        { k: 'step', tool: 'fill', args: { target: '@e1', value: 'x7 RD Part A' }, locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'label', label: 'Name' }] } } },
        { k: 'step', tool: 'fill', args: { target: '@e2', value: '100' }, locators: { target: { expr: 'x', verified: true, raw: '@e2', chain: [{ kind: 'label', label: 'Cost' }] } } },
        { k: 'step', tool: 'fill', args: { target: '@e3', value: '25' }, locators: { target: { expr: 'x', verified: true, raw: '@e3', chain: [{ kind: 'label', label: 'Markup' }] } } },
      ],
      instruction: "add a part named 'x7 RD Part A' with cost 100 and markup 25",
      report: { status: 'success', summary: 'ok', evidence: { values: {} } },
      session: 's',
    })!;
    expect(skill.status).toBe('provisional'); // bindSkill ignores status, unlike matchTemplate
    expect(bindSkill(skill, "add a part named 'q9 RD Part B' with cost 300 and markup 40")).toEqual({ v1: 'q9 RD Part B', v2: '300', v3: '40' });
    expect(bindSkill(skill, 'something completely different')).toBeNull();
  });
});

describe('synthesizeReport honesty', () => {
  const skill = compileSkill({
    entries: [
      { k: 'instruction', text: "add a part named 'x7 RD Part A' with cost 100", url: `${ORIGIN}/#/tickets/t15` },
      { k: 'step', tool: 'fill', args: { target: '@e1', value: 'x7 RD Part A' }, locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'label', label: 'Name' }] } } },
    ],
    instruction: "add a part named 'x7 RD Part A' with cost 100",
    report: { status: 'success', summary: "Added 'x7 RD Part A' to ticket RD-1017; price 125.00.", evidence: { values: { part: 'x7 RD Part A', ticket: 'RD-1017', price: '125.00' } } },
    session: 's',
  })!;

  it('keeps parameter-derived and live values, drops stale recorded literals', () => {
    // no live reads: only the parameter-derived `part` survives; ticket/price were recorded literals → dropped
    const r = synthesizeReport(skill, { v1: 'q9 RD Part B' }, {});
    expect(r.evidence!.values).toEqual({ part: 'q9 RD Part B' });
    expect(r.summary).not.toContain('RD-1017');
    expect(r.summary).not.toContain('125.00');
    expect(r.details).toMatch(/omitted/);
  });

  it('a live read-back overrides and is reported verbatim', () => {
    const r = synthesizeReport(skill, { v1: 'q9 RD Part B' }, { price: '375.00', ticket: 'RD-1099' });
    expect(r.evidence!.values).toMatchObject({ part: 'q9 RD Part B', price: '375.00', ticket: 'RD-1099' });
  });
});

describe('flow url outputs (mechanism 1 at the flow level)', () => {
  function mintingSession(): RecordedEntry[] {
    return [
      { k: 'instruction', text: "Create a dashboard titled 'fr1 Bench Dashboard' and save it.", url: `${ORIGIN}/dashboards` },
      {
        k: 'step', tool: 'click', args: { target: '@e1' },
        locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'role', role: 'button', name: 'Save' }] } },
        diff: { url: `${ORIGIN}/d/afw6yy5xx9/fr1-bench-dashboard`, alerts: [], added: [] },
      },
      { k: 'report', status: 'success', summary: 'Saved.', values: {}, skill: 's_create' },
      { k: 'instruction', text: 'Open the dashboard at /d/afw6yy5xx9 and set its refresh to 1m.', url: `${ORIGIN}/d/afw6yy5xx9/fr1-bench-dashboard` },
      { k: 'report', status: 'success', summary: 'Done.', values: {}, skill: 's_refresh' },
    ];
  }
  it('minted end-url segments become outputs a later instruction references', () => {
    const flow = buildFlow(mintingSession(), { name: 'g', origin: ORIGIN, startUrl: `${ORIGIN}/dashboards`, vars: { runid: 'fr1' }, session: 's' })!;
    const [s1, s2] = flow.steps;
    // the uid the run minted is now a reference to step 1's end url, never a literal
    expect(s2.instruction).toContain(`{{${s1.id}.url.p1}}`);
    expect(s2.instruction).not.toContain('afw6yy5xx9');
    // digitless route words stay literal
    expect(s1.instruction).not.toContain('{{0');
  });
  it('resolveInstruction threads url.* outputs (refs split at the FIRST dot)', () => {
    const flowStep: FlowStep = { id: '02-open', instruction: 'Open /d/{{01-create.url.p1}} now', outputs: [], recorded: {} };
    const { text, missing } = resolveInstruction(flowStep, {}, { '01-create': { 'url.p1': 'zzz91' } });
    expect(missing).toEqual([]);
    expect(text).toBe('Open /d/zzz91 now');
    const soft = softResolveInstruction(flowStep, {}, {});
    expect(soft).toBe('Open /d/ now');
  });
  it('resolveStepParams threads url.* outputs too', () => {
    const flowStep: FlowStep = { id: '02-open', instruction: 'x', params: { v1: '{{01-create.url.p1}}' }, outputs: [], recorded: {} };
    const bound = resolveStepParams(flowStep, {}, { '01-create': { 'url.p1': 'zzz91' } })!;
    expect(bound.missing).toEqual([]);
    expect(bound.params).toEqual({ v1: 'zzz91' });
  });
});

describe('url-provenance refs beat report-value refs (fwgr-n2 regression)', () => {
  it('a report value that duplicates a minted url part is referencized as the url part', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: "Create a dashboard titled 'fr1 Bench Dashboard'; report its uid.", url: `${ORIGIN}/dashboards` },
      {
        k: 'step', tool: 'click', args: { target: '@e1' },
        locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [] } },
        diff: { url: `${ORIGIN}/d/dfw8c6t9/fr1-bench-dashboard`, alerts: [], added: [] },
      },
      // The report ALSO carries the uid — the ref must still point at the url
      // part, because a tier-A replay's synthesized report drops values it
      // cannot re-observe while url parts are always published.
      { k: 'report', status: 'success', summary: 'Created.', values: { dashboard_uid: 'dfw8c6t9' }, skill: 's_create' },
      { k: 'instruction', text: 'Open the dashboard with uid dfw8c6t9 and set refresh to 1m.', url: `${ORIGIN}/d/dfw8c6t9/fr1-bench-dashboard` },
      { k: 'report', status: 'success', summary: 'Done.', values: {}, skill: 's_open' },
    ];
    const flow = buildFlow(entries, { name: 'g', origin: ORIGIN, startUrl: `${ORIGIN}/dashboards`, vars: { runid: 'fr1' }, session: 's' })!;
    const [s1, s2] = flow.steps;
    expect(s2.instruction).toContain(`{{${s1.id}.url.p1}}`);
    expect(s2.instruction).not.toContain('dashboard_uid');
    expect(s2.instruction).not.toContain('dfw8c6t9');
  });
});

describe('digitless minted ids (fwgr2 regression)', () => {
  it('a digitless uid is still referencized at the flow level', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: 'Create a dashboard and save it.', url: `${ORIGIN}/dashboards` },
      {
        k: 'step', tool: 'click', args: { target: '@e1' },
        locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [] } },
        diff: { url: `${ORIGIN}/d/cfwcsdxqdjabkf/fr1-bench`, alerts: [], added: [] },
      },
      { k: 'report', status: 'success', summary: 'Saved.', values: {}, skill: 's_create' },
      { k: 'instruction', text: 'Open http://127.0.0.1:4180/d/cfwcsdxqdjabkf/fr1-bench fresh and verify.', url: `${ORIGIN}/d/cfwcsdxqdjabkf/fr1-bench` },
      { k: 'report', status: 'success', summary: 'Done.', values: {}, skill: 's_open' },
    ];
    const flow = buildFlow(entries, { name: 'h', origin: ORIGIN, startUrl: `${ORIGIN}/dashboards`, vars: { runid: 'fr1' }, session: 's' })!;
    expect(flow.steps[1].instruction).toContain(`{{${flow.steps[0].id}.url.p1}}`);
    expect(flow.steps[1].instruction).not.toContain('cfwcsdxqdjabkf');
  });
});

describe('recoveryRoute', () => {
  it('routes a step with no pinned skill to the cheap model first', () => {
    expect(recoveryRoute({}, false)).toEqual({ easy: true, cause: 'no-skill' });
  });

  it('routes an unthreaded reference to the cheap model first even with a skill', () => {
    expect(recoveryRoute({ skill: 's_abc' }, true)).toEqual({ easy: true, cause: 'unthreaded-ref' });
  });

  it('routes a genuine replay failure straight to the strong model', () => {
    expect(recoveryRoute({ skill: 's_abc' }, false)).toEqual({ easy: false, cause: 'replay-failed' });
  });
});
