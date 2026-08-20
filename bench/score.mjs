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

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const resultsDir = path.resolve(args.results || 'bench/results');
const rates = JSON.parse(fs.readFileSync(path.resolve(args.rates || 'bench/rates.json'), 'utf8'));

function rateFor(provider, model) {
  return rates[provider]?.[model] ?? null;
}

function cost(rate, { input = 0, cacheWrite = 0, cacheRead = 0, output = 0 }) {
  if (!rate) return null;
  return (
    (input * rate.input + cacheWrite * rate.cacheWrite + cacheRead * rate.cacheRead + output * rate.output) /
    1e6
  );
}

const rows = [];
for (const file of fs.readdirSync(resultsDir).filter((f) => f.endsWith('-result.json'))) {
  const r = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));

  const orchRate = rateFor(r.provider, r.model);
  const orchCost = cost(orchRate, r.orchestrator);

  // Inner model: prefer the per-model split; it is the only way to price a run
  // in which escalation moved work onto a second, pricier tier.
  let innerCost = null;
  let innerBasis = 'none';
  const inner = r.inner ?? {};
  if (inner.byModel && Object.keys(inner.byModel).length) {
    innerCost = 0;
    innerBasis = 'per-model';
    for (const [model, u] of Object.entries(inner.byModel)) {
      const rate = rateFor(r.provider, model);
      const c = cost(rate, {
        input: Math.max(0, (u.promptTokens ?? 0) - (u.cachedTokens ?? 0)),
        cacheRead: u.cachedTokens ?? 0,
        output: u.completionTokens ?? 0,
      });
      if (c === null) {
        innerCost = null;
        innerBasis = `unknown rate for ${model}`;
        break;
      }
      innerCost += c;
    }
  } else if (inner.promptTokens) {
    const rate = rateFor(r.provider, inner.model);
    innerCost = cost(rate, {
      input: Math.max(0, inner.promptTokens - (inner.cachedTokens ?? 0)),
      cacheRead: inner.cachedTokens ?? 0,
      output: inner.completionTokens ?? 0,
    });
    innerBasis = 'single-rate ESTIMATE (no per-model split)';
  }

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
    total_usd: orchCost === null || innerCost === null ? null : +(orchCost + innerCost).toFixed(4),
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
