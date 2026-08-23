import type { LocatorCandidate, RecordedEntry, RecordedInstruction, RecordedStep } from '../daemon/recorder.js';
import type { Report } from '../agent/report.js';
import { newSkillId, originOf, type Skill, type SkillParam, type SkillStep, type StepExpectation } from './store.js';

/** Args whose string values are candidates for parameter slots. */
const VALUE_ARGS = new Set(['value', 'text', 'option', 'url', 'prompt_text']);

const MAX_ADDED_LINES = 5;
const MAX_SLOT_VALUES = 12;

export interface CompileInput {
  /** The `instruction` entry and every step recorded after it. */
  entries: RecordedEntry[];
  instruction: string;
  report: Report;
  session: string;
  model?: string;
  now?: string;
  /** When the instruction repaired a partly-failed replay, the skill it was replaying. */
  variantOf?: string;
}

/**
 * Turn one successful instruction's recording into a skill.
 *
 * Parameterisation is deliberately deterministic: any literal the agent typed
 * (fill/type/select/goto values) that also occurs as a whole token in the
 * instruction text becomes a slot, substituted everywhere it appears — step
 * args, locator names, expectations, the report. Values that do not occur in
 * the instruction stay literal: they are defaults the agent invented, which is
 * the right thing to replay and worth being able to see in `skills show`.
 *
 * Returns null when there is nothing replayable (no steps, or no origin).
 */
export function compileSkill(input: CompileInput): Skill | null {
  return compileSkills(input)[0] ?? null;
}

/** One recorded segment: the steps that ran on one page template. */
interface Segment {
  steps: RecordedStep[];
  startUrl: string;
  fingerprint?: number[];
}

/**
 * Like compileSkill, but the recording is first split at page-template seams
 * — a step whose url PATTERN changed navigated to a different template — and
 * each segment compiles into its own skill, scoped to the page it runs on
 * (its own startUrl precondition and, when the recorder captured one, its own
 * fingerprint). The segments share one template and one slot set and are
 * linked by `seq`, so a caller binds params once and replay composes them;
 * each segment is independently replayable, recoverable, and promotable, so a
 * drift in one cannot cascade — the next segment refuses unless the page
 * matches its template. A recording that never changes template compiles to
 * exactly one skill, as before.
 */
