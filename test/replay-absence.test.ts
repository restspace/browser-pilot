import { describe, expect, it } from 'vitest';
import { waitsForAbsence } from '../src/skills/replay.js';
import type { SkillStep } from '../src/skills/store.js';

const step = (tool: string, args: Record<string, unknown>): SkillStep => ({ tool, args, locators: {} });

describe('waitsForAbsence', () => {
  it('is true only for a wait_for whose condition is that nothing matches', () => {
    expect(waitsForAbsence(step('wait_for', { state: 'hidden' }), { state: 'hidden' })).toBe(true);
    expect(waitsForAbsence(step('wait_for', { state: 'count', count: 0 }), { state: 'count', count: 0 })).toBe(true);
    expect(waitsForAbsence(step('wait_for', { state: 'visible' }), { state: 'visible' })).toBe(false);
    expect(waitsForAbsence(step('wait_for', { state: 'count', count: 2 }), { state: 'count', count: 2 })).toBe(false);
    expect(waitsForAbsence(step('click', { state: 'hidden' }), { state: 'hidden' })).toBe(false);
  });
});
