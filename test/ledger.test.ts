/**
 * The RunLedger and its leak scanner, checked against the artifacts that
 * exposed each defect. Phase 1 of PLAN-provenance.md: before the ledger is
 * allowed to replace anyone's recognition logic, it has to reproduce every
 * leak we found the slow way — by reading drift files after a two-hour cloud
 * sweep. If a case here does not fire, the ledger is incomplete, and that is
 * the finding.
 */
import { describe, expect, it } from 'vitest';
import { RunLedger, identifierLike, occursAsToken, scanForLeaks } from '../src/skills/ledger.js';

describe('identifierLike (the one copy)', () => {
  it('accepts minted ids, including the three-character ones', () => {
    expect(identifierLike('t15')).toBe(true); // fwrd16: six flow steps kept #/tickets/t15
    expect(identifierLike('RD-1015')).toBe(true);
    expect(identifierLike('afwfbbc2of6rkf')).toBe(true); // grafana uid: no digit, but long
    expect(identifierLike('fwrd17-n2')).toBe(true);
  });

  it('rejects route words, which is what stops a url turning into prose', () => {
    expect(identifierLike('tickets')).toBe(false);
    expect(identifierLike('dashboards')).toBe(false);
    expect(identifierLike('new')).toBe(false);
    expect(identifierLike('d')).toBe(false);
  });
});

describe('token boundaries', () => {
  it('binds on underscores and not on hyphens', () => {
    // fwod5 shipped a ref rewritten through the middle of an identifier.
    expect(occursAsToken('o_form_view_group', 'form')).toBe(false);
    expect(occursAsToken('x7-bench-dashboard', 'x7')).toBe(true);
    expect(occursAsToken('the ticket RD-1015 is ready', 'RD-1015')).toBe(true);
    expect(occursAsToken('RD-10159', 'RD-1015')).toBe(false);
  });
});

describe('banking values', () => {
  it('gives the minting step ownership — first appearance wins', () => {
    const l = new RunLedger();
    l.addUrlIds('http://app/d/afwfbbc2of6rkf/x', '02-create', [
      { label: 'p0', value: 'd' },
      { label: 'p1', value: 'afwfbbc2of6rkf' },
    ]);
    // A later step landing on the same uid must not re-mint it.
    l.addUrlIds('http://app/d/afwfbbc2of6rkf/settings', '05-edit', [{ label: 'p1', value: 'afwfbbc2of6rkf' }]);
    const banked = l.all().filter((e) => e.value === 'afwfbbc2of6rkf');
    expect(banked.length).toBe(1);
    expect(banked[0].binding).toEqual({ from: 'url', step: '02-create', label: 'p1' });
  });

  it('does not bank route words from a url', () => {
    const l = new RunLedger();
    l.addUrlIds('http://app/#/tickets', '01-open', [{ label: 'h0', value: 'tickets' }]);
    expect(l.all()).toEqual([]);
  });

  it('marks caller-declared values known, so only they can carry identity', () => {
    const l = new RunLedger();
    l.add('fwrd17-n2', { from: 'var', name: 'runid' });
    l.add('Bench Customer', { from: 'input' });
    expect(l.values({ known: true })).toEqual(['fwrd17-n2']);
  });
});

describe('the scanner reproduces every leak we found the slow way', () => {
  /** A ledger shaped like the recording run of the repairdesk flow. */
  const repairdesk = (): RunLedger => {
    const l = new RunLedger();
    l.add('fwrd17-n1', { from: 'var', name: 'runid' });
    l.addUrlIds('http://127.0.0.1:4180/#/tickets/t15', '01-open', [
      { label: 'h0', value: 'tickets' },
      { label: 'h1', value: 't15' },
    ]);
    l.add('RD-1015', { from: 'output', step: '01-open', name: 'ref' }, { kind: 'identifier', known: true });
    return l;
  };

  it('fwrd16: a literal record id left in a flow instruction', () => {
    const flow = {
      steps: [
        { id: '04-open', instruction: "On the ticket detail page for {{02-create.ref}} (currently open at #/tickets/t15), add a part." },
      ],
    };
    const leaks = scanForLeaks(flow, repairdesk());
    expect(leaks.length).toBe(1);
    expect(leaks[0].value).toBe('t15');
    expect(leaks[0].where).toBe('steps[0].instruction');
  });

  it('fwgr6: a minted uid embedded in a skill template', () => {
    const l = new RunLedger();
    l.add('fwgr6-n1', { from: 'var', name: 'runid' });
    l.addUrlIds('http://127.0.0.1:3000/d/afwfbbc2of6rkf/fwgr6-n1-bench-dashboard', '02-create', [
      { label: 'p0', value: 'd' },
      { label: 'p1', value: 'afwfbbc2of6rkf' },
    ]);
    const skill = {
      template: 'In Grafana at http://127.0.0.1:3000/d/afwfbbc2of6rkf/{{v1}}-bench-dashboard, add a {{v2}} panel.',
      steps: [{ tool: 'click', args: {}, locators: {} }],
    };
    const leaks = scanForLeaks(skill, l);
    expect(leaks.map((k) => k.value)).toEqual(['afwfbbc2of6rkf']);
    expect(leaks[0].binding).toEqual({ from: 'url', step: '02-create', label: 'p1' });
  });

  it('fwrd12l: the recording run id baked into a locator anchor', () => {
    const skill = {
      steps: [
        {
          tool: 'click',
          args: { target: '@e1' },
          locators: { target: [{ kind: 'scoped', container: 'tr', hasText: 'fwrd17-n1', selector: 'td' }] },
        },
      ],
    };
    const leaks = scanForLeaks(skill, repairdesk());
    expect(leaks.length).toBe(1);
    expect(leaks[0].where).toBe('steps[0].locators.target[0].hasText');
  });

  it('a properly slotted artifact is clean', () => {
    const skill = {
      template: "Open ticket {{v2}} titled '{{v1}} RD Bench Ticket'",
      steps: [
        {
          tool: 'click',
          args: { target: '@e1' },
          locators: { target: [{ kind: 'scoped', container: '#ticket-rows tr', hasText: '{{v1}} RD Bench Ticket', selector: 'td' }] },
        },
      ],
      preconditions: { urlPattern: 'http://127.0.0.1:4180/#/tickets/:id' },
    };
    expect(scanForLeaks(skill, repairdesk())).toEqual([]);
  });

  it('reports where the value came from, so a leak names its own fix', () => {
    const leaks = scanForLeaks({ template: 'go to #/tickets/t15 and read RD-1015' }, repairdesk());
    expect(leaks.map((l) => [l.value, l.binding.from])).toEqual([
      ['RD-1015', 'output'],
      ['t15', 'url'],
    ]);
  });
});
