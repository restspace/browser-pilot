#!/usr/bin/env node
/**
 * Reset one target app, for a flow-replay sweep run that bypasses the harness
 * (which normally does the reset).
 *
 *   node bench/reset-app.mjs --target odoo
 *
 * This file used to BE the repairdesk reset: it POSTed `/__reset` to whatever
 * APP_URL held. On grafana and odoo that 404s, and the sweep ignored the exit
 * code, so every replay on those targets ran against the previous run's
 * leftovers. See bench/app-reset.mjs for what that cost.
 *
 * A failure here is fatal on purpose. A replay against a dirty app produces
 * numbers that look like results and are not.
 */
import { resetTarget, RESET_TARGETS } from './app-reset.mjs';

const argv = process.argv.slice(2);
const target = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : process.env.BENCH_TARGET;

if (!target) {
  console.error(`[reset-app] --target is required (one of: ${RESET_TARGETS.join(', ')})`);
  process.exit(2);
}

try {
  await resetTarget(target);
} catch (err) {
  console.error(`[reset-app] ${target} reset FAILED: ${err.message}`);
  process.exit(1);
}
