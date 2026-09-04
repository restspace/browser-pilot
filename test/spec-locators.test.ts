/**
 * Locator source tests. Two halves: the exact text emitted for every
 * candidate kind (the emitter pastes it verbatim, so escaping is the whole
 * job), and - under BP_BROWSER_TESTS=1 - proof that the emitted expression
 * resolves the SAME element as makeLocator on the fixture page.
 *
 *   BP_BROWSER_TESTS=1 npx vitest run test/spec-locators.test.ts
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'playwright-core';
import { BrowserSession } from '../src/daemon/browser.js';
import { makeLocator, type LocatorCandidate } from '../src/daemon/recorder.js';
import { volatileMatcher } from '../src/shared/text.js';
import { candidateSource, chainSource, matcherSource, stringSource } from '../src/spec/locators.js';

/** What the generated file inlines; the regex tests need it in scope. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Evaluate emitted source the way the generated spec would run it. */
const evaluate = (src: string, p: Record<string, string> = {}): unknown =>
  new Function('page', 'p', 'escapeRe', `return ${src}`)(null, p, escapeRe);

describe('stringSource', () => {
  it('single-quotes plain text', () => {
    expect(stringSource('Save')).toBe("'Save'");
  });

  it('escapes quotes, backslashes and newlines', () => {
    expect(stringSource("O'Brien")).toBe("'O\\'Brien'");
    expect(stringSource('C:\\dev\\x')).toBe("'C:\\\\dev\\\\x'");
    expect(stringSource('a\nb\tc')).toBe("'a\\nb\\tc'");
    expect(evaluate(stringSource("a'b\\c\nd"))).toBe("a'b\\c\nd");
  });

  it('renders slots as interpolations in a template literal', () => {
    expect(stringSource('Ticket {{v1}} / {{d2}}')).toBe('`Ticket ${p.v1} / ${p.d2}`');
    expect(evaluate(stringSource('Ticket {{v1}}'), { v1: 'RD-9' })).toBe('Ticket RD-9');
  });

  it('escapes backticks and ${ around a slot, so the literal cannot be broken out of', () => {
    const src = stringSource('a `b` ${c} \\ {{v1}}');
    expect(src).toBe('`a \\`b\\` \\${c} \\\\ ${p.v1}`');
    expect(evaluate(src, { v1: 'x' })).toBe('a `b` ${c} \\ x');
  });

  it('honours a caller slot renderer', () => {
    expect(stringSource('id {{v1}}', { slot: (s) => '${vars.' + s + '}' })).toBe('`id ${vars.v1}`');
  });
});

describe('matcherSource', () => {
  const VOLATILE = 'Due date: 12/31/2026 07:40';

  it('is stringSource when volatileMatcher would return the string', () => {
    expect(volatileMatcher('Submit')).toBe('Submit');
    expect(matcherSource('Submit')).toBe("'Submit'");
    expect(matcherSource('Ticket {{v1}}')).toBe('`Ticket ${p.v1}`');
  });

  it('emits a RegExp literal that behaves like volatileMatcher', () => {
    const src = matcherSource(VOLATILE);
    expect(src.startsWith('/^Due date: ')).toBe(true);
    const re = evaluate(src) as RegExp;
    const ref = volatileMatcher(VOLATILE) as RegExp;
    for (const sample of [VOLATILE, 'Due date: 01/02/2027 23:59', 'Due date: nope 07:40', 'xDue date: 12/31/2026 07:40']) {
      expect(re.test(sample)).toBe(ref.test(sample));
    }
  });

  it('leans on RegExp.source for the slashes, so the literal is never double-escaped', () => {
    // Inside a character class a slash needs no escape and gets none; a bare
    // one would end the literal, and source has already escaped it.
    expect(matcherSource(VOLATILE)).toContain('[/.-]');
    const src = matcherSource('at 07:40 in a/b');
    expect(src).toContain('a\\/b');
    const re = evaluate(src) as RegExp;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('at 09:15 in a/b')).toBe(true);
    expect(re.test('at 09:15 in a\\/b')).toBe(false);
  });

  it('routes a slot through escapeRe inside new RegExp, so a parameter stays data', () => {
    const src = matcherSource('Ticket {{v1}} due 12/31/2026');
    expect(src).toBe('new RegExp(`^Ticket ${escapeRe(p.v1)} due (?:\\\\d{1,2}:\\\\d{2}(?::\\\\d{2})?|\\\\d{1,4}[/.-]\\\\d{1,2}[/.-]\\\\d{1,4})$`)');
    const re = evaluate(src, { v1: 'a+b' }) as RegExp;
    expect(re.test('Ticket a+b due 01/02/2027')).toBe(true);
    expect(re.test('Ticket aab due 01/02/2027')).toBe(false);
  });

  it('never lets recorded text escape the regex it is spliced into', () => {
    const re = evaluate(matcherSource('a) or (b at 07:40')) as RegExp;
    expect(re.test('a) or (b at 09:15')).toBe(true);
    expect(re.test('b at 09:15')).toBe(false);
  });
});

