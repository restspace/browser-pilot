// Lifts an emitted `<name>.flow.ts` back to the `SpecFlow` IR it was generated
// from. This is the other half of the round-trip emit.ts promises: repair
// re-derives the FLOW literal from the live app and needs the OLD spec to
// diff against, and `sitelooper compile --force` needs to know whether a
// `.flow.ts` on disk is still a sitelooper-owned file worth overwriting
// silently versus one a human edited past recognition (isOwnedFlowFile).
//
// Deliberately dumb: this does not re-parse the TypeScript body (the `steps`
// object, `runFlow`, the helpers) because none of that is authoritative — the
// FLOW constant is (see emit.ts's header comment, which this module trusts
// verbatim). Lift only has to find that one JSON literal between two marker
// comments and validate its shape.
import type { SpecFlow } from './ir.js';

const BEGIN_MARKER = '// @sitelooper-flow-begin';
const END_MARKER = '// @sitelooper-flow-end';
const OWNED_HEADER = '@sitelooper-flow v1';
const ASSIGNMENT = 'export const FLOW';

export class LiftError extends Error {}

/**
 * True when `source` carries the header comment + both region markers emit.ts
 * writes. Callers (repair, `compile --force`) use this to decide whether a
 * `.flow.ts` on disk is still fully tool-owned; a file that has lost any of
 * these was edited past the point sitelooper can trust it, even if
 * `liftFlowFile` would still happen to parse what remains.
 */
export function isOwnedFlowFile(source: string): boolean {
  return source.includes(OWNED_HEADER) && source.includes(BEGIN_MARKER) && source.includes(END_MARKER);
}

/**
 * Extracts and validates the `FLOW` constant from an emitted `.flow.ts`
 * source string, returning the `SpecFlow` it encodes. Throws `LiftError`
 * (never a bare parse/type error) naming exactly what was wrong: a missing
 * marker, invalid JSON (e.g. hand-edited to add a trailing comma), an
 * unsupported version, or a shape defect — with the step index / segment id
 * it was found at, so a human fixing a drifted file knows where to look.
 */
export function liftFlowFile(source: string): { spec: SpecFlow; version: 1 } {
  const beginIdx = source.indexOf(BEGIN_MARKER);
  const endIdx = source.indexOf(END_MARKER);
  if (beginIdx === -1 && endIdx === -1) {
    throw new LiftError(
      `neither "${BEGIN_MARKER}" nor "${END_MARKER}" found: this does not look like a sitelooper-generated .flow.ts`,
    );
  }
  if (beginIdx === -1) {
    throw new LiftError(`missing "${BEGIN_MARKER}" marker: the flow region is not delimited`);
  }
  if (endIdx === -1) {
    throw new LiftError(`missing "${END_MARKER}" marker: the flow region is not delimited`);
  }
  if (endIdx < beginIdx) {
    throw new LiftError(`"${END_MARKER}" appears before "${BEGIN_MARKER}": markers are out of order`);
  }

  // Slice strictly between the markers so a stray `export const FLOW = ...`
  // living outside the region (someone pasting an example, or a leftover
  // from a hand merge) is never mistaken for the real one.
  const block = source.slice(beginIdx + BEGIN_MARKER.length, endIdx);

  const assignIdx = block.indexOf(ASSIGNMENT);
  if (assignIdx === -1) {
    throw new LiftError(`no "${ASSIGNMENT} = ..." assignment found between the flow markers`);
  }
  let rest = block.slice(assignIdx + ASSIGNMENT.length);
  const eqIdx = rest.indexOf('=');
  if (eqIdx === -1) {
    throw new LiftError(`malformed "${ASSIGNMENT}" assignment: no "=" found`);
  }
  rest = rest.slice(eqIdx + 1).trim();
  if (!rest.endsWith(';')) {
    throw new LiftError(`malformed "${ASSIGNMENT}" assignment: missing trailing ";"`);
  }
  const jsonText = rest.slice(0, -1).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new LiftError(
      `FLOW constant is not valid JSON (the file may have been hand-edited): ${(e as Error).message}`,
    );
  }

  validateSpecShape(parsed);
  return { spec: parsed, version: 1 };
}

/**
 * Plain-checks the shape contract section 1 defines for `SpecFlow`, throwing
 * `LiftError` on the first defect found. Not a full schema validator (no
 * ajv) — every check is a targeted `typeof`/`Array.isArray` that mirrors
 * exactly what `emitFlowFile` promises to have written, so a legitimately
 * emitted file always passes and a hand-edited one fails loudly at the
 * field that broke.
 */
