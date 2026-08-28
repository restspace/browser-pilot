/**
 * The RunLedger: one registry for everything a RUN made, as opposed to what
 * the app provides.
 *
 * Seven defects in six cloud takes were the same bug wearing different
 * clothes — a value or a procedure from the recording run surviving into a
 * replay: a read pinned to row 1 publishing a seed record's ref; a runid
 * baked into a locator's hasText; a dashboard uid embedded 62 times in skill
 * templates; a three-character record id below a minting floor. Each was
 * fixed where it was found, and the next take produced a fresh instance,
 * because the rule they all violate had no home: recognition was
 * re-implemented per call site (three copies of the same length gate), and
 * relied on text matching against whatever the current instruction happened
 * to mention.
 *
 * This is that home. A value enters ONCE, with a Binding saying how a later
 * run re-derives its own, and every producer asks the ledger rather than
 * guessing. See PLAN-provenance.md.
 */

/** How a later run obtains its own value for a slot. */
export type Binding =
  /** The caller declared it (a flow var). */
  | { from: 'var'; name: string }
  /** The run typed it into the page. */
  | { from: 'input' }
  /** A part of a url the run landed on: `p1` (path), `h0` (hash path), `q.action` (hash state). */
  | { from: 'url'; step: string; label: string }
  /** A value an earlier step reported, optionally a JSON path into it. */
  | { from: 'output'; step: string; name: string; path?: string };

export interface LedgerEntry {
  /** What it was on the recording run. An EXAMPLE — never a value to replay. */
  value: string;
  binding: Binding;
  /**
   * `identifier` names a record (a ref, a uid, a row id) and may anchor a
   * locator; `name` is human-chosen text the run supplied; `text` is
   * everything else.
   */
  kind: 'identifier' | 'name' | 'text';
  /**
   * The caller vouched for this value rather than the compiler inferring it.
   * Known values are the only ones allowed to carry record IDENTITY, because
   * a wrong guess there silently moves a procedure onto another record.
   */
  known: boolean;
  /** Where it first appeared, for ordering and for diagnostics. */
  firstSeen: { instruction: number; step: number };
}

/**
 * Identifier-like: specific enough to be a REFERENCE rather than a word the
 * app happens to use. A route word ("tickets", "dashboards") is a common
 * lowercase noun; a minted id carries a digit, a separator, or the length of
 * a generated uid.
 *
 * This is the ONE copy. It previously existed three times with two different
 * length floors, which is why repair-desk's "t15" was banked by one caller
 * and left literal by another.
 */
export function identifierLike(value: string): boolean {
  if (value.length < MIN_ID_LEN) return false;
  return /\d/.test(value) || /[-_]/.test(value) || value.length >= 12;
}

/** Three, not four: repair-desk's record ids are "t15". */
const MIN_ID_LEN = 3;
const MAX_VALUE_LEN = 200;

export class RunLedger {
  private entries: LedgerEntry[] = [];
  /** Values already banked, so first appearance wins. */
  private seen = new Set<string>();
  private instruction = 0;
  private step = 0;

  /** Advance the cursor used to stamp `firstSeen`. */
  beginInstruction(index: number): void {
    this.instruction = index;
    this.step = 0;
  }

  beginStep(index: number): void {
    this.step = index;
  }

  /**
   * Bank a value with its provenance. Returns the entry, or null when the
   * value is unusable (too short, too long, already known). First appearance
   * wins: the step that MINTED a value owns it, so later steps reference it
   * rather than re-minting a duplicate.
   */
  add(value: string, binding: Binding, opts: { kind?: LedgerEntry['kind']; known?: boolean } = {}): LedgerEntry | null {
    const v = String(value ?? '').trim();
    if (v.length < MIN_ID_LEN || v.length > MAX_VALUE_LEN || this.seen.has(v)) return null;
    const entry: LedgerEntry = {
      value: v,
      binding,
      kind: opts.kind ?? (identifierLike(v) ? 'identifier' : 'text'),
      known: opts.known ?? binding.from === 'var',
      firstSeen: { instruction: this.instruction, step: this.step },
    };
    this.seen.add(v);
    this.entries.push(entry);
    return entry;
  }

