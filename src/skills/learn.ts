import type { InstructionResult, SkillRecord } from '../agent/loop.js';
import type { Report } from '../agent/report.js';
import type { RecordedEntry, RecordedInstruction } from '../daemon/recorder.js';
import { compileSkill, escapeRe, fillParams, sameProcedure, urlMatches } from './compile.js';
import type { Skill, SkillStore } from './store.js';

export interface LearnedRecord {
  /** A new skill was stored. */
  compiled?: string;
  /** An existing skill absorbed this run (same template or same procedure). */
  merged?: string;
  /** The stored skill whose stats were updated from a replay. */
  outcome?: { skill: string; status: Skill['status']; ok: boolean };
  variantOf?: string;
  /** A validated variant replaced the skill it repaired. */
  superseded?: string;
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

  // A clean full replay has nothing new to teach; a repair does.
  const fullReplay = sk?.invoked && !sk.refused && sk.stepsReplayed === sk.stepsTotal;
  if (fullReplay) return Object.keys(out).length ? out : null;
  const variantOf = sk?.invoked && !sk.refused && sk.stepsReplayed < sk.stepsTotal ? sk.invoked : undefined;

  const skill = compileSkill({
    entries: input.entries,
    instruction: input.instruction,
    report: input.result.report,
    session: input.session,
    model: input.model,
    now: input.now,
    variantOf,
  });
  if (!skill) return Object.keys(out).length ? out : null;

  const existing = store.list(skill.origin);
  const twin = existing.find((s) => s.status !== 'demoted' && (s.template === skill.template || sameProcedure(s, skill)));
  if (twin && !variantOf) {
    twin.stats.uses += 1;
    twin.stats.successes += 1;
    twin.stats.lastUsed = skill.provenance.created;
    if (twin.status === 'provisional' && twin.stats.successes >= 2) twin.status = 'validated';
    store.put(twin);
    out.merged = twin.id;
    return out;
  }
  store.put(skill);
  out.compiled = skill.id;
  if (variantOf) out.variantOf = variantOf;
  return out;
}

/**
 * Zero-model match: a validated skill whose template, read as a pattern,
 * matches the incoming instruction exactly (modulo case, whitespace and quote
 * style), and whose start page is the current one. Returns the bound params.
 */
export function matchTemplate(skills: Skill[], instruction: string, url: string): { skill: Skill; params: Record<string, string> } | null {
  for (const skill of skills) {
    if (skill.status !== 'validated') continue;
    if (!urlMatches(skill.preconditions.urlPattern, url)) continue;
    const params = bindSkill(skill, instruction);
    if (params) return { skill, params };
  }
  return null;
}

/**
 * Bind a specific skill's {{vN}} slots from an instruction by reading its
 * template as a pattern. Used by flow replay, where the skill is already
 * chosen (pinned), so its status and the page are the flow's concern, not this
 * function's. Returns null unless every slot binds.
 */
export function bindSkill(skill: Skill, instruction: string): Record<string, string> | null {
  const names: string[] = [];
  const pattern = escapeRe(squash(skill.template)).replace(/\\\{\\\{(v\d+)\\\}\\\}/g, (_m, name: string) => {
    names.push(name);
    return '(.+?)';
  });
  const m = new RegExp(`^${pattern}$`, 'i').exec(squash(instruction));
  if (!m) return null;
  const params: Record<string, string> = {};
  names.forEach((n, i) => (params[n] = m[i + 1].trim()));
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
  const dropped = stale.some((v) => summary.includes(v));
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

export function instructionEntry(entries: RecordedEntry[]): RecordedInstruction | undefined {
  return entries.find((e): e is RecordedInstruction => e.k === 'instruction');
}

export type { SkillRecord };