export function compileSkills(input: CompileInput): Skill[] {
  const head = input.entries.find((e): e is RecordedInstruction => e.k === 'instruction');
  const steps = input.entries.filter((e): e is RecordedStep => e.k === 'step');
  if (!steps.length) return [];
  const startUrl = head?.url ?? firstUrl(steps);
  const origin = startUrl ? originOf(startUrl) : null;
  if (!origin || !startUrl) return [];

  const slots = discoverSlots(input.instruction, steps);
  const sub = (s: string) => substitute(s, slots);

  const reportValues = input.report.evidence?.values ?? {};
  // Inspection-only actions the agent used to ORIENT itself — probe the DOM with
  // `eval`, grab a `screenshot`, read a value it never reported — are not part of
  // the reproducible procedure. An `eval` is worse than noise: it assumes the
  // record-time DOM and, unlike a read (which replay skips on failure), it is
  // fatal, which is exactly what sent the sign-in and archive steps to recovery
  // on every replay. Keep the actions, the synthetic read-backs, and any read
  // whose value the run actually reported; drop the rest.
  const replayable = steps.filter((step) => {
    if (step.tool === 'screenshot' || step.tool === 'eval') return false;
    if (step.tool === 'read' || step.tool === 'read_all') {
      return step.args.target === '(read-back)' || Boolean(readLabel(step, reportValues));
    }
    return true;
  });
  let kept = replayable.length ? replayable : steps;
  // A variant covers only the territory it repaired: steps that were replayed
  // via a DIFFERENT stored skill (an earlier segment completing cleanly) are
  // that skill's procedure, not this variant's.
  if (input.variantOf) kept = kept.filter((s) => !s.via || s.via.skill === input.variantOf);
  if (!kept.length) return [];

  // Split at page-template seams. A step that navigated (diff.url) to a url
  // with a DIFFERENT pattern ends its segment; the recorder's fingerprintAfter
  // (when captured) becomes the next segment's precondition.
  const segments: Segment[] = [];
  let seg: Segment = { steps: [], startUrl, ...(head?.fingerprint ? { fingerprint: head.fingerprint } : {}) };
  let currentUrl = startUrl;
  for (const step of kept) {
    seg.steps.push(step);
    if (step.diff?.url && step.diff.url !== currentUrl) {
      const crossed = urlPattern(step.diff.url, slots) !== urlPattern(currentUrl, slots);
      currentUrl = step.diff.url;
      if (crossed) {
        segments.push(seg);
        seg = { steps: [], startUrl: currentUrl, ...(step.fingerprintAfter ? { fingerprint: step.fingerprintAfter } : {}) };
      }
    }
  }
  if (seg.steps.length) segments.push(seg);

  // Build every segment's steps first: slot retention is decided across the
  // WHOLE chain (a slot used only by segment 2 must stay in the shared
  // template, or binding an instruction to segment 1 would fail).
  const built = segments.map((sg) => {
    const segParams: Record<string, SkillParam> = {};
    for (const [name, value] of slots) segParams[name] = { example: value, usedIn: [] };
    const skillSteps: SkillStep[] = sg.steps.map((step, i) => {
      const args = substituteDeep(step.args, slots) as Record<string, unknown>;
      const locators: Record<string, LocatorCandidate[]> = {};
      for (const [key, loc] of Object.entries(step.locators)) {
        locators[key] = stableFirst((loc.chain ?? []).map((c) => substituteDeep(c, slots) as LocatorCandidate));
      }
      const out: SkillStep = { tool: step.tool, args, locators };
      const expect = expectationFor(step, slots);
      if (expect) out.expect = expect;
      const label = readLabel(step, reportValues);
      if (label) out.label = label;
      if (step.via) out.via = step.via;
      for (const name of slotsUsed(JSON.stringify({ args, locators }))) segParams[name]?.usedIn.push(i + 1);
      return out;
    });
    return { sg, segParams, folded: foldLoops(coalesceControls(skillSteps)) };
  });

  // Drop slots no segment uses: instruction-only words (e.g. an id the
  // orchestrator mentioned for context) would only make matching harder.
  const usedNames = new Set<string>();
  for (const b of built) for (const [name, p] of Object.entries(b.segParams)) if (p.usedIn.length) usedNames.add(name);
  const keptSlots = new Map([...slots].filter(([n]) => usedNames.has(n)));
  const finalTemplate = keptSlots.size === slots.size ? sub(input.instruction) : substitute(input.instruction, keptSlots);

  const now = input.now ?? new Date().toISOString();
  const reportTemplate = {
    summary: sub(input.report.summary),
    values: Object.fromEntries(Object.entries(reportValues).map(([k, v]) => [k, sub(String(v))])),
  };
  const of = built.length;
  const chain = of > 1 ? newSkillId(origin, finalTemplate, now) : null;

  return built.map((b, k) => {
    const params: Record<string, SkillParam> = {};
    for (const name of keptSlots.keys()) params[name] = b.segParams[name];
    return {
      id: newSkillId(origin, of > 1 ? `${finalTemplate}#${k}` : finalTemplate, now),
      origin,
      template: finalTemplate,
      params,
      preconditions: {
        urlPattern: urlPattern(b.sg.startUrl, slots),
        ...(b.sg.fingerprint ? { fingerprint: b.sg.fingerprint } : {}),
      },
      steps: b.folded,
      // Only the last segment can vouch for the instruction's end state.
      ...(k === of - 1 ? { reportTemplate } : {}),
      stats: { uses: 1, successes: 1, partial: 0, created: now, failedAtStep: {}, fallthroughs: 0 },
      status: 'provisional' as const,
      ...(chain ? { seq: { chain, index: k, of } } : {}),
      ...(input.variantOf ? { variantOf: input.variantOf } : {}),
      provenance: { session: input.session, instruction: input.instruction, ...(input.model ? { model: input.model } : {}), created: now },
    };
  });
}

