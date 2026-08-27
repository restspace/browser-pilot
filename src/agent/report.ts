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
  const prose = `${report.summary} ${report.details ?? ''}`;
  const values: Record<string, string | number | boolean | null> = { ...(report.evidence?.values ?? {}) };
  const present = new Set(Object.values(values).map((v) => String(v).trim()));
  const added: string[] = [];
  for (const read of reads) {
    for (const raw of read.values) {
      if (added.length >= MAX_PROMOTED) break;
      const v = raw.trim();
      if (v.length < MIN_PROMOTED_LEN || v.length > VALUE_CHARS || present.has(v)) continue;
      const cited = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(v)}(?![A-Za-z0-9])`).test(prose);
      if (!cited) continue;
      const name = uniqueName(slug(read.target), values);
      values[name] = v;
      present.add(v);
      added.push(name);
    }
  }
  if (added.length) (report.evidence ??= {}).values = values;
  return added;
}

function slug(target: string): string {
  const s = target.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return s || 'read';
}

function uniqueName(base: string, taken: Record<string, unknown>): string {
  if (!(base in taken)) return base;
  for (let i = 2; ; i++) if (!(`${base}_${i}` in taken)) return `${base}_${i}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const name = uniqueName(slug(base), values);
  values[name] = value;
  (report.evidence ??= {}).values = values;
  return name;
}
