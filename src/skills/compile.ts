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
  /**
   * Run-scoped values the caller declared or minted (flow vars, url
   * provenance), slotted by policy wherever they occur — see discoverSlots.
   * Keys are informational; only the values matter.
   */
  knownValues?: Record<string, string>;
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
  /**
   * What the page showed where this segment starts: the instruction-start
   * snapshot for segment 0, the seam step's added lines for the rest. The
   * evidence behind `preconditions.requireText` — see identityText().
   */
  startText?: string;
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

  const slots = discoverSlots(input.instruction, steps, input.knownValues);
  const sub = (s: string) => substitute(s, slots);
  /** The caller's values for THIS run — a runid, a record it vouched for. */
  const runValues = Object.values(input.knownValues ?? {})
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length >= 3);

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
  let seg: Segment = {
    steps: [],
    startUrl,
    ...(head?.fingerprint ? { fingerprint: head.fingerprint } : {}),
    ...(head?.startText ? { startText: head.startText } : {}),
  };
  let currentUrl = startUrl;
  for (const step of kept) {
    seg.steps.push(step);
    if (step.diff?.url && step.diff.url !== currentUrl) {
      const crossed = urlPattern(step.diff.url, slots) !== urlPattern(currentUrl, slots);
      currentUrl = step.diff.url;
      if (crossed) {
        segments.push(seg);
        seg = {
          steps: [],
          startUrl: currentUrl,
          ...(step.fingerprintAfter ? { fingerprint: step.fingerprintAfter } : {}),
          ...(step.diff?.added?.length ? { startText: step.diff.added.join('\n') } : {}),
        };
      }
    }
  }
  if (seg.steps.length) segments.push(seg);

  // Provenance slots: values this run minted (first surfaced in a step's
  // post-nav url). Kept only where they can pay: a later step or a later
  // segment's start url mentions the value — otherwise the marker would just
  // blunt the minting step's own expectation for nothing.
  const mintedAll = discoverMinted(kept, startUrl, slots);
  const minted = mintedAll.filter(
    (m) =>
      JSON.stringify(kept.slice(m.keptIndex + 1).map((s) => [s.args, s.locators, s.diff ?? null])).includes(m.value) ||
      segments.some((sg, si) => si > 0 && urlParts(sg.startUrl).some((p) => p.value === m.value)),
  );
  const mintedMap = (pred: (m: MintedValue) => boolean) => new Map(minted.filter(pred).map((m) => [m.name, m.value] as const));

  // Build every segment's steps first: slot retention is decided across the
  // WHOLE chain (a slot used only by segment 2 must stay in the shared
  // template, or binding an instruction to segment 1 would fail).
  let segOffset = 0;
  const built = segments.map((sg) => {
    const base = segOffset;
    segOffset += sg.steps.length;
    const segParams: Record<string, SkillParam> = {};
    for (const [name, value] of slots) segParams[name] = { example: value, usedIn: [] };
    const skillSteps: SkillStep[] = sg.steps.map((step, i) => {
      const g = base + i;
      // A minted value is a reference only DOWNSTREAM of its mint: in this
      // step's args/locators when minted strictly earlier, and in this step's
      // expectation when minted here or earlier (the minting step's own
      // post-nav url is the first downstream occurrence).
      const mintedBefore = mintedMap((m) => m.keptIndex < g);
      const mintedHere = mintedMap((m) => m.keptIndex <= g);
      const args = substituteDeep(substituteDeep(step.args, slots), mintedBefore) as Record<string, unknown>;
      const locators: Record<string, LocatorCandidate[]> = {};
      for (const [key, loc] of Object.entries(step.locators)) {
        const filled = (loc.chain ?? []).map((c) => substituteDeep(substituteDeep(c, slots), mintedBefore) as LocatorCandidate);
        // An identity anchor still carrying THIS RUN's known value after
        // slotting (the recorded runid, because the value was typed in an
        // earlier instruction and so is not a slot here) can never match
        // again — and worse, with no {{marker}} it carries no identity, so
        // replay stops holding its fallbacks to the record and follows a
        // positional one onto whatever sorted into that row (fwrd12l 04-add,
        // 06-set). An anchor that cannot parameterise is not an anchor.
        // Never strand the whole chain: a step with no way at all to find its
        // element is worse than one carrying a candidate that will miss.
        const usable = filled.filter((c) => !stranded(c, runValues) && !bookmarked(c));
        const kept = stableFirst(usable.length ? usable : filled);
        // A READ that lost its anchor and can now only be found BY POSITION
        // must not publish. fwrd16-n3 is the cost of the alternative: the
        // read fell back to `tbody > tr:nth-of-type(1) > td`, resolved
        // instantly on a list whose first row was a seed ticket, and the step
        // published `ref: RD-1014` at tier A with zero turns — a confidently
        // wrong identity, which every later step then carried. Emptying the
        // chain makes replay SKIP the read (reads are observations; a missing
        // one is recoverable), so the value comes back absent, not wrong.
        const lostAnchor = filled.length !== kept.length && filled.some((c) => c.kind === 'scoped');
        const isRead = step.tool === 'read' || step.tool === 'read_all';
        locators[key] = isRead && lostAnchor && kept.every(positional) ? [] : kept;
      }
      const out: SkillStep = { tool: step.tool, args, locators };
      const expect = expectationFor(step, slots);
      if (expect) out.expect = substituteDeep(expect, mintedHere) as StepExpectation;
      const label = readLabel(step, reportValues);
      // A read with no way to find its element again publishes nothing, so it
      // must not advertise the value either — publishedOutputs reads `label`,
      // and a promised output that never arrives sends later steps to
      // recovery with the reference blank.
      if (label && Object.values(locators).some((chain) => chain.length)) out.label = label;
      if (step.via) out.via = step.via;
      for (const name of slotsUsed(JSON.stringify({ args, locators }))) segParams[name]?.usedIn.push(i + 1);
      return out;
    });
    const mintedForStart = mintedMap((m) => m.keptIndex < base);
    return { sg, segParams, mintedForStart, folded: foldLoops(coalesceControls(dropSupersededNavigation(skillSteps))) };
  });

  // Derived-param metadata lands on the MINTING segment: which post-fold step
  // to bind from, and which url part to read there. Replay binds the value
  // from the live run's own url right after that step executes.
  const segDerived: Record<number, Record<string, { step: number; at: string; example: string }>> = {};
  for (const m of minted) {
    const si = segments.findIndex((sg, k) => {
      const start = segments.slice(0, k).reduce((a, s) => a + s.steps.length, 0);
      return m.keptIndex >= start && m.keptIndex < start + sg.steps.length;
    });
    if (si < 0) continue;
    const marker = `{{${m.name}}}`;
    const stepIdx = built[si].folded.findIndex((st) => JSON.stringify(st).includes(marker));
    if (stepIdx < 0) continue;
    (segDerived[si] ??= {})[m.name] = { step: stepIdx + 1, at: m.at, example: m.value };
  }

  // Drop slots no segment uses: instruction-only words (e.g. an id the
  // orchestrator mentioned for context) would only make matching harder.
  // EXCEPT known run values: a runid or threaded ref that appears only in the
  // wording still changes every run, so leaving it literal would make the
  // template single-run — bindSkill could never match run n+1's instruction.
  const knownVals = new Set(Object.values(input.knownValues ?? {}).map((v) => String(v ?? '').trim()));
  const usedNames = new Set<string>();
  for (const b of built) for (const [name, p] of Object.entries(b.segParams)) if (p.usedIn.length) usedNames.add(name);
  // A known value can be wholly swallowed by a longer slot (the bare runid
  // inside the ticket-title slot): its marker then appears nowhere, and a
  // param that can never bind makes bindSkill refuse the skill's own source
  // instruction. Keep a known-value slot only when its marker survives.
  const tentative = sub(input.instruction);
  const keptSlots = new Map(
    [...slots].filter(([n, v]) => usedNames.has(n) || (knownVals.has(v) && tentative.includes(`{{${n}}}`))),
  );
  const finalTemplate = keptSlots.size === slots.size ? sub(input.instruction) : substitute(input.instruction, keptSlots);
  // The mirror hazard: a slot whose marker survives only in STEPS (its every
  // instruction occurrence was swallowed by a longer slot, or the value came
  // from an EARLIER instruction and this one never names it) can never bind
  // from the template — bindSkill derives values from the template alone,
  // then requires every param to have one.
  //
  // If the run banked the value, the param binds to its ORIGIN instead: a
  // later run resolves its own from the same place, and the marker stays. Only
  // when the origin is unknown do we fall back to re-inlining the recorded
  // literal, which is the compromise that put the recording run's runid inside
  // an anchor's hasText and cost every replay a positional fallback
  // (fwrd19l 04-edit, on both replays, deterministically).
  const originOfValue = new Map(Object.entries(input.knownValues ?? {}).map(([key, v]) => [String(v ?? '').trim(), key]));
  const bindings = new Map<string, string>();
  const inTemplate = new Set(Array.from(finalTemplate.matchAll(/\{\{(v\d+)\}\}/g), (m) => m[1]));
  for (const [name, value] of [...keptSlots]) {
    if (inTemplate.has(name)) continue;
    const origin = originOfValue.get(value);
    if (origin) {
      bindings.set(name, origin);
      continue;
    }
    keptSlots.delete(name);
    for (const b of built) b.folded = fillParamsDeep(b.folded, { [name]: value }) as SkillStep[];
  }

  const now = input.now ?? new Date().toISOString();
  const reportTemplate = {
    summary: sub(input.report.summary),
    values: Object.fromEntries(Object.entries(reportValues).map(([k, v]) => [k, sub(String(v))])),
  };
  const of = built.length;
  const chain = of > 1 ? newSkillId(origin, finalTemplate, now) : null;

  return built.map((b, k) => {
    const params: Record<string, SkillParam> = {};
    for (const name of keptSlots.keys()) {
      const value = keptSlots.get(name) ?? '';
      params[name] = {
        ...b.segParams[name],
        ...(derivesFromKnown(value, knownVals) ? { known: true as const } : {}),
        ...(bindings.has(name) ? { binding: bindings.get(name) as string } : {}),
      };
    }
    return {
      id: newSkillId(origin, of > 1 ? `${finalTemplate}#${k}` : finalTemplate, now),
      origin,
      template: finalTemplate,
      params,
      preconditions: {
        urlPattern: urlPattern(b.sg.startUrl, new Map([...slots, ...b.mintedForStart])),
        ...(b.sg.fingerprint ? { fingerprint: b.sg.fingerprint } : {}),
        ...(identityOf(b.sg.startText, keptSlots, knownVals).length
          ? { requireText: identityOf(b.sg.startText, keptSlots, knownVals) }
          : {}),
      },
      steps: b.folded,
      ...(segDerived[k] ? { derived: segDerived[k] } : {}),
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

const MIN_IDENTITY_LEN = 4;
const MAX_IDENTITY = 2;

/**
 * Which caller-vouched values the page ALREADY showed where this segment
 * starts — the segment's identity precondition, as slot markers so replay
 * checks the live run's own values.
 *
 * Only known values qualify (the runid, a threaded ref, url provenance): they
 * are the ones that name the record the caller means, and a value the
 * compiler merely inferred from repeated text could easily be page furniture.
 * A value the segment is about to TYPE is not on the page yet, so it never
 * qualifies either — which is what keeps this from refusing a create step.
 */
/**
 * Caller-vouched, or built out of something the caller vouched for: the
 * ticket TITLE ("r9-n2 RD Bench Ticket") is as run-scoped as the runid inside
 * it, and it is usually the title — not the bare runid — that survives as a
 * slot, because the longer value swallows the shorter one. Treating only the
 * exact known value as identity would therefore lose identity on exactly the
 * skills that need it.
 */
function derivesFromKnown(value: string, known: Set<string>): boolean {
  if (known.has(value)) return true;
  for (const k of known) {
    if (k.length < 3 || k.length === value.length) continue;
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(k)}(?![A-Za-z0-9])`).test(value)) return true;
  }
  return false;
}

function identityOf(startText: string | undefined, slots: Map<string, string>, known: Set<string>): string[] {
  if (!startText) return [];
  const out: string[] = [];
  for (const [name, value] of slots) {
    if (out.length >= MAX_IDENTITY) break;
    if (!derivesFromKnown(value, known) || value.length < MIN_IDENTITY_LEN || /^https?:/i.test(value)) continue;
    if (!startText.includes(value)) continue;
    out.push(`{{${name}}}`);
  }
  return out;
}

const MIN_MINTED_LEN = 4;
const MAX_MINTED = 8;

interface MintedValue {
  name: string;
  value: string;
  /** Index into the kept-steps array of the step whose post-nav url minted it. */
  keptIndex: number;
  /** Which url part carried it (urlParts label), for live re-extraction. */
  at: string;
}

/**
 * Mechanism-1 provenance (PLAN-replay-v2): values the run itself minted. A
 * url part that first appears in a step's post-navigation url — absent from
 * the start url, every earlier url, the caller's slot values and everything
 * the agent typed — was created by this run (a fresh record id, a generated
 * uid). Every later occurrence is downstream of that step's outcome, so it
 * becomes a {{dN}} reference bound at replay time from where the browser
 * actually lands — the same mechanism as discoverSlots, with a new value
 * source, and the same guards: length >= 4, whole-value match, first
 * appearance wins.
 */
function discoverMinted(kept: RecordedStep[], startUrl: string, slots: Map<string, string>): MintedValue[] {
  const seen = new Set<string>(urlParts(startUrl).map((p) => p.value));
  const slotVals = new Set(slots.values());
  const out: MintedValue[] = [];
  kept.forEach((step, i) => {
    // Values the agent TYPED are inputs, not mints, wherever they surface later.
    for (const v of Object.values(step.args)) if (typeof v === 'string') seen.add(v);
    if (!step.diff?.url) return;
    for (const part of urlParts(step.diff.url)) {
      const v = part.value;
      const fresh = !seen.has(v);
      seen.add(v);
      if (!fresh || v.length < MIN_MINTED_LEN || slotVals.has(v) || /\{\{/.test(v)) continue;
      // A stable route word ("tickets", "dashboards") also first appears in a
      // post-nav url once; claiming it would wildcard preconditions that
      // should stay exact. Requiring a digit is a heuristic, but one whose
      // being wrong costs a soft-match comparison (mechanism 2 still catches
      // a digitless minted id), not a dead flow.
      if (!/\d/.test(v)) continue;
      if (out.length >= MAX_MINTED) continue;
      out.push({ name: `d${out.length + 1}`, value: v, keptIndex: i, at: part.label });
    }
  });
  return out;
}

/**
 * Literal values the agent used that also appear as whole tokens in the
 * instruction. Ordered by first occurrence in the instruction, longest match
 * first when values nest ("x7 RD Part A" before "x7").
 *
 * `known` are run-scoped values the CALLER vouches for — declared flow vars
 * (the runid) and minted url-provenance parts. They are slotted by policy,
 * not heuristics: every occurrence in the instruction, args, and locators is
 * the same value playing the same role by construction, so the
 * single-occurrence guard below does not apply to them (unlike admin/admin,
 * where one string served two different roles). This is what keeps a run
 * identifier out of a compiled skill: fwrd3 baked "fwrd3-n1"/"RD-1015" into
 * templates and steps, so every skill was single-run poison — tier-A replay
 * died at the first stale literal on every later run, and repairs minted a
 * fresh single-run corpse each time instead of converging.
 */
export function discoverSlots(
  instruction: string,
  steps: RecordedStep[],
  known: Record<string, string> = {},
): Map<string, string> {
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
  const knownVals: string[] = [];
  for (const raw of Object.values(known)) {
    const v = String(raw ?? '').trim();
    if (v.length < 2 || v.length > 200) continue;
    if (!occursAsToken(instruction, v) || knownVals.includes(v)) continue;
    knownVals.push(v);
  }
  knownVals.sort((a, b) => instruction.indexOf(a) - instruction.indexOf(b) || b.length - a.length);
  const ordered = [...values]
    .filter((v) => !knownVals.includes(v))
    // A value appearing twice in the instruction cannot be given a slot: one
    // slot name would stand for two roles. "sign in with email admin and
    // password admin" compiled to "email {{v1}} and password {{v1}}", and
    // bindSkill emits a capture group per OCCURRENCE, so replaying it with
    // "email alice@example.com and password hunter2" bound v1 to the last
    // group and typed the password into the email field — silently, and with
    // a credential. Leaving such a value literal costs generality (the skill
    // only replays for the values it was recorded with) and keeps
    // correctness, which is the right way round. Distinct positional slots
    // per occurrence would recover the generality, but they also need the
    // step-to-occurrence mapping that plain textual substitution cannot
    // recover, so that is a separate change.
    .filter((v) => countTokenOccurrences(instruction, v) === 1)
    .map((v) => ({ v, at: instruction.indexOf(v) }))
    .sort((a, b) => a.at - b.at || b.v.length - a.v.length)
    .slice(0, Math.max(0, MAX_SLOT_VALUES - knownVals.length));
  const slots = new Map<string, string>();
  // Known values first so a cap can never cut them: they are the slots that
  // decide whether the skill survives past the run that recorded it.
  [...knownVals, ...ordered.map(({ v }) => v)].forEach((v, i) => slots.set(`v${i + 1}`, v));
  return slots;
}

/** How many times `value` stands as a whole token in `text`. */
export function countTokenOccurrences(text: string, value: string): number {
  if (!value) return 0;
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(value)}(?=$|[^A-Za-z0-9])`, 'g');
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
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
/**
 * An identity anchor left naming the recorded run's record: its text still
 * contains a value the caller vouched for THIS run, with no slot to swap.
 * Only anchors qualify — a role/text locator that survives un-slotted is
 * ordinary UI text, and dropping it would cost a working fallback.
 */
/**
 * Positional: this candidate finds an element by WHERE it sits (a structural
 * path, or an index into a set of matches), not by what it is. Fine as a
 * fallback for an action whose target is otherwise pinned; never sufficient
 * on its own for a read that names a record.
 */
function positional(c: LocatorCandidate): boolean {
  return c.kind === 'css' || c.nth !== undefined;
}

function stranded(c: LocatorCandidate, runValues: string[]): boolean {
  const fields: string[] = [];
  if (c.kind === 'scoped') fields.push(c.hasText);
  // A NAME that is really a record reference. The rule used to stop at
  // anchors, reasoning that "a role/text locator that survives un-slotted is
  // ordinary UI text, and dropping it would cost a working fallback". True of
  // ordinary UI text — false of a link whose accessible name IS the ticket
  // ref. fwrd22l shipped six of these, `getByText('RD-1015')` and
  // `getByRole('link', { name: 'RD-1015' })`, every one of them pinned to the
  // record the RECORDING run created. A value that changes every run is not a
  // working fallback, it is a fallback that has already stopped working.
  else if (c.kind === 'role') fields.push(c.name);
  else if (c.kind === 'text') fields.push(c.text);
  else if (c.kind === 'label') fields.push(c.label);
  else if (c.kind === 'placeholder') fields.push(c.placeholder);
  // An ADDRESS welded out of a value this run minted. `ticket-link-t15` is
  // the record's own id inside a test hook, and it survived every fix so far
  // because this check only ever looked at anchors: fwrd20l and fwrd21l both
  // shipped it. stableFirst demotes it to the tail, so it is not usually
  // reached — but if the anchor and the structural path both miss, it
  // resolves against whatever wears that id NEXT run, which on an app that
  // reuses ids is a different record.
  else if (c.kind === 'testid') fields.push(c.value);
  else if (c.kind === 'id' || c.kind === 'css') fields.push(c.selector);
  return fields.some((f) => runValues.some((v) => f.includes(v)));
}

/**
 * An ADDRESS that is really a bookmark: a test hook or an id whose text
 * carries a minted identifier, like `ticket-link-t15`. Next run the record is
 * t16 and it matches nothing — or worse, on an app that reuses ids, it
 * matches a DIFFERENT record.
 *
 * Distinct from `stranded`, which needs the value to be one the run
 * demonstrably made. That is not enough here: the id an instruction MINTS is
 * unknown while that instruction is compiling — repair-desk's create step
 * never visits a t15 url, so nothing banks it — yet the testid recorded on
 * that very step already has it welded in. fwrd19l shipped three, fwrd20l and
 * fwrd21l two each, all of them below `stranded`'s reach.
 *
 * Structural, so it needs no provenance: an id-like token that is not a slot
 * marker. Bare one- and two-digit numbers are excluded by `isIdLike`'s
 * callers here, so ordinary hooks (`del-1`, `row-2`) are untouched.
 */
function bookmarked(c: LocatorCandidate): boolean {
  if (c.kind !== 'testid' && c.kind !== 'id') return false;
  const text = c.kind === 'testid' ? c.value : c.selector;
  return text
    .split(/[^A-Za-z0-9{}]+/)
    .filter(Boolean)
    .some((tok) => !tok.includes('{{') && isIdLike(tok) && !/^\d{1,2}$/.test(tok));
}

function locatorValues(chain: LocatorCandidate[]): string[] {
  const out: string[] = [];
  for (const c of chain) {
    if (c.kind === 'scoped') out.push(c.hasText);
    else if (c.kind === 'role') out.push(c.name);
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

/** Inverse of substitute(): fill "{{vN}}" (caller param) and "{{dN}}" (derived,
 * bound from the live run's own urls) markers from a param map. */
export function fillParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{([vd]\d+)\}\}/g, (m, name: string) => (name in params ? params[name] : m));
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
  /**
   * A hash-routed app puts its route in the fragment, in one of two shapes: a
   * path ("#/orders/123") or a query-like state string
   * ("#action=123&cids=1&menu_id=81", which is Odoo). Only the path shape was
   * being reduced, because norm() splits on "/" and a query-shaped fragment
   * has none — so the whole fragment survived verbatim, volatile ids and all.
   *
   * That made a segment's precondition unmatchable by anything but the run
   * that recorded it: Odoo hands out a fresh action id per session, so a
   * chain's second segment refused every replay and the work fell back to the
   * model, run after run, with the store looking perfectly healthy.
   *
   * Keys are kept (they are what distinguishes one template from another) and
   * id-like values reduced. Pairs are sorted because the app is free to emit
   * them in any order between runs, and two orderings of the same state are
   * the same page.
   */
  const normHash = (raw: string): string => {
    const body = raw.split('?')[0];
    if (!body) return '';
    if (body.startsWith('/') || !body.includes('=')) return '#' + norm(body);
    const pairs = body
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        const filled = substitute(decodeURIComponent(value), slots);
        if (filled !== value && filled.includes('{{')) return `${key}=${filled}`;
        return `${key}=${isIdLike(value) ? ':id' : value}`;
      })
      .sort();
    return '#' + pairs.join('&');
  };
  const hash = u.hash && u.hash.length > 1 ? normHash(u.hash.slice(1)) : '';
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

/**
 * A url decomposed for structural matching: origin, path segments, and the
 * hash fragment as either route segments or state pairs. Parses stored
 * patterns (which may carry `:id` / `:var` / `{{…}}` markers) and live urls
 * alike; the query string is not part of a page's identity and is dropped.
 */
interface UrlShape {
  origin: string;
  path: string[];
  hashKind: 'none' | 'path' | 'state';
  hashPath: string[];
  hashState: Map<string, string>;
  /** Whether a path-shaped fragment began with '/', for round-tripping. */
  hashSlash: boolean;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function urlShapeOf(s: string): UrlShape | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const origin = u.protocol === 'file:' ? 'file://' : u.origin;
  const shape: UrlShape = {
    origin,
    path: u.pathname.split('/').filter(Boolean).map(safeDecode),
    hashKind: 'none',
    hashPath: [],
    hashState: new Map(),
    hashSlash: false,
  };
  const body = u.hash && u.hash.length > 1 ? u.hash.slice(1).split('?')[0] : '';
  if (!body) return shape;
  if (body.startsWith('/') || !body.includes('=')) {
    shape.hashKind = 'path';
    shape.hashSlash = body.startsWith('/');
    shape.hashPath = body.split('/').filter(Boolean).map(safeDecode);
    return shape;
  }
  shape.hashKind = 'state';
  for (const pair of body.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 0) shape.hashState.set(pair, '');
    else shape.hashState.set(pair.slice(0, eq), safeDecode(pair.slice(eq + 1)));
  }
  return shape;
}