/**
 * Literal values the agent used that also appear as whole tokens in the
 * instruction. Ordered by first occurrence in the instruction, longest match
 * first when values nest ("x7 RD Part A" before "x7").
 */
export function discoverSlots(instruction: string, steps: RecordedStep[]): Map<string, string> {
  const values = new Set<string>();
  const locatorCandidates = new Set<string>();
  for (const step of steps) {
    if (step.tool === 'read' || step.tool === 'read_all' || step.tool === 'eval') continue;
    for (const [key, v] of Object.entries(step.args)) {
      if (!VALUE_ARGS.has(key) || typeof v !== 'string') continue;
      const value = v.trim();
      if (value.length < 2 || value.length > 200) continue;
      if (!occursAsToken(instruction, value)) continue;
      values.add(value);
    }
    // wait_for text is a check, but a check on a parameter is still parameterised
    if (step.tool === 'wait_for' && typeof step.args.text === 'string' && occursAsToken(instruction, step.args.text.trim())) {
      values.add(step.args.text.trim());
    }
    // A locator that IDENTIFIES a record — clicking the row for ticket
    // "RD-1015", a link named after the value — hard-codes that record unless
    // its identifying string is parameterised too. Collect candidates now;
    // add them below only if they look record-specific, so a plain UI label
    // ("Save") that happens to appear in the instruction is not parameterised.
    for (const loc of Object.values(step.locators)) {
      for (const value of locatorValues(loc.chain ?? [])) {
        const v = value.trim();
        if (v.length >= 2 && v.length <= 200 && occursAsToken(instruction, v)) locatorCandidates.add(v);
      }
    }
  }
  for (const v of locatorCandidates) {
    // Record-specific = already a value the caller typed (an arg slot), or
    // carries an identifier (a digit / id-like token). Excludes stable UI text.
    if (values.has(v) || /\d/.test(v) || v.split(/\s+/).some(isIdLike)) values.add(v);
  }
  const ordered = [...values]
    .map((v) => ({ v, at: instruction.indexOf(v) }))
    .sort((a, b) => a.at - b.at || b.v.length - a.v.length)
    .slice(0, MAX_SLOT_VALUES);
  const slots = new Map<string, string>();
  ordered.forEach(({ v }, i) => slots.set(`v${i + 1}`, v));
  return slots;
}

