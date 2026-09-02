import { describe, expect, it } from 'vitest';
import { admitsIncompletion } from '../src/agent/report.js';
import { parseRefLines } from '../src/daemon/refs.js';
import type { RecordedEntry } from '../src/daemon/recorder.js';
import { agentGesturesOutsideReplay } from '../src/skills/learn.js';

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

describe('parseRefLines', () => {
  it('maps each ref to the role and name its snapshot line showed', () => {
    const snap = [
      '- dialog "Opened data source picker list" [@e1601]:',
      '  - button "TestData" [@e1653]',
      '  - generic [@e1660]:',
      '    - option "Loki \\"prod\\"" [@e1661] [selected]',
      '  - textbox "Search" [@e1670]: hello',
      '- text: not a ref line',
    ].join('\n');
    const m = parseRefLines(snap);
    expect(m.get('e1653')).toEqual({ role: 'button', name: 'TestData' });
    expect(m.get('e1660')).toEqual({ role: 'generic' });
    expect(m.get('e1661')).toEqual({ role: 'option', name: 'Loki "prod"' });
    expect(m.get('e1670')).toEqual({ role: 'textbox', name: 'Search' });
    expect(m.get('e1601')).toEqual({ role: 'dialog', name: 'Opened data source picker list' });
    expect(m.size).toBe(5);
  });
});
