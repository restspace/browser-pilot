import { Ajv, type ValidateFunction } from 'ajv';

export interface Report {
  status: 'success' | 'failure' | 'blocked';
  summary: string;
  details?: string;
  evidence?: {
    url?: string;
    capturedDialogs?: string[];
    values?: Record<string, string | number | boolean | null>;
  };
}

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['success', 'failure', 'blocked'] },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    details: { type: 'string' },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
        capturedDialogs: { type: 'array', items: { type: 'string' } },
        values: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
    },
  },
} as const;

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    compiled = ajv.compile(REPORT_SCHEMA);
  }
  return compiled;
}

export type ReportValidation =
  | { ok: true; report: Report; coerced?: string[] }
  | { ok: false; error: string };

/** Longest stringified value kept for a single evidence entry. */
const VALUE_CHARS = 300;
const SUMMARY_CHARS = 2000;

/**
 * Validate the agent's `report` tool call, repairing near-misses first.
 *
 * Providers vary in how strictly they honour tool schemas, and the common
 * failures are presentational rather than substantive: a list of ids where the
 * schema wants one scalar, a stray extra key, a status that differs only in
 * case. Rejecting those is expensive out of all proportion to the mistake —
 * it costs a retry turn, then a blocked bail-out, and (with escalation on) a
 * paid retry of the whole instruction on a pricier model, all because the
 * agent formatted a value it had already correctly obtained.
 *
 * So: repair what is unambiguously repairable, and report what was repaired.
 * Anything still invalid after coercion is a real disagreement about content
 * and is fed back to the model as before.
 */
export function validateReport(input: unknown): ReportValidation {
  const validate = validator();
  if (validate(input)) return { ok: true, report: input as Report };

  const { value, notes } = coerce(input);
  if (notes.length && validate(value)) {
    return { ok: true, report: value as unknown as Report, coerced: notes };
  }

  const error = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
  return { ok: false, error: error || 'report did not match the required schema' };
}

/** A scalar the schema accepts, or null when the input cannot be reduced to one. */
function toScalar(v: unknown): string | number | boolean | null {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return typeof v === 'string' && v.length > VALUE_CHARS ? v.slice(0, VALUE_CHARS - 1) + '…' : v;
  }
  // The frequent real-world miss: an array of ids/names where one scalar was asked for.
  const text = Array.isArray(v) ? v.map((x) => (x === null ? 'null' : String(x))).join(', ') : safeJson(v);
  return text.length > VALUE_CHARS ? text.slice(0, VALUE_CHARS - 1) + '…' : text;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function coerce(input: unknown): { value: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { value: {}, notes };
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof src.status === 'string') {
    const norm = src.status.trim().toLowerCase();
    if (norm !== src.status) notes.push(`status normalised to "${norm}"`);
    out.status = norm;
  } else if (src.status !== undefined) {
    out.status = src.status; // leave it: not something we can guess
  }

  if (typeof src.summary === 'string') {
    out.summary =
      src.summary.length > SUMMARY_CHARS ? src.summary.slice(0, SUMMARY_CHARS - 1) + '…' : src.summary;
    if (out.summary !== src.summary) notes.push('summary truncated');
  } else if (src.summary !== undefined) {
    out.summary = String(src.summary);
    notes.push('summary stringified');
  }

  if (src.details !== undefined) {
    out.details = typeof src.details === 'string' ? src.details : safeJson(src.details);
    if (out.details !== src.details) notes.push('details stringified');
  }

  if (typeof src.evidence === 'object' && src.evidence !== null && !Array.isArray(src.evidence)) {
    const ev = src.evidence as Record<string, unknown>;
    const evOut: Record<string, unknown> = {};

    if (ev.url !== undefined) {
      evOut.url = typeof ev.url === 'string' ? ev.url : String(ev.url);
      if (evOut.url !== ev.url) notes.push('evidence.url stringified');
    }

    if (ev.capturedDialogs !== undefined) {
      const list = Array.isArray(ev.capturedDialogs) ? ev.capturedDialogs : [ev.capturedDialogs];
      if (!Array.isArray(ev.capturedDialogs)) notes.push('evidence.capturedDialogs wrapped in an array');
      const strs = list.map((d) => (typeof d === 'string' ? d : safeJson(d)));
      if (strs.some((s, i) => s !== list[i])) notes.push('evidence.capturedDialogs entries stringified');
      evOut.capturedDialogs = strs;
    }

    if (typeof ev.values === 'object' && ev.values !== null && !Array.isArray(ev.values)) {
      const vals: Record<string, unknown> = {};
      const fixed: string[] = [];
      for (const [k, v] of Object.entries(ev.values as Record<string, unknown>)) {
        if (v === undefined) {
          fixed.push(k);
          continue; // JSON has no undefined; drop rather than invent a value
        }
        const scalar = toScalar(v);
        if (scalar !== v) fixed.push(k);
        vals[k] = scalar;
      }
      if (fixed.length) notes.push(`evidence.values flattened to scalars: ${fixed.join(', ')}`);
      evOut.values = vals;
    } else if (ev.values !== undefined) {
      notes.push('evidence.values dropped (not an object)');
    }

    const extras = Object.keys(ev).filter((k) => !['url', 'capturedDialogs', 'values'].includes(k));
    if (extras.length) notes.push(`unknown evidence key(s) dropped: ${extras.join(', ')}`);
    out.evidence = evOut;
  } else if (src.evidence !== undefined) {
    notes.push('evidence dropped (not an object)');
  }

  const rootExtras = Object.keys(src).filter(
    (k) => !['status', 'summary', 'details', 'evidence'].includes(k),
  );
  if (rootExtras.length) notes.push(`unknown key(s) dropped: ${rootExtras.join(', ')}`);

  return { value: out, notes };
}

