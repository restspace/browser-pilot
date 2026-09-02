import { describe, expect, it } from 'vitest';
import { admitsIncompletion } from '../src/agent/report.js';
import { parseRefLines } from '../src/daemon/refs.js';
import type { RecordedEntry } from '../src/daemon/recorder.js';
import { agentGesturesOutsideReplay, decideRepin } from '../src/skills/learn.js';

// Three gates from the set-20 grafana post-mortem: a success report that
// admits it did not finish, a re-pin onto a skill the model finished by hand,
// and a recorded step whose element vanished before it could be described.

describe('admitsIncompletion', () => {
  it('spots the rpgr3-r2 report: success, summary says otherwise', () => {
    const s =
      "The replayed procedure created the 'rpgr3-r2 Notes' panel. The panel has been given the title but the visualization is still 'Time series' (default) rather than 'Text', and I was unable to switch it to Text (ran out of turns when trying to search for 'Text').";
    expect(admitsIncompletion(s)).toBe('unable to');
  });

  it('flags the common admissions', () => {
    expect(admitsIncompletion('Saved the dashboard but could not confirm the tag persisted.')).toBe('could not');
    expect(admitsIncompletion('Ran out of turns before saving.')).toBe('Ran out of turns');
    expect(admitsIncompletion('Filled the form; the record was not saved.')).toBe('not saved');
    expect(admitsIncompletion('Failed to open the settings drawer.')).toBe('Failed to');
  });

  it('does not hold a verified invariant phrased with an admission word', () => {
    expect(admitsIncompletion('The dashboard still shows 3 panels after refresh, as expected.')).toBeNull();
    expect(admitsIncompletion('Confirmed the total remains unchanged after cancelling, which is correct.')).toBeNull();
  });

  it('lets a clean success through', () => {
    expect(admitsIncompletion("Created dashboard 'x Bench Dashboard' with a Stat panel; save confirmed by the 'Dashboard saved' alert.")).toBeNull();
    expect(admitsIncompletion('Verified all three panel titles: Request rate, Error count, Latency by endpoint.')).toBeNull();
  });
});

describe('agentGesturesOutsideReplay', () => {
  const step = (tool: string, via?: { skill: string; step: number }): RecordedEntry =>
    ({ k: 'step', tool, args: {}, locators: {}, ...(via ? { via } : {}) }) as unknown as RecordedEntry;

  it('counts only model-driven state changes, never replayed steps or reads', () => {
    const entries = [
      step('click', { skill: 's_1', step: 1 }),
      step('fill', { skill: 's_1', step: 2 }),
      step('snapshot'),
      step('read'),
      step('eval'),
      step('click'),
      step('press'),
    ];
    expect(agentGesturesOutsideReplay(entries)).toBe(2);
  });

  it('is zero for a recovery the skill carried alone', () => {
    expect(agentGesturesOutsideReplay([step('click', { skill: 's_1', step: 1 }), step('read')])).toBe(0);
  });
});

describe('decideRepin', () => {
  const validated = { skill: 's_new', status: 'validated' as const, ok: true };
  const provisional = { skill: 's_new', status: 'provisional' as const, ok: true };
  const base = { step: { id: '03-add', skill: 's_old' }, reportStatus: 'success' as const, stray: 0, adoptable: true };

  it('moves the pin to a validated skill that carried the step', () => {
    expect(decideRepin({ ...base, outcome: validated })).toEqual({ skill: 's_new', graduated: false });
  });

  it('refuses when the model drove the step beyond the replay (rpgr3 s_567dd1)', () => {
    const d = decideRepin({ ...base, outcome: validated, stray: 3 });
    expect(d && 'refused' in d ? d.refused : null).toMatch(/drove 3 gesture/);
  });

  it('withholds the pin from a provisional skill, a failed report, or an unadoptable one', () => {
    expect(decideRepin({ ...base, outcome: provisional })).toBeNull();
    expect(decideRepin({ ...base, outcome: validated, reportStatus: 'blocked' })).toBeNull();
    expect(decideRepin({ ...base, outcome: validated, adoptable: false })).toBeNull();
  });

  it('graduates an adopted step on its first clean recovery, provisional or not', () => {
    expect(decideRepin({ ...base, step: { id: '01-open', adopted: true }, outcome: provisional })).toEqual({ skill: 's_new', graduated: true });
  });

  it('does nothing when the incumbent replayed, failed, or is the same skill', () => {
    expect(decideRepin({ ...base, outcome: undefined })).toBeNull();
    expect(decideRepin({ ...base, outcome: { ...validated, ok: false } })).toBeNull();
    expect(decideRepin({ ...base, outcome: { ...validated, skill: 's_old' } })).toBeNull();
  });
});

describe('parseRefLines', () => {
  it('maps each ref to the role and name its snapshot line showed', () => {
    const snap = [
      '- dialog "Opened data source picker list" [@e1601]:',
      '  - button "TestData" [@e1653]',
      '  - generic [@e1660]:',
      '    - option "Loki \\"prod\\"" [@e1661] [selected]',
      '  - textbox "Search" [@e1670]: hello',
      '- text: not a ref line',
      '- heading "Order S00021" [level=1] [@e7]',
      '- button "Data source" [expanded] [@e9]',
    ].join('\n');
    const m = parseRefLines(snap);
    // state attributes sit between the name and the ref (the expanded picker
    // is exactly the element that vanishes before it can be described)
    expect(m.get('e7')).toEqual({ role: 'heading', name: 'Order S00021' });
    expect(m.get('e9')).toEqual({ role: 'button', name: 'Data source' });
    expect(m.get('e1653')).toEqual({ role: 'button', name: 'TestData' });
    expect(m.get('e1660')).toEqual({ role: 'generic' });
    expect(m.get('e1661')).toEqual({ role: 'option', name: 'Loki "prod"' });
    expect(m.get('e1670')).toEqual({ role: 'textbox', name: 'Search' });
    expect(m.get('e1601')).toEqual({ role: 'dialog', name: 'Opened data source picker list' });
    expect(m.size).toBe(7);
  });
});