  /** Bank the identifier-like parts of a url the run just landed on. */
  addUrlIds(url: string, step: string, parts: { label: string; value: string }[]): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const part of parts) {
      if (!identifierLike(part.value)) continue;
      const entry = this.add(part.value, { from: 'url', step, label: part.label }, { kind: 'identifier', known: true });
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Every entry, oldest first. */
  all(): LedgerEntry[] {
    return [...this.entries];
  }

  has(value: string): boolean {
    return this.seen.has(String(value ?? '').trim());
  }

  /**
   * THE predicate. Every producer that needs to know "does this string carry
   * something this run made?" asks here — compile's slot discovery, the flow
   * exporter's referencizing, the recorder's identity hints, the scanner.
   *
   * Longest first, so a value nested inside a longer one (a runid inside a
   * part name) does not shadow the more specific match.
   */
  runValuesIn(text: string): LedgerEntry[] {
    const s = String(text ?? '');
    if (!s) return [];
    return this.entries.filter((e) => occursAsToken(s, e.value)).sort((a, b) => b.value.length - a.value.length);
  }

  /** The values themselves, for callers that only need strings (identity hints). */
  values(opts: { known?: boolean } = {}): string[] {
    return this.entries.filter((e) => (opts.known === undefined ? true : e.known === opts.known)).map((e) => e.value);
  }
}

/**
 * Whole-token occurrence. Underscores bind — `o_form_view_group` is ONE
 * identifier, so a value "form" must not match its middle (fwod5 shipped
 * exactly that corruption) — while hyphens do not, since a runid prefix in
 * "x7-bench-dashboard" is a reference worth threading.
 */
export function occursAsToken(text: string, value: string): boolean {
  if (!value) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(value)}(?![A-Za-z0-9_])`).test(text);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fields whose CONTRACT is to hold the recording run's value: a param's
 * example, the provenance of the recording, a flow step's record of what it
 * observed. They are documentation, never replayed, and exempting them is
 * what keeps the scanner's output all signal.
 *
 * Deliberately NOT exempt, though both hold recorded text: `reportTemplate`
 * (a tier-A replay synthesises its report from it, so an unslotted value is
 * published as this run's answer) and `expect.urlPattern` (a replay checks
 * the live url against it).
 */
const EXEMPT = [/(^|\.)provenance(\.|$)/, /(^|\.)params\.[^.]+\.example$/, /(^|\.)derived\.[^.]+\.example$/, /(^|\.)recorded(\.|$)/, /(^|\.)stats(\.|$)/];

function exempt(path: string): boolean {
  return EXEMPT.some((re) => re.test(path));
}

/** One artifact carrying a run value verbatim. */
export interface Leak {
  /** Which artifact: "skill.template", "step 3 args.url", "flow 02-create.instruction". */
  where: string;
  value: string;
  binding: Binding;
  /** The surrounding text, trimmed, so a reader can see it in context. */
  context: string;
}

/**
 * Walk anything JSON-shaped and report every run value that survived
 * unslotted. This is an INSTRUMENT before it is a guard: what it actually
 * measures is ledger coverage, since a converter given a complete slot set is
 * a total function. Every one of the seven known defects was a recognition
 * gap, not a conversion error, and each cost a two-hour sweep plus a reading
 * of the drift files to find. This finds them in milliseconds.
 *
 * It can only report values it knows about, so it can never prove absence —
 * only ever "here are more".
 */
export function scanForLeaks(artifact: unknown, ledger: RunLedger, where = ''): Leak[] {
  const out: Leak[] = [];
  const walk = (node: unknown, path: string): void => {
    if (exempt(path)) return;
    if (typeof node === 'string') {
      for (const entry of ledger.runValuesIn(node)) {
        out.push({ where: path, value: entry.value, binding: entry.binding, context: node.slice(0, 160) });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(artifact, where);
  return out;
}

/** One line per leak, for a warning or a thrown error. */
export function describeLeaks(leaks: Leak[]): string {
  return leaks
    .map((l) => `  ${l.where}: ${JSON.stringify(l.value)} (${l.binding.from}) in ${JSON.stringify(l.context)}`)
    .join('\n');
}