function serializeShape(s: UrlShape): string {
  let hash = '';
  if (s.hashKind === 'path') hash = '#' + (s.hashSlash ? '/' : '') + s.hashPath.join('/');
  else if (s.hashKind === 'state') {
    hash = '#' + [...s.hashState].map(([k, v]) => `${k}=${v}`).sort().join('&');
  }
  return `${s.origin}/${s.path.join('/')}${hash}`;
}

/** A pattern segment that stands for "any value here". */
function isWildcardSeg(seg: string): boolean {
  return seg === ':id' || seg === ':var' || /\{\{[\w.-]+\}\}/.test(seg);
}

/** One segment where a pattern's literal disagrees with the live url. */
export interface UrlSegDiff {
  where: 'path' | 'hashPath' | 'hashState';
  index?: number;
  key?: string;
  expected: string;
  actual: string;
}

/**
 * Structural comparison of a stored pattern against a live url: `null` when
 * the two are not even the same page shape (different origin, path length,
 * route, or a required state key missing), otherwise the list of segments
 * where a literal in the pattern disagrees with the live value — empty list
 * means a match. Wildcard segments (`:id`, `:var`, unfilled `{{…}}`) match
 * anything: matching consults the pattern's own markers, never a shape
 * heuristic on the live value (that is what made isIdLike load-bearing).
 *
 * A query-shaped fragment is application STATE, and state accumulates (Odoo
 * lands on "#cids=1" and has grown "#action=…&menu_id=…" by the next
 * segment) — so it is a necessary condition: every pair the pattern names
 * must be present, extra live pairs are allowed, and a pattern with no hash
 * requires nothing of a live state fragment. A path-shaped fragment is a
 * route and must match segment for segment.
 */
