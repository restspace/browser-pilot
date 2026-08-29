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
import { buildFlow, freshUrlIds, jsonLeaves, lookupOutput } from '../src/skills/flow.js';
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

describe('session-minted url ids (fwgr6: the uid in the skill template)', () => {
  const UID = 'afwfbbc2of6rkf';

  it('banks an identifier-like url part once, and ignores route words', () => {
    const seen = new Set<string>();
    const first = freshUrlIds(`http://127.0.0.1:3000/d/${UID}/r9-n2-bench-dashboard`, seen);
    expect(first.map((p) => p.value)).toContain(UID);
    // "d" is a route word, too short and not identifier-like.
    expect(first.map((p) => p.value)).not.toContain('d');
    // First appearance wins: the same uid on a later page is not minted twice.
    expect(freshUrlIds(`http://127.0.0.1:3000/d/${UID}/settings`, seen).map((p) => p.value)).not.toContain(UID);
  });

  it('banks a three-character record id, which a four-character floor missed', () => {
    // fwrd16 left a literal "#/tickets/t15" in six flow steps.
    expect(freshUrlIds('http://127.0.0.1:4180/#/tickets/t15', new Set()).map((p) => p.value)).toContain('t15');
    // Still not route words: no digit, no separator, under twelve characters.
    expect(freshUrlIds('http://127.0.0.1:4180/#/tickets', new Set()).map((p) => p.value)).toEqual([]);
  });

  it("slots a minted uid the NEXT instruction names, so the template is not pinned to the recording's record", () => {
    const instruction = `In Grafana at http://127.0.0.1:3000/d/${UID}/r9-n2-bench-dashboard, add a text panel.`;
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: instruction, url: `${ORIGIN}/#/x`, fingerprint: [1, 0, 0] },
      step('click', { target: '@e1' }, [{ kind: 'role', role: 'button', name: 'Add panel' }]),
    ];
    const rep = { status: 'success' as const, summary: 'Added.', evidence: { values: {} } };
    const bare = compileSkills({ entries, instruction, report: rep, session: 's', now: '2026-08-27T00:00:00.000Z' })[0];
    expect(bare.template).toContain(UID); // today's behaviour without the banked value

    const [skill] = compileSkills({
      entries,
      instruction,
      report: rep,
      session: 's',
      now: '2026-08-27T00:00:00.000Z',
      knownValues: { runid: 'r9-n2', 'mint.p1.0': UID },
    });
    expect(skill.template).not.toContain(UID);
    const name = Object.keys(skill.params).find((n) => skill.params[n].example === UID)!;
    expect(skill.params[name].known).toBe(true);
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

  it('a READ that loses its anchor publishes nothing rather than reading by position', () => {
    // fwrd16-n3: the read fell back to `tbody > tr:nth-of-type(1) > td`,
    // resolved instantly on a list whose first row was a seed ticket, and
    // published ref RD-1014 at tier A with zero turns.
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: ADD_PART, url: `${ORIGIN}/#/tickets`, fingerprint: [1, 0, 0] },
      step('read', { target: '@e9', what: 'text' }, [
        { kind: 'scoped', container: '#ticket-rows tr', hasText: 'r9-n1 RD Bench Ticket', selector: 'td:nth-of-type(1)' },
        { kind: 'css', selector: '#ticket-rows > tr:nth-of-type(1) > td:nth-of-type(1)' },
      ], { result: '"RD-1015"' }),
    ];
    const [skill] = compileSkills({
      entries,
      instruction: ADD_PART,
      report: { status: 'success', summary: 'Read the ref.', evidence: { values: { ref: 'RD-1015' } } },
      session: 's',
      now: '2026-08-27T00:00:00.000Z',
      knownValues: { runid: 'r9-n1' },
    });
    expect(skill.steps[0].locators.target).toEqual([]);
    expect(skill.steps[0].label).toBeUndefined(); // and it promises no output
  });

  it('keeps a read whose surviving fallback still NAMES the element', () => {
    const entries: RecordedEntry[] = [
      { k: 'instruction', text: ADD_PART, url: `${ORIGIN}/#/tickets`, fingerprint: [1, 0, 0] },
      step('read', { target: '@e9', what: 'text' }, [
        { kind: 'scoped', container: '#ticket-rows tr', hasText: 'r9-n1 RD Bench Ticket', selector: 'td' },
        { kind: 'testid', attr: 'data-testid', value: 'list-summary' },
      ], { result: '"Showing 1-1 of 1"' }),
    ];
    const [skill] = compileSkills({
      entries,
      instruction: ADD_PART,
      report: { status: 'success', summary: 'Read it.', evidence: { values: { summary: 'Showing 1-1 of 1' } } },
      session: 's',
      now: '2026-08-27T00:00:00.000Z',
      knownValues: { runid: 'r9-n1' },
    });
    expect(skill.steps[0].locators.target.length).toBe(1);
    expect(skill.steps[0].locators.target[0].kind).toBe('testid');
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
    expect(identityOfPrimary([primary], skill(true), { v1: 'r9-n2 RD Bench Ticket' })).toEqual(['r9-n2 RD Bench Ticket']);
  });

  it('ignores a slot the compiler guessed — only caller-vouched values are identity', () => {
    const primary = { kind: 'role', role: 'link', name: '{{v1}}' } as never;
    expect(identityOfPrimary([primary], skill(false), { v1: 'r9-n2 RD Bench Ticket' })).toEqual([]);
  });

  it('ignores slots inside a selector: an address is not a name', () => {
    const primary = { kind: 'css', selector: '#row-{{v1}} > a' } as never;
    expect(identityOfPrimary([primary], skill(true), { v1: 'r9-n2 RD Bench Ticket' })).toEqual([]);
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

describe('a self-navigating procedure is checked AFTER its goto', () => {
  it('refuses when the recorded url lands on another record', async () => {
    const { replaySkill } = await import('../src/skills/replay.js');
    // fwod10: the goto carries the RECORDING run's record id, so "step 1
    // decides the page" decided it to be the wrong one. Steps 03-07 did this
    // run's work on n1's records at tier A and reported success; 1/6 verified.
    const skill = {
      id: 's_nav', origin: 'http://x.test', template: 't',
      params: { v1: { example: 'n1 Bench Customer', usedIn: [], known: true as const } },
      preconditions: { urlPattern: 'http://x.test/rec/:id', requireText: ['{{v1}}'] },
      steps: [
        { tool: 'goto', args: { url: 'http://x.test/rec/44' }, locators: {} },
        { tool: 'click', args: { target: '@e1' }, locators: { target: [{ kind: 'role', role: 'button', name: 'Edit' }] } },
      ],
      stats: { uses: 1, successes: 1, partial: 0, created: '', failedAtStep: {}, fallthroughs: 0 },
      status: 'validated', provenance: { session: 's', instruction: 't', created: '' },
    } as unknown as Skill;
    const ran: string[] = [];
    const page = {
      url: () => 'http://x.test/rec/44',
      async goto() {},
      // The landed page shows n1's record, never n2's.
      locator: () => ({ count: async () => 0, first: () => ({ textContent: async () => '' }) }),
      async content() { return '<html>n1 Bench Customer</html>'; },
      async evaluate() { return 'n1 Bench Customer'; },
      async waitForLoadState() {},
    } as unknown as import('playwright-core').Page;
    const out = await replaySkill(skill, { v1: 'n2 Bench Customer' }, {
      page,
      exec: async (tool) => { ran.push(tool); return { result: 'ok' }; },
    });
    // NOT refused: refused means "nothing ran, try another candidate", and the
    // goto has already moved the browser. It is a partial stop, so the caller
    // hands it to recovery instead of replaying a sibling from a page nobody
    // expects.
    expect(out.refused).toBe(false);
    expect(out.failedAt).toBe(1);
    expect(out.wrongRecord).toMatch(/different record/);
    // The goto ran — that is how we learn where it lands. Nothing after it did.
    expect(ran).toEqual(['goto']);
    expect(out.stepsRun).toBe(1); // the goto ran and is not pretended away
  });
});

describe('a step that MINTS a record is known as such', () => {
  it('compiles `mints` from the url that first carried the identifier', async () => {
    const { compileSkill } = await import('../src/skills/compile.js');
    const instr = 'Create a quotation for Bench Customer.';
    const skill = compileSkill({
      entries: [
        { k: 'instruction', text: instr, url: 'http://x.test/orders' },
        { k: 'step', tool: 'click', args: { target: '@e1' },
          locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'role', role: 'button', name: 'New' }] } } },
        { k: 'step', tool: 'click', args: { target: '@e2' },
          locators: { target: { expr: 'x', verified: true, raw: '@e2', chain: [{ kind: 'role', role: 'button', name: 'Save' }] } },
          // Only after Save does an order id exist.
          diff: { url: 'http://x.test/orders/S00021', alerts: [], added: [] } },
        { k: 'step', tool: 'click', args: { target: '@e3' },
          locators: { target: { expr: 'x', verified: true, raw: '@e3', chain: [{ kind: 'role', role: 'button', name: 'Confirm' }] } } },
      ],
      instruction: instr,
      report: { status: 'success', summary: 'made S00021', evidence: { values: { ref: 'S00021' } } },
      session: 's',
    })!;
    const minting = skill.steps.filter((s) => s.mints);
    expect(minting).toHaveLength(1);

    // The SAVE step, not the New click before it and not the Confirm after.
    expect(skill.steps.indexOf(minting[0])).toBe(1);
    expect(minting[0].mints!.at).toBeTruthy();
  });

  it('tells recovery what THIS run created, not what the recording did', async () => {
    const { renderReplay } = await import('../src/skills/replay.js');
    const skill = { id: 's_mint', steps: [{}, {}] } as unknown as Skill;
    // `created` is filled as each minting step runs, by reading the live url
    // through the `at` label compile stored — so it holds S00099, this run's
    // order, never the recorded S00021.
    const res = {
      ok: false, refused: false, stepsRun: 1, stepsTotal: 2, failedAt: 2,
      lines: ['1. click → ok'], warnings: [], values: {}, misses: [],
      derivedValues: {}, generalisations: [], candidateEvidence: [],
      created: ['S00099'], similarity: null, fallthroughs: 0,
    } as unknown as import('../src/skills/replay.js').ReplayResult;
    const prelude = renderReplay(skill, res);
    expect(prelude).toContain('ALREADY CREATED');
    expect(prelude).toContain('S00099');
    expect(prelude).not.toContain('S00021');
    expect(prelude).toMatch(/silent duplicate/);
  });

  it('falls back to the generic warning when nothing was minted', async () => {
    const { renderReplay } = await import('../src/skills/replay.js');
    const skill = { id: 's_plain', steps: [{}, {}] } as unknown as Skill;
    const res = {
      ok: false, refused: false, stepsRun: 1, stepsTotal: 2, failedAt: 2,
      lines: [], warnings: [], values: {}, misses: [], derivedValues: {},
      generalisations: [], candidateEvidence: [], created: [], similarity: null, fallthroughs: 0,
    } as unknown as import('../src/skills/replay.js').ReplayResult;
    const prelude = renderReplay(skill, res);
    expect(prelude).not.toContain('ALREADY CREATED');
    expect(prelude).toMatch(/may already exist/);
  });
});