function occursAsToken(text: string, value: string): boolean {
  if (!value) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(value)}(?=$|[^A-Za-z0-9])`);
  return re.test(text);
}

/**
 * The human-meaningful identifying strings in a locator chain — the ones that
 * can carry a record identifier (a role/link name, visible text, a label). Id
 * and css selectors are excluded: their embedded ids are already handled by
 * stableFirst (demoted) and are not values a caller would supply.
 */
function locatorValues(chain: LocatorCandidate[]): string[] {
  const out: string[] = [];
  for (const c of chain) {
    if (c.kind === 'role') out.push(c.name);
    else if (c.kind === 'text') out.push(c.text);
    else if (c.kind === 'label') out.push(c.label);
    else if (c.kind === 'placeholder') out.push(c.placeholder);
  }
  return out.filter(Boolean);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every slot value in `text` by its "{{vN}}" marker, longest values first. */
export function substitute(text: string, slots: Map<string, string>): string {
  let out = text;
  const byLength = [...slots].sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of byLength) {
    if (!value) continue;
    // Whole-token only, and a bare number never rewrites a selector index:
    // a cost of "25" must not touch the 25 in `:nth-of-type(25)` or `nth=25`.
    const numeric = /^\d+$/.test(value);
    const re = numeric
      ? new RegExp(`(?<![A-Za-z0-9(=])${escapeRe(value)}(?![A-Za-z0-9)])`, 'g')
      : new RegExp(`(?<![A-Za-z0-9])${escapeRe(value)}(?![A-Za-z0-9])`, 'g');
    out = out.replace(re, `{{${name}}}`);
  }
  return out;
}

/** Inverse of substitute(): fill "{{vN}}" markers from a param map. */
export function fillParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(v\d+)\}\}/g, (m, name: string) => (name in params ? params[name] : m));
}

export function substituteDeep(value: unknown, slots: Map<string, string>): unknown {
  if (typeof value === 'string') return substitute(value, slots);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, slots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteDeep(v, slots)]));
  }
  return value;
}

export function fillParamsDeep(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') return fillParams(value, params);
  if (Array.isArray(value)) return value.map((v) => fillParamsDeep(v, params));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillParamsDeep(v, params)]));
  }
  return value;
}

export function slotsUsed(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{(v\d+)\}\}/g)].map((m) => m[1]))];
}

/**
 * A url reduced to the shape that identifies its page: origin + path + hash
 * route, with id-like segments replaced by `:id` and the query dropped.
 * Slot values in the path become their markers, so a skill recorded on
 * `/tickets/x7` matches `/tickets/{{v1}}` on the next run.
 */
export function urlPattern(url: string, slots: Map<string, string> = new Map()): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const norm = (p: string) =>
    p
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        const filled = substitute(decodeURIComponent(seg), slots);
        if (filled !== seg && filled.includes('{{')) return filled;
        return isIdLike(seg) ? ':id' : seg;
      })
      .join('/');
  const hash = u.hash && u.hash.length > 1 ? '#' + norm(u.hash.slice(1).split('?')[0]) : '';
  const origin = u.protocol === 'file:' ? 'file://' : u.origin;
  return `${origin}${norm(u.pathname)}${hash}`;
}

export function isIdLike(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8,}$/i.test(seg)) return true;
  if (/^[0-9a-f-]{32,}$/i.test(seg)) return true; // uuid
  if (/^[A-Za-z]{1,4}[-_]?\d+$/.test(seg)) return true; // t15, RD-1015
  if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg)) return true; // opaque tokens
  return false;
}

/** Whether a live url matches a stored pattern (both reduced the same way). */
export function urlMatches(pattern: string, url: string, params: Record<string, string> = {}): boolean {
  const expected = fillParams(pattern, params);
  const filled = urlPattern(url);
  if (filled === expected) return true;
  // Pattern may carry a raw (unreduced) slot value where the live url now has
  // an id-like segment, or vice versa — compare with both reduced.
  return urlPattern(expected) === filled;
}

function expectationFor(step: RecordedStep, slots: Map<string, string>): StepExpectation | undefined {
  if (!step.diff) return undefined;
  const out: StepExpectation = {};
  if (step.diff.url) out.urlPattern = urlPattern(step.diff.url, slots);
  if (step.diff.alerts[0]) out.alertContains = substitute(step.diff.alerts[0], slots).slice(0, 120);
  if (step.diff.added.length) {
    out.addedContains = step.diff.added.slice(0, MAX_ADDED_LINES).map((l) => substitute(l, slots).slice(0, 120));
  }
  return Object.keys(out).length ? out : undefined;
}

/** If a read's result equals one of the report's evidence values, label it with that key. */
function readLabel(step: RecordedStep, values: Record<string, unknown>): string | undefined {
  if ((step.tool !== 'read' && step.tool !== 'read_all') || step.result === undefined) return undefined;
  let observed: unknown;
  try {
    observed = JSON.parse(step.result);
  } catch {
    observed = step.result;
  }
  const flat = Array.isArray(observed) ? observed.map(String) : [String(observed)];
  for (const [key, v] of Object.entries(values)) {
    const s = String(v).trim();
    if (s && flat.some((f) => f.trim() === s)) return key;
  }
  return undefined;
}

function firstUrl(steps: RecordedStep[]): string | undefined {
  const goto = steps.find((s) => s.tool === 'goto' && typeof s.args.url === 'string');
  return goto ? String(goto.args.url) : undefined;
}

/**
 * Candidates whose selector text embeds something id-like (`ticket-link-t15`,
 * `#row-1042`) were unique on the recorded page but will name a *different*
 * element on the next run. They stay in the chain as a last resort; the
 * semantic candidates (role+name, label, text — now parameterised) go first.
 */
