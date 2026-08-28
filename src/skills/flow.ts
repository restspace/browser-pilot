import fs from 'node:fs';
import path from 'node:path';
import type { RecordedEntry, RecordedInstruction, RecordedReport } from '../daemon/recorder.js';
import { rootDir } from '../shared/paths.js';
import { escapeRe, urlParts } from './compile.js';
import { identifierLike } from './ledger.js';

/**
 * A flow is the resolved path a session took: the instructions the caller
 * actually issued, in order, each pinned to the skill it produced and to the
 * values it read back. It is NOT authored up front — it is exported from a
 * recorded `--learn` session, so the caller's mid-run decisions are captured
 * as steps like any other. Replaying a flow (`run`) needs no caller: each step
 * replays its skill, repairs on the cheap model if a step drifted, and only
 * escalates or halts when a step genuinely cannot complete.
 */
export interface Flow {
  name: string;
  origin: string;
  /** Where the browser must start (the session's first observed url). */
  startUrl: string;
  /** Run variables the caller declared; the export turned their values into {{name}} refs. */
  vars: string[];
  steps: FlowStep[];
  provenance: { session: string; created: string; model?: string };
}

export interface FlowStep {
  id: string;
  /** The instruction as issued, with {{var}} and {{step.output}} references substituted in. */
  instruction: string;
  /** The skill this instruction used, replayed first on `run`. Re-pinned when a repair validates. */
  skill?: string;
  /**
   * The skill's slot bindings, captured at record time so replay does not have
   * to re-derive them from the (reworded) instruction. Values may hold
   * {{var}}/{{step.output}} references, resolved the same way as the instruction.
   */
  params?: Record<string, string>;
  /** Report values this step produced, named, so later steps can reference them. */
  outputs: string[];
  /** Values observed at record time, kept for reference and as soft assertions. */
  recorded: Record<string, string>;
}

export function flowsDir(): string {
  return process.env.BROWSER_PILOT_FLOWS_DIR || path.join(rootDir(), 'flows');
}

function flowFile(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(flowsDir(), `${safe}.json`);
}

export function saveFlow(flow: Flow): string {
  const dir = flowsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = flowFile(flow.name);
  fs.writeFileSync(file, JSON.stringify(flow, null, 2));
  return file;
}

