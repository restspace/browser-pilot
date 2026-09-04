import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// src/cli.ts imports `compileFlow` from './spec/index.js', a sibling module another
// agent is writing concurrently (see CONTRACT.md). Importing src/cli.ts here would
// execute `main()` at module load and fail on that missing import until it lands, so
// this test reads the source directly instead — a source-level check of the new
// `compile` command's arg-parsing wiring, in the same spirit as the rest of cli.ts's
// hand-rolled `parseArgv` (there is no exported parsing seam to call into).
const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf8');

describe('cli: compile command', () => {
  it('documents the command in USAGE', () => {
    expect(cliSource).toMatch(/sitelooper compile <flow-name-or-path> \[--out <dir>\] \[--force\] \[--json\]/);
  });

  it('accepts --out as a value flag', () => {
    const valueFlags = cliSource.match(/const valueFlags = new Set\(\[([\s\S]*?)\]\);/);
    expect(valueFlags).not.toBeNull();
    expect(valueFlags![1]).toMatch(/'out'/);
  });

  it('accepts --force as a boolean flag', () => {
    const booleanFlags = cliSource.match(/const booleanFlags = new Set\(\[([\s\S]*?)\]\);/);
    expect(booleanFlags).not.toBeNull();
    expect(booleanFlags![1]).toMatch(/'force'/);
  });

  it('dispatches "compile" to a session-less handler, like flow/skills', () => {
    expect(cliSource).toMatch(/if \(command === 'compile'\) \{\s*\n\s*await compileCommand\(positional, flags, json\);/);
  });

  it('imports compileFlow from the spec module with the contracted signature call shape', () => {
    expect(cliSource).toMatch(/import \{ compileFlow \} from '\.\/spec\/index\.js';/);
    expect(cliSource).toMatch(/compileFlow\(flowNameOrPath, \{ outDir, force: flags\.has\('force'\) \}\)/);
  });

  it('exits 2 with a clear message when the compiled flow is not compilable', () => {
    expect(cliSource).toMatch(/not compilable: \$\{missing\} step\(s\) have no converged procedure/);
    expect(cliSource).toMatch(/fail\(`not compilable:.*`, 2\)/);
  });
});