export function urlDiff(pattern: string, url: string): UrlSegDiff[] | null {
  const p = urlShapeOf(pattern);
  const l = urlShapeOf(url);
  if (!p || !l) return pattern === url ? [] : null;
  if (p.origin !== l.origin || p.path.length !== l.path.length) return null;
  const diffs: UrlSegDiff[] = [];
  p.path.forEach((seg, i) => {
    if (!isWildcardSeg(seg) && seg !== l.path[i]) diffs.push({ where: 'path', index: i, expected: seg, actual: l.path[i] });
  });
  if (p.hashKind === 'path') {
    if (l.hashKind !== 'path' || p.hashPath.length !== l.hashPath.length) return null;
    p.hashPath.forEach((seg, i) => {
      if (!isWildcardSeg(seg) && seg !== l.hashPath[i]) diffs.push({ where: 'hashPath', index: i, expected: seg, actual: l.hashPath[i] });
    });
  } else if (p.hashKind === 'state') {
    if (l.hashKind !== 'state') return null;
    for (const [key, val] of p.hashState) {
      if (!l.hashState.has(key)) return null;
      const lv = l.hashState.get(key)!;
      if (!isWildcardSeg(val) && val !== lv) diffs.push({ where: 'hashState', key, expected: val, actual: lv });
    }
  } else if (l.hashKind === 'path' && l.hashPath.length) {
    return null; // pattern names no route; the live url is on one
  }
  return diffs;
}

