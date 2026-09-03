import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstructionResult } from '../src/agent/loop.js';
import type { RecordedEntry, RecordedStep } from '../src/daemon/recorder.js';
import { lineShows, specOf } from '../src/skills/replay.js';
import { maskVolatile, stranded } from '../src/skills/compile.js';
import { volatileMatcher } from '../src/shared/text.js';
import { recordCandidateEvidence, retired } from '../src/skills/repair.js';
import { SkillStore } from '../src/skills/store.js';
import { coalesceControls, compileSkill, dropSupersededNavigation, compileSkills, discoverSlots, fillParams, fillParamsDeep, foldLoops, isIdLike, sameProcedure, softUrlMatch, stableFirst, substitute, substituteUrlParts, urlDiff, urlMatches, urlParts, urlPattern } from '../src/skills/compile.js';
import type { LocatorCandidate } from '../src/daemon/recorder.js';
import type { SkillStep } from '../src/skills/store.js';
import { bindSkill, canAdoptPin, learnFromInstruction, matchTemplate, publishedOutputs, selectCandidates, synthesizeReport } from '../src/skills/learn.js';
import { candidatesFor, renderCandidates } from '../src/skills/replay.js';
import { SkillStore, originOf, originSlug, type Skill } from '../src/skills/store.js';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-skills-'));
  process.env.SLEEP_WALKER_SKILLS_DIR = tmp;
});
afterAll(() => {
  delete process.env.SLEEP_WALKER_SKILLS_DIR;
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
describe('cross-instruction url record-id slotting (fwod29)', () => {
  it("slots a goto url's id= when an earlier instruction's url minted it, binding by origin", () => {
    // The armdoc forbids instructions naming database ids, so this value can
    // never anchor in prose. fwod29 compiled three skills with `...&id=21`
    // literal; every replay navigated to the recording run's deleted order.
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: 'Open the sales order S00021 and report its state.', url: `${ORIGIN}/web` } as RecordedEntry,
      step('goto', { url: `${ORIGIN}/web#cids=1&menu_id=181&action=315&model=sale.order&view_type=form&id=21` }, [], {
        diff: { url: `${ORIGIN}/web#cids=1&menu_id=181&action=315&model=sale.order&view_type=form&id=21`, alerts: [], added: ['- heading "S00021"'] },
      }),
      step('read', { target: '@e5', what: 'text' }, [{ kind: 'css', selector: 'h1' }], { result: '"S00021"' }),
    ];
    const [skill] = compileSkills({
      entries,
      instruction: 'Open the sales order S00021 and report its state.',
      report: { status: 'success', summary: 'opened', evidence: { values: { reference: 'S00021' } } },
      session: 's',
      knownValues: { 'var:runid': 'x7', 'url:i2:q.id': '21' },
    });
    expect(skill).toBeTruthy();
    const gotoStep = skill.steps.find((st) => st.tool === 'goto')!;
    const slotName = Object.entries(skill.params).find(([, p]) => p.binding === 'url:i2:q.id')?.[0];
    expect(slotName).toBeTruthy();
    expect(String(gotoStep.args.url)).toContain(`id={{${slotName}}}`);
    expect(String(gotoStep.args.url)).not.toContain('id=21');
    // Routing constants stay literal — they are the app's, not the run's.
    expect(String(gotoStep.args.url)).toContain('menu_id=181');
    expect(String(gotoStep.args.url)).toContain('action=315');
  });

  it('a coinciding non-id slot value never rewrites a url id=', () => {
    // A cost of "21" must not bind the navigation to the cost.
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: 'Set the cost to 21 on the open order.', url: `${ORIGIN}/web` } as RecordedEntry,
      step('fill', { target: '@e2', value: '21' }, [{ kind: 'label', label: 'Cost' }]),
      step('goto', { url: `${ORIGIN}/web#model=sale.order&id=21` }, [], {
        diff: { url: `${ORIGIN}/web#model=sale.order&id=21`, alerts: [], added: [] },
      }),
    ];
    const [skill] = compileSkills({
      entries,
      instruction: 'Set the cost to 21 on the open order.',
      report: { status: 'success', summary: 'set' },
      session: 's',
      knownValues: {},
    });
    expect(skill).toBeTruthy();
    const gotoStep = skill.steps.find((st) => st.tool === 'goto')!;
    expect(String(gotoStep.args.url)).toContain('id=21');
  });
});

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

