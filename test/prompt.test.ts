import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, OPERATING_RULES } from '../src/agent/prompt.js';

describe('system prompt assembly', () => {
  it('is byte-stable across calls with the same inputs (cacheable prefix)', () => {
    const parts = { briefing: '# Guide\nselectors...', notes: ['runid is k7x2'] };
    expect(buildSystemPrompt(parts)).toBe(buildSystemPrompt(parts));
  });

  it('keeps stable content first: rules, then briefing, then notes', () => {
    const p = buildSystemPrompt({ briefing: 'BRIEF', notes: ['NOTE1', 'NOTE2'] });
    const iRules = p.indexOf(OPERATING_RULES);
    const iBrief = p.indexOf('BRIEF');
    const iNote = p.indexOf('NOTE1');
    expect(iRules).toBe(0);
    expect(iBrief).toBeGreaterThan(iRules);
    expect(iNote).toBeGreaterThan(iBrief);
    expect(p.indexOf('NOTE2')).toBeGreaterThan(iNote);
  });

  it('adding a note leaves the existing prefix untouched (append-only growth)', () => {
    const before = buildSystemPrompt({ briefing: 'B', notes: ['n1'] });
    const after = buildSystemPrompt({ briefing: 'B', notes: ['n1', 'n2'] });
    expect(after.startsWith(before)).toBe(true);
  });

  it('omits empty sections entirely', () => {
    const p = buildSystemPrompt({ briefing: '', notes: [] });
    expect(p).toBe(OPERATING_RULES);
  });
});