export function loadFlow(nameOrPath: string): Flow | null {
  const candidates = [nameOrPath, flowFile(nameOrPath)];
  for (const c of candidates) {
    try {
      return JSON.parse(fs.readFileSync(c, 'utf8')) as Flow;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function listFlows(): Flow[] {
  let names: string[];
  try {
    names = fs.readdirSync(flowsDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => loadFlow(path.join(flowsDir(), n))).filter((f): f is Flow => Boolean(f));
}

/**
 * Build a flow from one session's recording.
 *
 * References are resolved in two passes so a step can never reference a value
 * that has not been produced yet:
 *  1. Declared run variables (`vars`) → `{{name}}`, everywhere they occur.
 *  2. A value that equals an *earlier* step's named output → `{{stepId.output}}`.
 * Anything left literal is a constant the caller typed, and stays literal.
 */
export function buildFlow(
  entries: RecordedEntry[],
  opts: {
    name: string;
    origin: string;
    startUrl: string;
    vars: Record<string, string>;
    session: string;
    model?: string;
    now?: string;
    /** Given a skill id and the raw recorded instruction, return the slot bindings. */
    bind?: (skillId: string, instruction: string) => Record<string, string> | null;
  },
): Flow | null {
  const groups = groupByInstruction(entries);
  if (!groups.length) return null;

  const steps: FlowStep[] = [];
  const produced: { stepId: string; output: string; value: string }[] = [];
  const seenUrl = new Set(urlParts(opts.startUrl).map((p) => p.value));
  const varEntries = Object.entries(opts.vars).filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length);

  groups.forEach((g, i) => {
    const id = stepId(g.instruction.text, i);
    let text = g.instruction.text;
    for (const [name, value] of varEntries) text = replaceToken(text, value, `{{${name}}}`);
    // Reference earlier outputs (longest values first so nested ids resolve).
    for (const p of [...produced].sort((a, b) => b.value.length - a.value.length)) {
      if (p.value.length >= 2) text = replaceToken(text, p.value, `{{${p.stepId}.${p.output}}}`);
    }
    const outputs = Object.keys(g.report?.values ?? {});
    // Capture the skill's slot bindings, referencized like the instruction, so
    // replay binds params from the flow rather than re-parsing the wording.
    let params: Record<string, string> | undefined;
    if (g.report?.skill && opts.bind) {
      const raw = opts.bind(g.report.skill, g.instruction.text);
      if (raw) {
        params = {};
        for (const [k, v] of Object.entries(raw)) {
          let rv = v;
          for (const [name, value] of varEntries) rv = replaceToken(rv, value, `{{${name}}}`);
          for (const pr of [...produced].sort((a, b) => b.value.length - a.value.length)) {
            if (pr.value.length >= 2) rv = replaceToken(rv, pr.value, `{{${pr.stepId}.${pr.output}}}`);
          }
          params[k] = rv;
        }
      }
    }
    steps.push({
      id,
      instruction: text,
      ...(g.report?.skill ? { skill: g.report.skill } : {}),
      ...(params ? { params } : {}),
      outputs,
      recorded: g.report?.values ?? {},
    });
    // Provenance (PLAN-replay-v2): url parts this step MINTED (absent from
    // every earlier url) are outputs too — a later step's recorded literal
    // equal to one becomes {{stepId.url.<part>}}, re-bound each run from
    // where the replay's own browser lands. Same guards as report outputs:
    // length >= 4, first appearance wins.
    //
    // Url parts go into `produced` BEFORE report values, and a report value
    // that duplicates a minted part is not referencized under its report
    // name: a zero-model (tier-A) replay synthesizes its report from live
    // read-backs only and honestly DROPS recorded values it could not
    // re-observe, so a {{step.reportName}} ref dies exactly when the replay
    // is at its best — while {{step.url.<part>}} is published by every
    // replay unconditionally. fwgr-n2/n3 halted on precisely this: the
    // recorded instructions referenced {{02-create.dashboard_uid}}, the
    // tier-A replay's report legitimately omitted it, and recovery ran with
    // the uid blanked until it turn-capped.
    const minted: { stepId: string; output: string; value: string }[] = [];
    if (g.endUrl) {
      // The WHOLE url, not only its parts. A step's params often carry it
      // entire ("On ticket {{v1}} (url {{v2}})"), and without provenance that
      // literal gets referencized under whatever the RECORDING run's report
      // happened to name it. fwrd21l shows the cost: 02-add's model report
      // named it `url`, so the flow said {{02-add.url}} — then on replay 02-add
      // went tier A, synthesizeReport honestly dropped a recorded url it could
      // not re-observe, the ref went unresolved, and FOUR later steps skipped
      // the zero-model path entirely. Exactly the fwgr-n2/n3 failure the parts
      // loop below was written for, one level up.
      if (!produced.some((p) => p.value === g.endUrl) && !varEntries.some(([, v]) => v === g.endUrl)) {
        minted.push({ stepId: id, output: 'url', value: g.endUrl });
      }
      for (const part of urlParts(g.endUrl)) {
        const fresh = !seenUrl.has(part.value);
        seenUrl.add(part.value);
        // Looser than compile-level derived params, which demand a digit:
        // grafana mints digitless uids ("cfwcsdxqdjabkf" sank fwgr2), so
        // identifierLike() accepts a long word too. It still refuses short
        // route words — "tickets" out of a url was being substituted into
        // fwrd8's verify prose ("on the {{01-open.url.h0}} list").
        if (!fresh || !identifierLike(part.value)) continue;
        if (produced.some((p) => p.value === part.value) || varEntries.some(([, v]) => v === part.value)) continue;
        minted.push({ stepId: id, output: `url.${part.label}`, value: part.value });
      }
    }
    produced.push(...minted);
    for (const [output, value] of Object.entries(g.report?.values ?? {})) {
      if (typeof value !== 'string' || !value) continue;
      if (minted.some((m) => m.value === value)) continue;
      produced.push({ stepId: id, output, value });
      // An id can be minted where no url ever carries it: an app that saves
      // over its own API answers with JSON, and the run reads that answer
      // back rather than navigating. fwgr5 created its dashboard exactly so —
      // the uid existed only inside the response body — and every later step
      // kept n1's literal uid, which is what made those steps re-derive it on
      // the cheap model on every replay. Publish the JSON's scalar leaves
      // under `{{step.output#path}}`: a tier-A replay re-observes the read,
      // so the path re-reads THIS run's value.
      for (const leaf of jsonLeaves(value)) {
        if (produced.some((p) => p.value === leaf.value) || varEntries.some(([, v]) => v === leaf.value)) continue;
        produced.push({ stepId: id, output: `${output}#${leaf.path}`, value: leaf.value });
      }
    }
  });

  return {
    name: opts.name,
    origin: opts.origin,
    startUrl: opts.startUrl,
    vars: Object.keys(opts.vars),
    steps,
    provenance: { session: opts.session, created: opts.now ?? new Date().toISOString(), ...(opts.model ? { model: opts.model } : {}) },
  };
}

interface Group {
  instruction: RecordedInstruction;
  report?: RecordedReport;
  /** Where the browser ended up after this instruction's last navigation. */
  endUrl?: string;
}

function groupByInstruction(entries: RecordedEntry[]): Group[] {
  const groups: Group[] = [];
  for (const e of entries) {
    if (e.k === 'instruction') {
      // An escalation continuation (recorded under the original wording,
      // marked `resume`) is the same instruction still in flight: keep the
      // predecessor's group open so its clean start context survives and the
      // continuation's report/endUrl land on it. A resume with no same-text
      // predecessor (truncated recording) stands alone.
      const prev = groups[groups.length - 1];
      if (e.resume && prev?.instruction.text === e.text) continue;
      groups.push({ instruction: e });
    } else if (e.k === 'report' && groups.length) groups[groups.length - 1].report = e;
    else if (e.k === 'step' && groups.length && e.diff?.url) groups[groups.length - 1].endUrl = e.diff.url;
  }
  // Only steps that ended in a success are worth replaying; a blocked/failed
  // instruction the caller worked around is not part of the resolved path.
  return groups.filter((g) => g.report?.status === 'success');
}

function stepId(text: string, i: number): string {
  const verb = (/\b(sign in|log ?in|create|add|edit|change|set|delete|remove|archive|open|verify|find|report)\b/i.exec(text)?.[1] ?? 'step')
    .toLowerCase()
    .replace(/\s+/g, '');
  return `${String(i + 1).padStart(2, '0')}-${verb}`;
}

/** Replace a value on token boundaries, leaving substrings of longer words alone. */
function replaceToken(text: string, value: string, marker: string): string {
  if (!value) return text;
  // Underscores bind: `o_form_view_group` is ONE identifier, so a var whose
  // value is "form" must not rewrite its middle (fwod5 shipped exactly that
  // corruption). Hyphens do not bind — a runid prefix in "x7-bench-dashboard"
  // is a reference worth threading.
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(value)}(?![A-Za-z0-9_])`, 'g');
  // Never substitute INSIDE a reference already placed by an earlier pass: a
  // provenance value that happens to be a common word ("form") rewrote the
  // middle of an output NAME, and fwod5 shipped steps referencing
  // `{{02-create.o_{{01-open.url.q.view_type}}_view_o_group_tabl}}` — a ref
  // that can never resolve. Split on markers, rewrite only the gaps.
  return text
    .split(/(\{\{[^{}]*\}\})/g)
    .map((piece) => (piece.startsWith('{{') && piece.endsWith('}}') ? piece : piece.replace(re, marker)))
    .join('');
}

/**
 * Name the cause of a flow step's recovery, for the progress line and drift
 * telemetry. ALL causes now run cheap-first with the strong model as
 * escalation-on-blocked: the fwrd4l sweep showed the session model rescuing
 * every recovery — replay-failed ones included — at a fraction of the strong
 * model's rate ($0.041 warm vs $0.104 when the same steps routed straight to
 * the strong tier), and a replay refusal is usually a binding problem (a
 * stale template), not the genuine drift the straight-to-strong route was
 * priced for. The strong model is still one blocked report away.
 */
export function recoveryRoute(
  step: Pick<FlowStep, 'skill'>,
  unresolved: boolean,
): { easy: boolean; cause: 'no-skill' | 'unthreaded-ref' | 'replay-failed' } {
  if (!step.skill) return { easy: true, cause: 'no-skill' };
  if (unresolved) return { easy: true, cause: 'unthreaded-ref' };
  return { easy: true, cause: 'replay-failed' };
}

/**
 * Export-time reference lint (PLAN-no-skill-steps case 4a): find every
 * `{{stepId.output}}` reference whose producing step cannot re-publish the
 * value deterministically on replay, and say so while the author can still do
 * something about it. `url` and its `url.*` parts are exempt — every replay re-binds them
 * from where its own browser lands. `publishes` answers, for a skill id, which
 * output names a tier-A replay re-observes (labelled reads + param-derived
 * report values); null when the skill is not in the store. Advisory only:
 * replay behaviour is unchanged — an unthreaded ref already routes to cheap
 * recovery — this surfaces the debt at build time instead of replay time.
 */
export function lintFlowRefs(flow: Flow, publishes: (skillId: string) => string[] | null): string[] {
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const step of flow.steps) {
    const texts = [step.instruction, ...Object.values(step.params ?? {})];
    for (const text of texts) {
      for (const m of text.matchAll(/\{\{([\w-]+)\.([\w.#-]+)\}\}/g)) {
        const [, sid, out] = m;
        if (out === 'url' || out.startsWith('url.')) continue;
        const producer = byId.get(sid);
        if (!producer || seen.has(`${sid}.${out}`)) continue;
        seen.add(`${sid}.${out}`);
        const pubs = producer.skill ? publishes(producer.skill) : [];
        // A JSON-path ref (`body#dashboard.uid`) lives or dies with the read
        // that publishes `body`; the path itself is applied after the fact.
        if (pubs === null || pubs.includes(out.split('#')[0])) continue;
        warnings.push(
          `{{${sid}.${out}}} (used by ${step.id}) can only be re-observed by model recovery — ` +
            `consider re-recording so the value is read from the page.`,
        );
      }
    }
  }
  return warnings;
}

