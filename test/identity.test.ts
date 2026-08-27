/**
 * Record identity: the guards that stop a replay doing this run's work on a
 * DIFFERENT record of the same page template.
 *
 * fwrd8-n2/n3 (cloud, 2026-08-26) is the failure these cover: the primary
 * locator named the ticket by title, it did not resolve, replay fell through
 * to the recorded row position / recorded testid, and every later step —
 * preconditioned only on the url TEMPLATE `#/tickets/:id` — happily added
 * parts to, edited, and archived a seed ticket, reporting success.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordedEntry, RecordedStep } from '../src/daemon/recorder.js';
import { compileSkills } from '../src/skills/compile.js';
import { buildFlow, jsonLeaves, lookupOutput } from '../src/skills/flow.js';
import { addEvidenceValue, proseIdentifiers } from '../src/agent/report.js';
import { identityOfPrimary } from '../src/skills/replay.js';
import type { Skill } from '../src/skills/store.js';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-identity-'));
  process.env.BROWSER_PILOT_SKILLS_DIR = tmp;
});
afterAll(() => {
  delete process.env.BROWSER_PILOT_SKILLS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ORIGIN = 'http://127.0.0.1:4180';

function step(tool: string, args: Record<string, unknown>, chain: RecordedStep['locators']['target']['chain'] = [], extra: Partial<RecordedStep> = {}): RecordedStep {
  return {
    k: 'step',
    tool,
    args,
    locators: args.target ? { target: { expr: 'x', verified: true, raw: String(args.target), chain } } : {},
    ...extra,
  };
}

const ADD_PART = "On the ticket detail page for ticket 'r9-n2 RD Bench Ticket' (Ref RD-1015), add a part named exactly 'r9-n2 RD Part A' with cost 100.";

/** The add-part recording: starts ON the ticket's detail page, which showed the ticket. */
function addPartRecording(startText: string): RecordedEntry[] {
  return [
    { k: 'instruction', text: ADD_PART, url: `${ORIGIN}/#/tickets/t15`, fingerprint: [1, 0, 0], startText },
    step('click', { target: '@e3' }, [{ kind: 'role', role: 'button', name: 'Add part' }]),
    step('fill', { target: '@e10', value: 'r9-n2 RD Part A' }, [{ kind: 'label', label: 'Part name' }]),
    step('fill', { target: '@e11', value: '100' }, [{ kind: 'label', label: 'Cost' }]),
    step('click', { target: '@e13' }, [{ kind: 'role', role: 'button', name: 'Save' }], {
      diff: { url: `${ORIGIN}/#/tickets/t15`, alerts: [], added: ['- row "r9-n2 RD Part A 100"'] },
    }),
  ];
}

const REPORT = { status: 'success' as const, summary: 'Added the part.', evidence: { values: {} } };

function compile(entries: RecordedEntry[], known?: Record<string, string>): Skill[] {
  return compileSkills({ entries, instruction: ADD_PART, report: REPORT, session: 's', now: '2026-08-27T00:00:00.000Z', ...(known ? { knownValues: known } : {}) });
}

describe('identity precondition (compile)', () => {
  it('requires the caller-vouched value the page already showed when the segment started', () => {
    const [skill] = compile(addPartRecording('- heading "r9-n2 RD Bench Ticket"\n- text "Ref RD-1015"'), { runid: 'r9-n2' });
    const marker = skill.preconditions.requireText?.[0];
    expect(marker).toBeTruthy();
    expect(skill.params[marker!.replace(/[{}]/g, '')].example).toBe('r9-n2');
    expect(skill.params[marker!.replace(/[{}]/g, '')].known).toBe(true);
  });

  it('does not require a value the run was about to TYPE but the page did not show', () => {
    // The part name carries the runid too, but this page showed neither the
    // ticket title nor the part — a create step must not refuse itself.
    const [skill] = compile(addPartRecording('- heading "Repair tickets"\n- button "New ticket"'), { runid: 'r9-n2' });
    expect(skill.preconditions.requireText).toBeUndefined();
  });

  it('never requires a value the compiler merely inferred (no known values → no identity)', () => {
    const [skill] = compile(addPartRecording('- heading "r9-n2 RD Bench Ticket"'));
    expect(skill.preconditions.requireText).toBeUndefined();
  });

  it('a later segment takes its identity from the seam step it navigated through', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: ADD_PART, url: `${ORIGIN}/#/tickets`, fingerprint: [1, 0, 0], startText: '- heading "Repair tickets"' },
      step('click', { target: '@e1' }, [{ kind: 'role', role: 'link', name: 'r9-n2 RD Bench Ticket' }], {
        diff: { url: `${ORIGIN}/#/tickets/t15`, alerts: [], added: ['- heading "r9-n2 RD Bench Ticket"', '- button "Add part"'] },
      }),
      step('click', { target: '@e3' }, [{ kind: 'role', role: 'button', name: 'Add part' }]),
      step('fill', { target: '@e10', value: 'r9-n2 RD Part A' }, [{ kind: 'label', label: 'Part name' }]),
    ];
    const skills = compile(entries, { runid: 'r9-n2' });
    expect(skills.length).toBe(2);
    expect(skills[0].preconditions.requireText).toBeUndefined(); // the list showed no ticket yet
    expect(skills[1].preconditions.requireText?.length).toBe(1);
  });
});

