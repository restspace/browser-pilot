import type { InstructionResult, SkillRecord } from '../agent/loop.js';
import type { Report } from '../agent/report.js';
import type { RecordedEntry, RecordedInstruction } from '../daemon/recorder.js';
import { compileSkills, escapeRe, fillParams, sameProcedure, urlMatches } from './compile.js';
import { ComponentStore, learnRecipes } from './components.js';
import { identifierLike } from './ledger.js';
import { successRate, type Skill, type SkillStore } from './store.js';

export interface LearnedRecord {
  /** A new skill was stored (the first segment, when the compile split). */
  compiled?: string;
  /** Every segment stored, in chain order, when the compile split into >1. */
  compiledAll?: string[];
  /** An existing skill absorbed this run (same template or same procedure). */
  merged?: string;
  /** The stored skill whose stats were updated from a replay. */
  outcome?: { skill: string; status: Skill['status']; ok: boolean };
  variantOf?: string;
  /** A validated variant replaced the skill it repaired. */
  superseded?: string;
  /** Component recipes compiled from this instruction's recording. */
  recipes?: string[];
}

/**
 * Everything learning mode does once an instruction has finished: fold the
 * replay outcome into the replayed skill, then — only on a successful report —
 * compile the recording into a new skill, a variant, or a stat bump on one
 * that already exists.
 */
export function learnFromInstruction(
  store: SkillStore,
  input: {
    result: InstructionResult;
    instruction: string;
    entries: RecordedEntry[];
    session: string;
    model?: string;
    now?: string;
    /** Run-scoped values (flow vars, url provenance) to slot by policy at compile. */
    vars?: Record<string, string>;
  },
): LearnedRecord | null {
  const out: LearnedRecord = {};
  const sk = input.result.skill;
  const succeeded = input.result.report.status === 'success';

  if (sk?.invoked && !sk.refused) {
    const ok = sk.stepsReplayed === sk.stepsTotal;
    const updated = store.recordOutcome(
      sk.invoked,
      { ok, failedAt: ok ? undefined : sk.stepsReplayed + 1, fallthroughs: sk.fallthroughs, instructionSucceeded: succeeded },
      input.now,
    );
    if (updated) {
      out.outcome = { skill: updated.id, status: updated.status, ok };
      if (updated.status === 'validated' && updated.variantOf) {
        store.supersede(updated.variantOf);
        out.superseded = updated.variantOf;
      }
    }
  }

  if (!succeeded) return Object.keys(out).length ? out : null;

  // Component recipes (PLAN-component-recipes): a successful agent-driven
  // interaction with a recognized widget teaches a cross-app recipe,
  // regardless of what happens to the skill-level compile below.
  try {
    const recipes = learnRecipes(new ComponentStore(), input.entries, input.instruction, input.session, input.now);
    if (recipes.length) out.recipes = recipes;
  } catch {
    // recipe learning must never break instruction learning
  }

  // A clean full replay has nothing new to teach; a repair does.
  const fullReplay = sk?.invoked && !sk.refused && sk.stepsReplayed === sk.stepsTotal;
  if (fullReplay) return Object.keys(out).length ? out : null;
  const variantOf = sk?.invoked && !sk.refused && sk.stepsReplayed < sk.stepsTotal ? sk.invoked : undefined;

  const skills = compileSkills({
    entries: input.entries,
    instruction: input.instruction,
    report: input.result.report,
    session: input.session,
    model: input.model,
    now: input.now,
    variantOf,
    knownValues: input.vars,
  });
  if (!skills.length) return Object.keys(out).length ? out : null;

  const existing = store.list(skills[0].origin);
  if (!variantOf) {
    // A twin is an existing skill with this recording's shape at the same
    // chain position. Merge only when EVERY segment has a twin and the twins
    // all belong to one chain — otherwise the store would end up with
    // half-shared chains that replay cannot compose.
    const twins = skills.map((sk) =>
      existing.find(
        (s) =>
          s.status !== 'demoted' &&
          (s.seq?.index ?? 0) === (sk.seq?.index ?? 0) &&
          (s.seq?.of ?? 1) === (sk.seq?.of ?? 1) &&
          (s.template === sk.template || sameProcedure(s, sk)),
      ),
    );
    if (twins.every(Boolean) && new Set(twins.map((t) => t!.seq?.chain ?? t!.id)).size === 1) {
      for (const twin of twins as Skill[]) {
        twin.stats.uses += 1;
        twin.stats.successes += 1;
        twin.stats.lastUsed = skills[0].provenance.created;
        if (twin.status === 'provisional' && twin.stats.successes >= 2) twin.status = 'validated';
        store.put(twin);
      }
      out.merged = twins[0]!.id;
      return out;
    }
  }
  for (const sk of skills) store.put(sk);
  out.compiled = skills[0].id;
  if (skills.length > 1) out.compiledAll = skills.map((s) => s.id);
  if (variantOf) out.variantOf = variantOf;
  return out;
}