/** Whether a live url matches a stored pattern exactly (wildcards aside). */
export function urlMatches(pattern: string, url: string, params: Record<string, string> = {}): boolean {
  return urlDiff(fillParams(pattern, params), url)?.length === 0;
}

const MAX_SOFT_DIFFS = 2;

/**
 * Mechanism-2 tolerance (PLAN-replay-v2): the live url is the same page
 * SHAPE as the pattern but 1–2 literal segments disagree — the signature of
 * an environment-minted identifier (a Grafana uid, an Odoo action id) that
 * this run minted differently. Returns the pattern with exactly the
 * disagreeing segments generalised to `:var`, for the caller to proceed
 * optimistically and PERSIST only once the run past this point succeeds —
 * the segment has then demonstrated volatility. Null when the urls differ in
 * shape, everything matched already, or a slot value broke segmentation.
 */
export function softUrlMatch(
  pattern: string,
  url: string,
  params: Record<string, string> = {},
): { generalised: string; diffs: UrlSegDiff[] } | null {
  const filled = fillParams(pattern, params);
  const diffs = urlDiff(filled, url);
  if (!diffs || !diffs.length || diffs.length > MAX_SOFT_DIFFS) return null;
  // Generalise in the ORIGINAL pattern (markers intact). A param value
  // containing '/' would shift segment positions between the two — bail.
  const orig = urlShapeOf(pattern);
  const fld = urlShapeOf(filled);
  if (!orig || !fld || orig.path.length !== fld.path.length || orig.hashPath.length !== fld.hashPath.length) return null;
  for (const d of diffs) {
    if (d.where === 'path') orig.path[d.index!] = ':var';
    else if (d.where === 'hashPath') orig.hashPath[d.index!] = ':var';
    else orig.hashState.set(d.key!, ':var');
  }
  return { generalised: serializeShape(orig), diffs };
}

