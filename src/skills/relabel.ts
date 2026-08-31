import type { RecordedEntry } from '../daemon/recorder.js';
import type { ChatMessage, Provider, ToolDef } from '../agent/llm.js';
import type { Skill, SkillStep } from './store.js';

/**
 * Post-session relabelling: one smart-model pass, at the end of a recording,
 * that renames poorly named report values before the flow is built.
 *
 * Every in-session naming mechanism — the read-time label, the report-time
 * ask, the selector-slug backfill — must name a value BEFORE anyone can know
 * whether it matters, because that is decided by instructions that have not
 * arrived yet. Session end is the one moment the whole story exists: which
 * values later instructions actually consumed, what the task called things,
 * and which names are selector slugs (`h1`, `role_radiogroup_aria_che`)
 * rather than words a person would write. fwod24 threaded its quotation
 * reference through eleven flow references as `02-create.h1` for want of
 * exactly this hindsight.
 *
 * The pass is safe by construction: it changes only the KEYS of
 * `evidence.values`. Slot discovery, `readLabel` and read-back pinning all
 * match by VALUE, so nothing the run banked can be lost — the failure mode
 * that forced mergeReportValues on the report-time retry cannot occur here.
 * And it is cheap where the in-session asks are not: one call per RECORDING,
 * amortised over every replay, with a payload of instruction texts and value
 * tables rather than the full turn history.
 *
 * It must run BEFORE buildFlow mints `{{step.name}}` references, and rename
 * the already-compiled skills in the same pass (step labels, reportTemplate
 * keys, `output:` binding keys) — a rename that touched the entries and not
 * the skills would recreate the dead-reference bug in a new costume.
 */

/** One successful instruction whose report carries values, as the model sees it. */
export interface RelabelCase {
  /** 1-based instruction order in the session (ledger binding `i<n>`). */
  index: number;
  instruction: string;
  values: Record<string, string>;
  /** The skill this instruction compiled into, for applying renames to it. */
  skill?: string;
}

/** old name -> new name, per instruction index. */
export type RelabelPlan = Map<number, Record<string, string>>;

export function relabelCases(entries: RecordedEntry[]): RelabelCase[] {
  const out: RelabelCase[] = [];
  let index = 0;
  let instruction = '';
  for (const e of entries) {
    if (e.k === 'instruction') {
      index++;
      instruction = e.text ?? '';
    } else if (e.k === 'report' && e.status === 'success' && Object.keys(e.values ?? {}).length) {
      out.push({ index, instruction, values: { ...e.values }, ...(e.skill ? { skill: e.skill } : {}) });
    }
  }
  return out;
}

const RENAME_TOOL: ToolDef = {
  name: 'rename_values',
  description:
    'Submit the value renames for this session. Rename ONLY names that mislead or say nothing ' +
    '(selector fragments like h1, role_radiogroup_aria_che, generic value/value_2, or a name that ' +
    'contradicts what the value is). Leave every adequate name alone — churn costs more than it buys.',
  parameters: {
    type: 'object',
    required: ['renames'],
    properties: {
      renames: {
        type: 'array',
        items: {
          type: 'object',
          required: ['i', 'from', 'to'],
          properties: {
            i: { type: 'number', description: 'The instruction number the value belongs to.' },
            from: { type: 'string', description: 'The current name, exactly as listed.' },
            to: {
              type: 'string',
              description: 'The name a person would use: order_reference, unit_price, customer_name. snake_case.',
            },
          },
        },
      },
    },
  },
};

function relabelMessages(cases: RelabelCase[]): ChatMessage[] {
  const lines = cases.map(
    (c) => `instruction ${c.index}: ${JSON.stringify(c.instruction)}\n  values: ${JSON.stringify(c.values)}`,
  );
  return [
    {
      role: 'system',
      content:
        'A browser-automation session just finished recording. Each instruction below reported values read ' +
        'off the page, keyed by name. Later runs of this procedure address these values BY NAME, so a name ' +
        'must say what the value IS to someone who cannot see the page: a value the app minted as an order ' +
        'reference must be called order_reference, not h1 (the selector it was read from) and not value_2. ' +
        'You see the whole session, so use hindsight: if a later instruction uses a value, name it the way ' +
        'that instruction speaks about it. Call rename_values exactly once with every rename worth making — ' +
        'and no others.',
    },
    { role: 'user', content: lines.join('\n\n') },
  ];
}

// snake_case is what the prompt asks for, but models also name values in
// camelCase and those names WORK — fwrd35's reports use totalPrice, partB.
// The validator's job is mechanical safety, not style: it must not refuse
// `partB -> partBName` while partB itself stands. Letters either case.
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/**
 * Validate a raw rename list into a plan. Anything mechanically unsafe is
 * dropped, not repaired: a rename of a name that does not exist, to a name
 * already taken in the same report, or to something that is not a
 * snake_case word. Returns the plan and what was dropped (for the log).
 */