/**
 * Zero-model match: a validated skill whose template, read as a pattern,
 * matches the incoming instruction exactly (modulo case, whitespace and quote
 * style), and whose start page is the current one. Returns the bound params.
 */
export function matchTemplate(
  skills: Skill[],
  instruction: string,
  url: string,
  known: Record<string, string> = {},
): { skill: Skill; params: Record<string, string> } | null {
  for (const skill of skills) {
    if (skill.status !== 'validated') continue;
    if (skill.seq && skill.seq.index > 0) continue; // chains start at their head
    if (!urlMatches(skill.preconditions.urlPattern, url)) continue;
    const params = bindSkill(skill, instruction, known);
    if (params) return { skill, params };
  }
  return null;
}

/**
 * The skills a flow step should try for its procedure, best track record
 * first. The step's pinned skill is a HINT that defines the family (its
 * template and its procedure shape), never an authority: candidates are every
 * non-demoted skill in the store that either binds the instruction directly
 * or shares the hint's procedure, ordered validated-first, then by success
 * rate, then by experience. Selection by record is what stops one bad pin —
 * e.g. a fragile provisional from a single model recovery — from dominating
 * the step run after run.
 */
export function selectCandidates(
  skills: Skill[],
  hintId: string | undefined,
  instruction: string,
  hintParams?: Record<string, string>,
  known: Record<string, string> = {},
): { skill: Skill; params: Record<string, string> }[] {
  const hint = hintId ? skills.find((s) => s.id === hintId) : undefined;
  const pinned = hintParams && Object.keys(hintParams).length ? hintParams : undefined;
  const out: { skill: Skill; params: Record<string, string> }[] = [];
  for (const s of skills) {
    if (s.status === 'demoted') continue;
    if (s.seq && s.seq.index > 0) continue; // chains start at their head
    // The flow's stored bindings are authoritative for the pinned skill; a
    // sibling binds from the instruction text, or inherits the pinned
    // bindings when it shares the hint's procedure and its slots all resolve.
    let params: Record<string, string> | null = null;
    if (s.id === hintId && pinned) params = pinned;
    else params = bindSkill(s, instruction, known);
    if (!params && pinned && hint && (s.template === hint.template || sameProcedure(s, hint)) && Object.keys(s.params).every((p) => pinned[p])) {
      params = pinned;
    }
    if (!params) continue;
    out.push({ skill: s, params });
  }
  return out.sort((a, b) => {
    const rank = (s: Skill) => (s.status === 'validated' ? 1 : 0);
    return (
      rank(b.skill) - rank(a.skill) ||
      successRate(b.skill) - successRate(a.skill) ||
      b.skill.stats.uses - a.skill.stats.uses ||
      (b.skill.stats.lastUsed ?? '').localeCompare(a.skill.stats.lastUsed ?? '')
    );
  });
}

/**
 * Bind a specific skill's {{vN}} slots from an instruction by reading its
 * template as a pattern. Used by flow replay, where the skill is already
 * chosen (pinned), so its status and the page are the flow's concern, not this
 * function's. Returns null unless every slot binds.
 */