/** One read/read_all the instruction performed, with its parsed result values. */
export interface ObservedRead {
  target: string;
  values: string[];
}

/** Most read values promoted into evidence per report — enough for any real page summary, a cap against read_all floods. */
const MAX_PROMOTED = 8;
const MIN_PROMOTED_LEN = 3;

/**
 * Deterministically promote read results the report MENTIONED but did not
 * structure. Compile keeps a recorded `read` only when its value appears in
 * `evidence.values` (that is the proof the read mattered) — but models often
 * put the value in the summary prose instead, so the read is dropped, no
 * replayable step survives, and the instruction compiles to no skill. This
 * closes that gap without gating: for each value a real read observed, if the
 * prose cites it verbatim (token boundaries) and `evidence.values` does not
 * already carry it, add it under a name derived from the read's target.
 * Mutates the report; returns the names added.
 */
export function backfillReadValues(report: Report, reads: ObservedRead[]): string[] {
  const values: Record<string, string | number | boolean | null> = { ...(report.evidence?.values ?? {}) };
  const present = new Set(Object.values(values).map((v) => String(v).trim()));
  const added: string[] = [];
  for (const { read, value: v } of promotableReads(report, reads)) {
    if (added.length >= MAX_PROMOTED) break;
    // A value whose only available name would be "value" is not worth
    // publishing. fwod18's 03-create promoted the column heading "Untaxed
    // Amount" and the status badge "New" under `value` and `value_2`,
    // because both reads targeted a snapshot ref and slug() can make no
    // name from `@e757`. Those became report outputs no later step would
    // ever reference, while the value seven steps DID need went unpinned.
    // Publishing page furniture under a meaningless name is strictly worse
    // than not publishing it: it is noise a replay must still reproduce.
    const base = slug(read.target);
    if (!base) continue;
    const name = uniqueName(base, values);
    values[name] = v;
    present.add(v);
    added.push(name);
  }
  if (added.length) (report.evidence ??= {}).values = values;
  return added;
}

/**
 * Read values the report CITED in prose but did not put in `evidence.values`,
 * paired with the read that observed them. The one filter both the deterministic
 * backfill and the naming retry work from, so they can never disagree about
 * which values are unnamed.
 */
