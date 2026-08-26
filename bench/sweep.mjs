#!/usr/bin/env node
/**
 * Learning sweep: run the same task K times in sequence with ONE shared skill
 * store, a fresh app reset and a fresh runid each time, then print the
 * per-n curve the progressive-automation claim rests on — cost, turns,
 * deterministic fraction A_n, and (on the repairdesk target) externally
 * verified correctness.
 *
 *   node bench/sweep.mjs --k 5 --base lrn --learn bench/results/lrn-skills \
 *     --arm browser-pilot --target repairdesk --task bench/tasks/repairdesk-ticket-flow.md \
 *     --provider openrouter --model z-ai/glm-5.3 --coarse --out bench/results
 *
 * Everything after the sweep's own flags (--k, --base, --learn, --verify) is
 * passed to bench/harness.mjs unchanged; --reset is always added. Run n gets
 * runid `<base>-n<n>` so the result files line up. Pass --learn "" (or omit it)
 * for a control sweep with the same K and no store.
 *
 * --verify runs bench/verify-repairdesk.mjs after each run (needs the app's
 * /__log reachable, i.e. a local repairdesk target) and folds the pass count
 * into the table.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRates, priceRun } from './pricing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const own = { k: 3, base: `lrn-${Date.now().toString(36)}`, learn: '', verify: false, verifyCmd: '', resetCmd: '', out: 'bench/results' };
const pass = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--k') own.k = Number(argv[++i]);
  else if (a === '--base') own.base = argv[++i];
  else if (a === '--learn') own.learn = argv[++i] ?? '';
  else if (a === '--flow') own.flow = argv[++i];
  else if (a === '--verify') own.verify = true;
  else if (a === '--verify-cmd') own.verifyCmd = argv[++i] ?? '';
  else if (a === '--reset-cmd') own.resetCmd = argv[++i] ?? '';
  else if (a === '--out') {
    own.out = argv[++i];
    pass.push('--out', own.out);
  } else if (a === '--reset' || a === '--runid') {
    if (a === '--runid') i++;
  } else pass.push(a);
}

const outDir = path.resolve(own.out);
const learnDir = own.learn ? path.resolve(own.learn) : null;
if (learnDir) fs.mkdirSync(learnDir, { recursive: true });
const rates = loadRates();
const rows = [];
const flowsDir = own.flow ? path.resolve(learnDir ? path.join(learnDir, '..', 'flows') : outDir) : null;
const armBin = process.platform === 'win32' ? 'browser-pilot.cmd' : 'browser-pilot';

for (let n = 1; n <= own.k; n++) {
  const runid = `${own.base}-n${n}`;
  // Flow mode: run 1 records the flow with the orchestrator; runs 2..K replay
  // it with NO orchestrator (`browser-pilot run`) — the whole point: the caller
  // pays once, later executions are near-script.
  const replayOnly = Boolean(own.flow) && n > 1;
  console.error(`\n[sweep] run ${n}/${own.k}: ${runid}${replayOnly ? ` (replay flow ${own.flow}, no orchestrator)` : learnDir ? ` (store: ${learnDir})` : ' (no store)'}`);
  if (replayOnly) {
    // A spend-capped/incomplete run 1 saves no flow; replaying it anyway
    // writes empty flowrun files that LOOK like runs (swa-n2/n3). Skip with
    // an explicit row instead.
    const flowFile = flowsDir ? path.join(flowsDir, `${own.flow.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`) : own.flow;
    if (!fs.existsSync(own.flow) && !fs.existsSync(flowFile)) {
      console.error(`[sweep] ${runid}: flow "${own.flow}" was never saved (run 1 incomplete?) — SKIPPING replay`);
      rows.push({ n, runid, verified: '', stop: 'no-flow', turns: null, cmds: null, total_usd: null, A_n: '', replayed: 'skipped', wall_s: null });
      continue;
    }
    if (own.resetCmd) spawnSync(own.resetCmd, { stdio: 'inherit', env: process.env, shell: true });
    else spawnSync(process.execPath, [path.join(here, 'reset-app.mjs')], { stdio: 'inherit', env: process.env });
    const env = { ...process.env, BROWSER_PILOT_SKILLS: '1', ...(learnDir ? { BROWSER_PILOT_SKILLS_DIR: learnDir } : {}), ...(flowsDir ? { BROWSER_PILOT_FLOWS_DIR: flowsDir } : {}) };
    const fr = spawnSync(armBin, ['--session', runid, 'run', own.flow, '--var', `runid=${runid}`, '--json'], { stdio: ['inherit', 'pipe', 'inherit'], env, shell: process.platform === 'win32' });
    if (fr.stdout && fr.stdout.length) fs.writeFileSync(path.join(outDir, `${runid}-flowrun.json`), fr.stdout);
    // Drift tickets are the post-session repair work-list; split them out so
    // the repair pass can consume one file per run.
    try {
      const run = JSON.parse(fr.stdout);
      if (run.driftTickets?.length) {
        fs.writeFileSync(path.join(outDir, `${runid}-drift.json`), JSON.stringify(run.driftTickets, null, 2));
        console.error(`[sweep] ${runid}: ${run.driftTickets.length} drift ticket(s) → ${runid}-drift.json`);
      }
    } catch { /* no parseable flow result */ }
    spawnSync(armBin, ['stop', '--session', runid], { stdio: 'ignore', env, shell: process.platform === 'win32' });
  } else {
    const args = [path.join(here, 'harness.mjs'), ...pass, '--runid', runid, '--reset'];
    if (learnDir) args.push('--learn', learnDir);
    if (own.flow) args.push('--save-flow', own.flow, '--flowsDir', flowsDir);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
    if (r.status !== 0) console.error(`[sweep] harness exited ${r.status} for ${runid} — scoring whatever it wrote`);
  }

  const arm = pass[pass.indexOf('--arm') + 1] ?? 'browser-pilot';
  const file = path.join(outDir, `${runid}-${arm}-result.json`);
  let verified = '';
  if (own.verifyCmd) {
    // Generic per-run verification (odoo/grafana/atelyr sweeps): {runid} in
    // the command is substituted; PASS/FAIL lines are counted like --verify.
    const cmd = own.verifyCmd.includes('{runid}') ? own.verifyCmd.replaceAll('{runid}', runid) : `${own.verifyCmd} ${runid}`;
    const v = spawnSync(cmd, { encoding: 'utf8', env: { ...process.env, BENCH_OUT: outDir }, shell: true });
    process.stderr.write((v.stdout ?? '') + (v.stderr ?? ''));
    const passes = ((v.stdout ?? '').match(/PASS/g) ?? []).length;
    const total = ((v.stdout ?? '').match(/(PASS|FAIL)/g) ?? []).length;
    verified = total ? `${passes}/${total}` : 'n/a';
  } else if (own.verify) {
    const v = spawnSync(process.execPath, [path.join(here, 'verify-repairdesk.mjs'), runid], {
      encoding: 'utf8',
      env: { ...process.env, BENCH_OUT: outDir },
    });
    process.stderr.write(v.stdout + v.stderr);
    const passes = (v.stdout.match(/obj \d\s+PASS/g) ?? []).length;
    const total = (v.stdout.match(/obj \d\s+(PASS|FAIL)/g) ?? []).length;
    const mismatch = /MISMATCH/.test(v.stdout);
    verified = total ? `${passes}/${total}${mismatch ? ' +MISMATCH' : ''}` : 'n/a';
  }
  let row = { n, runid, verified, stop: '?', turns: null, cmds: null, total_usd: null, A_n: '', replayed: '', wall_s: null };
  if (replayOnly) {
    try {
      const fr = JSON.parse(fs.readFileSync(path.join(outDir, `${runid}-flowrun.json`), 'utf8'));
      // Price the replay's recovery tokens at the recovery model's rate — a
      // pure tier-A replay is genuinely $0; recovery steps are not.
      let usd = 0;
      if (fr.usage && fr.recoveryModel) {
        const r = rates[fr.provider]?.[fr.recoveryModel];
        if (r) usd = ((fr.usage.promptTokens - fr.usage.cachedTokens) * r.input + fr.usage.cachedTokens * (r.cacheRead ?? r.input) + fr.usage.completionTokens * r.output) / 1e6;
      }
      row = { ...row, stop: fr.status, cmds: fr.total, turns: fr.steps.reduce((a, s) => a + (s.turns ?? 0), 0), total_usd: +usd.toFixed(4), wall_s: +(fr.wallMs / 1000).toFixed(0), A_n: 1, replayed: `${fr.passed}/${fr.total} (flow)` };
    } catch (err) {
      console.error(`[sweep] no flowrun for ${runid}: ${err.message}`);
    }
    rows.push(row);
    continue;
  }
  try {
    const res = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { totalUsd } = priceRun(rates, res);
    row = {
      ...row,
      stop: res.stopReason,
      turns: res.turns,
      cmds: res.commandCount,
      total_usd: totalUsd === null ? null : +totalUsd.toFixed(4),
      wall_s: +(res.wallMs / 1000).toFixed(0),
      A_n: res.learn ? (res.learn.deterministicFraction ?? 'n/a') : '',
      replayed: res.learn ? `${res.learn.invoked ?? 0}/${res.learn.instructions ?? 0}${res.learn.repaired ? ` (${res.learn.repaired} rep)` : ''}` : '',
    };
  } catch (err) {
    console.error(`[sweep] no result for ${runid}: ${err.message}`);
  }
  rows.push(row);
}

console.log(`\nLearning sweep ${own.base} (K=${own.k}${learnDir ? '' : ', control: no store'})`);
console.table(rows);
if (learnDir) {
  const skills = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'browser-pilot.js'), 'skills', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, BROWSER_PILOT_SKILLS_DIR: learnDir },
  });
  console.log(skills.stdout);
}
const summary = path.join(outDir, `${own.base}-sweep.json`);
fs.writeFileSync(summary, JSON.stringify({ base: own.base, k: own.k, learnDir, rows }, null, 2));
console.log(`summary: ${summary}`);
