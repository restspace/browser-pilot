/**
 * Locator candidates as Playwright SOURCE.
 *
 * `makeLocator` builds a live Locator from a recorded candidate; a compiled
 * spec has no sitelooper runtime, so the same candidate must arrive as text
 * that builds the identical Locator when the generated file runs. Every kind
 * is mirrored option for option - `exact: true` on role and text, `hasText`
 * on scoped, the trailing `.nth()` - because a spec that resolves a DIFFERENT
 * element than the replay did is worse than no spec at all: it passes or
 * fails for reasons the recording never observed.
 *
 * Two things the runtime decides at resolve time have to be decided here
 * instead: the chain order (mirrored from `specOf`) and the identity guard
 * (mirrored from `ResolvePolicy.requireIdentity`).
 */
import type { LocatorCandidate } from '../daemon/recorder.js';
import { specOf } from '../skills/replay.js';
import { volatileMatcher } from '../shared/text.js';

export interface SourceOptions {
  /** expression for the page, default 'page' */
  page?: string;
  /** how a "{{vN}}"/"{{dN}}" slot renders inside a template literal; default s => '${p.' + s + '}' */
  slot?: (slot: string) => string;
}

const SLOT = /\{\{([vd]\d+)\}\}/;
const SLOT_G = new RegExp(SLOT.source, 'g');
const defaultSlot = (s: string) => '${p.' + s + '}';

