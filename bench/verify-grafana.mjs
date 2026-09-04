/**
 * External verification of a benchmark run against Grafana's HTTP API. Same
 * contract as the other verify scripts: success is judged from what the app
 * actually persisted, never from the agent's final report — which for Grafana
 * has a specific bite: the panel editor shows every edit live, but only an
 * explicit dashboard save persists it, and the task requires saving. A run
 * that reported DONE from the editor without saving fails here.
 *
 *   obj 1  (report-only: provisioned panel titles)   checked against finalText
 *   obj 2  dashboard "<runid> Bench Dashboard" with stat panel on TestData
 *   obj 3  text panel whose content includes the runid
 *   obj 4  tag "bench", time range now-6h..now
 *   obj 5  refresh interval 1m
 *   obj 6  (report-only: dashboard uid)              checked against finalText
 *
 * Objectives 1 and 6 ask the run to REPORT something rather than change
 * something, so the app alone cannot score them; they are checked against the
 * run's recorded finalText when the result file is present, and reported
 * UNVERIFIABLE when it is not.
 */
import fs from 'node:fs'
import path from 'node:path'

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3000/').replace(/\/$/, '')
const AUTH = 'Basic ' + Buffer.from(`${process.env.APP_EMAIL || 'admin'}:${process.env.APP_PASSWORD || 'admin'}`).toString('base64')
const OUT = process.env.BENCH_OUT || 'bench/results'

const runids = process.argv.slice(2)
if (!runids.length) {
  console.error('usage: node bench/verify-grafana.mjs <runid> [runid...]')
  process.exit(2)
}

async function api(p) {
  const res = await fetch(`${APP_URL}${p}`, { headers: { authorization: AUTH } })
  if (!res.ok) throw new Error(`${p}: ${res.status}`)
  return res.json()
}

// Ground truth for objective 1, read once from the provisioned dashboard.
const provisioned = (await api('/api/search?query=Service%20health&type=dash-db'))[0]
const provTitles = provisioned
  ? (await api(`/api/dashboards/uid/${provisioned.uid}`)).dashboard.panels.map((p) => p.title)
  : []

const report = []
let anyFailure = false

for (const runid of runids) {
  const objectives = []
  const obj = (n, pass, detail) => {
    objectives.push({ n, pass, detail })
    if (pass === false) anyFailure = true
  }

  // finalText from the run's result file, for the report-only objectives. The
  // result file name embeds the arm, which this script deliberately does not
  // know — glob for it instead.
  let finalText = null
  for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith(`${runid}-`) && f.endsWith('-result.json'))) {
    try { finalText = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')).finalText ?? null } catch {}
  }
  // Flow replays (`sitelooper run`, no orchestrator) have no harness result
  // file; their reporting lives in the flowrun's per-step summaries and
  // read-back values. Those are the same claims a finalText would carry, so
  // the report-only objectives are checked against them.
  if (finalText === null) {
    try {
      const fr = JSON.parse(fs.readFileSync(path.join(OUT, `${runid}-flowrun.json`), 'utf8'))
      finalText = fr.steps
        .map((s) => `${s.summary ?? ''}\n${Object.values(s.values ?? {}).join('\n')}`)
        .join('\n')
    } catch {}
  }

  if (finalText === null) {
    objectives.push({ n: 1, pass: 'UNVERIFIABLE', detail: 'no result file with finalText found' })
  } else {
    const missing = provTitles.filter((t) => t && !finalText.includes(t))
    obj(1, provTitles.length > 0 && missing.length === 0,
      missing.length ? `finalText missing panel titles: ${missing.join(', ')}` : `all ${provTitles.length} provisioned titles reported`)
  }

  const hits = await api(`/api/search?query=${encodeURIComponent(`${runid} Bench Dashboard`)}&type=dash-db`)
  const hit = hits.find((h) => h.title === `${runid} Bench Dashboard`)
  let dash = null
  if (hit) dash = (await api(`/api/dashboards/uid/${hit.uid}`)).dashboard

  const panels = dash?.panels ?? []
  const stat = panels.find((p) => p.title === `${runid} Availability`)
  const statSrc = JSON.stringify(stat?.datasource ?? '') + JSON.stringify(stat?.targets ?? '')
  obj(2, Boolean(dash && stat && stat.type === 'stat' && /testdata|benchtestdata/i.test(statSrc)),
    !dash ? 'dashboard not found (or not saved)' : !stat ? 'stat panel not found' : `type=${stat.type}, datasource ok=${/testdata|benchtestdata/i.test(statSrc)}`)

  const text = panels.find((p) => p.title === `${runid} Notes`)
  obj(3, Boolean(text && text.type === 'text' && JSON.stringify(text.options ?? {}).includes(runid)),
    !text ? 'text panel not found' : `type=${text.type}, content includes runid=${JSON.stringify(text.options ?? {}).includes(runid)}`)

  obj(4, Boolean(dash && (dash.tags ?? []).includes('bench') && dash.time?.from === 'now-6h' && dash.time?.to === 'now'),
    dash ? `tags=${JSON.stringify(dash.tags)}, time=${dash.time?.from}..${dash.time?.to}` : 'no dashboard')

  obj(5, dash?.refresh === '1m', dash ? `refresh=${JSON.stringify(dash.refresh)}` : 'no dashboard')

  if (finalText === null) {
    objectives.push({ n: 6, pass: 'UNVERIFIABLE', detail: 'no result file with finalText found' })
  } else {
    obj(6, Boolean(hit && finalText.includes(hit.uid)),
      hit ? `uid ${hit.uid} ${finalText.includes(hit.uid) ? 'reported' : 'NOT in finalText'}` : 'no dashboard to report')
  }

  const passed = objectives.filter((o) => o.pass === true).length
  console.log(`\n${runid}: objectives passed ${passed}/${objectives.length}`)
  for (const o of objectives) console.log(`  obj ${o.n}: ${o.pass === true ? 'PASS' : o.pass === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'FAIL'} — ${o.detail}`)
  report.push({ runid, uid: hit?.uid ?? null, objectives, passed })
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'verify-grafana.json'), JSON.stringify(report, null, 2))
process.exitCode = anyFailure ? 1 : 0
