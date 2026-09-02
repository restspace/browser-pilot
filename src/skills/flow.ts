import fs from 'node:fs';
import path from 'node:path';
import type { RecordedEntry, RecordedInstruction, RecordedReport } from '../daemon/recorder.js';
import { rootDir } from '../shared/paths.js';
import { escapeRe, urlParts } from './compile.js';
import { idPositionPart, identifierLike } from './ledger.js';

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
  /**
   * This step's recording instruction did NOT report success — it was adopted
   * because the session's resolved path demonstrably ran through the state it
   * produced (see resolveGroups). It replays model-first with extra budget,
   * and a non-success replay of it does not halt the flow: the recording's
   * own path also continued from this instruction's partial state.
   */
  adopted?: boolean;
  /**
   * Cross-run evidence about this step's outputs: for each output name, how
   * often a later run produced the SAME value here and how often it differed.
   *
   * This is what replaces reading a value's characters to decide whether it
   * names a record. Run 1 cannot know: "New (unsaved)" and "S00021" are both
   * just strings a step reported. Run 2 settles it by producing its own value
   * for the same output — Odoo says "New (unsaved)" again (app furniture) and
   * "S00023" (this run's record). Same mechanism as a locator candidate's
   * `seen: {hit, miss}`; see PLAN-evidence-over-shape.md.
   */
  outputEvidence?: Record<string, { same: number; differed: number }>;
}

/**
 * Outputs a later run may substitute as a LITERAL when the producing step did
 * not republish them: `{{sid.out}}` → the recorded value.
 *
 * One demonstration of difference is permanent. A value that changed once
 * names a record, and being wrong in that direction is the silent failure —
 * a step acting on the recording run's record while reporting success —
 * whereas being wrong the other way costs a recovery turn. So `differed` is a
 * veto no amount of later agreement lifts.
 */
export function stableOutputs(flow: Flow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const step of flow.steps) {
    for (const [name, ev] of Object.entries(step.outputEvidence ?? {})) {
      if (ev.differed > 0 || ev.same < 1) continue;
      const value = step.recorded?.[name];
      if (typeof value === 'string' && value) out[`${step.id}.${name}`] = value;
    }
  }
  return out;
}

/**
 * Record what a replay of `step` produced, against what the recording run saw.
 * Only outputs BOTH runs reported can be compared — a tier-A replay honestly
 * drops what it could not re-observe, and silence is not disagreement.
 * Returns the names whose verdict changed, for progress reporting.
 */
export function noteOutputEvidence(step: FlowStep, reported: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const [name, recorded] of Object.entries(step.recorded ?? {})) {
    const seen = reported[name];
    if (typeof seen !== 'string' || !seen || typeof recorded !== 'string' || !recorded) continue;
    const ev = (step.outputEvidence ??= {})[name] ?? { same: 0, differed: 0 };
    const agrees = seen.trim() === recorded.trim();
    const wasStable = ev.differed === 0 && ev.same >= 1;
    if (agrees) ev.same += 1;
    else ev.differed += 1;
    step.outputEvidence[name] = ev;
    if (wasStable !== (ev.differed === 0 && ev.same >= 1)) changed.push(name);
    else if (ev.same + ev.differed === 1) changed.push(name);
  }
  return changed;
}