/**
 * The addressable parts of a url, labelled stably so a value observed at
 * record time can be re-extracted from the live run's url at the same
 * position: path segments `p<i>`, hash-route segments `h<i>`, hash-state
 * values `q.<key>`.
 */
export function urlParts(url: string): { label: string; value: string }[] {
  const s = urlShapeOf(url);
  if (!s) return [];
  const out: { label: string; value: string }[] = [];
  s.path.forEach((value, i) => out.push({ label: `p${i}`, value }));
  s.hashPath.forEach((value, i) => out.push({ label: `h${i}`, value }));
  for (const [k, value] of s.hashState) out.push({ label: `q.${k}`, value });
  return out;
}

export function urlPart(url: string, label: string): string | undefined {
  return urlParts(url).find((p) => p.label === label)?.value;
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

/**
 * Drop a navigation whose destination another navigation immediately
 * replaces. The agent explores — fwod6's step-01 skill recorded `goto /web`,
 * a hand-built `#action=&…&menu_id=` url, then `goto /web?cids=1` — and a
 * procedure that re-walks the search is not the procedure, just its history.
 * Only strictly adjacent navigations qualify: once anything else ran, the
 * intermediate page may have been load-bearing (a session bootstrap, a
 * redirect that set a cookie), and this cannot tell from the outside.
 */
export function dropSupersededNavigation(steps: SkillStep[]): SkillStep[] {
  return steps.filter((step, i) => !(step.tool === 'goto' && steps[i + 1]?.tool === 'goto'));
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
