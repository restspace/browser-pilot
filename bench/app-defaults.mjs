/**
 * The app credentials each target runs against, in ONE place.
 *
 * bench/harness.mjs sets these for the recording run. bench/sweep.mjs drives
 * the REPLAYS itself and was passing only process.env, so a flow whose sign-in
 * step fills `{{env:APP_PASSWORD}}` failed at its first step on every replay:
 *
 *   fwgr10: "fill failed: secret {{env:APP_PASSWORD}} cannot be resolved"
 *
 * Two of three grafana replays were scored against that, and the run was read
 * as a product regression. Both files import this rather than keeping their
 * own copy, because two copies of one fact disagreeing is the shape of most of
 * the bugs found in this work.
 *
 * Anything already in the environment wins over these, so an explicit override
 * still works.
 */
export const APP_DEFAULTS = {
  // atelyr supplies its own from rsconfig; the harness leaves it empty.
  atelyr: {},
  repairdesk: {
    APP_URL: 'http://127.0.0.1:4180/',
    APP_EMAIL: 'bench@example.com',
    APP_PASSWORD: 'bench-pass-1234',
  },
  odoo: {
    APP_URL: 'http://127.0.0.1:8069/',
    APP_EMAIL: 'admin',
    APP_PASSWORD: 'admin',
  },
  grafana: {
    APP_URL: 'http://127.0.0.1:3000/',
    APP_EMAIL: 'admin',
    APP_PASSWORD: 'admin',
  },
  kanboard: {
    APP_URL: 'http://127.0.0.1:8085/',
    APP_EMAIL: 'admin',
    APP_PASSWORD: 'admin',
  },
};
