/**
 * External verification of a benchmark run against Kanboard's JSON-RPC API.
 * Same contract as the other verify scripts: success is judged from what the
 * app actually persisted, never from the agent's final report. The Kanboard
 * bite: a drag that LOOKS done on the board but never fired the move request
 * leaves the task in its old column, and only the API can tell.
 *
 *   obj 1  (report-only: board column names, in order)  checked against finalText
 *   obj 2  task "<runid> Bench Task" exists, description includes the runid
 *   obj 3  that task sits in the "Work in progress" column
 *   obj 4  a comment on the task includes the runid
 *   obj 5  the task's due date is 2026-12-31
 *   obj 6  (report-only: the task's numeric id)         checked against finalText
 *
 * Report-only objectives are checked against the run's recorded finalText when
 * the result file is present, and reported UNVERIFIABLE when it is not.
 */
import fs from 'node:fs'
import path from 'node:path'

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:8085/').replace(/\/$/, '')
const TOKEN = process.env.KANBOARD_API_TOKEN || 'bench-api-token'
const AUTH = 'Basic ' + Buffer.from(`jsonrpc:${TOKEN}`).toString('base64')
const OUT = process.env.BENCH_OUT || 'bench/results'
const DUE = '2026-12-31'

const runids = process.argv.slice(2)
if (!runids.length) {
  console.error('usage: node bench/verify-kanboard.mjs <runid> [runid...]')
  process.exit(2)
}

let rpcId = 0
async function rpc(method, params = {}) {
  const res = await fetch(`${APP_URL}/jsonrpc.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

// Ground truth: the board's columns, read once.
const project = await rpc('getProjectByName', { name: 'Bench Board' })
if (!project) {
  console.error('verify-kanboard: project "Bench Board" not found — was the target seeded?')
  process.exit(2)
}
const projectId = Number(project.id)
const columns = await rpc('getColumns', { project_id: projectId })
const columnTitles = columns.map((c) => c.title)
const wipColumn = columns.find((c) => /work in progress/i.test(c.title))

const report = []
let anyFailure = false

for (const runid of runids) {
  const objectives = []
  const obj = (n, pass, detail) => {
    objectives.push({ n, pass, detail })
    if (pass === false) anyFailure = true
  }

  // finalText from the run's result file, for the report-only objectives.
  let finalText = null
  for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith(`${runid}-`) && f.endsWith('-result.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))
      if (typeof r.finalText === 'string') finalText = r.finalText
    } catch {
      /* unreadable result file — treated as absent */
    }
  }

  if (finalText === null) {
    objectives.push({ n: 1, pass: 'UNVERIFIABLE', detail: 'no result file with finalText found' })
  } else {
    const missing = columnTitles.filter((t) => !finalText.includes(t))
    obj(1, missing.length === 0,
      missing.length ? `column(s) not in report: ${missing.join(', ')}` : `all ${columnTitles.length} column names reported (${columnTitles.join(' | ')})`)
  }

  // The run's task, open or closed — a wrongly-closed task should still be found and judged.
  let task = null
  for (const statusId of [1, 0]) {
    task = ((await rpc('getAllTasks', { project_id: projectId, status_id: statusId })) ?? [])
      .find((t) => t.title === `${runid} Bench Task`)
    if (task) break
  }

  obj(2, Boolean(task && String(task.description ?? '').includes(runid)),
    !task ? 'task not found' : `description includes runid=${String(task.description ?? '').includes(runid)}`)

  obj(3, Boolean(task && wipColumn && Number(task.column_id) === Number(wipColumn.id)),
    !task ? 'no task' : !wipColumn ? 'board has no "Work in progress" column' :
      `column=${columns.find((c) => Number(c.id) === Number(task.column_id))?.title ?? task.column_id}`)

  const comments = task ? ((await rpc('getAllComments', { task_id: Number(task.id) })) ?? []) : []
  obj(4, comments.some((c) => String(c.comment ?? '').includes(runid)),
    !task ? 'no task' : `${comments.length} comment(s), runid present=${comments.some((c) => String(c.comment ?? '').includes(runid))}`)

  // date_due comes back as a unix timestamp (string). The container runs UTC.
  const due = task && Number(task.date_due) ? new Date(Number(task.date_due) * 1000).toISOString().slice(0, 10) : null
  obj(5, due === DUE, !task ? 'no task' : `date_due=${due ?? '(not set)'}, want ${DUE}`)

  if (finalText === null) {
    objectives.push({ n: 6, pass: 'UNVERIFIABLE', detail: 'no result file with finalText found' })
  } else {
    const idRe = task ? new RegExp(`#?\\b${task.id}\\b`) : null
    obj(6, Boolean(task && idRe.test(finalText)),
      task ? `task id ${task.id} ${idRe.test(finalText) ? 'reported' : 'NOT in finalText'}` : 'no task to report')
  }

  const passed = objectives.filter((o) => o.pass === true).length
  console.log(`\n${runid}: objectives passed ${passed}/${objectives.length}`)
  for (const o of objectives) console.log(`  obj ${o.n}: ${o.pass === true ? 'PASS' : o.pass === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'FAIL'} — ${o.detail}`)
  report.push({ runid, taskId: task?.id ?? null, objectives, passed })
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'verify-kanboard.json'), JSON.stringify(report, null, 2))
process.exitCode = anyFailure ? 1 : 0
