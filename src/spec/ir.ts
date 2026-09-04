import type { Flow } from '../skills/flow.js';
import type { Skill, SkillParam, SkillStep, SkillStore } from '../skills/store.js';

/**
 * The intermediate representation a compiled spec carries.
 *
 * It is a FLOW plus the converged procedures its steps resolved to, with
 * everything the emitted file cannot honour dropped: stats, status, the
 * structural fingerprint and the model that recorded it. Two reasons for it
 * to be its own shape rather than "a Flow and a store". First, the emitted
 * `.flow.ts` embeds this object verbatim as its FLOW constant, so it has to
 * be self-contained — a spec that resolved its skills out of `~/.sitelooper`
 * at run time would not be a Tier-2 artifact at all. Second, the store is
 * mutable and the file is a snapshot: pinning the procedure here is what
 * makes `lift(emit(spec))` the same IR every time, however the store has
 * moved on since.
 */
export interface SpecFlow {
  version: 1;
  /** Flow name. */
  name: string;
  origin: string;
  startUrl: string;
  /** Flow-level inputs; the spec takes them as a `vars` object. */
  vars: string[];
  /** One per FlowStep, in order. */
  steps: SpecStep[];
}

export interface SpecStep {
  /** FlowStep.id, e.g. "01-open". */
  id: string;
  instruction: string;
  /** slot -> value; values may be literals, "{{var}}" or "{{stepId.output}}" refs (FlowStep.params). */
  params: Record<string, string>;
  /** FlowStep.outputs. */
  outputs: string[];
  /** The converged procedure: the skill's segments in seq order; empty when the step has no skill. */
  segments: SpecSegment[];
}

/** A Skill minus what the spec does not need to carry: stats, status, provenance.model, fingerprint. */
export interface SpecSegment {
  id: string;
  template: string;
  params: Record<string, SkillParam>;
  preconditions: { urlPattern: string; requireText?: string[] };
  /** Verbatim, including locators[].seen evidence, expect, mints, loops. */
  steps: SkillStep[];
  derived?: Skill['derived'];
}

/** A skill as the spec carries it: the procedure, none of the bookkeeping. */
function toSegment(skill: Skill): SpecSegment {
  const seg: SpecSegment = {
    id: skill.id,
    template: skill.template,
    params: skill.params,
    preconditions: { urlPattern: skill.preconditions.urlPattern },
    steps: skill.steps,
  };
  // Identity markers travel; the fingerprint does not — a vector of DOM
  // counts is measured against a live page by a runtime the emitted spec
  // deliberately does not have.
  if (skill.preconditions.requireText?.length) seg.preconditions.requireText = skill.preconditions.requireText;
  if (skill.derived) seg.derived = skill.derived;
  return seg;
}

/**
 * Every segment of the procedure `skill` belongs to, in replay order.
 *
 * A multi-segment skill is ONE recorded instruction split at page-template
 * boundaries (see Skill.seq), and replay composes the chain in `index`
 * order. A compiler that emitted only the segment the flow step points at
 * would silently drop the rest of the instruction — the sign-in step of
 * fwat2 is two segments, and the second is where the app actually lands.
 */
function chainOf(skill: Skill, store: SkillStore): Skill[] {
  if (!skill.seq) return [skill];
  const chain = skill.seq.chain;
  const members = store
    .list(skill.origin)
    .filter((s) => s.seq?.chain === chain)
    .sort((a, b) => (a.seq?.index ?? 0) - (b.seq?.index ?? 0));
  return members.length ? members : [skill];
}

/**
 * Resolve a flow against a skill store into the IR the emitter prints.
 *
 * Warnings are the honest half of the result: a step with no converged
 * procedure still becomes a SpecStep (the flow's shape is worth showing)
 * with empty segments, and the emitter turns that into a `throw` rather
 * than into silence. A demoted skill compiles — it is the best evidence
 * there is — but the caller is told, because a demotion means the last two
 * replays failed at the same step and the emitted assertions inherit that.
 */
export function flowToSpec(flow: Flow, store: SkillStore): { spec: SpecFlow; warnings: string[] } {
  const warnings: string[] = [];
  const steps: SpecStep[] = [];

  for (const step of flow.steps) {
    const skill = step.skill ? store.get(step.skill) : null;
    if (step.skill && !skill) warnings.push(`step ${step.id} refers to skill ${step.skill}, which is not in the store`);
    const segments = skill ? chainOf(skill, store).map(toSegment) : [];
    if (!segments.length) warnings.push(`step ${step.id} has no converged procedure`);
    for (const member of skill ? chainOf(skill, store) : []) {
      if (member.status === 'demoted') {
        warnings.push(`step ${step.id} compiles a demoted skill (${member.id}) — its last replays failed at the same step`);
      }
    }
    steps.push({
      id: step.id,
      instruction: step.instruction,
      params: step.params ?? {},
      outputs: step.outputs ?? [],
      segments,
    });
  }

  return {
    spec: { version: 1, name: flow.name, origin: flow.origin, startUrl: flow.startUrl, vars: flow.vars ?? [], steps },
    warnings,
  };
}
