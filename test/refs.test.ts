import { describe, expect, it } from 'vitest';
import { filterInteractive, isRefTarget, normalizeRefs, truncate } from '../src/daemon/refs.js';

describe('ref handling', () => {
  it('normalizes Playwright [ref=eNN] markers to [@eNN]', () => {
    const input = '- button "Save" [ref=e12]\n- textbox "Name" [ref=e3]';
    expect(normalizeRefs(input)).toBe('- button "Save" [@e12]\n- textbox "Name" [@e3]');
  });

  it('classifies targets: @refs and bare refs vs CSS selectors', () => {
    expect(isRefTarget('@e12')).toBe(true);
    expect(isRefTarget('e12')).toBe(true);
    expect(isRefTarget(' @e5 ')).toBe(true);
    expect(isRefTarget('#e12')).toBe(false);
    expect(isRefTarget('button.save')).toBe(false);
    expect(isRefTarget('@e12 > span')).toBe(false);
  });

  it('filterInteractive keeps ref-carrying and interactive lines, drops decoration', () => {
    const snap = [
      '- generic',
      '- img "logo"',
      '- button "Save" [@e1]',
      '- paragraph: some text',
      '- link "Organisations"',
      '- heading "Dashboard" [level=1]',
    ].join('\n');
    const filtered = filterInteractive(snap).split('\n');
    expect(filtered).toContain('- button "Save" [@e1]');
    expect(filtered).toContain('- link "Organisations"');
    expect(filtered).toContain('- heading "Dashboard" [level=1]');
    expect(filtered).not.toContain('- generic');
    expect(filtered).not.toContain('- img "logo"');
  });

  it('truncate marks how much was cut', () => {
    const out = truncate('x'.repeat(100), 10);
    expect(out.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out).toContain('truncated 90 chars');
    expect(truncate('short', 10)).toBe('short');
  });
});
