#!/usr/bin/env node
// Matrix v0.2 bp column: rerun the sitelooper arm across all four targets
// (K=3 each) on the latest build — replay v2, navigation fallback, component
// recipes, designed inner model (deepseek-v4-flash via OpenRouter/Baidu,
// glm-5.3 escalation). Matrix conditions otherwise unchanged: glm-5.3
// orchestrator, --coarse, $2 ceiling, --reset, fresh state, no learning
// store; each run gets a FRESH components file so cells stay independent
// (seed recipes only — they ship with the build).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bench = path.dirname(fileURLToPath(import.meta.url)); // bench/
const out = path.join(bench, 'results');

const CELLS = [
  { target: 'repairdesk', task: 'tasks/repairdesk-ticket-flow.md', verify: 'verify-repairdesk.mjs', ids: ['m2rd1', 'm2rd2', 'm2rd3'], env: {} },
  { target: 'odoo', task: 'tasks/odoo-sale-flow.md', verify: 'verify-odoo.mjs', ids: ['m2od1', 'm2od2', 'm2od3'], env: {} },
  { target: 'grafana', task: 'tasks/grafana-dashboard-flow.md', verify: 'verify-grafana.mjs', ids: ['m2gr1', 'm2gr2', 'm2gr3'], env: {} },
  {
    target: 'atelyr', task: 'tasks/atelyr-project-flow.md', verify: 'verify.mjs', ids: ['m2at1', 'm2at2', 'm2at3'],
    env: {
      APP_URL: 'http://localhost:5174/project-manager',
      APP_EMAIL: 'mtp-e2e@atelyr.com',
      APP_PASSWORD: process.env.ATELYR_BENCH_PASSWORD ?? '',
    },
  },
];

const base = {
  ...process.env,
  SITELOOPER_PROVIDER: 'openrouter',
  SITELOOPER_MODEL: 'deepseek/deepseek-v4-flash',
  SITELOOPER_FALLBACK_MODEL: 'z-ai/glm-5.3',
  SITELOOPER_EXTRA_BODY: '{"provider":{"order":["baidu"]}}',
};

for (const cell of CELLS) {
  for (const runid of cell.ids) {
    console.log(`\n===== ${runid} (${cell.target}) =====`);
    const env = { ...base, ...cell.env, SITELOOPER_COMPONENTS_FILE: path.join(out, `${runid}-components.json`) };
    const r = spawnSync(process.execPath, [
      path.join(bench, 'harness.mjs'),
      '--arm', 'sitelooper',
      '--target', cell.target,
      '--task', path.join('bench', cell.task),
      '--provider', 'openrouter', '--model', 'z-ai/glm-5.3',
      '--coarse',
      '--runid', runid, '--reset', '--out', 'bench/results',
    ], { stdio: 'inherit', env, cwd: path.dirname(bench) });
    if (r.status !== 0) console.log(`[matrix2] harness exited ${r.status} for ${runid} — verifying whatever it wrote`);
    // Verify BEFORE the next run's reset destroys the evidence (atelyr restores
    // a baseline; grafana deletes bench dashboards).
    const v = spawnSync(process.execPath, [path.join(bench, cell.verify), runid], {
      stdio: 'inherit',
      env: { ...env, BENCH_OUT: out },
      cwd: path.dirname(bench),
    });
    if (v.status !== 0) console.log(`[matrix2] verifier exited ${v.status} for ${runid}`);
  }
}
console.log('\n[matrix2] all cells done');