export function bindSkill(skill: Skill, instruction: string, known: Record<string, string> = {}): Record<string, string> | null {
  const names: string[] = [];
  const pattern = escapeRe(squash(skill.template)).replace(/\\\{\\\{(v\d+)\\\}\\\}/g, (_m, name: string) => {
    names.push(name);
    return '(.+?)';
  });
  const m = new RegExp(`^${pattern}$`, 'i').exec(squash(instruction));
  if (!m) return null;
  const params: Record<string, string> = {};
  names.forEach((n, i) => (params[n] = m[i + 1].trim()));
  // A param the template cannot supply binds to its ORIGIN instead: the value
  // came from an earlier instruction, so this run resolves its own from the
  // same place rather than the skill carrying the recorded literal.
  for (const [n, p] of Object.entries(skill.params)) {
    if (params[n] || !p.binding) continue;
    const value = known[p.binding];
    if (value) params[n] = value;
  }
  return Object.keys(skill.params).every((n) => params[n]) ? params : null;
}

function squash(text: string): string {
  return text.replace(/[“”"]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * A report for a zero-model replay. A value is trustworthy only if it came
 * from this run — either a live read-back, or a slot filled from the caller's
 * own parameters. A recorded literal (the ticket id "RD-1017" from the run
 * that made the skill) is stale on any later run, so it is dropped, never
 * reported from memory; the same stale substrings are struck from the summary.
 * This is the honesty rule the scref3 fabrication made load-bearing, applied
 * to the model-free path.
 */
const MIN_STALE_LEN = 4;

export function synthesizeReport(skill: Skill, params: Record<string, string>, liveValues: Record<string, string>): Report {
  const template = skill.reportTemplate ?? { summary: '', values: {} };
  const values: Record<string, string> = {};
  const stale: string[] = [];
  for (const [k, v] of Object.entries(template.values)) {
    if (k in liveValues) continue; // a live read wins outright, below
    const filled = fillParams(v, params);
    // Kept only if every part of it came from a parameter: no residual literal.
    if (/\{\{v\d+\}\}/.test(v) && !/\{\{v\d+\}\}/.test(filled)) values[k] = filled;
    else stale.push(v);
  }
  for (const [k, live] of Object.entries(liveValues)) values[k] = live;

  let summary = fillParams(template.summary, params);
  for (const [k, live] of Object.entries(liveValues)) {
    const recorded = template.values[k];
    const old = recorded ? fillParams(recorded, params) : undefined;
    if (old && old !== live) summary = summary.split(old).join(live);
  }
  // Strip stale recorded literals from the prose so the summary cannot state a
  // value this run did not observe.
  //
  // Containment is compared LOOSELY. fwrd19l stored the same validation
  // message twice — once in the summary keeping the app's "-" bullets, once
  // in values with them collapsed by whitespace normalisation — and an exact
  // substring test missed by that one character, publishing the recording
  // run's part names as this run's finding.
  const loose = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hay = loose(summary);
  const fromParams = Object.values(params).map(loose).join(' ');
  const dropped =
    stale.some((v) => loose(v).length >= MIN_STALE_LEN && hay.includes(loose(v))) ||
    // A param's `example` IS the recording run's value. If one survives in the
    // prose while this run bound something else to that param, the sentence is
    // describing the wrong record however well the rest of it filled.
    Object.entries(skill.params).some(([n, p]) => {
      const example = String(p.example ?? '');
      return example.length >= MIN_STALE_LEN && params[n] !== example && hay.includes(loose(example));
    }) ||
    // A replay that re-observed NOTHING cannot vouch for a sentence naming
    // specifics. Both rules above need something to compare against — a stale
    // template value, or a param whose example survived — and fwod12's steps
    // 03-06 had neither: no labelled reads, no matching param. So they
    // republished the recording's own narrative verbatim,
    //   "Added a second order line to S00021 and saved."
    // as this run's finding, while publishing {} as their values. The run had
    // created S00023.
    //
    // An identifier the prose names that no parameter supplied is a claim
    // about the world made by a replay that looked at nothing.
    (!Object.keys(liveValues).length &&
      (summary.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []).some((tok) => identifierLike(tok) && !fromParams.includes(loose(tok))));
  const clean = dropped
    ? `Replayed stored procedure ${skill.id}${Object.keys(values).length ? `; observed ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}.`
    : summary;

  return {
    status: 'success',
    summary: clean || `Replayed stored procedure ${skill.id} (${skill.steps.length} steps).`,
    details: `Replayed stored procedure ${skill.id} without the model. Reported values are live read-backs or your own parameters; ${stale.length ? `${stale.length} recorded value(s) that could not be re-observed were omitted` : 'no stale values were carried over'}.`,
    evidence: { values },
  };
}

/**
 * Which report-value names a tier-A (zero-model) replay of this skill
 * re-publishes deterministically: labelled reads (re-read live from the page)
 * and report-template values derived from the caller's own {{vN}} params
 * (synthesizeReport keeps exactly those; recorded literals are dropped as
 * stale). Used by the flow export lint to flag {{step.output}} references
 * that only model recovery could re-observe.
 */
export function publishedOutputs(skill: Skill): string[] {
  const out = new Set<string>();
  const walk = (steps: Skill['steps']): void => {
    for (const s of steps) {
      if ((s.tool === 'read' || s.tool === 'read_all') && s.label) out.add(s.label);
      if (s.body) walk(s.body);
    }
  };
  walk(skill.steps);
  for (const [k, v] of Object.entries(skill.reportTemplate?.values ?? {})) {
    if (/\{\{v\d+\}\}/.test(v)) out.add(k);
  }
  return [...out];
}

/** Tools that CHANGE the app, as opposed to observing it. */
const MUTATING = new Set(['click', 'dblclick', 'right_click', 'modifier_click', 'fill', 'type', 'press', 'select', 'check', 'drag', 'upload']);

/**
 * How many state-changing steps the MODEL drove in a recovery, beyond what a
 * stored skill replayed — the measure of whether that skill did this step's
 * work or merely ran somewhere inside it. rpgr3-r1 invoked s_567dd1 during a
 * 41-turn 03-add recovery; the skill replayed fully, validated, and was
 * re-pinned — but the model had done 30-odd clicks after it to actually
 * finish, so on the next run the pinned skill alone left the panel unmade.
 * A recovery the skill carried on its own has (near) none of these.
 */
export function agentGesturesOutsideReplay(entries: RecordedEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.k === 'step' && !e.via && MUTATING.has(e.tool)) n++;
  return n;
}

/** The most model-driven gestures a recovery may contain and still hand its replayed skill the pin. */
export const MAX_STRAY_GESTURES_FOR_PIN = 2;

function mutates(store: SkillStore, id: string | undefined): boolean {
  const skill = id ? store.get(id) : null;
  if (!skill) return false;
  const walk = (steps: Skill['steps']): boolean => steps.some((s) => MUTATING.has(s.tool) || (s.body ? walk(s.body) : false));
  return walk(skill.steps);
}

/**
 * May a flow step move its pin to `next`? Adoption is already gated on the
 * skill being validated and having just replayed cleanly; these two say the
 * candidate is about THIS STEP'S WORK, not merely a procedure that resolves
 * on this page.
 *
 * fwrd14l-n2 is why. Step 08 (create a scratch ticket) and step 09 (delete
 * both parts) were re-pinned to s_0b2413 — step 07's READ-ONLY skill, which
 * was validated and matched the same detail page. The rewritten flow went to
 * disk; n3 inherited it, replayed 07's read chain for all three steps,
 * changed NOTHING, reported success three times, and halted at step 10 on a
 * scratch ticket that never existed. A replay that reports success having
 * done nothing is the worst failure this system has, so:
 *
 *  1. A skill another step of the flow already owns is that step's procedure.
 *     Two steps are two different instructions; one skill cannot be both.
 *  2. A read-only skill never replaces one that mutates. Reads resolve on any
 *     plausible page, which is exactly why this swap looks like success.
 */
export function canAdoptPin(
  store: SkillStore,
  steps: { id: string; skill?: string }[],
  stepId: string,
  current: string | undefined,
  next: string,
): boolean {
  if (steps.some((s) => s.id !== stepId && s.skill === next)) return false;
  return !(mutates(store, current) && !mutates(store, next));
}

export function instructionEntry(entries: RecordedEntry[]): RecordedInstruction | undefined {
  return entries.find((e): e is RecordedInstruction => e.k === 'instruction');
}

export type { SkillRecord };
