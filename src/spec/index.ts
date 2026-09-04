import fs from 'node:fs';
import path from 'node:path';
import { loadFlow } from '../skills/flow.js';
import { SkillStore } from '../skills/store.js';
import { emitFlowFile, emitSpecFile } from './emit.js';
import { flowToSpec, type SpecFlow } from './ir.js';

export type { SpecFlow, SpecSegment, SpecStep } from './ir.js';
export { emitFlowFile, emitSpecFile } from './emit.js';
export { flowToSpec } from './ir.js';

/** Filename-safe form of a flow name; the same rule flow.ts uses for its own files. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'flow';
}

export interface CompileResult {
  spec: SpecFlow;
  flowFile: string;
  /** null when the scaffold existed already and `force` was not set. */
  specFile: string | null;
  warnings: string[];
  compilable: boolean;
}

/**
 * Compile a converged flow to a reviewable Playwright spec.
 *
 * The `.flow.ts` is rewritten every time — it is generated, and the FLOW
 * constant inside it is what `repair` reads back. The `.spec.ts` is written
 * only when it is absent: it is the user's file, and silently regenerating
 * it would delete the assertions that make the spec theirs.
 */
export function compileFlow(
  flowNameOrPath: string,
  o: { store?: SkillStore; outDir: string; tier?: 'plain'; force?: boolean },
): CompileResult {
  const flow = loadFlow(flowNameOrPath);
  if (!flow) throw new Error(`no flow named ${JSON.stringify(flowNameOrPath)} (looked in the flows dir and as a path)`);
  const store = o.store ?? new SkillStore();
  const { spec, warnings } = flowToSpec(flow, store);
  const emitted = emitFlowFile(spec, { tier: o.tier ?? 'plain' });

  fs.mkdirSync(o.outDir, { recursive: true });
  const base = safeName(spec.name);
  const flowFile = path.join(o.outDir, `${base}.flow.ts`);
  fs.writeFileSync(flowFile, emitted.source);

  const specPath = path.join(o.outDir, `${base}.spec.ts`);
  const exists = fs.existsSync(specPath);
  let specFile: string | null = null;
  if (!exists || o.force) {
    fs.writeFileSync(specPath, emitSpecFile(spec));
    specFile = specPath;
  }

  return {
    spec,
    flowFile,
    specFile,
    warnings: [...warnings, ...emitted.warnings],
    compilable: spec.steps.every((s) => s.segments.length > 0),
  };
}