function promotableReads(report: Report, reads: ObservedRead[]): Array<{ read: ObservedRead; value: string }> {
  const prose = `${report.summary} ${report.details ?? ''}`;
  const present = new Set(Object.values(report.evidence?.values ?? {}).map((v) => String(v).trim()));
  const out: Array<{ read: ObservedRead; value: string }> = [];
  const seen = new Set<string>();
  for (const read of reads) {
    for (const raw of read.values) {
      const v = raw.trim();
      if (v.length < MIN_PROMOTED_LEN || v.length > VALUE_CHARS || present.has(v) || seen.has(v)) continue;
      if (!new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(v)}(?![A-Za-z0-9])`).test(prose)) continue;
      seen.add(v);
      out.push({ read, value: v });
    }
  }
  return out;
}

/**
 * Values this instruction read off the page and then described in prose without
 * naming them in `evidence.values`.
 *
 * These are the values `backfillReadValues` would name from their SELECTOR, and
 * a selector is a bad name in a way that compounds. fwod24 recorded the odoo
 * quotation reference as `02-create.h1`, because the model returned
 * `evidence.values: {}` on five of nine instructions and every name in the flow
 * came from the backfill. Eleven flow references pointed at `h1`; on both
 * replays the bare `page.locator('h1')` read missed, nothing republished the
 * output, and four of seven steps fell to the model with
 * `unresolved reference(s): 02-create.h1`. The model had the right name — n3's
 * own recovery report called it `quotation_reference` — but run 1's naming is
 * permanent, so the good name never got in.
 *
 * Asking once, naming the values so the model only has to label them, costs one
 * cheap turn on the RECORDING run and buys a name every later run reproduces.
 * Strengthening the tool-schema wording did not work: this is the same ask made
 * where it cannot be skimmed past.
 */
export function unnamedReadValues(report: Report, reads: ObservedRead[]): string[] {
  if (report.status !== 'success') return [];
  return promotableReads(report, reads).slice(0, MAX_PROMOTED).map((p) => p.value);
}

/** A name derived from a read's target, or null when the target names nothing. */
function slug(target: string): string | null {
  const s = target.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  // A target that is a SNAPSHOT REF names nothing. `@e5322` slugged to
  // `e5322`, buildFlow minted {{03-report.e5322}} into three later steps of
  // fwgr10's flow, and no replay ever resolved it — a reference no human or
  // model would write, pointing at a handle that expires with the snapshot.
  // Same defect as the prose-identifier path, second site; fixing one and not
  // looking for the other is why this survived.
  //
  // A selector-derived slug (`dashboard_title`, `price_cell`) is meaningful
  // and is kept.
  if (!s || /^e\d+$/.test(s)) return null;
  return s;
}

function uniqueName(base: string, taken: Record<string, unknown>): string {
  if (!(base in taken)) return base;
  for (let i = 2; ; i++) if (!(`${base}_${i}` in taken)) return `${base}_${i}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Most scalars taken out of one composed value. A read_all dumped as JSON is a table, not evidence. */
const MAX_LEAVES = 8;

/**
 * Split a report value the model COMPOSED out of several page values into the
 * values it was made of.
 *
 * fwod17's 03-open reported two order lines as JSON blobs:
 *
 *   line_1: {"product":"Customizable Desk","qty":"3.00","unit_price":"750.00",…}
 *
 * Nothing downstream can use that. `captureReadBack` pins evidence values on
 * the page, and no element shows that string, so the six reads the run really
 * did were recorded with no label; `publishedOutputs` keeps a report value
 * only when it is a pure slot fill, and this one is a hand-built literal. So a
 * tier-A replay correctly dropped it — and took `{{03-open.line_1#qty}}` with
 * it, sending four steps of the flow to recovery for values sitting on screen.
 *
 * A composite is really several values, so make it several. Each leaf is a
 * string a real element shows, which means read-back can pin it, the read gets
 * a label, and the flow references `{{03-open.line_1_qty}}` — an output every
 * zero-model replay republishes from its OWN page.
 *
 * The composite itself is dropped: keeping it would leave the unreferencable
 * form available to reference. Mutates the report; returns the names added.
 */
export function flattenComposedValues(report: Report): string[] {
  const values = report.evidence?.values;
  if (!values) return [];
  const added: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (typeof raw !== 'string' || !/^\s*[[{]/.test(raw)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // prose that merely opens with a bracket
    }
    const leaves = leavesOf(parsed);
    // Nothing to split, or a table rather than a record: leave it whole.
    if (!leaves.length || leaves.length > MAX_LEAVES) continue;
    delete values[key];
    for (const [path, value] of leaves) {
      const name = uniqueName(`${key}_${slug(path)}`, values);
      values[name] = value;
      added.push(name);
    }
  }
  return added;
}

/** Scalar leaves of a parsed value, two levels deep, as [path, text] pairs. */
function leavesOf(node: unknown, prefix = '', depth = 0): [string, string][] {
  if (node === null || typeof node !== 'object') {
    const text = String(node ?? '').trim();
    return prefix && text ? [[prefix, text]] : [];
  }
  if (depth >= 2) return [];
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i + 1), v] as const) : Object.entries(node);
  return entries.flatMap(([k, v]) => leavesOf(v, prefix ? `${prefix}_${k}` : k, depth + 1));
}

/** Record identifiers cited in prose per report, and their shape. */
const MAX_PROSE_IDS = 3;
const MIN_PROSE_ID_LEN = 4;
const MAX_PROSE_ID_LEN = 40;

/**
 * Identifier-like tokens the report's prose cites but `evidence.values` does
 * not carry: an order reference (S00021), a ticket ref (RD-1015), a generated
 * uid. Mixed letters AND digits is the test — it admits every app-minted
 * reference seen across the bench targets while rejecting prices ("125.00"),
 * counts, and ordinary words.
 *
 * These are the values later flow steps address the run's own record BY, so a
 * step that leaves one unstructured strands every later step on the RECORDED
 * run's record: fwod5-n2/n3 cancelled sales order S00021 — run n1's order —
 * because the confirm step reported its reference only in prose and the flow
 * had no reference to thread. The caller pins them on the live page (see
 * captureReadBack) so a replay re-reads its own.
 */
export function proseIdentifiers(report: Report): string[] {
  const prose = `${report.summary} ${report.details ?? ''}`;
  const present = new Set(Object.values(report.evidence?.values ?? {}).map((v) => String(v).trim()));
  const out: string[] = [];
  for (const m of prose.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*/g)) {
    if (out.length >= MAX_PROSE_IDS) break;
    const v = m[0].replace(/[.\-_]+$/, '');
    if (v.length < MIN_PROSE_ID_LEN || v.length > MAX_PROSE_ID_LEN) continue;
    if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) continue;
    if (present.has(v) || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

/** Add a value to a report's evidence under a fresh name derived from `base`. */
export function addEvidenceValue(report: Report, base: string, value: string): string {
  const values: Record<string, string | number | boolean | null> = { ...(report.evidence?.values ?? {}) };
  // The caller vouched for this one by naming it explicitly ("ref"), so an
  // unusable base falls back rather than dropping the value.
  const name = uniqueName(slug(base) ?? 'value', values);
  values[name] = value;
  (report.evidence ??= {}).values = values;
  return name;
}