describe('anchors must parameterise (compile)', () => {
  /** An anchor on the part's own row, the way the recorder now mints one. */
  const anchored = (hasText: string): RecordedEntry[] => [
    { k: 'instruction', text: ADD_PART, url: `${ORIGIN}/#/tickets/t15`, fingerprint: [1, 0, 0], startText: '- heading "r9-n2 RD Bench Ticket"' },
    step('click', { target: '@e20' }, [
      { kind: 'scoped', container: 'tr', hasText, selector: 'td:nth-of-type(7) > button' },
      { kind: 'css', selector: 'tbody > tr:nth-of-type(1) > td:nth-of-type(7) > button' },
    ]),
  ];

  it("slots the anchor's text, so it names the replay's record and not the recording's", () => {
    const [skill] = compile(anchored('r9-n2 RD Part A'), { runid: 'r9-n2' });
    const primary = skill.steps[0].locators.target[0] as { kind: string; hasText: string };
    expect(primary.kind).toBe('scoped');
    expect(primary.hasText).toContain('{{');
    // …and the slot is a known value, so replay holds fallbacks to it.
    const name = primary.hasText.match(/\{\{(v\d+)\}\}/)![1];
    expect(skill.params[name].known).toBe(true);
  });

  it('drops an anchor stranded on the recorded run, rather than replaying it positionally', () => {
    // Nothing in THIS instruction types "r9-n1 RD Part Z" (it was created by an
    // earlier one), so no slot covers it: the anchor would miss every future
    // run, and carrying no marker it would also switch the identity guard off.
    const [skill] = compile(anchored('r9-n1 RD Part Z'), { runid: 'r9-n1' });
    const chain = skill.steps[0].locators.target;
    expect(chain.some((c) => c.kind === 'scoped')).toBe(false);
    expect(chain.length).toBe(1);
  });
});

describe('identity-guarded fallthrough (replay)', () => {
  const skill = (known: boolean): Skill =>
    ({ params: { v1: { example: 'r9-n2 RD Bench Ticket', usedIn: [1], ...(known ? { known: true as const } : {}) } } }) as unknown as Skill;

  it('reads the identity out of a text-bearing primary locator', () => {
    const primary = { kind: 'role', role: 'link', name: '{{v1}}' } as never;
    expect(identityOfPrimary(primary, skill(true), { v1: 'r9-n2 RD Bench Ticket' })).toEqual(['r9-n2 RD Bench Ticket']);
  });

  it('ignores a slot the compiler guessed — only caller-vouched values are identity', () => {
    const primary = { kind: 'role', role: 'link', name: '{{v1}}' } as never;
    expect(identityOfPrimary(primary, skill(false), { v1: 'r9-n2 RD Bench Ticket' })).toEqual([]);
  });

  it('ignores slots inside a selector: an address is not a name', () => {
    const primary = { kind: 'css', selector: '#row-{{v1}} > a' } as never;
    expect(identityOfPrimary(primary, skill(true), { v1: 'r9-n2 RD Bench Ticket' })).toEqual([]);
  });
});