describe('volatile expectations and whitespace identity (fwkb3, fwod31)', () => {
  it('masks clock and calendar tokens the recording happened to see, keeping the slot', () => {
    expect(maskVolatile('- textbox "09/03/2026 07:22": {{v3}}')).toBe('- textbox "{{*}} {{*}}": {{v3}}');
    expect(maskVolatile('- cell "2026-12-31"')).toBe('- cell "{{*}}"');
    expect(maskVolatile('- row "Su Mo Tu We Th Fr Sa"')).toBe('- row "Su Mo Tu We Th Fr Sa"');
    expect(maskVolatile('- link "RD-1015"')).toBe('- link "RD-1015"');
  });
  it('volatileMatcher leaves a plain name alone and wildcards clock/date tokens in a recorded one', () => {
    expect(volatileMatcher('Save dashboard')).toBe('Save dashboard');
    const m = volatileMatcher('Due date: 12/31/2026 07:40');
    expect(m).toBeInstanceOf(RegExp);
    expect((m as RegExp).test('Due date: 12/31/2026 07:55')).toBe(true);
    expect((m as RegExp).test('Due date: 01/02/2027 18:00')).toBe(true);
    expect((m as RegExp).test('Start date: 12/31/2026 07:40')).toBe(false);
    expect((m as RegExp).test('Due date: 12/31/2026 07:40 (overdue)')).toBe(false);
  });
  it('lineShows matches a wildcard line and ignores whitespace on both sides', () => {
    const live = ['- textbox "09/03/2026 07:31": 2026-12-31', '- link "Backlog"  ', '- heading "Bench   Board"'];
    expect(lineShows(live, ['- textbox "{{*}} {{*}}": 2026-12-31'])).toBe(true);
    expect(lineShows(live, ['- textbox "{{*}} {{*}}": 2026-12-30'])).toBe(false);
    expect(lineShows(live, ['Backlog '])).toBe(true);
    expect(lineShows(live, ['Bench Board'])).toBe(true);
    expect(lineShows(live, ['Ready'])).toBe(false);
    // a wildcard never spans lines
    expect(lineShows(['- a "x"', '- b "y"'], ['- a "{{*}}b "y"'])).toBe(false);
  });
  it('re-inlines a slot that survives only in an expectation: no orphan marker, no phantom param (fwgr23 05-open)', () => {
    // '125.00' is a run value the instruction only names inside '£125.00', so
    // its marker is swallowed in the template and it is typed nowhere; the
    // recording merely SAW it in a row. It must neither stay behind as an
    // unfillable {{vN}} in the expectation nor become a param bound by origin
    // that refuses the skill when that origin is not published.
    const text = "Add part 'x7 RD Part A' to ticket t15; the row should total £125.00.";
    const entries: RecordedEntry[] = [
      { k: 'instruction', text, url: `${ORIGIN}/#/tickets/t15`, fingerprint: [1, 0, 0] },
      step('fill', { target: '@e10', value: 'x7 RD Part A' }, [{ kind: 'label', label: 'Name' }]),
      step('click', { target: '@e13' }, [{ kind: 'role', role: 'button', name: 'Save' }], {
        diff: { url: `${ORIGIN}/#/tickets/t15`, alerts: [], added: ['- row "x7 RD Part A 125.00"'] },
      }),
    ];
    const s = compileSkill({ entries, instruction: text, report, session: 's', model: 'm', now: '2026-09-03T00:00:00Z', knownValues: { total: '£125.00', price: '125.00' } })!;
    expect(s).toBeTruthy();
    expect(Object.values(s.params).map((p) => p.example)).not.toContain('125.00');
    expect(s.steps[1].expect?.addedContains?.[0]).toMatch(/^- row "\{\{v\d+\}\} 125\.00"$/);
    const markers = new Set(Array.from(JSON.stringify(s.steps).matchAll(/\{\{(v\d+)\}\}/g), (m) => m[1]));
    for (const m of markers) expect(s.params).toHaveProperty(m);
  });
  it('labels a list read with the report value made from the whole list, not with one item (fwgr23 01-open)', () => {
    const text = 'Report the panel titles on the Service Health dashboard.';
    const entries: RecordedEntry[] = [
      { k: 'instruction', text, url: `${ORIGIN}/d/health`, fingerprint: [1, 0, 0] },
      step('click', { target: '@e3' }, [{ kind: 'role', role: 'link', name: 'Service Health' }], {
        diff: { url: `${ORIGIN}/d/health`, alerts: [], added: ['- heading "Request rate"'] },
      }),
      step('read_all', { target: 'h2', what: 'text' }, [{ kind: 'css', selector: 'h2' }], { result: '["Request rate","Error count","Latency by endpoint"]' }),
    ];
    const listReport = {
      status: 'success' as const,
      summary: 'Three panels.',
      evidence: { values: { first_title: 'Request rate', panel_titles: 'Request rate, Error count, Latency by endpoint' } },
    };
    const s = compileSkill({ entries, instruction: text, report: listReport, session: 's', model: 'm', now: '2026-09-03T00:00:00Z' })!;
    expect(s.steps[1].label).toBe('panel_titles');
  });
  it('a minted url part is rewritten in a navigation url at its own position only (fwod32 sign-in)', () => {
    const minted = [
      { name: 'd2', value: '135', at: 'q.action' },
      { name: 'd3', value: '120', at: 'q.menu_id' },
    ];
    expect(substituteUrlParts('http://127.0.0.1:8069/web#action=135&menu_id=120', minted)).toBe('http://127.0.0.1:8069/web#action={{d2}}&menu_id={{d3}}');
    // the same digits at another key or elsewhere are not touched
    expect(substituteUrlParts('http://127.0.0.1:8069/web?page=135#action=1350&id=135', minted)).toBe('http://127.0.0.1:8069/web?page=135#action=1350&id=135');
  });
  it('a state key the pattern only knows as a wildcard may be absent from the live url; a literal one may not', () => {
    expect(urlDiff('http://x/web#action=:id&cids=:id&menu_id=:id', 'http://x/web#action=9&menu_id=8')).toEqual([]);
    expect(urlDiff('http://x/web#action=:id&cids={{d1}}&menu_id=:id', 'http://x/web#action=9&menu_id=8')).toEqual([]);
    expect(urlDiff('http://x/web#action=:id&cids=1&menu_id=:id', 'http://x/web#action=9&menu_id=8')).toBeNull();
  });
  it('a number inside a dotted address or version is never a slot', () => {
    const slots = new Map([['d1', '1']]);
    // (a number after `=` is substituteUrlId's business, not substitute()'s)
    expect(substitute('http://127.0.0.1:8069/web#action=5&cids=1 page 1', slots)).toBe('http://127.0.0.1:8069/web#action=5&cids=1 page {{d1}}');
    expect(substitute('version 1.2.3, qty 1', slots)).toBe('version 1.2.3, qty {{d1}}');
    // a sentence-final number still substitutes
    expect(substitute('qty 1.', slots)).toBe('qty {{d1}}.');
  });
});

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
  it('reduces a query-shaped hash route, keys kept and order-independent', () => {
    // Odoo's shape: the fragment is the route AND volatile per-session state.
    expect(urlPattern('http://h:1/web#action=123&cids=1&menu_id=81')).toBe('http://h:1/web#action=:id&cids=:id&menu_id=:id');
    // Same page, different session ids and a different key order. Matching
    // consults the stored pattern's own :id markers (written once at compile
    // time), never a shape heuristic on the live value.
    expect(urlMatches(urlPattern('http://h:1/web#action=123&cids=1&menu_id=81'), 'http://h:1/web#menu_id=99&cids=2&action=456')).toBe(true);
    // Non-id values still distinguish one template from another.
    expect(urlPattern('http://h:1/web#action=315&model=sale.order&view_type=list')).toBe(
      'http://h:1/web#action=:id&model=sale.order&view_type=list',
    );
    expect(urlMatches('http://h:1/web#action=315&model=sale.order', 'http://h:1/web#action=9&model=res.partner')).toBe(false);
  });
  it('treats query-shaped hash state as a necessary, not exact, condition', () => {
    // State accumulates: recorded at "#cids=1", the page has grown an action
    // and a menu id by the time a later segment starts on it.
    expect(urlMatches('http://h:1/web#cids=1', 'http://h:1/web#action=133&cids=1&menu_id=91')).toBe(true);
    // Missing a required pair is still a mismatch...
    expect(urlMatches('http://h:1/web#model=sale.order', 'http://h:1/web#action=133&cids=2')).toBe(false);
    // ...as is a different path, however well the fragment lines up.
    expect(urlMatches('http://h:1/web#cids=1', 'http://h:1/other#action=1&cids=2')).toBe(false);
    // A path-shaped fragment is a route, so it keeps matching exactly.
    expect(urlMatches('http://h:1/#/tickets/:id', 'http://h:1/#/tickets/t9/edit')).toBe(false);
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

describe('slot-by-policy known values', () => {
  // The fwrd3 delete-both-parts shape: the run identifier repeats throughout
  // (act on part A, verify part A gone), so the heuristic single-occurrence
  // guard de-slots EVERYTHING and the skill bakes in the runid.
  const DELETE_INSTR =
    "On the ticket 'x7 RD Bench Ticket' (ref RD-1015), delete BOTH parts ('x7 RD Part A' and 'x7 RD Part B'), then verify 'x7 RD Part A' and 'x7 RD Part B' are gone and 'x7 RD Bench Ticket' is archived.";
  const deleteSteps = (): RecordedStep[] => [
    step('click', { target: '@e1' }, [{ kind: 'role', role: 'link', name: 'x7 RD Bench Ticket' }]),
    step('click', { target: '@e2' }, [{ kind: 'role', role: 'button', name: 'Delete x7 RD Part A' }]),
    step('click', { target: '@e3' }, [{ kind: 'role', role: 'button', name: 'Delete x7 RD Part B' }]),
  ];

  it('without known values the repeated identifiers stay literal (heuristic guard intact)', () => {
    expect([...discoverSlots(DELETE_INSTR, deleteSteps()).values()]).not.toContain('x7');
  });

  it('a declared run value is slotted at every occurrence despite repetition', () => {
    const slots = discoverSlots(DELETE_INSTR, deleteSteps(), { runid: 'x7' });
    const name = [...slots.entries()].find(([, v]) => v === 'x7')?.[0];
    expect(name).toBeTruthy();
    const template = substitute(DELETE_INSTR, slots);
    expect(template).not.toContain('x7');
    expect((template.match(new RegExp(`\\{\\{${name}\\}\\}`, 'g')) ?? []).length).toBe(6);
  });

  it('the admin/admin guard still holds for values that are NOT declared', () => {
    const instr = 'sign in with email admin and password admin';
    const steps = [
      step('fill', { target: '@e1', value: 'admin' }, [{ kind: 'label', label: 'Email' }]),
      step('fill', { target: '@e2', value: 'admin' }, [{ kind: 'label', label: 'Password' }]),
    ];
    expect([...discoverSlots(instr, steps, { runid: 'x7' }).values()]).toEqual([]);
  });

  it('compiles a run-generic skill: no runid literal anywhere, binds a later run', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: DELETE_INSTR, url: `${ORIGIN}/#/tickets`, fingerprint: [1, 0, 0] },
      ...deleteSteps(),
    ];
    const rep = { status: 'success' as const, summary: 'Deleted both parts; ticket archived.' };
    const [skill] = compileSkills({ entries, instruction: DELETE_INSTR, report: rep, session: 's', knownValues: { runid: 'x7', '01-open.reference': 'RD-1015' } });
    expect(skill).toBeTruthy();
    expect(skill.template).not.toContain('x7');
    expect(skill.template).not.toContain('RD-1015');
    expect(JSON.stringify(skill.steps)).not.toContain('x7');
    const bound = bindSkill(skill, DELETE_INSTR.replaceAll('x7', 'fw-n2').replaceAll('RD-1015', 'RD-1044'));
    expect(bound).toBeTruthy();
    expect(Object.values(bound!)).toContain('fw-n2');
    expect(Object.values(bound!)).toContain('RD-1044');
  });

  it('a known value nested inside a discovered arg slot composes cleanly', () => {
    const slots = discoverSlots(INSTRUCTION, recording().filter((e): e is RecordedStep => e.k === 'step'), { runid: 'x7' });
    expect(substitute(INSTRUCTION, slots)).not.toContain('x7');
  });

  it('a known value wholly swallowed by a longer slot leaves no unbindable param', () => {
    // fwrd5l: the bare runid's every occurrence sat inside the ticket-title
    // slot, so {{v1}} appeared nowhere — yet v1 stayed a param, and bindSkill
    // refused the skill's own source instruction (step 01 never went tier A).
    const instr = "Open http://x.test/ and create a ticket titled exactly 'x7 RD Bench Ticket'. Confirm it exists.";
    const steps = [
      step('goto', { url: 'http://x.test/' }),
      step('fill', { target: '@e1', value: 'x7 RD Bench Ticket' }, [{ kind: 'label', label: 'Title' }]),
    ];
    const entries: RecordedEntry[] = [{ k: 'instruction', text: instr, url: 'http://x.test/', fingerprint: [1, 0, 0] }, ...steps];
    const [skill] = compileSkills({ entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's', knownValues: { runid: 'x7' } });
    expect(skill).toBeTruthy();
    expect(skill.template).not.toContain('x7');
    for (const name of Object.keys(skill.params)) expect(skill.template).toContain(`{{${name}}}`);
    expect(bindSkill(skill, instr.replaceAll('x7', 'k9'))).toBeTruthy();
  });

  it('drops an address welded out of a run value, not just an anchor', () => {
    // fwrd20l and fwrd21l both shipped `data-testid="ticket-link-t15"`: the
    // record's own id inside a test hook. The check only ever looked at
    // scoped anchors, so an address carrying the same value walked straight
    // through. stableFirst demotes it to the tail, so it is reached only when
    // everything better has missed — and then it resolves against whatever
    // wears that id NEXT run.
    const instr = 'Open the ticket list and read the first ticket reference.';
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instr, url: 'http://x.test/#/tickets', fingerprint: [1, 0, 0] },
      step('read', { target: '@e1', what: 'text' }, [
        { kind: 'scoped', container: 'tr', hasText: 'x7 RD Bench Ticket', selector: 'td > a' },
        { kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' },
      ]),
    ];
    const [skill] = compileSkills({
      entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's',
      knownValues: { 'var:runid': 'x7', 'url:i1:h1': 't15' },
    });
    expect(JSON.stringify(skill.steps)).not.toContain('ticket-link-t15');
  });

  it('drops a NAME that is really a record reference', () => {
    // fwrd22l shipped six: getByText('RD-1015') and getByRole('link', {name:
    // 'RD-1015'}), each pinned to the ticket the RECORDING run created. The
    // rule used to stop at anchors on the grounds that role/text locators are
    // ordinary UI text worth keeping as fallbacks — true, until the name IS
    // the record's reference.
    const instr = 'Open the ticket list and archive the ticket.';
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instr, url: 'http://x.test/#/tickets', fingerprint: [1, 0, 0] },
      step('click', { target: '@e1' }, [
        { kind: 'role', role: 'link', name: 'RD-1015' },
        { kind: 'text', text: 'RD-1015' },
        { kind: 'css', selector: '#ticket-rows > tr:nth-of-type(1) > td' },
      ]),
    ];
    const [skill] = compileSkills({
      entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's',
      knownValues: { 'output:i1:ref': 'RD-1015' },
    });
    expect(JSON.stringify(skill.steps)).not.toContain('RD-1015');
    // The structural path survives — dropping the whole chain would be worse.
    expect((skill.steps[0].locators.target ?? []).length).toBe(1);
  });

  it('DEMOTES a minted-id address it can only guess at, rather than deleting it', () => {
    // The instruction that MINTS t15 never visits a t15 url, so no ledger
    // entry exists while it compiles. Provenance cannot reach this one and
    // only the token's SHAPE suggests it — which is a weak signal: grafana's
    // ephemeral `_r8b_` matches none of our id patterns while odoo's stable
    // `o_form_view` hooks trip several. A wrong deletion costs a working
    // locator permanently; a wrong demotion costs one failed count(), and two
    // replays of evidence settle it either way. So it sorts last and the
    // running tally decides — see recordCandidateEvidence.
    const instr = 'Create a ticket and confirm it appears in the list.';
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instr, url: 'http://x.test/#/tickets', fingerprint: [1, 0, 0] },
      step('read', { target: '@e1', what: 'text' }, [
        { kind: 'scoped', container: 'tr', hasText: 'x7 RD Bench Ticket', selector: 'td > a' },
        { kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' },
      ]),
    ];
    const [skill] = compileSkills({ entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's', knownValues: {} });
    const chain = skill.steps[0].locators.target ?? [];
    expect(chain.some((c) => c.kind === 'testid')).toBe(true); // kept...
    expect(chain[chain.length - 1]).toMatchObject({ value: 'ticket-link-t15' }); // ...but last
  });

  it('leaves ordinary numbered hooks alone', () => {
    const instr = 'Remove the first row.';
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instr, url: 'http://x.test/#/tickets', fingerprint: [1, 0, 0] },
      step('click', { target: '@e1' }, [
        { kind: 'testid', attr: 'data-testid', value: 'del-1' },
        { kind: 'css', selector: '#dellist > div:nth-of-type(1)' },
      ]),
    ];
    const [skill] = compileSkills({ entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's', knownValues: {} });
    expect(JSON.stringify(skill.steps)).toContain('del-1');
  });

  it('keeps a chain that would otherwise be emptied entirely', () => {
    // Failing closed is right for ONE candidate, not for the whole step: with
    // nothing left the step cannot even be attempted.
    const instr = 'Open the ticket list and read the first ticket reference.';
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instr, url: 'http://x.test/#/tickets', fingerprint: [1, 0, 0] },
      step('click', { target: '@e1' }, [{ kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' }]),
    ];
    const [skill] = compileSkills({
      entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's',
      knownValues: { 'url:i1:h1': 't15' },
    });
    expect((skill.steps[0].locators.target ?? []).length).toBe(1);
  });

  it('a known value this instruction never names binds to its ORIGIN, not a literal', () => {
    // fwrd19l 04-edit: the instruction edits Part A, but a step's identity
    // anchor names Part B — a value an EARLIER instruction supplied. The slot
    // was formed and substituted correctly, then the mirror-hazard rule
    // deleted the unbindable param and pasted the recording run's runid back
    // into the anchor, so every replay missed it and fell to a positional
    // fallback. Deterministically, on both replays of both sweeps.
    const instr = "Edit the part named 'x7 RD Part A' and change its cost to 150.";
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instr, url: 'http://x.test/#/t/1', fingerprint: [1, 0, 0] },
      // The step that TYPES Part A makes it a slot of its own, which swallows
      // the bare runid in the template — the exact shape of the real skill.
      step('fill', { target: '@e0', value: 'x7 RD Part A' }, [{ kind: 'label', label: 'Name' }]),
      step('fill', { target: '@e1', value: '150' }, [{ kind: 'label', label: 'Cost' }]),
      step('click', { target: '@e2' }, [
        { kind: 'scoped', container: 'tr', hasText: 'x7 RD Part B', selector: 'td:nth-of-type(6)' },
      ]),
    ];
    const known = { 'var:runid': 'x7' };
    const [skill] = compileSkills({ entries, instruction: instr, report: { status: 'success', summary: 'ok' }, session: 's', knownValues: known });
    expect(skill).toBeTruthy();
    // The anchor keeps its marker: no run value survives into the procedure.
    expect(JSON.stringify(skill.steps)).not.toContain('x7');
    const bound = Object.entries(skill.params).find(([, p]) => p.binding);
    expect(bound?.[1].binding).toBe('var:runid');
    // A later run resolves its own value from the same origin, even though
    // nothing in the instruction it is matching mentions it.
    const params = bindSkill(skill, instr.replaceAll('x7', 'k9'), { 'var:runid': 'k9' });
    expect(params).toBeTruthy();
    expect(fillParamsDeep(skill.steps, params!)).toContainEqual(
      expect.objectContaining({ locators: { target: [expect.objectContaining({ hasText: 'k9 RD Part B' })] } }),
    );
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

  it('keeps the label on a target-less url read, so the flow can publish where a record lives', () => {
    const entries = [
      ...recording(),
      step('read', { what: 'url', label: 'ticket_url' }, [], { result: JSON.stringify(`${ORIGIN}/#/tickets/t15`) }),
    ];
    const urlReport = { ...report, evidence: { values: { ...report.evidence.values, ticket_url: `${ORIGIN}/#/tickets/t15` } } };
    const s = compileSkill({ entries, instruction: INSTRUCTION, report: urlReport, session: 's' })!;
    const last = s.steps.at(-1)!;
    expect(last.tool).toBe('read');
    expect(last.args.what).toBe('url');
    expect(last.locators).toEqual({});
    expect(last.label).toBe('ticket_url');
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
    // step 5's alert expectation carries the slot too, but only args and
    // locators count as use (an expectation-only slot must not become a param)
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

describe('dropSupersededNavigation (fwod6: exploration recorded as procedure)', () => {
  const nav = (url: string): SkillStep => ({ tool: 'goto', args: { url }, locators: {} });
  const click = (): SkillStep => ({ tool: 'click', args: { target: '@e1' }, locators: {} });

  it('keeps only the last of a run of adjacent navigations', () => {
    // fwod6 step 01 recorded a hand-built "#action=&...&menu_id=" url followed
    // immediately by the url that actually landed.
    const out = dropSupersededNavigation([nav('/web'), nav('/web#action=&menu_id='), nav('/web?cids=1'), click()]);
    expect(out.map((s) => s.args.url ?? s.tool)).toEqual(['/web?cids=1', 'click']);
  });

  it('keeps a navigation that anything else follows — the page may be load-bearing', () => {
    const out = dropSupersededNavigation([nav('/login'), click(), nav('/home')]);
    expect(out.length).toBe(3);
  });
});

describe('canAdoptPin (a flow step may not adopt another step\'s procedure)', () => {
  const store = () => new SkillStore(path.join(tmp, `pin-${Math.random().toString(36).slice(2)}`));
  const put = (s: SkillStore, id: string, tools: string[]): string => {
    s.put({
      id, origin: ORIGIN, template: 't', params: {}, preconditions: { urlPattern: `${ORIGIN}/#/tickets/:id` },
      steps: tools.map((tool) => ({ tool, args: {}, locators: {} })),
      stats: { uses: 3, successes: 3, partial: 0, created: 'now', failedAtStep: {}, fallthroughs: 0 },
      status: 'validated', provenance: { session: 's', instruction: 't', created: 'now' },
    });
    return id;
  };

  it('refuses a skill another step of the flow already owns', () => {
    const s = store();
    put(s, 's_read', ['read', 'read_all']);
    put(s, 's_create', ['click', 'fill', 'click']);
    const steps = [{ id: '07-open', skill: 's_read' }, { id: '08-create', skill: 's_create' }];
    // fwrd14l-n2: step 08's recovery invoked step 07's read-only skill, which
    // resolved cleanly on the same detail page and reported success.
    expect(canAdoptPin(s, steps, '08-create', 's_create', 's_read')).toBe(false);
  });

  it('refuses to trade a mutating procedure for a read-only one', () => {
    const s = store();
    put(s, 's_reads', ['read', 'read_all']);
    put(s, 's_deletes', ['click', 'click']);
    const steps = [{ id: '09-delete', skill: 's_deletes' }];
    expect(canAdoptPin(s, steps, '09-delete', 's_deletes', 's_reads')).toBe(false);
  });

  it('refuses a skill this run has ALREADY adopted for another step', () => {
    const s = store();
    put(s, 's_create', ['click', 'fill', 'click']);
    put(s, 's_other', ['click', 'fill']);
    // fwrd16-n3 re-pinned 02-create and 10-open onto one skill in a single
    // pass: the write-back happens after the loop, so the flow object alone
    // cannot see this run's own pending adoptions. The caller must fold them
    // in — as runFlow now does — and then the gate holds.
    const committed = [{ id: '02-create', skill: 's_old' }, { id: '10-open', skill: 's_other' }];
    expect(canAdoptPin(s, committed, '02-create', 's_old', 's_create')).toBe(true);
    const withPending = [{ id: '02-create', skill: 's_create' }, { id: '10-open', skill: 's_other' }];
    expect(canAdoptPin(s, withPending, '10-open', 's_other', 's_create')).toBe(false);
  });

  it('still adopts an honest repair of the same kind of work', () => {
    const s = store();
    put(s, 's_old', ['click', 'fill']);
    put(s, 's_new', ['click', 'fill', 'click']);
    const steps = [{ id: '02-create', skill: 's_old' }];
    expect(canAdoptPin(s, steps, '02-create', 's_old', 's_new')).toBe(true);
  });

  it('a read-only step may still repair to another read-only skill', () => {
    const s = store();
    put(s, 's_r1', ['read']);
    put(s, 's_r2', ['read', 'read_all']);
    expect(canAdoptPin(s, [{ id: '07-open', skill: 's_r1' }], '07-open', 's_r1', 's_r2')).toBe(true);
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

describe('softUrlMatch (mechanism 2: observed variance)', () => {
  it('tolerates one disagreeing segment and generalises exactly that segment', () => {
    // The swg-n2 halt: run 1 baked its generated dashboard uid into the
    // expectation; the replay minted a different one.
    const soft = softUrlMatch('http://h:1/d/afw6yy5xxq4u8e/:id', 'http://h:1/d/afw711m2aifb4a/swg-n2-bench-dashboard');
    expect(soft).not.toBeNull();
    expect(soft!.generalised).toBe('http://h:1/d/:var/:id');
    // and the generalised pattern now hard-matches any future uid
    expect(urlMatches('http://h:1/d/:var/:id', 'http://h:1/d/zzz9x/other')).toBe(true);
  });
  it('rejects a different page shape outright', () => {
    expect(softUrlMatch('http://h:1/d/afw6yy5xxq4u8e/:id', 'http://h:1/dashboards')).toBeNull();
    expect(softUrlMatch('http://h:1/a/b', 'http://other:2/a/b')).toBeNull();
  });
  it('rejects when everything already matched (no diff to generalise)', () => {
    expect(softUrlMatch('http://h:1/d/:id/:id', 'http://h:1/d/x1/y2')).toBeNull();
  });
  it('generalises a query-shaped hash value the way Odoo needs', () => {
    const soft = softUrlMatch('http://h:1/web#action=133&model=sale.order', 'http://h:1/web#action=915&cids=1&model=sale.order');
    expect(soft).not.toBeNull();
    expect(soft!.generalised).toBe('http://h:1/web#action=:var&model=sale.order');
  });
  it('gives up past two disagreeing segments', () => {
    expect(softUrlMatch('http://h:1/a1/b2/c3', 'http://h:1/x1/y2/z3')).toBeNull();
  });
  it('an unfilled {{dN}} marker in a pattern matches any segment', () => {
    expect(urlMatches('http://h:1/d/{{d1}}/:id', 'http://h:1/d/afw711m2aifb4a/slug')).toBe(true);
    // and a filled one must match exactly
    expect(urlMatches('http://h:1/d/{{d1}}/:id', 'http://h:1/d/afw711m2aifb4a/slug', { d1: 'afw711m2aifb4a' })).toBe(true);
    expect(urlMatches('http://h:1/d/{{d1}}/:id', 'http://h:1/d/afw711m2aifb4a/slug', { d1: 'other9' })).toBe(false);
  });
});

describe('derived params (mechanism 1: provenance)', () => {
  const START = `${ORIGIN}/dashboard/new`;
  const CREATE_INSTR = "Create a dashboard named 'Bench Board' and verify it saved.";
  function mintingRecording(): RecordedEntry[] {
    return [
      { k: 'instruction', text: CREATE_INSTR, url: START, fingerprint: [1, 0, 0] },
      step('fill', { target: '@e1', value: 'Bench Board' }, [{ kind: 'label', label: 'Title' }]),
      // Saving navigates to the minted uid's url — the mint step.
      step('click', { target: '@e2' }, [{ kind: 'role', role: 'button', name: 'Save' }], {
        diff: { url: `${ORIGIN}/d/afw6yy5xx9/bench-board`, alerts: ['Dashboard saved'], added: [] },
      }),
      // A later navigation back to the same record bakes the uid again.
      step('goto', { url: `${ORIGIN}/d/afw6yy5xx9/bench-board` }, [], {
        diff: { url: `${ORIGIN}/d/afw6yy5xx9/bench-board`, alerts: [], added: ['- heading "Bench Board"'] },
      }),
    ];
  }
  it('turns a value minted in a post-nav url into a {{dN}} reference downstream', () => {
    // The mint navigation crosses a template seam, so this compiles to a
    // 2-segment chain: the MINTING segment carries the derived metadata, the
    // later segment consumes the marker.
    const skills = compileSkills({ entries: mintingRecording(), instruction: CREATE_INSTR, report: { status: 'success', summary: 'ok', evidence: { values: {} } }, session: 's' });
    expect(skills).toHaveLength(2);
    const [a, b] = skills;
    expect(a.derived).toBeDefined();
    const [name, meta] = Object.entries(a.derived!)[0];
    expect(meta.example).toBe('afw6yy5xx9');
    expect(meta.at).toBe('p1');
    // the minting step's own expectation references the value it produced
    expect(JSON.stringify(a.steps[meta.step - 1].expect)).toContain(`{{${name}}}`);
    // the later segment's precondition and goto use the reference, not the literal
    expect(b.preconditions.urlPattern).toContain(`{{${name}}}`);
    const goto = b.steps.find((st) => st.tool === 'goto')!;
    expect(String(goto.args.url)).toContain(`{{${name}}}`);
    expect(String(goto.args.url)).not.toContain('afw6yy5xx9');
  });
  it('leaves stable digitless route words alone', () => {
    const skills = compileSkills({ entries: recording(), instruction: INSTRUCTION, report, session: 's' });
    expect(JSON.stringify(skills)).not.toContain('{{d');
  });
});

describe('urlParts', () => {
  it('labels path, hash-route and hash-state parts stably', () => {
    expect(urlParts('http://h:1/d/uid9/slug#x')).toEqual([
      { label: 'p0', value: 'd' },
      { label: 'p1', value: 'uid9' },
      { label: 'p2', value: 'slug' },
      { label: 'h0', value: 'x' },
    ]);
    expect(urlParts('http://h:1/web#action=915&cids=1')).toEqual([
      { label: 'p0', value: 'web' },
      { label: 'q.action', value: '915' },
      { label: 'q.cids', value: '1' },
    ]);
  });
});

describe('ElementSpec view', () => {
  it('separates naming a record, naming an element, and saying where it sits', () => {
    const chain: LocatorCandidate[] = [
      { kind: 'css', selector: '#view > div > button:nth-of-type(2)' },
      { kind: 'scoped', container: 'tr', hasText: '{{v1}} Two' },
      { kind: 'testid', attr: 'data-testid', value: 'modal-save' },
      { kind: 'css', selector: '#modal-save' },
      { kind: 'role', role: 'button', name: 'Save', nth: 2 },
    ];
    const spec = specOf(chain);
    expect(spec.identity.map((c) => c.kind)).toEqual(['scoped']);
    // An agent-chosen `#modal-save` NAMES a control; it is not a route to
    // wherever that shape currently sits, so it stays a handle.
    expect(spec.handles.map((c) => (c as { value?: string; selector?: string }).value ?? (c as { selector?: string }).selector)).toEqual(['modal-save', '#modal-save']);
    // A structural path, and a role pinned to a match index, are both routes.
    expect(spec.path.length).toBe(2);
  });
});

describe('evidence, not shape, decides whether an id is real', () => {
  const chainOf = (): LocatorCandidate[] => [
    { kind: 'id', selector: '[id="_r8b_"]' },      // grafana: React-minted, changes every load
    { kind: 'role', role: 'button', name: 'Save' }, // stable
  ];
  const skillWith = (chain: LocatorCandidate[]): Skill =>
    ({
      id: 's_ev', origin: ORIGIN, template: 't', params: {},
      preconditions: { urlPattern: ORIGIN },
      steps: [{ tool: 'click', args: { target: '@e1' }, locators: { target: chain } }],
      stats: { uses: 1, successes: 1, partial: 0, created: '', failedAtStep: {}, fallthroughs: 0 },
      status: 'validated', provenance: { session: 's', instruction: 't', created: '' },
    }) as unknown as Skill;

  it('retires a candidate only after it misses TWICE with the element present', () => {
    const store = new SkillStore();
    const skill = skillWith(chainOf());
    store.put(skill);
    // `_r8b_` matches no id-shaped pattern we have, so no heuristic would
    // catch it. One replay: it missed, the role candidate resolved.
    recordCandidateEvidence(store, 's_ev', [{ step: '1', key: 'target', hit: 1, missed: [0] }]);
    let chain = store.get('s_ev')!.steps[0].locators.target!;
    expect(chain[0].seen).toEqual({ hit: 0, miss: 1 });
    // One miss is not evidence — a slow paint or a modal can do that.
    expect(retired(chain[0])).toBe(false);
    recordCandidateEvidence(store, 's_ev', [{ step: '1', key: 'target', hit: 1, missed: [0] }]);
    chain = store.get('s_ev')!.steps[0].locators.target!;
    expect(retired(chain[0])).toBe(true);
    // The one that worked is not retired, and nothing was deleted: if the app
    // changes back it can still win a later pass.
    expect(retired(chain[1])).toBe(false);
    expect(chain).toHaveLength(2);
  });

  it('a candidate that ever resolves is never retired, however odd it looks', () => {
    const store = new SkillStore();
    store.put(skillWith(chainOf()));
    // Odoo's `o_data_row_7` trips every id-shaped rule we have — and works.
    recordCandidateEvidence(store, 's_ev', [{ step: '1', key: 'target', hit: 0, missed: [] }]);
    recordCandidateEvidence(store, 's_ev', [{ step: '1', key: 'target', hit: 1, missed: [0] }]);
    recordCandidateEvidence(store, 's_ev', [{ step: '1', key: 'target', hit: 1, missed: [0] }]);
    const chain = store.get('s_ev')!.steps[0].locators.target!;
    expect(chain[0].seen).toEqual({ hit: 1, miss: 2 });
    expect(retired(chain[0])).toBe(false);
  });
});

describe('provenance that arrives late', () => {
  it('strips a candidate the ledger only learns about after the step compiled', () => {
    // fwrd25l refused its own export over `ticket-link-t15`. The instruction
    // that MINTS t15 never visits a t15 url, so while it compiled nothing had
    // banked the value and `stranded` could not see it; the ledger only learns
    // it when a LATER instruction lands on that url. Export knows, so the same
    // provenance rule is applied there with the knowledge that arrived late.
    const chain: LocatorCandidate[] = [
      { kind: 'scoped', container: 'tr', hasText: '{{v1}} RD Bench Ticket', selector: 'td > a' },
      { kind: 'testid', attr: 'data-testid', value: 'ticket-link-t15' },
    ];
    expect(stranded(chain[0], ['t15'])).toBe(false); // a slot marker is not a value
    expect(stranded(chain[1], ['t15'])).toBe(true);
    // ...and with nothing banked, compile could not have known.
    expect(stranded(chain[1], [])).toBe(false);
  });
});

describe('a read-back carries the name it was captured for', () => {
  const readBack = (label?: string): RecordedEntry[] => [
    { k: 'step', tool: 'goto', args: { url: `${ORIGIN}/#/tickets/t15` }, locators: {} },
    {
      k: 'step',
      tool: 'read',
      args: { target: '(read-back)', what: 'text' },
      locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'label', label: 'Unit Price' }] } },
      result: '750.00',
      ...(label ? { label } : {}),
    },
  ];

  it('labels from the evidence key, not by matching the result text', () => {
    // fwod20's 02-verify recorded eight values and republished NONE on either
    // replay: readLabel recovered the name by comparing the read's result
    // against every reported value for an EXACT hit, and "£750.00" in the
    // report does not equal "750.00" off the page. The read was stored
    // unlabelled, an unlabelled read publishes nothing, and every later step
    // referencing that output fell to recovery for ever.
    const report = { status: 'success' as const, summary: 'read it', evidence: { values: { unit_price: '£750.00' } } };
    const s = compileSkill({ entries: readBack('unit_price'), instruction: 'Read the unit price', report, session: 's' })!;
    const read = s.steps.find((st) => st.tool === 'read');
    expect(read?.label).toBe('unit_price');
    expect(publishedOutputs(s)).toContain('unit_price');
  });

  it('still recovers the name by matching when none was carried', () => {
    // Note the value: "750.00" would NOT recover, because the fallback parses
    // the read result as JSON and 750 !== "750.00". That is the fragility the
    // carried label removes, demonstrated by its own test.
    const entries = readBack().map((e) => (e.k === 'step' && e.tool === 'read' ? { ...e, result: 'Sales Order' } : e));
    const report = { status: 'success' as const, summary: 'read it', evidence: { values: { order_status: 'Sales Order' } } };
    const s = compileSkill({ entries, instruction: 'Read the status', report, session: 's' })!;
    expect(s.steps.find((st) => st.tool === 'read')?.label).toBe('order_status');
  });

  it('ignores a carried label the report does not name', () => {
    const report = { status: 'success' as const, summary: 'read it', evidence: { values: { total: '999.00' } } };
    const s = compileSkill({ entries: readBack('unit_price'), instruction: 'Read the unit price', report, session: 's' })!;
    expect(s.steps.find((st) => st.tool === 'read')?.label).toBeUndefined();
  });
});
