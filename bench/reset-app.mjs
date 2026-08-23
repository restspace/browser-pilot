#!/usr/bin/env node
// Reset the repairdesk bench app to seed, for a flow-replay sweep run that
// bypasses the harness (which normally does the reset).
const url = new URL('/__reset', process.env.APP_URL || 'http://127.0.0.1:4180/');
const res = await fetch(url, { method: 'POST' }).catch((e) => ({ ok: false, statusText: String(e) }));
if (!res.ok) {
  console.error(`[reset-app] failed: ${res.statusText}`);
  process.exit(1);
}
console.error(`[reset-app] reloaded seed via ${url}`);