describe('JSON-path provenance', () => {
  it('publishes identifier-like leaves of a read-back JSON body', () => {
    const body = JSON.stringify({ status: 'success', uid: 'dfwdzd27pk934b', slug: 'r9-n2-bench-dashboard', version: 2 });
    const paths = jsonLeaves(body).map((l) => l.path);
    expect(paths).toContain('uid');
    expect(paths).toContain('slug');
    expect(paths).not.toContain('status'); // a word, not an identifier
    expect(paths).not.toContain('version'); // too short to be a reference
  });

  it('resolves a {{step.output#path}} reference from the live run own read-back', () => {
    const outputs = { '03-step': { body: JSON.stringify({ dashboard: { uid: 'live-uid-99' } }) } };
    expect(lookupOutput(outputs, '03-step', 'body#dashboard.uid')).toBe('live-uid-99');
    expect(lookupOutput(outputs, '03-step', 'body#dashboard.missing')).toBeUndefined();
    expect(lookupOutput(outputs, '03-step', 'body')).toBe(outputs['03-step'].body);
  });

  it('threads a uid that never appeared in any url into the later step that uses it', () => {
    const body = JSON.stringify({ uid: 'dfwdzd27pk934b', url: '/d/dfwdzd27pk934b/x7-bench-dashboard' });
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: 'Save the dashboard over the API and report the response body.', url: `${ORIGIN}/dashboard/new` },
      step('read', { target: '@e1', what: 'text' }, [], { result: JSON.stringify(body) }),
      { k: 'report', status: 'success', summary: 'saved', values: { body } } as RecordedEntry,
      { k: 'instruction', text: 'Open http://127.0.0.1:4180/d/dfwdzd27pk934b and confirm it renders.', url: `${ORIGIN}/dashboard/new` },
      step('goto', { url: `${ORIGIN}/d/dfwdzd27pk934b` }, []),
      { k: 'report', status: 'success', summary: 'rendered', values: {} } as RecordedEntry,
    ];
    const flow = buildFlow(entries, { name: 'f', origin: ORIGIN, startUrl: `${ORIGIN}/dashboard/new`, vars: {}, session: 's', now: '2026-08-27T00:00:00.000Z' });
    expect(flow!.steps[1].instruction).toContain('#uid}}');
    expect(flow!.steps[1].instruction).not.toContain('dfwdzd27pk934b');
  });

  it('does not referencize a route word out of a url (the {{01-open.url.h0}} = "tickets" bug)', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: 'Open the app and sign in.', url: `${ORIGIN}/` },
      step('click', { target: '@e1' }, [], { diff: { url: `${ORIGIN}/#/tickets`, alerts: [], added: [] } }),
      { k: 'report', status: 'success', summary: 'in', values: {} } as RecordedEntry,
      { k: 'instruction', text: 'Verify no ticket from this run is left in the active tickets list.', url: `${ORIGIN}/#/tickets` },
      step('read', { target: '@e2', what: 'text' }, [], { result: '"none"' }),
      { k: 'report', status: 'success', summary: 'clean', values: {} } as RecordedEntry,
    ];
    const flow = buildFlow(entries, { name: 'f', origin: ORIGIN, startUrl: `${ORIGIN}/`, vars: {}, session: 's', now: '2026-08-27T00:00:00.000Z' });
    expect(flow!.steps[1].instruction).toContain('active tickets list');
    expect(flow!.steps[1].instruction).not.toContain('url.h');
  });
});

describe('reference integrity', () => {
  it('never rewrites the inside of a reference an earlier pass placed', () => {
    // fwod5 (odoo): the url part "form" was provenance, and substituting it
    // everywhere corrupted an output NAME into
    // {{02-create.o_{{01-open.url.q.view_type}}_view_o_group_tabl}}.
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: 'Open the quotation form and report the totals table.', url: `${ORIGIN}/odoo/sales/new` },
      step('read', { target: '@e1', what: 'text' }, [], { result: '"x"' }),
      { k: 'report', status: 'success', summary: 'read', values: { o_form_view_group: '9,900' } } as RecordedEntry,
      { k: 'instruction', text: 'On the same quotation, confirm the total is still 9,900 and the view is a form.', url: `${ORIGIN}/odoo/sales/new` },
      step('read', { target: '@e2', what: 'text' }, [], { result: '"x"' }),
      { k: 'report', status: 'success', summary: 'ok', values: {} } as RecordedEntry,
    ];
    const flow = buildFlow(entries, { name: 'f', origin: ORIGIN, startUrl: `${ORIGIN}/odoo/sales/new`, vars: { view: 'form' }, session: 's', now: '2026-08-27T00:00:00.000Z' });
    const instruction = flow!.steps[1].instruction;
    // The value is threaded under its (uncorrupted) output name, and the var
    // pass rewrote the standalone word only — never the middle of the name.
    expect(instruction).toContain('.o_form_view_group}}');
    expect(instruction).toContain('a {{view}}.');
    expect(instruction).not.toContain('o_{{view}}_view');
  });
});

describe('prose-cited record identifiers', () => {
  const report = (summary: string, values: Record<string, string> = {}) => ({ status: 'success' as const, summary, evidence: { values } });

  it('finds the app-minted reference a report left in prose', () => {
    expect(proseIdentifiers(report('Confirmed the quotation. The order reference is **S00021** and the total is 4,550.00.'))).toEqual(['S00021']);
  });

  it('ignores prices, counts and plain words', () => {
    expect(proseIdentifiers(report('Added 2 lines totalling 4,550.00 for the customer; the untaxed amount is 125.00.'))).toEqual([]);
  });

  it('skips a value evidence already carries', () => {
    expect(proseIdentifiers(report('Order S00021 confirmed.', { ref: 'S00021' }))).toEqual([]);
  });

  it('names the pinned value and puts it in evidence', () => {
    const r = report('Order S00021 confirmed.');
    const name = addEvidenceValue(r, 'o_statusbar span', 'S00021');
    expect(r.evidence.values[name]).toBe('S00021');
  });
});