describe('a replay that acted is never retried by a sibling', () => {
  it('marks `acted` when the action fired, even if the step did not complete', async () => {
    const { replaySkill } = await import('../src/skills/replay.js');
    const skill = {
      id: 's_act', origin: 'http://x.test', template: 't', params: {},
      preconditions: { urlPattern: 'http://x.test/orders' },
      steps: [
        // The click fires; the expectation then fails. stepsRun stays 0 —
        // which the caller used to read as "the page was not touched".
        { tool: 'click', args: { target: '@e1' }, locators: { target: [{ kind: 'role', role: 'button', name: 'Create' }] },
          expect: { urlPattern: 'http://x.test/nowhere/:id' } },
      ],
      stats: { uses: 1, successes: 1, partial: 0, created: '', failedAtStep: {}, fallthroughs: 0 },
      status: 'validated', provenance: { session: 's', instruction: 't', created: '' },
    } as unknown as Skill;
    const fired: string[] = [];
    const page = {
      url: () => 'http://x.test/orders',
      async goto() {}, async content() { return '<html></html>'; },
      async evaluate() { return ''; }, async waitForLoadState() {},
      getByRole: () => ({ count: async () => 1, first: () => ({ textContent: async () => '' }) }),
      locator: () => ({ count: async () => 1, first: () => ({ textContent: async () => '' }) }),
    } as unknown as import('playwright-core').Page;
    const out = await replaySkill(skill, {}, {
      page,
      exec: async (tool) => { fired.push(tool); return { result: 'ok' }; },
    });
    expect(fired).toEqual(['click']); // the action really did fire
    expect(out.stepsRun).toBe(0); // ...and the step still did not complete
    expect(out.acted).toBe(true); // which is exactly what `acted` records
    expect(out.ok).toBe(false);
  });

  it('does not mark `acted` for a read', async () => {
    const { replaySkill } = await import('../src/skills/replay.js');
    const skill = {
      id: 's_read', origin: 'http://x.test', template: 't', params: {},
      preconditions: { urlPattern: 'http://x.test/orders' },
      steps: [{ tool: 'read', args: { target: '@e1', what: 'text' }, locators: { target: [{ kind: 'role', role: 'link', name: 'Ref' }] }, label: 'ref' }],
      stats: { uses: 1, successes: 1, partial: 0, created: '', failedAtStep: {}, fallthroughs: 0 },
      status: 'validated', provenance: { session: 's', instruction: 't', created: '' },
    } as unknown as Skill;
    const page = {
      url: () => 'http://x.test/orders',
      async goto() {}, async content() { return '<html></html>'; },
      async evaluate() { return ''; }, async waitForLoadState() {},
      getByRole: () => ({ count: async () => 1, first: () => ({ textContent: async () => '' }) }),
      locator: () => ({ count: async () => 1, first: () => ({ textContent: async () => '' }) }),
    } as unknown as import('playwright-core').Page;
    const out = await replaySkill(skill, {}, { page, exec: async () => ({ result: '"S1"' }) });
    expect(out.acted).toBe(false); // observing is not acting
  });
});

