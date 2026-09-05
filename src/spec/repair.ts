// The reviewer-facing half of `sitelooper repair <name.flow.ts>`: what the
// repair pass actually changed, said in the vocabulary of the owned file the
// reviewer is about to see a diff of.
//
// Everything here is PURE — two `SpecFlow`s in, lines of English out, plus
// the small amount of filesystem staging the CLI needs to hand a lifted spec
// to the existing replay/repair machinery. No model, no browser, no daemon:
// the run happens in cli.ts, and this module only ever reads the before/after
// IR it produced. That split is what makes the summary unit-testable at all
// (test/spec-repair.test.ts) — the interesting cases (a fallback promoted, a
// model-proposed locator, a step re-pinned to a variant) are all reachable by
// hand-building two IRs, and none of them need a live app.
//
// The one rule this module enforces rather than merely reports is
// PLAN-self-updating-spec.md's "never weaken an expectation": a repair that
// dropped a step's `expect` is a refusal, not a diff line, and
// `droppedExpectations` is what the CLI gates the write on.
import fs from 'node:fs';
import path from 'node:path';
import { candidateExpr, type LocatorCandidate } from '../daemon/recorder.js';
import { stepByTag } from '../skills/repair.js';
import type { Flow } from '../skills/flow.js';
import { SkillStore, type SkillStep } from '../skills/store.js';
import { flowToSpec, type SpecFlow, type SpecSegment, type SpecStep } from './ir.js';
import { stageForReplay } from './lower.js';

/** One skill step, addressed the way a reviewer can find it again. */
interface FlatStep {
  /** "3" for a top-level step, "3.body.2" for a step inside a folded loop. */
  tag: string;
  step: SkillStep;
}

/**
 * Every locator-bearing step of a segment, loop bodies included, in the order
 * replay walks them. Loop bodies matter here because a chain that drifted
 * inside a loop is exactly the case `triage` canonicalises to ONE ticket —
 * so it is also the case where exactly one line of summary is owed.
 */
function flatten(steps: SkillStep[], prefix = ''): FlatStep[] {
  const out: FlatStep[] = [];
  steps.forEach((step, i) => {
    const tag = `${prefix}${i + 1}`;
    out.push({ tag, step });
    if (step.body?.length) out.push(...flatten(step.body, `${tag}.body.`));
  });
  return out;
}

/** Chains a step carries, keyed by the name a reviewer would recognise. */
function chainsOf(step: SkillStep): Array<[string, LocatorCandidate[]]> {
  const out: Array<[string, LocatorCandidate[]]> = Object.entries(step.locators ?? {}).filter(([, c]) => Array.isArray(c));
  if (step.while?.length) out.push(['while', step.while]);
  return out;
}

const exprs = (chain: LocatorCandidate[]) => chain.map((c) => candidateExpr(c));

/**
 * How one step's `expect` weakened, if it did.
 *
 * Only ever LOSS: a repair that ADDS an expectation is fine (it observed
 * something new), and a changed url pattern is reported as a change, not a
 * weakening — the pattern names where the app went, and the app moving is the
 * drift being repaired. Dropping the whole clause, or dropping members of
 * `addedContains`, is the thing PLAN-self-updating-spec.md forbids: it turns
 * a red build green by asserting less.
 */
function expectationLoss(before: SkillStep, after: SkillStep): string | null {
  const b = before.expect;
  if (!b) return null;
  const a = after.expect;
  if (!a) return 'the step no longer asserts anything about the page it produced';
  const lost: string[] = [];
  if (b.urlPattern && !a.urlPattern) lost.push(`url ${b.urlPattern}`);
  if (b.alertContains && !a.alertContains) lost.push(`alert ${JSON.stringify(b.alertContains)}`);
  for (const line of b.addedContains ?? []) {
    if (!(a.addedContains ?? []).includes(line)) lost.push(`page text ${JSON.stringify(line)}`);
  }
  return lost.length ? `no longer asserts ${lost.join(', ')}` : null;
}

export interface SpecDiff {
  /** The reviewer-facing summary, one line per observation, "no change" per untouched step. */
  lines: string[];
  /** Expectation losses; non-empty means the repair must be refused, not written. */
  droppedExpectations: string[];
  /**
   * Expectation losses on a step that was re-pinned to a repair VARIANT.
   *
   * Reported loudly, but not a refusal, and the distinction is not a loophole:
   * `patchSegment` drops the drifted step's recorded page-change expectation
   * BY CONSTRUCTION, because that expectation names the control that moved
   * (its accessible label, the text it produced) and would hard-fail the very
   * replay the new locator makes possible. The safety here is the variant
   * lifecycle — it has to earn adoption across runs — plus this line in front
   * of a human. A loss with no variant behind it has no such story, and stays
   * a refusal.
   */
  weakenedByVariant: string[];
}

