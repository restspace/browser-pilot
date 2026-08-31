import { describe, expect, it } from 'vitest';
import { addEvidenceValue, backfillReadValues, flattenComposedValues, unnamedReadValues, validateReport, type Report } from '../src/agent/report.js';

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

describe('backfillReadValues', () => {
  it('promotes a read value cited in the summary but missing from evidence', () => {
    const report: Report = { status: 'success', summary: 'The dashboard is titled "Ops Overview" as expected.' };
    const added = backfillReadValues(report, [{ target: 'dashboard title', values: ['Ops Overview'] }]);
    expect(added).toEqual(['dashboard_title']);
    expect(report.evidence?.values).toEqual({ dashboard_title: 'Ops Overview' });
  });

  it('promotes read_all elements individually, only the cited ones', () => {
    const report: Report = { status: 'success', summary: 'Panels present.', details: 'Saw CPU Load and Memory among others.' };
    const added = backfillReadValues(report, [{ target: 'panel titles', values: ['CPU Load', 'Memory', 'Disk IO'] }]);
    expect(added).toEqual(['panel_titles', 'panel_titles_2']);
    expect(report.evidence?.values).toEqual({ panel_titles: 'CPU Load', panel_titles_2: 'Memory' });
  });

  it('skips values already present in evidence.values', () => {
    const report: Report = {
      status: 'success',
      summary: 'Title is Ops Overview.',
      evidence: { values: { title: 'Ops Overview' } },
    };
    const added = backfillReadValues(report, [{ target: 'heading', values: ['Ops Overview'] }]);
    expect(added).toEqual([]);
    expect(report.evidence?.values).toEqual({ title: 'Ops Overview' });
  });

  it('does not promote a read the prose never mentions', () => {
    const report: Report = { status: 'success', summary: 'Signed in fine.' };
    const added = backfillReadValues(report, [{ target: 'debug cell', values: ['a1b2c3'] }]);
    expect(added).toEqual([]);
    expect(report.evidence?.values).toBeUndefined();
  });

  it('requires token boundaries — a substring of a longer word is not a citation', () => {
    const report: Report = { status: 'success', summary: 'The page mentions Overviewing procedures.' };
    const added = backfillReadValues(report, [{ target: 'title', values: ['Overview'] }]);
    expect(added).toEqual([]);
  });

  it('matches values containing regex metacharacters literally', () => {
    const report: Report = { status: 'success', summary: 'Cost shown as $1.50 (net).' };
    const added = backfillReadValues(report, [{ target: 'price cell', values: ['$1.50 (net)'] }]);
    expect(added).toEqual(['price_cell']);
    expect(report.evidence?.values?.price_cell).toBe('$1.50 (net)');
  });

  it('ignores trivial values below the length floor', () => {
    const report: Report = { status: 'success', summary: 'Count is 4.' };
    const added = backfillReadValues(report, [{ target: 'count', values: ['4'] }]);
    expect(added).toEqual([]);
  });

  it('names collide into numbered suffixes rather than overwriting', () => {
    const report: Report = {
      status: 'success',
      summary: 'First row Alpha One, second row Beta Two.',
      evidence: { values: { row: 'existing' } },
    };
    const added = backfillReadValues(report, [
      { target: 'row', values: ['Alpha One'] },
      { target: 'row', values: ['Beta Two'] },
    ]);
    expect(added).toEqual(['row_2', 'row_3']);
    expect(report.evidence?.values).toEqual({ row: 'existing', row_2: 'Alpha One', row_3: 'Beta Two' });
  });
});
describe('a snapshot ref is not a value name', () => {
  it('does not promote a read whose target names nothing', () => {
    // fwgr10: a read on @e5322 was promoted as `e5322`, buildFlow minted
    // {{03-report.e5322}} into three later flow steps, and no replay resolved
    // it — the handle expires with the snapshot that issued it. Naming it
    // `value` instead stopped the dead reference but kept the noise: fwod18
    // published the column heading "Untaxed Amount" and the status badge
    // "New" as `value` and `value_2`, outputs no later step would ever name.
    // A value with no usable name is not published at all.
    const report = { status: 'success' as const, summary: 'The dashboard is named fwgr10-n2 Bench Dashboard.' };
    const added = backfillReadValues(report, [{ target: '@e5322', values: ['fwgr10-n2 Bench Dashboard'] }]);
    expect(added).toEqual([]);
    expect(report.evidence?.values ?? {}).toEqual({});
  });

  it('still publishes a prose-pinned identifier, which the caller named itself', () => {
    // addEvidenceValue's base comes from the CALLER ("ref"), not from a
    // selector, so the drop above must not reach it — that path is how a
    // record reference the model left in prose becomes threadable at all.
    const report: Report = { status: 'success', summary: 'Created S00021.' };
    expect(addEvidenceValue(report, 'ref', 'S00021')).toBe('ref');
    expect(report.evidence!.values!.ref).toBe('S00021');
  });

  it('keeps a selector-derived name, which does mean something', () => {
    const report = { status: 'success' as const, summary: 'Total is 437.50 on the page.' };
    const added = backfillReadValues(report, [{ target: '.parts_total', values: ['437.50'] }]);
    expect(added).toEqual(['parts_total']);
  });
});