/**
 * One step output, with support for a JSON path suffix: `body#dashboard.uid`
 * reads the `body` output, parses it as JSON, and walks the path. That is how
 * an id an app only ever returned in a response body gets threaded — see the
 * jsonLeaves() publication in buildFlow.
 */
export function lookupOutput(outputs: Record<string, Record<string, string>>, sid: string, out: string): string | undefined {
  const hash = out.indexOf('#');
  if (hash < 0) return outputs[sid]?.[out];
  const base = outputs[sid]?.[out.slice(0, hash)];
  if (base === undefined) return undefined;
  let node: unknown;
  try {
    node = JSON.parse(base);
  } catch {
    return undefined;
  }
  for (const key of out.slice(hash + 1).split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' || typeof node === 'number' ? String(node) : undefined;
}

/** Fill {{var}} and {{step.output}} references from run vars and prior outputs. */
export function resolveInstruction(step: FlowStep, vars: Record<string, string>, outputs: Record<string, Record<string, string>>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = step.instruction.replace(/\{\{([\w.#-]+)\}\}/g, (m, ref: string) => {
    if (ref.includes('.')) {
      const dot = ref.indexOf('.');
      const [sid, out] = [ref.slice(0, dot), ref.slice(dot + 1)];
      const v = lookupOutput(outputs, sid, out);
      if (v === undefined) {
        missing.push(ref);
        return m;
      }
      return v;
    }
    if (ref in vars) return vars[ref];
    missing.push(ref);
    return m;
  });
  return { text, missing };
}

/**
 * Like resolveInstruction, but for the recovery path: fill every reference that
 * can be filled and blank the rest (rather than leaving `{{...}}` in the text),
 * so the strong model gets a readable instruction built from what IS known —
 * e.g. the ticket title even when its id could not be threaded.
 */
export function softResolveInstruction(step: FlowStep, vars: Record<string, string>, outputs: Record<string, Record<string, string>>): string {
  return step.instruction
    .replace(/\{\{([\w.#-]+)\}\}/g, (m, ref: string) => {
      if (ref.includes('.')) {
        const dot = ref.indexOf('.');
        const [sid, out] = [ref.slice(0, dot), ref.slice(dot + 1)];
        return lookupOutput(outputs, sid, out) ?? '';
      }
      return ref in vars ? vars[ref] : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Resolve a step's stored param bindings from run vars and prior outputs. */
export function resolveStepParams(
  step: FlowStep,
  vars: Record<string, string>,
  outputs: Record<string, Record<string, string>>,
): { params: Record<string, string>; missing: string[] } | null {
  if (!step.params) return null;
  const params: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, tmpl] of Object.entries(step.params)) {
    params[k] = tmpl.replace(/\{\{([\w.#-]+)\}\}/g, (m, ref: string) => {
      if (ref.includes('.')) {
        const dot = ref.indexOf('.');
        const [sid, out] = [ref.slice(0, dot), ref.slice(dot + 1)];
        const v = lookupOutput(outputs, sid, out);
        if (v === undefined) { missing.push(ref); return m; }
        return v;
      }
      if (ref in vars) return vars[ref];
      missing.push(ref);
      return m;
    });
  }
  return { params, missing };
}

/** Cap on JSON leaves published per read value, and how deep to walk. */
const MAX_JSON_LEAVES = 12;
const MAX_JSON_DEPTH = 4;


/**
 * Url parts of `url` that are identifier-like and that this session has not
 * seen before — the values it just minted. First appearance wins, so the
 * start url's own parts (and anything already banked) never qualify.
 */
export function freshUrlIds(url: string, seen: Set<string>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const part of urlParts(url)) {
    // Three characters, not four: repair-desk's record ids are "t15", and at
    // a four-character floor fwrd16 left a literal `#/tickets/t15` in six
    // flow steps. identifierLike() still does the real work — a three-letter
    // route word carries no digit and no separator, so it never qualifies.
    if (seen.has(part.value) || !identifierLike(part.value)) continue;
    seen.add(part.value);
    out.push(part);
  }
  return out;
}

/** Scalar leaves of a JSON read value, as `path` (dot/index joined) + value. */
export function jsonLeaves(text: string): { path: string; value: string }[] {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return [];
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: { path: string; value: string }[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= MAX_JSON_LEAVES || depth > MAX_JSON_DEPTH) return;
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (typeof node !== 'string' && typeof node !== 'number') return;
    const value = String(node);
    if (value.length > 120 || !identifierLike(value)) return;
    if (!path) return;
    out.push({ path, value });
  };
  walk(root, '', 0);
  return out;
}
