/**
 * The RunLedger and its leak scanner, checked against the artifacts that
 * exposed each defect. Phase 1 of PLAN-provenance.md: before the ledger is
 * allowed to replace anyone's recognition logic, it has to reproduce every
 * leak we found the slow way — by reading drift files after a two-hour cloud
 * sweep. If a case here does not fire, the ledger is incomplete, and that is
 * the finding.
 */
import { describe, expect, it } from 'vitest';
import { RunLedger, fatal, identifierLike, occursAsToken, scanForLeaks } from '../src/skills/ledger.js';
import { primaryFor } from '../src/daemon/recorder.js';

describe('identifierLike (the one copy)', () => {
  it('accepts minted ids, including the three-character ones', () => {
    expect(identifierLike('t15')).toBe(true); // fwrd16: six flow steps kept #/tickets/t15
    expect(identifierLike('RD-1015')).toBe(true);
    expect(identifierLike('afwfbbc2of6rkf')).toBe(true); // grafana uid: no digit, but long
    expect(identifierLike('fwrd17-n2')).toBe(true);
  });

  it('rejects a slug: a hyphenated pair of words is a route, not an id', () => {
    // Every one of these was banked from a url and made the export gate refuse
    // a whole recording: grafana's dashboard slug, atelyr's route segment.
    expect(identifierLike('bench-service-health')).toBe(false);
    expect(identifierLike('service-health')).toBe(false);
    expect(identifierLike('project-manager')).toBe(false);
    // A separator makes a reference when a digit comes with it...
    expect(identifierLike('RD-1015')).toBe(true);
    expect(identifierLike('fwrd24l-n1')).toBe(true);
    // ...and a digitless opaque token still qualifies on length, which is what
    // grafana's uids need ("cfwcsdxqdjabkf" sank fwgr2).
    expect(identifierLike('cfwcsdxqdjabkf')).toBe(true);
  });

  it('rejects prose, so an observed error message is not a reference', () => {
    // fwrd23l refused a clean 37-minute export because the app's validation
    // heading was reported as a value, cleared the `length >= 12` clause meant
    // for digitless uids, and was banked as an identifier.
    expect(identifierLike('Ticket is not ready')).toBe(false);
    expect(identifierLike('No parts on this ticket yet.')).toBe(false);
    expect(identifierLike('Bench Customer')).toBe(false);
    // ...while the digitless uid that clause exists for still passes.
    expect(identifierLike('afwfbbc2of6rkf')).toBe(true);
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

describe('a raw text target is recorded as text, not css', () => {
  it('maps the quoted form, which is what disarmed the identity guard', () => {
    // fwrd19l 01-open/02-open: the agent's own `text="..."` target was kept
    // verbatim at the head of the chain and typed css, so identityOfPrimary
    // (which skips css by design) saw no identity and every fallback —
    // including tr:nth-of-type(1) — was accepted unchecked.
    expect(primaryFor('text="x7 RD Bench Ticket"')).toEqual({ kind: 'text', text: 'x7 RD Bench Ticket' });
    expect(primaryFor("text='x7 RD Bench Ticket'")).toEqual({ kind: 'text', text: 'x7 RD Bench Ticket' });
  });

  it('leaves everything else css, including the forms that do not mean exact', () => {
    // Unquoted is substring + case-insensitive and the regex form is neither;
    // typing them as `text` would silently NARROW what the agent asked for.
    expect(primaryFor('text=Ready')).toEqual({ kind: 'css', selector: 'text=Ready' });
    expect(primaryFor('text=/^Ready$/')).toEqual({ kind: 'css', selector: 'text=/^Ready$/' });
    expect(primaryFor('#ticket-rows tr')).toEqual({ kind: 'css', selector: '#ticket-rows tr' });
    expect(primaryFor('button:has-text("Save")')).toEqual({ kind: 'css', selector: 'button:has-text("Save")' });
  });
});

describe('fatal leaks', () => {
  const at = (where: string, kind: 'identifier' | 'name' | 'text') => ({
    where, kind, value: 'x', binding: { from: 'input' } as const, context: 'x',
  });
  it('is an identifier in a LOCATOR, and nothing else', () => {
    expect(fatal(at('s.steps[0].locators.target[1].text', 'identifier'))).toBe(true);
    // A precondition is loud: a stale urlPattern or requireText makes the
    // skill refuse and the step says so. Grafana puts a minted uid in almost
    // every precondition, so treating those as fatal refused whole recordings
    // for a defect that announces itself.
    expect(fatal(at('s.preconditions.urlPattern', 'identifier'))).toBe(false);
    expect(fatal(at('s.preconditions.requireText[0]', 'identifier'))).toBe(false);
    // Text the run OBSERVED rather than made: a locator matching the app's own
    // copy is doing its job, and refusing an export over it trains people to
    // force past the gate.
    expect(fatal(at('s.steps[0].locators.target[1].text', 'text'))).toBe(false);
    // Announces itself at replay, so it warns rather than blocks.
    expect(fatal(at('s.reportTemplate.summary', 'identifier'))).toBe(false);
    expect(fatal(at('s.steps[0].expect.urlPattern', 'identifier'))).toBe(false);
  });
});
