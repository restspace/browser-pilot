#!/usr/bin/env node
/**
 * Price the runs in a results directory and print a comparison table.
 *
 * Costing is deliberately split. The orchestrator and the inner model bill at
 * different rates, and with escalation a single browser-pilot session can bill
 * against two tiers that differ by an order of magnitude — so inner cost is
 * computed from the per-model breakdown when one is present, and only falls
 * back to a single-rate estimate (clearly flagged) when it is not.
 *
 *   node bench/score.mjs [--results bench/results] [--rates bench/rates.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRates, priceRun } from './pricing.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const resultsDir = path.resolve(args.results || 'bench/results');
const rates = loadRates(args.rates);

const rows = [];
for (const file of fs.readdirSync(resultsDir).filter((f) => f.endsWith('-result.json'))) {
  const r = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));

  // Same formula the harness uses for its live spend ceiling (bench/pricing.mjs),
  // so a run stopped at `--maxUsd` scores at the figure that stopped it.
  const { orchUsd: orchCost, innerUsd, totalUsd, innerBasis } = priceRun(rates, r);
  // An arm with no inner model shows n/a rather than a misleading 0.
  const innerCost = innerBasis === 'none' ? null : innerUsd;

  rows.push({
    runid: r.runid,
    arm: r.arm,
    briefed: r.briefed ? 'briefed' : 'cold',
    stop: r.stopReason,
    turns: r.turns,
    cmds: r.commandCount,
    timeouts: r.timeouts,
    wall_s: +(r.wallMs / 1000).toFixed(1),
    ctxKB: +(r.commandBytes / 1024).toFixed(1),
    orch_usd: orchCost === null ? null : +orchCost.toFixed(4),
    inner_usd: innerCost === null ? null : +innerCost.toFixed(4),
    total_usd: totalUsd === null ? null : +totalUsd.toFixed(4),
    cap: r.maxUsd === undefined ? '' : r.stopReason === 'spend-cap' ? `HIT ${r.maxUsd}` : `< ${r.maxUsd}`,
    innerBasis,
  });
}

rows.sort((a, b) => a.runid.localeCompare(b.runid) || a.arm.localeCompare(b.arm));
if (!rows.length) {
  console.log(`no *-result.json files in ${resultsDir}`);
  process.exit(0);
}

console.table(
  rows.map(({ innerBasis, ...keep }) => keep),
);

const caveats = rows.filter((r) => r.innerBasis !== 'per-model' && r.innerBasis !== 'none');
if (caveats.length) {
  console.log('\nInner-cost caveats:');
  for (const c of caveats) console.log(`  ${c.runid}/${c.arm}: ${c.innerBasis}`);
}
console.log(
  '\nctxKB = bytes of command output returned to the orchestrator — the context an agent driving this tool would pay for.',
);
console.log('Success is NOT scored here: verify it externally against the app, not from a tool\'s self-report.');