describe('composed report values', () => {
  const of = (values: Record<string, string>): Report => ({
    status: 'success',
    summary: 'read the order lines',
    evidence: { values },
  });

  it('splits a JSON blob into the page values it was built from', () => {
    // fwod17's 03-open, verbatim. Nothing could pin that string on the page,
    // so six real reads were recorded unlabelled and four later steps lost
    // {{03-open.line_1#qty}} on every zero-model replay.
    const report = of({
      line_1: '{"product":"Customizable Desk","qty":"3.00","unit_price":"750.00"}',
      untaxed_amount: '2316.00',
    });
    const added = flattenComposedValues(report);
    expect(added).toEqual(['line_1_product', 'line_1_qty', 'line_1_unit_price']);
    expect(report.evidence?.values).toEqual({
      untaxed_amount: '2316.00',
      line_1_product: 'Customizable Desk',
      line_1_qty: '3.00',
      line_1_unit_price: '750.00',
    });
    // The composite is GONE: leaving it would leave the unreferencable form
    // available to reference.
    expect('line_1' in (report.evidence?.values ?? {})).toBe(false);
  });

  it('leaves a table alone, and leaves prose alone', () => {
    const rows = of({ rows: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ n: String(i) }))) });
    expect(flattenComposedValues(rows)).toEqual([]);
    expect(rows.evidence?.values?.rows).toBeTypeOf('string');

    const prose = of({ note: '[see the totals section] the amount was 2316.00' });
    expect(flattenComposedValues(prose)).toEqual([]);
    expect(prose.evidence?.values?.note).toBe('[see the totals section] the amount was 2316.00');
  });

  it('names array elements by position and keeps existing names', () => {
    const report = of({ line_1_qty: 'taken', lines: '["A","B"]' });
    expect(flattenComposedValues(report)).toEqual(['lines_1', 'lines_2']);
    expect(report.evidence?.values).toEqual({ line_1_qty: 'taken', lines_1: 'A', lines_2: 'B' });
  });
});

describe('unnamedReadValues', () => {
  it('names the values the report described but did not label', () => {
    const report: Report = { status: 'success', summary: 'Saved quotation S00021 with unit price 85.00.' };
    expect(unnamedReadValues(report, [
      { target: 'h1', values: ['S00021'] },
      { target: '[name="price_unit"]', values: ['85.00'] },
    ])).toEqual(['S00021', '85.00']);
  });

  it('asks for nothing when the model already named the value', () => {
    const report: Report = {
      status: 'success',
      summary: 'Saved quotation S00021.',
      evidence: { values: { quotation_reference: 'S00021' } },
    };
    expect(unnamedReadValues(report, [{ target: 'h1', values: ['S00021'] }])).toEqual([]);
  });

  it('asks for nothing about a value the report never mentioned', () => {
    const report: Report = { status: 'success', summary: 'Saved the quotation.' };
    expect(unnamedReadValues(report, [{ target: 'h1', values: ['S00021'] }])).toEqual([]);
  });

  it('never holds a blocked or failed report', () => {
    const report: Report = { status: 'blocked', summary: 'Stuck after reading S00021.' };
    expect(unnamedReadValues(report, [{ target: 'h1', values: ['S00021'] }])).toEqual([]);
  });
});
