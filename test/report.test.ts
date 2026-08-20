import { describe, expect, it } from 'vitest';
import { validateReport } from '../src/agent/report.js';

describe('report validation', () => {
  it('accepts a minimal valid report', () => {
    const v = validateReport({ status: 'success', summary: 'done' });
    expect(v.ok).toBe(true);
  });

  it('accepts full evidence', () => {
    const v = validateReport({
      status: 'failure',
      summary: 'count did not increment',
      details: 'expected 5, saw 4',
      evidence: {
        url: 'http://localhost:5173/organisations',
        capturedDialogs: ['confirm("Delete?") → accept'],
        values: { orgName: 'k7x2 MTP Supplies Ltd', count: 4, deleted: false, missing: null },
      },
    });
    expect(v.ok).toBe(true);
  });

  it('rejects what cannot be repaired without guessing, with a readable error', () => {
    for (const bad of [
      { status: 'ok', summary: 'x' }, // not a status we can map without inventing intent
      { status: 'success' }, // no summary to salvage
      'not an object',
      42,
      null,
    ]) {
      const v = validateReport(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error.length).toBeGreaterThan(0);
    }
  });

  describe('near-miss repair', () => {
    it('flattens a list of ids where the schema wants one scalar', () => {
      const v = validateReport({
        status: 'success',
        summary: 'removed the items',
        evidence: { values: { removed: ['a', 'b', 'c'], count: 3 } },
      });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.report.evidence!.values!.removed).toBe('a, b, c');
      expect(v.report.evidence!.values!.count).toBe(3);
      expect(v.coerced?.join(' ')).toMatch(/flattened to scalars: removed/);
    });

    it('drops stray keys rather than failing the whole report', () => {
      const v = validateReport({ status: 'success', summary: 'x', extra: 1 });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect((v.report as Record<string, unknown>).extra).toBeUndefined();
      expect(v.coerced?.join(' ')).toMatch(/unknown key\(s\) dropped: extra/);
    });

    it('normalises status case and wraps a lone dialog string', () => {
      const v = validateReport({
        status: 'Success',
        summary: 'x',
        evidence: { capturedDialogs: 'confirm: Remove this item?' },
      });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.report.status).toBe('success');
      expect(v.report.evidence!.capturedDialogs).toEqual(['confirm: Remove this item?']);
    });

    it('truncates an over-long summary instead of rejecting it', () => {
      const v = validateReport({ status: 'failure', summary: 'y'.repeat(5000) });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.report.summary.length).toBeLessThanOrEqual(2000);
      expect(v.coerced).toContain('summary truncated');
    });

    it('reports nothing as coerced when the payload was already valid', () => {
      const v = validateReport({ status: 'success', summary: 'clean' });
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.coerced).toBeUndefined();
    });
  });
});
