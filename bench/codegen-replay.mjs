#!/usr/bin/env node
/**
 * The "recording as code" arm: replay a sitelooper session recording the way
 * `playwright codegen` output would — one literal Playwright locator per
 * gesture, literal values, Playwright's own auto-waiting, and nothing else.
 * No candidate ladder, no slots, no effect gates, no recovery: when a locator
 * misses or an id has moved, the script fails (or worse, doesn't notice).
 * That absence is the thing being measured.
 *
 * Why generate from OUR recording rather than run codegen itself: codegen is a
 * human at a browser, which does not ship in a benchmark box. The session
 * recording already carries, for every gesture, the exact locator expression
 * codegen would have emitted (`locators.target.expr` — role/name first, the
 * same preference order), plus the literal arguments. Emitting those verbatim
 * IS the codegen script for this flow, minus a human's tidying. Disclosed in
 * the result as `generatedFrom`.
 *
 * What is included / excluded, and why:
 *   included  goto, click, dblclick, fill, type, press, check, hover, drag,
 *             wait_for, dialog_expect — the gestures a recording captures.
 *   included  read / read_all, as best-effort scrapes printed to the log —
 *             the "assertions a codegen user adds by hand" concession. A read
 *             failure never stops the run; codegen users' assertions are for
 *             values, and the app-side verifier is the actual scorer.
 *   excluded  eval, screenshot — those are the recording model LOOKING at the
 *             page to decide what to do next. Codegen records no observation,
 *             and replaying exploration would be replaying our agent, not a
 *             script. Audited 2026-09-01: no eval in the set-15 recordings
 *             mutates the page, so skipping them drops no app state change.
 *
 * The one deliberate concession: the recorded runid is swapped for this run's
 * runid at generation time, in fill values and locator text alike. Any human
 * shipping a codegen script parameterises that much. Nothing else is touched —
 * URLs keep their baked record ids, that being the point.
 *
 * Usage:
 *   node bench/codegen-replay.mjs --from bench/results-published/fwrd39-n1-script.jsonl \
 *     --recorded-runid fwrd39-n1 --runid cgrd1 --target repairdesk --reset \
 *     --out bench/results [--gen-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_DEFAULTS } from './app-defaults.mjs';
import { resetTarget } from './app-reset.mjs';

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
for (const req of ['from', 'recorded-runid', 'runid', 'target']) {
  if (!args[req]) {
    console.error(`--${req} is required`);
    process.exit(2);
  }
}
const defaults = APP_DEFAULTS[args.target];
if (!defaults) {
  console.error(`--target must be one of: ${Object.keys(APP_DEFAULTS).join(', ')}`);
  process.exit(2);
}
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;

const outDir = path.resolve(args.out || 'bench/results');
fs.mkdirSync(outDir, { recursive: true });

const lines = fs
  .readFileSync(path.resolve(args.from), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((x) => {
    try {
      return JSON.parse(x);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const recordedRunid = String(args['recorded-runid']);
const runid = String(args.runid);
let runidSwaps = 0;
/** The only rewrite the generator performs. Counted so the result can prove it. */
function swapRunid(s) {
  if (typeof s !== 'string' || !s.includes(recordedRunid)) return s;
  runidSwaps += s.split(recordedRunid).length - 1;
  return s.split(recordedRunid).join(runid);
}
const J = (v) => JSON.stringify(swapRunid(v));
const exprOf = (loc) => swapRunid(loc.expr);

/** Emit one generated line per recorded step; null = step type not emitted. */
function emit(step) {
  const t = step.tool;
  const a = step.args || {};
  const L = step.locators || {};
  const target = L.target ? exprOf(L.target) : null;
  switch (t) {
    case 'goto':
      return `await page.goto(${J(a.url)}, { waitUntil: 'domcontentloaded' });`;
    case 'click':
      return `await ${target}.click();`;
    case 'dblclick':
      return `await ${target}.dblclick();`;
    case 'fill':
      return `await ${target}.fill(${J(a.value)});`;
    case 'type':
      return `await ${target}.pressSequentially(${J(a.text)}, { delay: ${a.delay_ms ?? 50} });`;
    case 'press':
      return target ? `await ${target}.press(${J(a.key)});` : `await page.keyboard.press(${J(a.key)});`;
    case 'check':
      return `await ${target}.setChecked(${a.checked !== false});`;
    case 'hover':
      return `await ${target}.hover();`;
    case 'drag':
      return `await ${exprOf(L.source)}.dragTo(${target});`;
    case 'dialog_expect':
      return `page.once('dialog', (d) => d.${a.action === 'dismiss' ? 'dismiss' : 'accept'}().catch(() => {}));`;
    case 'wait_for': {
      const ms = a.timeout_ms ?? 10_000;
      if (a.state === 'text_contains') return `await waitText(${target}, ${J(a.text)}, ${ms});`;
      return `await ${target}.waitFor({ state: ${J(a.state || 'visible')}, timeout: ${ms} });`;
    }
    case 'read':
      return `await scrape(${JSON.stringify(step.i)}, async () => ${target}.first().innerText());`;
    case 'read_all':
      return `await scrape(${JSON.stringify(step.i)}, async () => ${target}.allInnerTexts());`;
    case 'eval':
    case 'screenshot':
      return null; // observation, not recording — see file header
    default:
      throw new Error(`recording uses tool "${t}" the generator does not know`);
  }
}

