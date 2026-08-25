#!/usr/bin/env node
// Standalone grafana reset for sweep replay runs (sweep.mjs --reset-cmd),
// same semantics as the harness's grafana target reset: delete bench-tagged
// dashboards. Everything the task creates carries the `bench` tag, and
// provisioned dashboards refuse API deletion, so this can only ever remove
// benchmark debris.
const base = (process.env.APP_URL || 'http://127.0.0.1:3000/').replace(/\/$/, '')
const auth = 'Basic ' + Buffer.from(`${process.env.APP_EMAIL || 'admin'}:${process.env.APP_PASSWORD || 'admin'}`).toString('base64')
const res = await fetch(`${base}/api/search?tag=bench&type=dash-db`, { headers: { authorization: auth } })
if (!res.ok) {
  console.error(`[reset-grafana] search failed: ${res.status}`)
  process.exit(1)
}
const hits = await res.json()
for (const h of hits) {
  const del = await fetch(`${base}/api/dashboards/uid/${h.uid}`, { method: 'DELETE', headers: { authorization: auth } })
  console.error(`[reset-grafana] deleted leftover dashboard "${h.title}" (${del.status})`)
}
if (!hits.length) console.error('[reset-grafana] no leftover bench-tagged dashboards')