export function stableFirst(chain: LocatorCandidate[]): LocatorCandidate[] {
  const volatile = (c: LocatorCandidate): boolean => {
    if (c.kind === 'testid' || c.kind === 'id' || c.kind === 'css') {
      const text = c.kind === 'testid' ? c.value : c.selector;
      return text
        .split(/[^A-Za-z0-9{}]+/)
        .filter(Boolean)
        .some((tok) => !tok.includes('{{') && isIdLike(tok) && !/^\d{1,2}$/.test(tok));
    }
    // A name that is nothing but an id ("RD-1017") names a record, not a
    // control: the same element next run will carry a different one.
    const name = c.kind === 'role' ? c.name : c.kind === 'text' ? c.text : '';
    return Boolean(name) && !name.includes('{{') && isIdLike(name.trim());
  };
  const stable = chain.filter((c) => !volatile(c));
  return stable.length ? [...stable, ...chain.filter(volatile)] : chain;
}

/** Steps are structurally the same procedure: same tools, same primary locator shapes. */
export function sameProcedure(a: Skill, b: Skill): boolean {
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((s, i) => {
    const t = b.steps[i];
    if (s.tool !== t.tool) return false;
    // Same procedure = same tools driven by the same KIND of primary locator,
    // regardless of the literal value (a label of 'Name' vs 'Name *', a role
    // name that is a parameter or a record id). This is what lets two runs'
    // "add a part" skills merge instead of fragmenting the store; the literal
    // differences are exactly the parameters the skills already carry.
    return locatorShape(s.locators.target?.[0]) === locatorShape(t.locators.target?.[0]);
  });
}

/** A locator's structural shape for merge comparison: its kind, plus the stable
 * part of a css/id selector (tag/structure, not any embedded id). */
function locatorShape(c: LocatorCandidate | undefined): string {
  if (!c) return 'none';
  if (c.kind === 'css' || c.kind === 'id') {
    // Drop id-like and numeric tokens so `#row-1042 > a` and `#row-77 > a` match.
    const skeleton = c.selector.replace(/[A-Za-z0-9_-]+/g, (tok) => (isIdLike(tok) ? '*' : tok));
    return `${c.kind}:${skeleton}`;
  }
  return c.kind;
}

const MAX_GROUP_LEN = 3;
const LOOP_MAX_ITER_CAP = 50;
// A loop iterates an ACTION over records (delete each part, ...). Its anchor
// must be a click; a group may carry connector controls (dialog_expect) but
// never an observation — folding consecutive read-backs into a loop, which they
// superficially resemble (same shape, per-record ids), is a bug: reads observe,
// they do not iterate.
const LOOP_ANCHOR_TOOLS = new Set(['click', 'dblclick', 'modifier_click', 'right_click']);
const NON_LOOP_TOOLS = new Set(['read', 'read_all', 'eval', 'screenshot']);

/**
 * Collapse a run of consecutive, identical control steps that carry no target
 * (chiefly `dialog_expect`, which the agent often re-arms redundantly) into
 * one. Arming the same handler twice is a no-op, but the extra copies land
 * unevenly between otherwise-identical action groups and stop foldLoops from
 * seeing the repetition. Only no-locator steps with byte-identical args are
 * touched, so real actions are never merged.
 */
export function coalesceControls(steps: SkillStep[]): SkillStep[] {
  const out: SkillStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    const noTarget = !step.locators.target?.length && !step.locators.source?.length;
    if (prev && noTarget && prev.tool === step.tool && !prev.locators.target?.length && JSON.stringify(prev.args) === JSON.stringify(step.args)) {
      continue;
    }
    out.push(step);
  }
  return out;
}