export function flowsDir(): string {
  return process.env.SLEEP_WALKER_FLOWS_DIR || path.join(rootDir(), 'flows');
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

/**
 * A flow the export REFUSED, written where nothing will replay it.
 *
 * Refusing is right — a flow carrying a run value in a locator quietly does
 * its work on the wrong record — but throwing the recording away with it is
 * not. fwrd23l cost 37 minutes and $0.26 to record and left nothing at all
 * behind, and a cloud run is dearer. The `.rejected.json` suffix keeps it out
 * of listFlows — which is excluded explicitly, since `.rejected.json` ends in
 * `.json` too — while leaving it for verify-artifacts and for a human to read.
 */
export function saveRejectedFlow(flow: Flow, reason: string): string {
  const dir = flowsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = flowFile(flow.name).replace(/\.json$/, '.rejected.json');
  fs.writeFileSync(file, JSON.stringify({ rejected: reason, flow }, null, 2));
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
    names = fs.readdirSync(flowsDir()).filter((n) => n.endsWith('.json') && !n.endsWith('.rejected.json'));
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
  const groups = resolveGroups(groupByInstruction(entries));
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
      if (p.value.length >= 2 && !coincidental(text, p.value)) text = replaceToken(text, p.value, `{{${p.stepId}.${p.output}}}`);
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
            if (pr.value.length >= 2 && !coincidental(rv, pr.value)) rv = replaceToken(rv, pr.value, `{{${pr.stepId}.${pr.output}}}`);
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
      ...(g.adopted ? { adopted: true } : {}),
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
        // Position is evidence here too: a `q.id` part is a record id
        // whatever its length — odoo's `#id=44` failed the shape test and the
        // recording's record rode into fwod27's replays (see idPositionPart).
        if (!fresh || (!identifierLike(part.value) && !idPositionPart(part))) continue;
        if (produced.some((p) => p.value === part.value) || varEntries.some(([, v]) => v === part.value)) continue;
        minted.push({ stepId: id, output: `url.${part.label}`, value: part.value });
      }
    }
    produced.push(...minted);
    for (const [output, value] of Object.entries(g.report?.values ?? {})) {
      if (typeof value !== 'string' || !value) continue;
      if (minted.some((m) => m.value === value)) continue;
      // EVERY reported value becomes a reference. Run 1 makes no judgement
      // about which of them name a record, because it cannot: "New (unsaved)"
      // and "S00021" are both just strings a step reported, and the question
      // — does the app produce this again, or was it specific to this run? —
      // is about behaviour ACROSS runs.
      //
      // A previous cut of this gated on identifierLike, which reads the
      // characters. That is the failure this plan exists to remove: a record
      // id that does not look like one would be left literal and every replay
      // would act on run 1's record while reporting success.
      //
      // So reference everything, which is the safe default (an unresolved
      // reference costs a recovery turn, never a wrong record), and let run 2
      // demote the ones it demonstrates are app furniture — see
      // noteOutputEvidence/stableOutputs and PLAN-evidence-over-shape.md.
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
  /** How many state-changing tool steps this instruction ran. */
  mutations: number;
  /** The tool of this instruction's first recorded step. */
  firstTool?: string;
  /** Set by resolveGroups: kept despite a non-success report — see there. */
  adopted?: boolean;
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
      groups.push({ instruction: e, mutations: 0 });
    } else if (e.k === 'report' && groups.length) groups[groups.length - 1].report = e;
    else if (e.k === 'step' && groups.length) {
      const g = groups[groups.length - 1];
      if (e.diff?.url) g.endUrl = e.diff.url;
      if (!g.firstTool) g.firstTool = e.tool;
      if (MUTATING_TOOLS.has(e.tool)) g.mutations += 1;
    }
  }
  return groups;
}

/** Same page, ignoring query and hash — view state, not location. */
function samePage(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && decodeURIComponent(ua.pathname) === decodeURIComponent(ub.pathname);
  } catch {
    return false;
  }
}

/**
 * The groups that ARE the resolved path, in order.
 *
 * Success groups, obviously. But dropping every other group loses work the
 * session provably built on: fwgr14's "create a NEW dashboard. Add a Stat
 * panel..." blocked on the turn budget, then failed on escalation — yet both
 * attempts HAD created the dashboard, and the very next (successful)
 * instruction began "The browser is on an unsaved new Grafana dashboard..."
 * and saved it. The exported flow started on in-memory state no replay could
 * reach and scored 1/6 on every replay. Same class as fwod27, where the
 * dropped create meant no step produced the record and its id could not be
 * referencized.
 *
 * So a non-success group is ADOPTED when the recording itself testifies its
 * work is part of the path:
 *   1. it changed the app (ran mutating tools) — an observing group that
 *      blocked contributed nothing a replay needs;
 *   2. the next kept group picked up exactly where it left off — issued on
 *      the same page the group ended on, and not opening with a `goto`
 *      (a successor that navigates away first is the workaround case, where
 *      the drop is correct).
 * Scanned right-to-left so a chain of continuations adopts as a chain.
 *
 * Marks `adopted` on the group (unbankedMutations reads it) and returns the
 * kept groups.
 */
function resolveGroups(groups: Group[]): Group[] {
  const kept = groups.map((g) => g.report?.status === 'success');
  for (let i = groups.length - 2; i >= 0; i--) {
    if (kept[i]) continue;
    const g = groups[i];
    const next = groups[i + 1];
    if (!g.report || !g.mutations || !kept[i + 1]) continue;
    if (next.firstTool === 'goto') continue;
    if (!samePage(g.endUrl, next.instruction.url)) continue;
    g.adopted = true;
    kept[i] = true;
  }
  return groups.filter((_, i) => kept[i]);
}

