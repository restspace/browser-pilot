import fs from 'node:fs';
import path from 'node:path';
import type { RecordedEntry, RecordedInstruction, RecordedReport } from '../daemon/recorder.js';
import { rootDir } from '../shared/paths.js';
import { escapeRe } from './compile.js';

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
    for (const [output, value] of Object.entries(g.report?.values ?? {})) {
      if (typeof value === 'string' && value) produced.push({ stepId: id, output, value });
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
}

function groupByInstruction(entries: RecordedEntry[]): Group[] {
  const groups: Group[] = [];
  for (const e of entries) {
    if (e.k === 'instruction') groups.push({ instruction: e });
    else if (e.k === 'report' && groups.length) groups[groups.length - 1].report = e;
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
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(value)}(?![A-Za-z0-9])`, 'g'), marker);
}

/** Fill {{var}} and {{step.output}} references from run vars and prior outputs. */
export function resolveInstruction(step: FlowStep, vars: Record<string, string>, outputs: Record<string, Record<string, string>>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = step.instruction.replace(/\{\{([\w.-]+)\}\}/g, (m, ref: string) => {
    if (ref.includes('.')) {
      const [sid, out] = ref.split('.');
      const v = outputs[sid]?.[out];
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
    .replace(/\{\{([\w.-]+)\}\}/g, (m, ref: string) => {
      if (ref.includes('.')) {
        const [sid, out] = ref.split('.');
        return outputs[sid]?.[out] ?? '';
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
    params[k] = tmpl.replace(/\{\{([\w.-]+)\}\}/g, (m, ref: string) => {
      if (ref.includes('.')) {
        const [sid, out] = ref.split('.');
        const v = outputs[sid]?.[out];
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