describe('candidateSource', () => {
  const cases: Array<[string, LocatorCandidate, string | null]> = [
    ['testid', { kind: 'testid', attr: 'data-testid', value: 'del-1' }, "page.getByTestId('del-1')"],
    ['testid (other attr, quoted value)', { kind: 'testid', attr: 'data-qa', value: 'a"b' }, 'page.locator(\'[data-qa="a\\\\"b"]\')'],
    ['role', { kind: 'role', role: 'button', name: 'Edit' }, "page.getByRole('button', { name: 'Edit', exact: true })"],
    ['label', { kind: 'label', label: 'Name' }, "page.getByLabel('Name')"],
    ['placeholder', { kind: 'placeholder', placeholder: 'Search' }, "page.getByPlaceholder('Search')"],
    ['text', { kind: 'text', text: 'Row Alpha' }, "page.getByText('Row Alpha', { exact: true })"],
    ['id', { kind: 'id', selector: '#name' }, "page.locator('#name')"],
    ['css', { kind: 'css', selector: 'div[title="a b"] > button' }, 'page.locator(\'div[title="a b"] > button\')'],
    [
      'scoped',
      { kind: 'scoped', container: '#editlist .erow', hasText: 'Item One', selector: 'button' },
      "page.locator('#editlist .erow', { hasText: 'Item One' }).locator('button')",
    ],
    [
      'scoped without a selector',
      { kind: 'scoped', container: 'tr', hasText: "O'Brien" },
      "page.locator('tr', { hasText: 'O\\'Brien' })",
    ],
    ['point', { kind: 'point', x: 10, y: 20, w: 5, h: 5, role: 'button', tag: 'button', vw: 1280, vh: 720 }, null],
  ];
  for (const [name, candidate, expected] of cases) {
    it(`emits ${name}`, () => {
      expect(candidateSource(candidate)).toBe(expected);
    });
  }

  it('appends the recorded match index, as makeLocator does', () => {
    expect(candidateSource({ kind: 'role', role: 'button', name: 'Edit', nth: 1 })).toBe(
      "page.getByRole('button', { name: 'Edit', exact: true }).nth(1)",
    );
  });

  it('slots the value of every kind that carries one', () => {
    expect(candidateSource({ kind: 'testid', attr: 'data-testid', value: 'row-{{v1}}' })).toBe('page.getByTestId(`row-${p.v1}`)');
    expect(candidateSource({ kind: 'scoped', container: 'tr', hasText: '{{v2}}', selector: 'button' })).toBe(
      "page.locator('tr', { hasText: `${p.v2}` }).locator('button')",
    );
  });

  it('takes the page expression from the options', () => {
    expect(candidateSource({ kind: 'id', selector: '#name' }, { page: 'frame' })).toBe("frame.locator('#name')");
  });
});