/** Replace id-like whole tokens in a string with `*`, so per-record ids collapse. */
function stripIds(text: string): string {
  return text
    .split(/([^A-Za-z0-9]+)/)
    .map((tok) => (/^[A-Za-z0-9]+$/.test(tok) && isIdLike(tok) ? '*' : tok))
    .join('');
}

/** A candidate's identity with per-record ids blanked — its shape AND its name/value. */
function candSkeleton(c: LocatorCandidate): string {
  switch (c.kind) {
    case 'role':
      return `role:${c.role}:${stripIds(c.name ?? '')}`;
    case 'text':
      return `text:${stripIds(c.text ?? '')}`;
    case 'label':
      return `label:${stripIds(c.label ?? '')}`;
    case 'placeholder':
      return `placeholder:${stripIds(c.placeholder ?? '')}`;
    case 'testid':
      return `testid:${stripIds(c.value)}`;
    default:
      return locatorShape(c);
  }
}

function chainSkeleton(chain: LocatorCandidate[] | undefined): string {
  return (chain ?? []).map(candSkeleton).join('|');
}

/** Two steps are the same procedure applied to (possibly) a different record. */
function loopEquivalent(a: SkillStep, b: SkillStep): boolean {
  if (a.tool !== b.tool || a.tool === 'loop') return false;
  return chainSkeleton(a.locators.target) === chainSkeleton(b.locators.target) && chainSkeleton(a.locators.source) === chainSkeleton(b.locators.source);
}

/** True when two groups differ in a *raw* id somewhere — proof they act on distinct records, not an accidental repeat. */
function differsInRawId(a: SkillStep[], b: SkillStep[]): boolean {
  const raw = (g: SkillStep[]) => JSON.stringify(g.map((s) => [s.locators.target ?? [], s.locators.source ?? []]));
  return raw(a) !== raw(b);
}

/**
 * Collapse a run of ≥2 consecutive, structurally-identical action groups that
 * differ only in a per-record id — the signature of iterating over a list (e.g.
 * deleting each part in turn) — into a single `loop` step. The loop repeats its
 * body while the body's first target still matches an element, so a replay on a
 * list of a different length still clears it, instead of hard-coding the count
 * seen when recording. Conservative by construction: distinct fields (a title
 * vs a customer box) have different skeletons and never fold, and an accidental
 * identical repeat (no id difference) is left alone.
 */
export function foldLoops(steps: SkillStep[]): SkillStep[] {
  const out: SkillStep[] = [];
  let i = 0;
  while (i < steps.length) {
    let folded = false;
    // Prefer the smallest group length so [del, confirm] folds before [del]×2.
    for (let len = 1; len <= MAX_GROUP_LEN && i + 2 * len <= steps.length; len++) {
      const group = steps.slice(i, i + len);
      if (group.some((s) => s.tool === 'loop' || NON_LOOP_TOOLS.has(s.tool))) continue;
      // The body must anchor on a repeatable, locate-able ACTION (a click on a
      // record's control), never an observation.
      if (!LOOP_ANCHOR_TOOLS.has(group[0].tool) || !group[0].locators.target?.length) continue;
      let count = 1;
      const groups: SkillStep[][] = [group];
      while (i + (count + 1) * len <= steps.length) {
        const next = steps.slice(i + count * len, i + (count + 1) * len);
        if (!group.every((s, k) => loopEquivalent(s, next[k]))) break;
        groups.push(next);
        count++;
      }
      if (count < 2) continue;
      // Require a real per-record id difference across at least one pair, so we
      // only fold genuine iteration, never a control legitimately hit twice.
      if (!groups.slice(1).some((g) => differsInRawId(group, g))) continue;
      out.push({
        tool: 'loop',
        args: {},
        locators: {},
        body: group,
        while: group[0].locators.target,
        max: Math.min(count * 2 + 3, LOOP_MAX_ITER_CAP),
      });
      i += count * len;
      folded = true;
      break;
    }
    if (!folded) out.push(steps[i++]);
  }
  return out;
}
