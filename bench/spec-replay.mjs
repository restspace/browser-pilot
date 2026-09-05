#!/usr/bin/env node
/**
 * The "Tier 2 spec" arm: compile a converged flow (Flow + SkillStore) to a
 * standalone `@playwright/test` spec with `sitelooper compile`, then replay
 * THAT — not sitelooper, not a raw script — under the real Playwright test
 * runner. No sitelooper runtime, no model, no candidate ladder at replay
 * time: the compiler baked one locator chain per gesture into
 * `<name>.flow.ts` when it ran, and this arm finds out whether that chain
 * still resolves.
 *
 * Where this sits in the matrix: bench/codegen-replay.mjs is the floor
 * (literal recording, no candidate chain, no effect gates). bench/author-
 * replay.mjs is the ceiling for a human/model writing Playwright by hand.
 * This arm is the thing sitelooper itself claims to produce for a reader who
 * wants zero-runtime-dependency Playwright out the other end — it should
 * fall between the two, or the compiler has a bug worth knowing about.
 *
 * Two things this arm needs that the others do not, both preflighted before
 * any work happens:
 *
 *   1. A BUILT `dist/cli.js` (`npm run build`) — `bin/sitelooper.js compile`
 *      is a normal CLI command, not something this script reimplements.
 *   2. `@playwright/test` resolvable from the repo root. As of this file,
 *      it is NOT: the repo depends on `playwright` (the browser-automation
 *      package, which happens to bundle the same test runner CLI) and
 *      `playwright-core`, but not the separate `@playwright/test` package
 *      that the compiler's emitted files import
 *      (`import { expect, type Page } from '@playwright/test'` in
 *      `<name>.flow.ts`; `import { test, expect } from '@playwright/test'`
 *      in `<name>.spec.ts` — see PLAN section on the emitter). Without it,
 *      Node's resolver fails on the very first line of the emitted spec.
 *      `npm install -D @playwright/test` (any version compatible with the
 *      installed `playwright-core`) closes this gap; nothing else does,
 *      because the import specifier is spelled by the emitter, not by this
 *      harness. This script checks for it and exits 2 with that exact
 *      instruction rather than failing deep inside a Playwright stack trace.
 *
 * Usage:
 *   node bench/spec-replay.mjs \
 *     --flow bench/results-published/flows/rdflow.json \
 *     --skills bench/results-published/fwat2-skills \
 *     --tag sprd1 --target repairdesk --out bench/results [--reset] [--dry]
 *
 * `--dry` prints the compile command and the playwright-test command (and
 * writes the generated playwright.config.mjs, so it can be inspected) without
 * running either. That is what this script has actually been exercised with
 * so far — see the file header note in bench/README.md's Matrix 2 section.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_DEFAULTS } from './app-defaults.mjs';
import { resetTarget } from './app-reset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    out[key] = val && !val.startsWith('--') ? (i++, val) : true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
for (const req of ['flow', 'skills', 'tag']) {
  if (!args[req]) {
    console.error(`--${req} is required`);
    process.exit(2);
  }
}
if (args.target && !APP_DEFAULTS[args.target]) {
  console.error(`--target must be one of: ${Object.keys(APP_DEFAULTS).join(', ')}`);
  process.exit(2);
}

const outDir = path.resolve(args.out || 'bench/results');
fs.mkdirSync(outDir, { recursive: true });
const tag = String(args.tag);
const tmpDir = path.join(outDir, `${tag}-spec-tmp`);
fs.mkdirSync(tmpDir, { recursive: true });

const skillsDir = path.resolve(String(args.skills));
const flowArg = String(args.flow);

/** Same name the compiler uses to name its output files: the flow's own
 * `name` field when --flow points at a flow JSON file on disk, else the bare
 * argument (a name sitelooper's own flow store would resolve). Mirrors what
 * `compileFlow`/`flowToSpec` do with `flowNameOrPath` — this script does not
 * reimplement resolution, it only needs to predict the two output paths. */
function flowName(arg) {
  const p = path.resolve(arg);
  if (fs.existsSync(p) && p.endsWith('.json')) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && typeof j.name === 'string') return j.name;
    } catch {
      /* fall through to basename */
    }
  }
  return path.basename(arg).replace(/\.json$/, '');
}
const name = flowName(flowArg);
const flowFile = path.join(tmpDir, `${name}.flow.ts`);
const specFile = path.join(tmpDir, `${name}.spec.ts`);
const pwReportFile = path.join(tmpDir, 'pw-report.json');
const pwConfigFile = path.join(tmpDir, 'playwright.config.mjs');

const cliBin = path.join(repoRoot, 'bin', 'sitelooper.js');
const compileCmd = [process.execPath, cliBin, 'compile', flowArg, '--out', tmpDir, '--force'];
const compileEnv = { ...process.env, SITELOOPER_SKILLS_DIR: skillsDir };