describe('a two-digit record id still marks its minting step', () => {
  it('accepts a bare numeric url id, which is what odoo uses', async () => {
    const { compileSkill } = await import('../src/skills/compile.js');
    const instr = 'Create a contact named Bench Customer.';
    // fwod15 compiled ZERO minting steps because odoo's ids are two-digit
    // integers and the floor here was four characters — while the url-pattern
    // code has always treated a bare number in a url as an id. Position is
    // the evidence: "44" free in prose means nothing, "44" in a url part is
    // a record.
    const skill = compileSkill({
      entries: [
        { k: 'instruction', text: instr, url: 'http://x.test/web#model=res.partner' },
        { k: 'step', tool: 'click', args: { target: '@e1' },
          locators: { target: { expr: 'x', verified: true, raw: '@e1', chain: [{ kind: 'role', role: 'button', name: 'Save' }] } },
          diff: { url: 'http://x.test/web#id=44&model=res.partner', alerts: [], added: [] } },
        { k: 'step', tool: 'click', args: { target: '@e2' },
          locators: { target: { expr: 'x', verified: true, raw: '@e2', chain: [{ kind: 'role', role: 'button', name: 'Close' }] } } },
      ],
      instruction: instr,
      report: { status: 'success', summary: 'made it', evidence: { values: {} } },
      session: 's',
    })!;
    const minting = skill.steps.filter((s) => s.mints);
    expect(minting).toHaveLength(1);
    expect(skill.steps.indexOf(minting[0])).toBe(0); // the Save, not the Close
  });
});