export function validateRelabelPlan(
  raw: unknown,
  cases: RelabelCase[],
): { plan: RelabelPlan; dropped: string[] } {
  const plan: RelabelPlan = new Map();
  const dropped: string[] = [];
  const byIndex = new Map(cases.map((c) => [c.index, c]));
  const list = Array.isArray((raw as { renames?: unknown })?.renames) ? (raw as { renames: unknown[] }).renames : [];
  for (const r of list) {
    const { i, from, to } = (r ?? {}) as { i?: unknown; from?: unknown; to?: unknown };
    const c = typeof i === 'number' ? byIndex.get(i) : undefined;
    const oldName = typeof from === 'string' ? from : '';
    const newName = typeof to === 'string' ? to.trim() : '';
    const have = c
      ? new Set([...Object.keys(c.values), ...Object.values(plan.get(c.index) ?? {})])
      : new Set<string>();
    if (!c || !(oldName in c.values)) dropped.push(`i${String(i)}.${oldName}: no such value`);
    else if (!NAME_RE.test(newName)) dropped.push(`i${c.index}.${oldName} -> ${JSON.stringify(newName)}: not a snake_case name`);
    else if (newName === oldName) continue;
    else if (have.has(newName)) dropped.push(`i${c.index}.${oldName} -> ${newName}: name already taken`);
    else {
      const m = plan.get(c.index) ?? {};
      m[oldName] = newName;
      plan.set(c.index, m);
    }
  }
  return { plan, dropped };
}

/** Ask the model for a plan. One call; a refusal or malformed answer is an empty plan. */
export async function requestRelabelPlan(
  provider: Provider,
  cases: RelabelCase[],
): Promise<{ plan: RelabelPlan; dropped: string[] }> {
  if (!cases.length) return { plan: new Map(), dropped: [] };
  const done = await provider.complete(relabelMessages(cases), [RENAME_TOOL]);
  const call = (done.toolCalls ?? []).find((t) => t.name === 'rename_values');
  return validateRelabelPlan(call?.args, cases);
}

/**
 * Rename report value keys in the recorded entries, in place. Key order is
 * preserved so the rewritten script diffs cleanly. Returns renames applied.
 */
export function applyRelabelToEntries(entries: RecordedEntry[], plan: RelabelPlan): number {
  let applied = 0;
  let index = 0;
  for (const e of entries) {
    if (e.k === 'instruction') index++;
    else if (e.k === 'report' && plan.has(index)) {
      const renames = plan.get(index)!;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.values ?? {})) {
        const nk = renames[k] ?? k;
        if (nk !== k) applied++;
        values[nk] = v;
      }
      e.values = values;
    }
  }
  return applied;
}

/**
 * Rename one session's compiled skills to agree with the renamed entries:
 * read labels, reportTemplate keys, and `output:i<n>:<name>` param bindings.
 * `skillIndex` says which instruction each skill (or segment chain) belongs
 * to. Mutates; returns the ids of skills actually changed, for persisting.
 */
export function applyRelabelToSkills(skills: Skill[], plan: RelabelPlan, skillIndex: Map<string, number>): string[] {
  const changed = new Set<string>();
  for (const skill of skills) {
    const index = skillIndex.get(skill.id);
    const renames = index !== undefined ? plan.get(index) : undefined;
    if (renames) {
      const renameSteps = (steps: SkillStep[]): void => {
        for (const s of steps) {
          if (s.label && renames[s.label]) {
            s.label = renames[s.label];
            changed.add(skill.id);
          }
          if (s.body) renameSteps(s.body);
        }
      };
      renameSteps(skill.steps);
      if (skill.reportTemplate?.values) {
        const values: Record<string, string> = {};
        let touched = false;
        for (const [k, v] of Object.entries(skill.reportTemplate.values)) {
          const nk = renames[k] ?? k;
          if (nk !== k) touched = true;
          values[nk] = v;
        }
        if (touched) {
          skill.reportTemplate.values = values;
          changed.add(skill.id);
        }
      }
    }
    // Bindings can point at ANY earlier instruction's output, so every skill
    // is checked against the whole plan, not just its own instruction's part.
    for (const param of Object.values(skill.params ?? {})) {
      const m = param.binding?.match(/^output:i(\d+):([^#]+)(#.*)?$/);
      if (!m) continue;
      const to = plan.get(Number(m[1]))?.[m[2]];
      if (to) {
        param.binding = `output:i${m[1]}:${to}${m[3] ?? ''}`;
        changed.add(skill.id);
      }
    }
  }
  return [...changed];
}
