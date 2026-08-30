/**
 * Per-target app reset: put the app back to a state where the NEXT run starts
 * where the last one started.
 *
 * This exists because `bench/reset-app.mjs` was hardcoded to repairdesk — it
 * POSTed `/__reset` to whatever APP_URL happened to be. On a grafana or odoo
 * replay that 404s, and the sweep ignored the exit code, so **replay runs on
 * those targets got no reset at all**. The harness had a working grafana reset
 * the whole time; the sweep just never called it.
 *
 * The cost was not a slow run, it was wrong evidence:
 *
 *   fwgr13  all three runs reported dashboard uid dfwq7fnd2d81sa. The replays
 *           RENAMED run 1's dashboard instead of making their own, and the one
 *           objective needing a created artifact failed on both.
 *   fwod20  n1 created S00021, n2 S00022, n3 S00023, all still in the orders
 *           list together. A replay looking for "the" order could find three.
 *
 * It also blocks the cleanup assumption in PLAN-evidence-over-shape.md: if the
 * last run's records are still there, "the recorded value is still on the page"
 * stops meaning "the app puts it there every run" and starts meaning "the last
 * run left it behind" — which would inline a live record identity, the one
 * failure direction the plan forbids.
 *
 * Cleanup lives HERE, at the run boundary, rather than as a final step of each
 * task, because verification is app-side and runs after the task: a task that
 * deleted its own order would leave verify-odoo nothing to check. What each
 * reset removes is strictly EARLIER runs' debris, and every verifier matches
 * its own runid, so a reset can never erase the evidence for the run being
 * scored.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.error(`[reset] ${m}`);

/** Everything the bench creates is named for its run; nothing else matches. */
const BENCH_CUSTOMER = '% Bench Customer';

async function resetRepairdesk() {
  const url = new URL('/__reset', process.env.APP_URL || 'http://127.0.0.1:4180/');
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`repairdesk reset failed: ${res.status} ${res.statusText}`);
  log(`repairdesk: reloaded seed via ${url}`);
}

async function resetGrafana() {
  const base = (process.env.APP_URL || 'http://127.0.0.1:3000/').replace(/\/$/, '');
  const auth =
    'Basic ' + Buffer.from(`${process.env.APP_EMAIL || 'admin'}:${process.env.APP_PASSWORD || 'admin'}`).toString('base64');
  // Everything the task creates carries the `bench` tag, and provisioned
  // dashboards refuse API deletion, so this can only remove benchmark debris.
  const res = await fetch(`${base}/api/search?tag=bench&type=dash-db`, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`grafana search failed: ${res.status}`);
  const hits = await res.json();
  for (const h of hits) {
    const del = await fetch(`${base}/api/dashboards/uid/${h.uid}`, { method: 'DELETE', headers: { authorization: auth } });
    log(`grafana: deleted leftover dashboard "${h.title}" (${del.status})`);
  }
  if (!hits.length) log('grafana: no leftover bench-tagged dashboards');
}

async function resetOdoo() {
  const base = (process.env.APP_URL || 'http://127.0.0.1:8069/').replace(/\/$/, '');
  const db = process.env.ODOO_DB || 'bench';
  const login = process.env.APP_EMAIL || 'admin';
  const password = process.env.APP_PASSWORD || 'admin';
  let rpcId = 0;
  const rpc = async (service, method, args) => {
    const res = await fetch(`${base}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'call', params: { service, method, args } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.data?.message || body.error.message);
    return body.result;
  };
  const uid = await rpc('common', 'login', [db, login, password]);
  if (!uid) throw new Error('odoo: could not authenticate — check APP_EMAIL/APP_PASSWORD/ODOO_DB');
  const kw = (model, method, args, kwargs = {}) => rpc('object', 'execute_kw', [db, uid, password, model, method, args, kwargs]);

  const partners = await kw('res.partner', 'search', [[['name', 'like', BENCH_CUSTOMER]]]);
  if (!partners.length) {
    log('odoo: no leftover bench customers');
    return;
  }
  const orders = await kw('sale.order', 'search', [[['partner_id', 'in', partners]]]);
  if (orders.length) {
    // A CONFIRMED order refuses deletion. Cancel first, then delete; if the
    // delete is still refused, archive it — out of every default list view,
    // which is what a later run actually needs.
    try {
      await kw('sale.order', 'action_cancel', [orders]);
    } catch {
      /* already cancelled, or the button is not available in this state */
    }
    try {
      await kw('sale.order', 'unlink', [orders]);
      log(`odoo: deleted ${orders.length} leftover bench order(s)`);
    } catch (err) {
      await kw('sale.order', 'write', [orders, { active: false }]);
      log(`odoo: archived ${orders.length} leftover bench order(s) (delete refused: ${err.message})`);
    }
  }
  try {
    await kw('res.partner', 'unlink', [partners]);
    log(`odoo: deleted ${partners.length} leftover bench customer(s)`);
  } catch (err) {
    await kw('res.partner', 'write', [partners, { active: false }]);
    log(`odoo: archived ${partners.length} leftover bench customer(s) (delete refused: ${err.message})`);
  }
}

function resetAtelyr() {
  log('atelyr: restoring datastore baseline');
  execFileSync(process.execPath, [path.join(here, 'reset.mjs'), '--restore'], { stdio: 'inherit' });
}

const RESETS = {
  atelyr: resetAtelyr,
  repairdesk: resetRepairdesk,
  odoo: resetOdoo,
  grafana: resetGrafana,
};

export const RESET_TARGETS = Object.keys(RESETS);

/** Reset one target. Throws if the target is unknown or the reset fails. */
export async function resetTarget(name) {
  const fn = RESETS[name];
  if (!fn) throw new Error(`unknown target "${name}" — expected one of: ${RESET_TARGETS.join(', ')}`);
  await fn();
}
