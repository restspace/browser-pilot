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

  it('rejects bad status, missing summary, and unknown keys with a readable error', () => {
    for (const bad of [
      { status: 'ok', summary: 'x' },
      { status: 'success' },
      { status: 'success', summary: 'x', extra: 1 },
      'not an object',
    ]) {
      const v = validateReport(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error.length).toBeGreaterThan(0);
    }
  });
});