function validateSpecShape(v: unknown): asserts v is SpecFlow {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new LiftError('FLOW must be a JSON object');
  }
  const flow = v as Record<string, unknown>;

  if (flow.version !== 1) {
    throw new LiftError(`unsupported spec version ${JSON.stringify(flow.version)}: lift only supports version 1`);
  }
  if (typeof flow.name !== 'string') {
    throw new LiftError('FLOW.name must be a string');
  }
  if (typeof flow.origin !== 'string') {
    throw new LiftError('FLOW.origin must be a string');
  }
  if (typeof flow.startUrl !== 'string') {
    throw new LiftError('FLOW.startUrl must be a string');
  }
  if (!Array.isArray(flow.vars) || !flow.vars.every((x) => typeof x === 'string')) {
    throw new LiftError('FLOW.vars must be an array of strings');
  }
  if (!Array.isArray(flow.steps)) {
    throw new LiftError('FLOW.steps must be an array');
  }

  flow.steps.forEach((rawStep, stepIndex) => {
    const stepWhere = describeStep(rawStep, stepIndex);
    if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) {
      throw new LiftError(`${stepWhere}: not an object`);
    }
    const step = rawStep as Record<string, unknown>;
    if (typeof step.id !== 'string') {
      throw new LiftError(`${stepWhere}: missing string "id"`);
    }
    if (typeof step.instruction !== 'string') {
      throw new LiftError(`${stepWhere}: missing string "instruction"`);
    }
    if (typeof step.params !== 'object' || step.params === null || Array.isArray(step.params)) {
      throw new LiftError(`${stepWhere}: "params" must be an object`);
    }
    if (!Array.isArray(step.outputs) || !step.outputs.every((o) => typeof o === 'string')) {
      throw new LiftError(`${stepWhere}: "outputs" must be an array of strings`);
    }
    if (!Array.isArray(step.segments)) {
      throw new LiftError(`${stepWhere}: "segments" must be an array`);
    }

    (step.segments as unknown[]).forEach((rawSeg, segIndex) => {
      const segWhere = describeSegment(stepWhere, rawSeg, segIndex);
      if (typeof rawSeg !== 'object' || rawSeg === null || Array.isArray(rawSeg)) {
        throw new LiftError(`${segWhere}: not an object`);
      }
      const seg = rawSeg as Record<string, unknown>;
      if (typeof seg.id !== 'string') {
        throw new LiftError(`${segWhere}: missing string "id"`);
      }
      if (!Array.isArray(seg.steps)) {
        throw new LiftError(`${segWhere}: "steps" must be an array`);
      }

      (seg.steps as unknown[]).forEach((rawSkillStep, skillStepIndex) => {
        const skillStepWhere = `${segWhere}, steps[${skillStepIndex}]`;
        if (typeof rawSkillStep !== 'object' || rawSkillStep === null || Array.isArray(rawSkillStep)) {
          throw new LiftError(`${skillStepWhere}: not an object`);
        }
        const skillStep = rawSkillStep as Record<string, unknown>;
        if (typeof skillStep.tool !== 'string') {
          throw new LiftError(`${skillStepWhere}: missing string "tool"`);
        }
        if (
          typeof skillStep.locators !== 'object' ||
          skillStep.locators === null ||
          Array.isArray(skillStep.locators)
        ) {
          throw new LiftError(`${skillStepWhere}: "locators" must be an object`);
        }
      });
    });
  });
}

function describeStep(rawStep: unknown, index: number): string {
  const id =
    rawStep && typeof rawStep === 'object' && typeof (rawStep as Record<string, unknown>).id === 'string'
      ? (rawStep as Record<string, unknown>).id
      : undefined;
  return id ? `step[${index}] (id "${id}")` : `step[${index}]`;
}

function describeSegment(stepWhere: string, rawSeg: unknown, index: number): string {
  const id =
    rawSeg && typeof rawSeg === 'object' && typeof (rawSeg as Record<string, unknown>).id === 'string'
      ? (rawSeg as Record<string, unknown>).id
      : undefined;
  return id ? `${stepWhere}, segment[${index}] (id "${id}")` : `${stepWhere}, segment[${index}]`;
}
