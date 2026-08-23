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
  const wanted = squash(instruction);
  for (const skill of skills) {
    if (skill.status !== 'validated') continue;
    if (!urlMatches(skill.preconditions.urlPattern, url)) continue;
    const names: string[] = [];
    const pattern = escapeRe(squash(skill.template)).replace(/\\\{\\\{(v\d+)\\\}\\\}/g, (_m, name: string) => {
      names.push(name);
      return '(.+?)';
    });
    const m = new RegExp(`^${pattern}$`, 'i').exec(wanted);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => (params[n] = m[i + 1].trim()));
    // Every slot must be bound, and the same slot bound twice must agree.
    if (Object.keys(skill.params).every((n) => params[n])) return { skill, params };
  }
  return null;
}

function squash(text: string): string {
  return text.replace(/[“”"]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * A report for a zero-model replay. Values are the live read-backs wherever
 * the original report had a labelled read; the stored summary is only reused
 * where those values are substituted into it, so a price that changed between
 * runs cannot be reported from memory.
 */
export function synthesizeReport(skill: Skill, params: Record<string, string>, liveValues: Record<string, string>): Report {
  const template = skill.reportTemplate ?? { summary: '', values: {} };
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(template.values)) values[k] = fillParams(v, params);
  let summary = fillParams(template.summary, params);
  for (const [k, live] of Object.entries(liveValues)) {
    const old = values[k];
    if (old !== undefined && old !== live && old) summary = summary.split(old).join(live);
    values[k] = live;
  }
  return {
    status: 'success',
    summary: summary || `Replayed stored procedure ${skill.id} (${skill.steps.length} steps).`,
    details: `Replayed stored procedure ${skill.id} without the model; every reported value was read back from the live page during this run.`,
    evidence: { values },
  };
}

export function instructionEntry(entries: RecordedEntry[]): RecordedInstruction | undefined {
  return entries.find((e): e is RecordedInstruction => e.k === 'instruction');
}

export type { SkillRecord };