/** The escapes a single-quoted and a template literal share. */
function escapeFor(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A JS single-quoted string literal for `text`. */
function quote(text: string): string {
  return `'${escapeFor(text).replace(/'/g, "\\'")}'`;
}

/** Literal text inside a template literal: a backtick or a `${` would end it or open a hole. */
function escapeTemplate(text: string): string {
  return escapeFor(text).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** JS string source for recorded text: a single-quoted literal, or a template literal when it
 *  carries {{slots}}. */
export function stringSource(text: string, o: SourceOptions = {}): string {
  if (!SLOT.test(text)) return quote(text);
  const slot = o.slot ?? defaultSlot;
  // split() with one capture group alternates literal, slot name, literal...
  const body = text
    .split(SLOT_G)
    .map((p, i) => (i % 2 ? slot(p) : escapeTemplate(p)))
    .join('');
  return `\`${body}\``;
}

type Piece = { lit: string } | { slot: string };

// The \u0001 delimiters keep a sentinel's digits from fusing with neighbouring
// text into a clock or date token, and escapeRe leaves all three characters
// alone, so the sentinel comes back out of the pattern intact.
const SENTINEL = (i: number) => `\u0001${i}\u0001`;
const SENTINEL_G = /\u0001(\d+)\u0001/g;

/**
 * The pieces of the RegExp `volatileMatcher` would build, with the slots
 * pulled back out - or null when it would return a plain string.
 *
 * Built by asking volatileMatcher itself rather than restating its token
 * shape here: each slot is swapped for a sentinel that survives its escaping
 * untouched, and the sentinels are cut back out of the resulting `source`.
 * Duplicating the wildcard pattern would let the two drift, and the whole
 * point of this module is that they cannot.
 *
 * Volatility is judged with the slots still unbound, because a parameter is
 * unknown at compile time: a date arriving through `{{v1}}` stays an exact
 * match in the spec where replay would have wildcarded it. Stricter, never
 * looser - a spec that quietly matched another day's row would be a lie.
 */
function matcherPieces(text: string): Piece[] | null {
  const names: string[] = [];
  const probe = text.replace(SLOT_G, (_m, name: string) => {
    names.push(name);
    return SENTINEL(names.length - 1);
  });
  const matcher = volatileMatcher(probe);
  if (typeof matcher === 'string') return null;
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of matcher.source.matchAll(SENTINEL_G)) {
    const at = m.index ?? 0;
    if (at > last) pieces.push({ lit: matcher.source.slice(last, at) });
    pieces.push({ slot: names[Number(m[1])] });
    last = at + m[0].length;
  }
  if (last < matcher.source.length) pieces.push({ lit: matcher.source.slice(last) });
  return pieces;
}

/** The expression inside a slot's interpolation, so it can be wrapped in escapeRe(). */
function slotExpr(name: string, o: SourceOptions): string | null {
  const rendered = (o.slot ?? defaultSlot)(name);
  return /^\$\{[\s\S]*\}$/.test(rendered) ? rendered.slice(2, -1) : null;
}

/** Source for the matcher makeLocator would build: stringSource, or a RegExp literal when
 *  volatileMatcher would return a RegExp (mirror its construction exactly; slots inside a
 *  regex become `${escapeRe(p.vN)}` via new RegExp(...) source). */
export function matcherSource(text: string, o: SourceOptions = {}): string {
  const pieces = matcherPieces(text);
  if (!pieces) return stringSource(text, o);
  if (!pieces.some((p) => 'slot' in p)) {
    const source = pieces.map((p) => (p as { lit: string }).lit).join('');
    // A literal keeps the generated file readable, and RegExp.source is
    // already literal-safe - it escapes the slashes that would end one, which
    // is why nothing is escaped again here. Only a line terminator has no
    // literal form, so that case goes through new RegExp.
    return /[\n\r\u2028\u2029]/.test(source) ? `new RegExp(${quote(source)})` : `/${source}/`;
  }
  // escapeRe is inlined into the generated file: a bound parameter is DATA, so
  // its own regex metacharacters must not become pattern - which is exactly
  // what volatileMatcher does to the recorded text before splicing in the
  // wildcards.
  const body = pieces
    .map((p) => {
      if ('lit' in p) return escapeTemplate(p.lit);
      const expr = slotExpr(p.slot, o);
      // A caller whose slot renderer is not an interpolation owns its own
      // escaping; there is no expression here to wrap.
      return expr === null ? (o.slot ?? defaultSlot)(p.slot) : '${escapeRe(' + expr + ')}';
    })
    .join('');
  return `new RegExp(\`${body}\`)`;
}

/** Playwright Locator expression for ONE candidate, mirroring makeLocator kind by kind
 *  (testid -> getByTestId / [attr="v"], role -> getByRole(role,{name,exact:true}), label,
 *  placeholder, text -> getByText(..,{exact:true}), id/css -> locator(sel), scoped ->
 *  locator(container,{hasText}).locator(sel), nth -> .nth(n)). Returns null for 'point'
 *  (not expressible without a runtime). */
export function candidateSource(c: LocatorCandidate, o: SourceOptions = {}): string | null {
  const page = o.page ?? 'page';
  let src: string;
  switch (c.kind) {
    case 'testid':
      src =
        c.attr === 'data-testid'
          ? `${page}.getByTestId(${stringSource(c.value, o)})`
          : `${page}.locator(${stringSource(`[${c.attr}=${JSON.stringify(c.value)}]`, o)})`;
      break;
    case 'role':
      src = `${page}.getByRole(${quote(c.role)}, { name: ${matcherSource(c.name, o)}, exact: true })`;
      break;
    case 'label':
      src = `${page}.getByLabel(${matcherSource(c.label, o)})`;
      break;
    case 'placeholder':
      src = `${page}.getByPlaceholder(${matcherSource(c.placeholder, o)})`;
      break;
    case 'text':
      src = `${page}.getByText(${matcherSource(c.text, o)}, { exact: true })`;
      break;
    case 'id':
    case 'css':
      src = `${page}.locator(${stringSource(c.selector, o)})`;
      break;
    case 'scoped':
      // hasText stays a plain substring match on the container, exactly as
      // makeLocator passes it: the recorded value names the RECORD.
      src = `${page}.locator(${stringSource(c.container, o)}, { hasText: ${stringSource(c.hasText, o)} })`;
      if (c.selector) src += `.locator(${stringSource(c.selector, o)})`;
      break;
    case 'point':
      // markPoint tags the element under the recorded coordinates at replay
      // time; a plain spec has nothing to tag, so the candidate is dropped
      // rather than approximated into a selector that names a position.
      return null;
  }
  return c.nth !== undefined ? `${src}.nth(${c.nth})` : src;
}

/** The whole chain as ONE expression: candidates ordered by specOf (identity, handles,
 *  path), joined with .or(), point dropped. When the chain carries identity (a scoped
 *  candidate with hasText), every non-identity candidate is guarded with
 *  .filter({ hasText }) so a fallback cannot land on another record - mirrors
 *  ResolvePolicy.requireIdentity. Returns the source, the candidates that could not be
 *  expressed, and the hasText guards applied. Multi-line pretty form: one candidate per
 *  line, `.or(` continuation lines indented by `indent`. */
export function chainSource(
  chain: LocatorCandidate[],
  o: SourceOptions & { indent?: string } = {},
): { source: string; dropped: LocatorCandidate[]; identity: string[] } {
  const indent = o.indent ?? '  ';
  const spec = specOf(chain);
  const ordered = [...spec.identity, ...spec.handles, ...spec.path];
  const scoped = spec.identity as Extract<LocatorCandidate, { kind: 'scoped' }>[];
  const guards = [...new Set(scoped.map((c) => c.hasText).filter(Boolean))];

  const dropped: LocatorCandidate[] = [];
  const applied = new Set<string>();
  const parts: string[] = [];
  for (const c of ordered) {
    let src = candidateSource(c, o);
    if (src === null) {
      dropped.push(c);
      continue;
    }
    if (c.kind !== 'scoped') {
      // requireIdentity's rule: a value the candidate already carries needs no
      // guard, everything else must still land on a node bearing the record's
      // text. Unlike replay there is no exemption for the primary - a spec
      // re-resolves nothing and has no recovery to fail over to, so a fallback
      // that would silently work ANOTHER record must instead match nothing and
      // let the step fail loudly.
      const expr = JSON.stringify(c);
      for (const g of guards.filter((v) => !expr.includes(v))) {
        src += `.filter({ hasText: ${stringSource(g, o)} })`;
        applied.add(g);
      }
    }
    parts.push(src);
  }
  const source = parts.length ? parts[0] + parts.slice(1).map((p) => `\n${indent}.or(${p})`).join('') : '';
  return { source, dropped, identity: [...applied] };
}
