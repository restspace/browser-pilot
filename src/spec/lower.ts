// The inverse of `flowToSpec` (ir.ts): turns a compiled `SpecFlow` back into
// the `Flow` + `Skill[]` shape the existing replay/repair machinery already
// understands, so `sitelooper repair <x.flow.ts>` does not need a second,
// spec-native runner. Lift gets a spec out of a `.flow.ts` file; lower gets
// it back INTO the store-and-flow world repair.ts, replay.ts and the CLI's
// `run` already operate on.
//
// This only has to be as faithful as `flowToSpec` is honest about being
// lossy: fingerprint, stats history, status history and the recording model
// are gone for good once a spec is emitted (ir.ts's header comment explains
// why), so lower manufactures fresh, conservative values for them rather
// than pretending to recover what was never carried. A compiled spec is by
// definition the converged output of a prior run, so `status: 'validated'`
// is not a guess — that is what "compiled" means.
import type { Flow, FlowStep } from '../skills/flow.js';
import type { Skill, SkillStore } from '../skills/store.js';
import type { SpecFlow, SpecSegment, SpecStep } from './ir.js';

/**
 * Rebuild one segment as a `Skill`.
 *
 * `id` and the procedure fields (template/params/preconditions/steps/derived)
 * are copied straight from the segment — those are exactly what `toSegment`
 * (ir.ts) kept, so copying them back is the whole round trip. Everything else
 * is bookkeeping `toSegment` deliberately drops and this function has to
 * invent: zeroed stats (a compiled spec carries no replay history), no
 * fingerprint (the emitted spec never had one to begin with — a live DOM
 * count vector needs a runtime, not a JSON literal), and a synthetic
 * provenance naming the spec as its own source rather than a recording
 * session.
 *
 * `seq` is set only when the step's procedure has more than one segment: a
 * single-segment skill in the wild never carries `seq` (see `Skill.seq` and
 * `chainOf` in ir.ts, which treats an absent `seq` as "this skill is its own
 * one-member chain"), and giving every skill a `seq` here would desync from
 * that. The chain id is the step's FIRST segment's id — stable, unique to
 * this step (segment ids are unique across a store), and exactly what
 * `chainOf` needs to find every member back by filtering the origin's skills
 * on `seq.chain`.
 */
function toSkill(spec: SpecFlow, step: SpecStep, seg: SpecSegment, index: number, total: number, now: string): Skill {
  const skill: Skill = {
    id: seg.id,
    origin: spec.origin,
    template: seg.template,
    params: seg.params,
    preconditions: seg.preconditions.requireText
      ? { urlPattern: seg.preconditions.urlPattern, requireText: seg.preconditions.requireText }
      : { urlPattern: seg.preconditions.urlPattern },
    steps: seg.steps,
    stats: { uses: 0, successes: 0, partial: 0, created: now, failedAtStep: {}, fallthroughs: 0 },
    status: 'validated',
    provenance: { session: `spec:${spec.name}`, instruction: step.instruction, created: now },
  };
  if (seg.derived) skill.derived = seg.derived;
  if (total > 1) skill.seq = { chain: step.segments[0].id, index, of: total };
  return skill;
}

/**
 * Rebuild one `FlowStep`. `skill` points at the first segment's id (index 0)
 * — matching `Skill.seq`'s own doc: "Matching/selection always starts at
 * index 0" — and `chainOf` walks the rest of the chain from there. A step
 * whose spec carried no segments (no converged procedure — `flowToSpec`
 * still exports the shape and warns) gets no `skill` at all, same as a Flow
 * step that never had one.
 *
 * `recorded` and `outputEvidence` are cross-run evidence `SpecStep` never
 * carried in the first place (ir.ts's `SpecStep` has no field for them), so
 * they come back empty/absent rather than fabricated — an empty `recorded`
 * is indistinguishable, to every consumer, from "this run observed nothing
 * yet", which is the truth for a freshly staged spec.
 */
function toFlowStep(spec: SpecFlow, step: SpecStep, now: string, skills: Skill[]): FlowStep {
  const segSkills = step.segments.map((seg, i) => toSkill(spec, step, seg, i, step.segments.length, now));
  skills.push(...segSkills);
  const flowStep: FlowStep = {
    id: step.id,
    instruction: step.instruction,
    params: step.params,
    outputs: step.outputs,
    recorded: {},
  };
  if (segSkills.length) flowStep.skill = segSkills[0].id;
  return flowStep;
}

/**
 * A lifted spec as the Flow + Skill[] the replay/repair code understands.
 *
 * Segments become skills that keep their ids, seq (chain = the flow step's
 * first segment id, index/of from position), preconditions (no fingerprint),
 * steps, derived, params; stats start at zero, status 'validated' (a
 * compiled spec is by definition converged), provenance from the spec.
 *
 * Mirrors `flowToSpec`'s own ordering exactly (same per-step segment order,
 * same chain-id choice) so that `flowToSpec(specToFlow(spec).flow, store)`
 * reproduces `spec` once the returned skills are in a store `flowToSpec` can
 * read — see `stageForReplay`, and PLAN-self-updating-spec.md's round-trip
 * invariant.
 */
export function specToFlow(spec: SpecFlow): { flow: Flow; skills: Skill[] } {
  const now = new Date().toISOString();
  const skills: Skill[] = [];
  const steps = spec.steps.map((step) => toFlowStep(spec, step, now, skills));
  const flow: Flow = {
    name: spec.name,
    origin: spec.origin,
    startUrl: spec.startUrl,
    vars: spec.vars,
    steps,
    provenance: { session: `spec:${spec.name}`, created: now },
  };
  return { flow, skills };
}

/**
 * Write the skills into a store (an isolated temp store is the normal use)
 * and return the flow, ready for `run`.
 *
 * A compiled spec has no store of its own — the spec IS the store, frozen —
 * so `repair` cannot just point the existing replay/repair machinery at
 * `~/.sitelooper/skills` (that store may not even have this origin, or may
 * have moved on since the spec was emitted). Staging into a scratch
 * `SkillStore` gives that machinery the on-disk shape it already expects
 * without teaching it a second, spec-native code path.
 */
export function stageForReplay(spec: SpecFlow, store: SkillStore): Flow {
  const { flow, skills } = specToFlow(spec);
  for (const skill of skills) store.put(skill);
  return flow;
}