/** Tools that CHANGE the app, as opposed to observing it. */
const MUTATING_TOOLS = new Set(['click', 'dblclick', 'right_click', 'modifier_click', 'fill', 'type', 'press', 'select', 'check', 'drag', 'upload']);

/**
 * Instructions that CHANGED the app but did not report success AND were not
 * adopted, so their work contributed nothing to the flow.
 *
 * resolveGroups now adopts the fwgr13/fwgr14 shape (the next kept group
 * carried straight on from the blocked work), so what remains here is the
 * genuinely dropped case: mutating work the session abandoned or worked
 * around. That drop is right — but it must not be silent, because whether the
 * workaround actually replaced the work is a judgement only the person
 * reading the export can make.
 */
/**
 * Flow instructions that quote a DATABASE ID this recording minted.
 *
 * The one channel no leak guard reads is the instruction prose itself. In
 * fwod27 the recording-time orchestrator wrote "You are on an Odoo contact
 * form for res.partner id 44" — the id of the record ITS run created (in a
 * blocked instruction, so no flow step produces the value and nothing can be
 * referencized). Locator and navigation guards all passed; both replays
 * navigated to record 44, which the reset had deleted, and halted at step 2
 * with 0/6.
 *
 * Scans EVERY recorded url (blocked instructions included — that is where
 * fwod27's id was minted) for id-position parts, then flags any flow
 * instruction that still quotes one as a literal id. Warn-level: the flow
 * still exports, but the person who can re-record is told while it is cheap.
 */