const body = [];
let gestureCount = 0;
let readCount = 0;
let skipped = 0;
let stepIndex = 0;
for (const e of lines) {
  if (e.k === 'instruction') {
    body.push('', `// instruction: ${swapRunid(e.text).replace(/\r?\n/g, ' ').slice(0, 160)}`);
    continue;
  }
  if (e.k !== 'step') continue;
  stepIndex++;
  const line = emit({ ...e, i: stepIndex });
  if (line === null) {
    skipped++;
    continue;
  }
  const isRead = e.tool === 'read' || e.tool === 'read_all';
  if (isRead) readCount++;
  else gestureCount++;
  body.push(isRead ? line : `await gesture(${stepIndex}, ${JSON.stringify(e.tool)}, async () => { ${line.replace(/^await /, 'return ')} });`);
}

const spec = `// GENERATED by bench/codegen-replay.mjs — do not hand-edit; see that file's header.
// from: ${path.basename(String(args.from))}  runid: ${runid}  (recorded as ${recordedRunid}, ${runidSwaps} occurrences swapped)
import { chromium } from 'playwright-core';

const results = { runid: ${JSON.stringify(runid)}, gestures: [], reads: [], fatal: null };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(30_000);

async function gesture(i, tool, fn) {
  const started = Date.now();
  try {
    await fn();
    results.gestures.push({ i, tool, ok: true, ms: Date.now() - started });
    console.log('[ok]', i, tool, Date.now() - started + 'ms');
  } catch (err) {
    results.gestures.push({ i, tool, ok: false, ms: Date.now() - started, error: String(err.message || err).slice(0, 300) });
    console.log('[FATAL]', i, tool, String(err.message || err).split('\\n')[0]);
    results.fatal = i;
    throw err;
  }
}
async function scrape(i, fn) {
  try {
    const v = await fn();
    results.reads.push({ i, ok: true, value: typeof v === 'string' ? v.slice(0, 400) : v });
    console.log('[read]', i, JSON.stringify(v).slice(0, 200));
  } catch (err) {
    results.reads.push({ i, ok: false, error: String(err.message || err).slice(0, 200) });
    console.log('[read-miss]', i, String(err.message || err).split('\\n')[0]);
  }
}
async function waitText(loc, text, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await loc.first().innerText({ timeout: 2000 })).includes(text)) return;
    } catch {}
    if (Date.now() > deadline) throw new Error('waitText timeout: ' + JSON.stringify(text));
    await page.waitForTimeout(250);
  }
}

try {
${body.map((l) => (l.startsWith('//') || l === '' ? l : `  ${l}`)).join('\n')}
} catch (err) {
  // fall through — the failing gesture already recorded itself
} finally {
  await browser.close();
  const done = results.fatal === null;
  console.log(done ? '[script complete]' : '[script aborted at gesture ' + results.fatal + ']');
  process.stdout.write('RESULT ' + JSON.stringify(results) + '\\n');
  process.exit(done ? 0 : 1);
}
`;

const specPath = path.join(outDir, `${runid}-codegen.spec.mjs`);
fs.writeFileSync(specPath, spec);
console.log(
  `[codegen] generated ${specPath}: ${gestureCount} gestures, ${readCount} reads, ${skipped} observation steps skipped, ${runidSwaps} runid swaps`,
);
if (args['gen-only']) process.exit(0);

if (args.reset) {
  console.log(`[codegen] resetting ${args.target}`);
  await resetTarget(args.target);
}

const started = Date.now();
const run = spawnSync(process.execPath, [specPath], { encoding: 'utf8', timeout: 900_000 });
const out = `${run.stdout || ''}${run.stderr || ''}`;
fs.writeFileSync(path.join(outDir, `${runid}-codegen.log`), out);
const resultLine = out.split('\n').reverse().find((l) => l.startsWith('RESULT '));
const inner = resultLine ? JSON.parse(resultLine.slice(7)) : { error: 'no RESULT line — spec crashed before finally', tail: out.slice(-1000) };
const result = {
  arm: 'playwright-codegen',
  runid,
  target: args.target,
  generatedFrom: path.basename(String(args.from)),
  recordedRunid,
  runidSwaps,
  counts: { gestures: gestureCount, reads: readCount, skippedObservations: skipped },
  wallMs: Date.now() - started,
  exitCode: run.status,
  costUsd: 0, // by construction: no model is ever called
  ...inner,
};
fs.writeFileSync(path.join(outDir, `${runid}-codegen-result.json`), JSON.stringify(result, null, 2));
const okGestures = (inner.gestures || []).filter((g) => g.ok).length;
console.log(
  `[codegen] ${runid}: ${okGestures}/${gestureCount} gestures, fatal=${inner.fatal ?? 'none'}, ${Math.round((Date.now() - started) / 1000)}s — result written`,
);
process.exit(run.status === 0 ? 0 : 1);