// Minimal config: no `defineConfig` import (that lives in `@playwright/test`,
// which may not be installed yet — see the file header), just the plain
// object shape Playwright Test accepts as a config module's default export.
// baseURL is deliberately absent: the emitted `<name>.flow.ts` calls
// `page.goto(<startUrl>)` with the flow's own absolute URL, never a relative
// one, so nothing here needs to supply an origin.
const pwConfigSource = `// GENERATED by bench/spec-replay.mjs for tag "${tag}" — safe to delete.
export default {
  testDir: ${JSON.stringify(tmpDir)},
  testMatch: ${JSON.stringify(`${name}.spec.ts`)},
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['json', { outputFile: ${JSON.stringify(pwReportFile)} }], ['list']],
  use: { headless: true },
};
`;

const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const testCmd = [npxBin, 'playwright', 'test', '--config', pwConfigFile];

if (args.dry) {
  fs.writeFileSync(pwConfigFile, pwConfigSource);
  console.log('[spec-replay] DRY RUN — nothing executed.');
  console.log(`[spec-replay] flow name: ${name}`);
  console.log(`[spec-replay] would compile: ${compileCmd.map((s) => JSON.stringify(s)).join(' ')}`);
  console.log(`[spec-replay]   env SITELOOPER_SKILLS_DIR=${skillsDir}`);
  console.log(`[spec-replay] expected outputs: ${flowFile}  ${specFile}`);
  console.log(`[spec-replay] wrote config: ${pwConfigFile}`);
  console.log(`[spec-replay] would run: ${testCmd.map((s) => JSON.stringify(s)).join(' ')}  (cwd ${tmpDir})`);
  console.log(`[spec-replay] would write: ${path.join(outDir, `${tag}-spec-result.json`)}`);
  const has = fs.existsSync(path.join(repoRoot, 'node_modules', '@playwright', 'test'));
  console.log(
    has
      ? '[spec-replay] @playwright/test is resolvable — a real run can proceed once dist/cli.js is built.'
      : '[spec-replay] @playwright/test is NOT installed in this repo (only `playwright`/`playwright-core`). ' +
          'A real run needs `npm install -D @playwright/test` first — the emitted spec imports it directly.',
  );
  process.exit(0);
}

// Preflight 1: dist/cli.js must exist — `compile` is a normal CLI command.
if (!fs.existsSync(path.join(repoRoot, 'dist', 'cli.js'))) {
  console.error('[spec-replay] dist/cli.js not found — run `npm run build` first (bin/sitelooper.js imports it).');
  process.exit(2);
}
// Preflight 2: the package the EMITTED files import must resolve, or the
// spec fails on its own first line with a confusing module-not-found deep
// inside Playwright's loader rather than a clear message here.
if (!fs.existsSync(path.join(repoRoot, 'node_modules', '@playwright', 'test'))) {
  console.error(
    '[spec-replay] @playwright/test is not installed. The compiled flow/spec files import it directly ' +
      '(`import { expect, type Page } from \'@playwright/test\'`), so `npm install -D @playwright/test` ' +
      'is required before this arm can run for real. `playwright`/`playwright-core` alone are not enough.',
  );
  process.exit(2);
}

if (args.reset && args.target) {
  console.log(`[spec-replay] resetting ${args.target}`);
  await resetTarget(args.target);
}

fs.writeFileSync(pwConfigFile, pwConfigSource);

const started = Date.now();
// --compiled <dir>: run the .flow.ts/.spec.ts already in <dir> instead of
// compiling afresh. A `sitelooper repair` rewrites the owned .flow.ts, and
// recompiling from the flow JSON would throw that repair away — this is how
// the repaired file gets its own scored run.
let compile;
if (args.compiled) {
  const src = path.resolve(String(args.compiled));
  for (const f of [`${name}.flow.ts`, `${name}.spec.ts`]) fs.copyFileSync(path.join(src, f), path.join(tmpDir, f));
  console.log(`[spec-replay] using compiled files from ${src} (no compile)`);
  compile = { status: 0, stdout: `copied ${name}.flow.ts and ${name}.spec.ts from ${src}
`, stderr: '' };
} else {
  console.log(`[spec-replay] compiling: ${compileCmd.join(' ')}`);
  compile = spawnSync(compileCmd[0], compileCmd.slice(1), { encoding: 'utf8', timeout: 120_000, env: compileEnv });
}
const compileOut = `${compile.stdout || ''}${compile.stderr || ''}`;
fs.writeFileSync(path.join(outDir, `${tag}-spec-compile.log`), compileOut);
console.log(compileOut.trim());

// compile exit 2 == "not compilable" (a step has no converged procedure),
// per the CLI contract — that is a real, reportable outcome for this arm,
// not a script failure, so it still writes a result file.
const compilable = compile.status === 0;
if (compile.status !== 0 && compile.status !== 2) {
  console.error(`[spec-replay] compile exited ${compile.status} unexpectedly (neither 0 nor 2) — aborting`);
  fs.writeFileSync(
    path.join(outDir, `${tag}-spec-result.json`),
    JSON.stringify(
      {
        arm: 'spec',
        runid: tag,
        target: args.target ?? null,
        flow: path.basename(flowArg),
        flowName: name,
        skillsDir,
        compiled: false,
        compileExitCode: compile.status,
        wallMs: Date.now() - started,
        costUsd: 0,
        error: 'compile failed unexpectedly',
      },
      null,
      2,
    ),
  );
  process.exit(compile.status ?? 1);
}