/**
 * Compare two compiled IRs step by step and say, in one line per observation,
 * what the repair pass did.
 *
 * Matching is positional inside a step (segment i to segment i, skill step i
 * to skill step i) because that is what `promoteFallback` and `patchSegment`
 * preserve: neither ever inserts or removes a gesture, they only reorder a
 * chain, prepend a candidate to it, or clone the whole procedure into a
 * variant. Anything that does NOT match up positionally is therefore a
 * structural change worth its own line rather than a mis-alignment to paper
 * over — hence the shape lines below.
 */
export function diffSpecChanges(before: SpecFlow, after: SpecFlow): SpecDiff {
  const lines: string[] = [];
  const droppedExpectations: string[] = [];
  const weakenedByVariant: string[] = [];
  const afterById = new Map(after.steps.map((s) => [s.id, s]));

  for (const b of before.steps) {
    const a = afterById.get(b.id);
    const own: string[] = [];
    if (!a) {
      lines.push(`${b.id}: step is gone from the repaired flow`);
      continue;
    }
    own.push(...diffStep(b, a, droppedExpectations, weakenedByVariant));
    lines.push(...own.map((l) => `${b.id}: ${l}`));
    if (!own.length) lines.push(`${b.id}: no change`);
  }
  for (const a of after.steps) {
    if (!before.steps.some((b) => b.id === a.id)) lines.push(`${a.id}: new step`);
  }
  return { lines, droppedExpectations, weakenedByVariant };
}

/** `diffSpecChanges`, as the plain list of lines the CLI prints. */
export function describeSpecChanges(before: SpecFlow, after: SpecFlow): string[] {
  return diffSpecChanges(before, after).lines;
}

function diffStep(b: SpecStep, a: SpecStep, droppedExpectations: string[], weakenedByVariant: string[]): string[] {
  const out: string[] = [];
  if (a.segments.length !== b.segments.length) {
    out.push(`procedure now has ${a.segments.length} segment(s) (was ${b.segments.length})`);
  }
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const bs = b.segments[i];
    const as = a.segments[i];
    // A re-pin: the flow step points at a different skill than it did, which
    // for repair means the provisional VARIANT patchSegment stored was adopted
    // by the run that followed. Reported first, because every locator line
    // under it is then a line about the variant, not about the original.
    if (as.id !== bs.id) out.push(`step re-pinned to variant ${as.id} (was ${bs.id})`);
    out.push(...diffSegment(b.id, bs, as, as.id !== bs.id, droppedExpectations, weakenedByVariant));
  }
  return out;
}

function diffSegment(
  stepId: string,
  bs: SpecSegment,
  as: SpecSegment,
  isVariant: boolean,
  droppedExpectations: string[],
  weakenedByVariant: string[],
): string[] {
  const out: string[] = [];
  const bSteps = flatten(bs.steps);
  const aSteps = flatten(as.steps);
  const aByTag = new Map(aSteps.map((s) => [s.tag, s]));
  if (aSteps.length !== bSteps.length) {
    out.push(`${as.id} now has ${aSteps.length} step(s) (was ${bSteps.length})`);
  }

  for (const bStep of bSteps) {
    const aStep = aByTag.get(bStep.tag);
    if (!aStep) continue;
    const where = `${as.id} step ${bStep.tag}`;

    const loss = expectationLoss(bStep.step, aStep.step);
    if (loss) {
      const line = `${where}: ${loss}`;
      (isVariant ? weakenedByVariant : droppedExpectations).push(`${stepId}: ${line}`);
      out.push(`${isVariant ? 'REVIEW — the repair variant no longer asserts what the old control produced' : 'EXPECTATION DROPPED'} — ${line}`);
    }

    const aChains = new Map(chainsOf(aStep.step));
    for (const [k, bChain] of chainsOf(bStep.step)) {
      const aChain = aChains.get(k);
      if (!aChain?.length || !bChain.length) continue;
      const bExprs = exprs(bChain);
      const aExprs = exprs(aChain);
      if (aExprs[0] === bExprs[0]) continue;
      const wasAt = bExprs.indexOf(aExprs[0]);
      if (wasAt > 0) {
        out.push(`candidate promoted: ${aExprs[0]} now primary (was #${wasAt}) — ${where} ${k}`);
      } else if (wasAt < 0) {
        const how = isVariant ? `model-proposed variant ${as.id}` : 'model-proposed';
        out.push(`new locator: ${aExprs[0]} (${how}) — ${where} ${k}`);
      } else {
        out.push(`chain reordered — ${where} ${k}`);
      }
    }
  }
  return out;
}

// --- staging -----------------------------------------------------------------