describe('chainSource', () => {
  const identity: LocatorCandidate = { kind: 'scoped', container: '#editlist .erow', hasText: 'Item One', selector: 'button' };
  const role: LocatorCandidate = { kind: 'role', role: 'button', name: 'Edit' };
  const positional: LocatorCandidate = { kind: 'css', selector: '#editlist > div:nth-of-type(1) > button' };
  const point: LocatorCandidate = { kind: 'point', x: 1, y: 2, w: 3, h: 4, role: 'button', tag: 'button', vw: 1280, vh: 720 };

  it('orders identity, then handles, then paths, and drops the point', () => {
    const { source, dropped, identity: guards } = chainSource([positional, role, identity, point]);
    expect(source).toBe(
      "page.locator('#editlist .erow', { hasText: 'Item One' }).locator('button')\n" +
        "  .or(page.getByRole('button', { name: 'Edit', exact: true }).filter({ hasText: 'Item One' }))\n" +
        "  .or(page.locator('#editlist > div:nth-of-type(1) > button').filter({ hasText: 'Item One' }))",
    );
    expect(dropped).toEqual([point]);
    expect(guards).toEqual(['Item One']);
  });

  it('leaves a chain without identity unguarded', () => {
    const { source, identity: guards } = chainSource([role, positional]);
    expect(source).toContain(".or(page.locator('#editlist > div:nth-of-type(1) > button'))");
    expect(source).not.toContain('filter');
    expect(guards).toEqual([]);
  });

  it('does not guard a candidate that already names the record', () => {
    const { source } = chainSource([identity, { kind: 'text', text: 'Item One' }]);
    expect(source).toContain(".or(page.getByText('Item One', { exact: true }))");
  });

  it('indents continuation lines with the caller indent', () => {
    const { source } = chainSource([role, positional], { indent: '      ' });
    expect(source.split('\n')[1].startsWith('      .or(')).toBe(true);
  });

  it('is empty when nothing in the chain can be expressed', () => {
    expect(chainSource([point])).toEqual({ source: '', dropped: [point], identity: [] });
  });
});

/**
 * The claim the unit tests above cannot make: that the emitted text builds
 * the SAME Locator makeLocator does. Resolved side by side on the fixture and
 * compared by match count and outerHTML.
 */
const enabled = process.env.BP_BROWSER_TESTS === '1';
const d = enabled ? describe : describe.skip;
const fixtureUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'page.html')).href;

d('emitted source resolves what makeLocator resolves (fixture page)', () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = new BrowserSession({ session: 'spec-locators', persist: false });
    const page = await session.getPage();
    await page.goto(fixtureUrl);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  const same = async (loc: Locator, other: Locator) => {
    const [n, m] = [await loc.count(), await other.count()];
    expect(m).toBe(n);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      expect(await other.nth(i).evaluate((el) => el.outerHTML)).toBe(await loc.nth(i).evaluate((el) => el.outerHTML));
    }
  };

  const candidates: Array<[string, LocatorCandidate]> = [
    ['id', { kind: 'id', selector: '#name' }],
    ['role', { kind: 'role', role: 'button', name: 'Submit' }],
    ['label', { kind: 'label', label: 'Qty' }],
    ['text', { kind: 'text', text: 'Row Alpha' }],
    ['testid', { kind: 'testid', attr: 'data-testid', value: 'del-1' }],
    ['testid (other attr)', { kind: 'testid', attr: 'data-name', value: 'beta' }],
    ['css with nth', { kind: 'css', selector: 'button.dup', nth: 1 }],
    ['scoped', { kind: 'scoped', container: '#editlist .erow', hasText: 'Item Two', selector: 'button' }],
  ];
  for (const [name, c] of candidates) {
    it(`matches makeLocator for ${name}`, async () => {
      const page = await session.getPage();
      const src = candidateSource(c)!;
      await same(makeLocator(page, c), new Function('page', 'p', `return ${src}`)(page, {}) as Locator);
    }, 30_000);
  }

  it('a guarded chain lands on the identity row, never on the other one', async () => {
    const page = await session.getPage();
    const scoped: LocatorCandidate = { kind: 'scoped', container: '#editlist .erow', hasText: 'Item Two', selector: 'button' };
    const { source } = chainSource([scoped, { kind: 'role', role: 'button', name: 'Edit' }, { kind: 'css', selector: '#editlist > div:nth-of-type(1) > button' }]);
    const chain = new Function('page', 'p', `return ${source}`)(page, {}) as Locator;
    await same(makeLocator(page, scoped), chain);
    // The guards are what keep it there: row 1's Edit button is a perfect
    // match for both fallbacks and has none of "Item Two" about it.
    expect(await chain.evaluate((el) => el.closest('.erow')!.getAttribute('data-row'))).toBe('2');
  }, 30_000);
});