if (!compilable) {
  const result = {
    arm: 'spec',
    runid: tag,
    target: args.target ?? null,
    flow: path.basename(flowArg),
    flowName: name,
    skillsDir,
    compiled: false,
    compileExitCode: compile.status,
    wallMs: Date.now() - started,
    costUsd: 0,
    exitCode: compile.status,
    stats: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
  fs.writeFileSync(path.join(outDir, `${tag}-spec-result.json`), JSON.stringify(result, null, 2));
  console.log(`[spec-replay] ${tag}: not compilable — result written (exit ${compile.status})`);
  process.exit(1);
}

if (!fs.existsSync(specFile)) {
  console.error(`[spec-replay] compile reported success but ${specFile} does not exist — compiler/harness mismatch`);
  process.exit(2);
}

console.log(`[spec-replay] running: ${testCmd.join(' ')}`);
const run = spawnSync(testCmd[0], testCmd.slice(1), {
  encoding: 'utf8',
  timeout: 600_000,
  cwd: tmpDir,
  env: process.env,
  shell: process.platform === 'win32',
});
const runOut = `${run.stdout || ''}${run.stderr || ''}`;
fs.writeFileSync(path.join(outDir, `${tag}-spec.log`), runOut);

let report = null;
try {
  report = JSON.parse(fs.readFileSync(pwReportFile, 'utf8'));
} catch {
  /* no report — spec crashed before Playwright could write one */
}

/** One stdout/stderr chunk from the JSON reporter as text. Playwright records
 * each console write as `{ text }` (already a string) or, for binary writes,
 * `{ buffer }` (base64) — a compiled spec never writes binary, but decode it
 * anyway rather than silently dropping a chunk that happens to take that shape. */
function chunkText(c) {
  if (typeof c === 'string') return c;
  if (typeof c?.text === 'string') return c.text;
  if (typeof c?.buffer === 'string') {
    try {
      return Buffer.from(c.buffer, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

/** Every `[sitelooper drift] ...` line pick() (see src/spec/emit.ts) warned
 * into stdout/stderr for one test result — console.warn lands on stderr, but
 * this reads both so it survives a reporter that merges them. */
function driftLines(result) {
  const text = [...(result?.stdout ?? []), ...(result?.stderr ?? [])].map(chunkText).join('');
  return text.split(/\r?\n/).filter((l) => l.startsWith('[sitelooper drift]'));
}

/** Walk the Playwright JSON reporter's suite tree and flatten to one row per
 * test result, the shape score.mjs/verify*.mjs need without having to know
 * Playwright's report schema themselves. */
function flattenTests(suite, acc = []) {
  for (const s of suite.suites || []) flattenTests(s, acc);
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const r = t.results?.[0];
      acc.push({
        title: spec.title,
        status: t.status, // 'expected' | 'unexpected' | 'flaky' | 'skipped'
        ok: t.status === 'expected',
        durationMs: r?.duration ?? null,
        error: r?.error?.message ?? null,
        drift: driftLines(r),
      });
    }
  }
  return acc;
}
const tests = report ? flattenTests(report) : [];
const drift = tests.flatMap((t) => t.drift);
const stats = report?.stats ?? {
  total: tests.length,
  expected: tests.filter((t) => t.status === 'expected').length,
  unexpected: tests.filter((t) => t.status === 'unexpected').length,
  skipped: tests.filter((t) => t.status === 'skipped').length,
};

const result = {
  arm: 'spec',
  runid: tag,
  target: args.target ?? null,
  flow: path.basename(flowArg),
  flowName: name,
  skillsDir,
  compiled: true,
  flowFile: path.relative(repoRoot, flowFile),
  specFile: path.relative(repoRoot, specFile),
  wallMs: Date.now() - started,
  exitCode: run.status,
  timedOut: run.status === null,
  costUsd: 0, // by construction: no model runs at replay time — compile is a
  // template expansion of an already-recorded procedure, not an inference call
  stats: {
    total: stats.expected + stats.unexpected + (stats.skipped ?? 0) || tests.length,
    passed: stats.expected ?? tests.filter((t) => t.ok).length,
    failed: stats.unexpected ?? tests.filter((t) => !t.ok && t.status !== 'skipped').length,
    skipped: stats.skipped ?? 0,
  },
  tests,
  drift,
  driftCount: drift.length,
  logTail: runOut.slice(-4000),
};
fs.writeFileSync(path.join(outDir, `${tag}-spec-result.json`), JSON.stringify(result, null, 2));
console.log(
  `[spec-replay] ${tag}: ${result.stats.passed}/${result.stats.total} passed, exit=${run.status}, ${Math.round(
    (Date.now() - started) / 1000,
  )}s, ${drift.length} drift line(s) — result written`,
);
process.exit(run.status === 0 ? 0 : 1);