export function staleInstructionIds(entries: RecordedEntry[], flow: Flow): string[] {
  const minted = new Set<string>();
  for (const e of entries) {
    const url = e.k === 'step' ? e.diff?.url : e.k === 'instruction' ? e.url : undefined;
    if (!url) continue;
    for (const part of urlParts(url)) if (idPositionPart(part)) minted.add(part.value);
  }
  if (!minted.size) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of flow.steps) {
    for (const m of step.instruction.matchAll(/\bid\s*[:#]?\s*(\d{1,10})\b/gi)) {
      if (!minted.has(m[1]) || seen.has(`${step.id}:${m[1]}`)) continue;
      seen.add(`${step.id}:${m[1]}`);
      out.push(
        `${step.id}'s instruction quotes record id ${m[1]} — a database id this recording minted, so every replay ` +
          `will act on the RECORDING run's record (deleted by the next reset). Re-record with instructions that ` +
          `name records by what is on screen (a name or reference), never by internal id.`,
      );
    }
  }
  return out;
}

export function unbankedMutations(entries: RecordedEntry[]): string[] {
  const groups = groupByInstruction(entries);
  resolveGroups(groups); // marks `adopted` in place
  const out: string[] = [];
  for (const g of groups) {
    if (g.report?.status === 'success' || g.adopted || !g.mutations) continue;
    const text = g.instruction.text;
    out.push(
      `instruction "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}" ran ${g.mutations} state-changing step(s) ` +
        `but reported ${g.report ? g.report.status : 'nothing'} — its work is NOT in the flow`,
    );
  }
  return out;
}

function stepId(text: string, i: number): string {
  const verb = (/\b(sign in|log ?in|create|add|edit|change|set|delete|remove|archive|open|verify|find|report)\b/i.exec(text)?.[1] ?? 'step')
    .toLowerCase()
    .replace(/\s+/g, '');
  return `${String(i + 1).padStart(2, '0')}-${verb}`;
}

/** Replace a value on token boundaries, leaving substrings of longer words alone. */
/**
 * The value only LOOKS like this reference: a common word matching inside a
 * hyphenated compound that means something else.
 *
 * fwgr8 reported `tags: "bench"` and its dashboard slug was
 * `fwgr8-n1-bench-dashboard`, so four later steps had their url rewritten to
 * `{{runid}}-{{04-open.tags}}-dashboard`. The "bench" in that slug comes from
 * the dashboard's NAME, not from its tags; the two agreed by coincidence on
 * the recording run and would not on any other. Every one of those refs then
 * failed to resolve and cost its step the zero-model path.
 *
 * Hyphens deliberately do not bind in replaceToken, because a runid prefix in
 * `x7-bench-dashboard` IS worth threading. The distinction is what the value
 * is: a minted identifier is specific enough that matching inside a compound
 * is evidence, while a common word is not. So a non-identifier must stand
 * alone to be referencized.
 */
function coincidental(text: string, value: string): boolean {
  if (identifierLike(value)) return false;
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(value)}(?![A-Za-z0-9_-])`).test(text) === false;
}

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
  step: Pick<FlowStep, 'skill' | 'adopted'>,
  unresolved: boolean,
): { easy: boolean; cause: 'no-skill' | 'unthreaded-ref' | 'replay-failed' | 'adopted' } {
  if (step.adopted && !step.skill) return { easy: true, cause: 'adopted' };
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
/**
 * The outputs a step's END URL publishes: the whole url, plus every part
 * specific enough to be a reference.
 *
 * ONE function, because the producer and the consumer disagreeing is a silent
 * dead reference. buildFlow mints `{{step.url.h1}}` for any part that is
 * `identifierLike` (three characters is enough — repair-desk's ids are "t15"),
 * while the daemon published parts at `length >= 4`. So every flow that named
 * a three-character record id minted a ref nothing would ever resolve, and the
 * four steps depending on it skipped the zero-model path on every replay.
 */
export function urlOutputs(url: string): Record<string, string> {
  const out: Record<string, string> = { url };
  for (const part of urlParts(url)) {
    const key = `url.${part.label}`;
    if (identifierLike(part.value) && !(key in out)) out[key] = part.value;
  }
  return out;
}

/**
 * Which of each step's `url.*` outputs some OTHER step actually consumes
 * (`{{03-open.url.q.id}}` in an instruction or a param). The flow runner
 * captures a step's end-url outputs in one snapshot — but an SPA can update
 * its URL a beat AFTER the page itself settles, and a structural replay is
 * fast enough to finish inside that beat. Odoo does exactly this with the
 * `id=` of a freshly saved record: fwod30's replays finished 03-open before
 * the hash carried the id, `{{03-open.url.q.id}}` went unresolved, and every
 * consumer of it fell to full recovery. Knowing which url outputs are
 * consumed lets the capture wait for them, bounded, instead of snapshotting
 * whatever the URL happened to say. The whole-url output (`url`) is always
 * present, so only dotted parts are listed.
 */
export function consumedUrlOutputs(steps: FlowStep[]): Map<string, Set<string>> {
  const wanted = new Map<string, Set<string>>();
  for (const s of steps) {
    for (const text of [s.instruction, ...Object.values(s.params ?? {})]) {
      for (const m of text.matchAll(/\{\{([\w-]+)\.(url\.[\w.-]+?)(#[\w.-]+)?\}\}/g)) {
        if (m[1] === s.id) continue; // own-step refs resolve after its capture regardless
        const set = wanted.get(m[1]) ?? new Set<string>();
        set.add(m[2]);
        wanted.set(m[1], set);
      }
    }
  }
  return wanted;
}

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
export function resolveInstruction(
  step: FlowStep,
  vars: Record<string, string>,
  outputs: Record<string, Record<string, string>>,
  stable: Record<string, string> = {},
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = step.instruction.replace(/\{\{([\w.#-]+)\}\}/g, (m, ref: string) => {
    if (ref.includes('.')) {
      const dot = ref.indexOf('.');
      const [sid, out] = [ref.slice(0, dot), ref.slice(dot + 1)];
      const v = lookupOutput(outputs, sid, out);
      if (v === undefined) {
        // Demonstrated stable by an earlier run: the app produced this exact
        // value again, so it is furniture and the recorded literal is right.
        // Anything not demonstrated stays missing and goes to recovery.
        if (ref in stable) return stable[ref];
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
export function softResolveInstruction(
  step: FlowStep,
  vars: Record<string, string>,
  outputs: Record<string, Record<string, string>>,
  stable: Record<string, string> = {},
): string {
  return step.instruction
    .replace(/\{\{([\w.#-]+)\}\}/g, (m, ref: string) => {
      if (ref.includes('.')) {
        const dot = ref.indexOf('.');
        const [sid, out] = [ref.slice(0, dot), ref.slice(dot + 1)];
        return lookupOutput(outputs, sid, out) ?? stable[ref] ?? '';
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
  stable: Record<string, string> = {},
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
        if (v !== undefined) return v;
        if (ref in stable) return stable[ref];
        missing.push(ref);
        return m;
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