export interface StagedRepair {
  /** An isolated skill store: the run's re-pins, variants and evidence land here and nowhere else. */
  skillsDir: string;
  store: SkillStore;
  /** The lowered flow, written as JSON where the daemon's flow runner can load it by path. */
  flowFile: string;
  flow: Flow;
}

/**
 * Lower a lifted spec into a throwaway store + flow file under `dir`.
 *
 * The point of the isolation is that the run this stages is a REAL sitelooper
 * run — it re-pins, it stores repair variants, it folds candidate evidence
 * back — and none of that may touch `~/.sitelooper`. The spec is the source of
 * truth (PLAN-self-updating-spec.md's one design decision); the store is a
 * scratch buffer that exists for the length of one repair.
 */
export function stageRepair(spec: SpecFlow, dir: string): StagedRepair {
  const skillsDir = path.join(dir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const store = new SkillStore(skillsDir);
  const flow = stageForReplay(spec, store);
  const flowFile = path.join(dir, `${spec.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'flow'}.json`);
  fs.writeFileSync(flowFile, JSON.stringify(flow, null, 2));
  return { skillsDir, store, flowFile, flow };
}

/**
 * Read a staged workspace back after a run has rewritten it.
 *
 * `runFlow` writes re-pins and output evidence back into the flow FILE it
 * loaded, and the drain writes promoted chains and variants into the store,
 * so the repaired IR is exactly what `flowToSpec` makes of those two on disk
 * — not something this process has to reconstruct from what it remembers
 * doing.
 */
export function reloadStaged(staged: Pick<StagedRepair, 'flowFile' | 'skillsDir'>): { spec: SpecFlow; warnings: string[] } {
  const flow = JSON.parse(fs.readFileSync(staged.flowFile, 'utf8')) as Flow;
  return flowToSpec(flow, new SkillStore(staged.skillsDir));
}

/**
 * Per-run values for a converge loop. Every converge iteration is a REAL run
 * against the app, so a flow that creates a record named after a var finds
 * the previous iteration's record next time and the gate fails for a reason
 * that is not drift. A `{n}` token in a --var value is replaced by the run
 * number (0 for the repair run, 1..n for the converge runs) so each run
 * works its own records without the app being reset in between.
 */
export function mintVars(vars: Record<string, string>, n: number): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.split('{n}').join(String(n))]));
}

/**
 * Fold a patch-segment VARIANT back into the chain it was cloned from.
 *
 * `patchSegment` stores its proposal as a provisional variant skill, to be
 * adopted (or not) by the normal replay lifecycle over later runs. That is
 * right for a long-lived store and wrong here, for two reasons.
 *
 * First, correctness: the variant is a clone, `seq` included, so a mid-chain
 * segment's variant claims the SAME chain slot as its original and
 * `flowToSpec` then compiles both — fwrd42's sign-in step went from three
 * segments to four, with the drifted one still first. Second, purpose: in the
 * spec loop the store is a scratch buffer, the `.flow.ts` is the artifact, and
 * the thing that makes an adaptation safe is not a provisional status nobody
 * will ever look at — it is the convergence gate plus a human reading the
 * diff. So the model's locator goes to the FRONT of the real chain, every
 * candidate that was already there stays behind it (drift can revert), the
 * step's expectations are untouched, and the variant is dropped.
 *
 * Returns one line per fold, for the summary.
 */
export function foldPatchedVariants(
  store: SkillStore,
  patched: Array<Record<string, unknown>>,
): string[] {
  const lines: string[] = [];
  for (const row of patched) {
    const variantId = typeof row.variant === 'string' ? row.variant : null;
    const originalId = typeof row.skill === 'string' ? row.skill : null;
    if (!variantId || !originalId) continue;
    const variant = store.get(variantId);
    const original = store.get(originalId);
    const tag = typeof row.step === 'string' ? row.step : undefined;
    const key = typeof row.key === 'string' ? row.key : 'target';
    const vstep = variant ? stepByTag(variant, tag) : null;
    const ostep = original ? stepByTag(original, tag) : null;
    const proposed = vstep?.locators[key]?.[0];
    const chain = ostep?.locators[key];
    if (!variant || !original || !proposed || !chain) {
      lines.push(`could not fold ${variantId} into ${originalId}: the patched step is no longer there`);
      continue;
    }
    const expr = candidateExpr(proposed);
    if (chain.length && candidateExpr(chain[0]) === expr) {
      store.remove(variantId);
      continue;
    }
    // Never a replacement: the dead candidate keeps its place behind the new
    // one, because an app that drifts back should still be found.
    chain.unshift(proposed);
    store.put(original);
    store.remove(variantId);
    lines.push(`${originalId} step ${tag ?? '?'} ${key}: ${expr} folded in as primary (from variant ${variantId})`);
  }
  return lines;
}
