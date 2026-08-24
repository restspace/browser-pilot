/**
 * External verification of a benchmark run, against the app's database.
 *
 * The reporting rules require that success is judged from the app, never from
 * the agent's own final report — an agent that hallucinates completion should
 * score zero, and only an outside check can catch that.
 *
 * IMPORTANT — what this can and cannot establish. Objective 6 requires the run
 * to delete both line items and close the project, which destroys the evidence
 * for objectives 2-5. By the time a run finishes, the database can only show:
 *
 *   obj 1  project exists                          externally verifiable
 *   obj 2  item A created, cost 100, markup 25     NOT verifiable (deleted by obj 6)
 *   obj 3  item B created, cost 200, markup 25     NOT verifiable (deleted by obj 6)
 *   obj 4  item A cost changed to 150              NOT verifiable (deleted by obj 6)
 *   obj 5  item A status ends Specified            NOT verifiable (deleted by obj 6)
 *   obj 6  items gone AND project closed           externally verifiable
 *
 * For 2-5 this reports the run's own claimed prices and checks them against the
 * app's pricing rule (price = cost / (1 - margin)). That is an arithmetic
 * consistency check on the claim, NOT independent confirmation that the app
 * displayed those values — a run could compute the right number without ever
 * having created the item. Treat those lines as "claim is plausible", never as
 * a pass. Closing this gap needs either a mid-run snapshot or a task variant
 * that omits the cleanup step.
 *
 * Usage:
 *   node bench/verify.mjs h12 [...more runids]
 */
import fs from 'node:fs'
import path from 'node:path'

const API = process.env.APP_API || 'http://127.0.0.1:3100'
const EMAIL = process.env.APP_EMAIL
const PASSWORD = process.env.APP_PASSWORD
const OUT = process.env.BENCH_OUT || 'bench/results'

const runids = process.argv.slice(2)
if (!runids.length) {
  console.error('usage: node bench/verify.mjs <runid> [runid...]')
  process.exit(2)
}
if (!EMAIL || !PASSWORD) {
  console.error('set APP_EMAIL and APP_PASSWORD')
  process.exit(2)
}

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return (await res.json()).token
}

async function collection(name, token) {
  const headers = { Authorization: `Bearer ${token}` }
  const list = await (await fetch(`${API}/dbdata/${name}`, { headers })).json()
  const names = (list.entries || []).filter((e) => !e.dir).map((e) => e.name)
  const out = []
  for (const n of names) {
    const rec = await (await fetch(`${API}/dbdata/${name}/${n}`, { headers })).json()
    out.push({ _id: n, ...rec })
  }
  return out
}

/** The app prices from cost and margin: price = cost / (1 - margin/100). */
const expectedPrice = (cost, marginPct) =>
  Math.round((cost / (1 - marginPct / 100)) * 100) / 100

/** Pull the run's own claimed prices out of its final report, for the 2-5 check. */
function claimedPrices(runid) {
  const f = path.join(OUT, `${runid}-browser-pilot-result.json`)
  const g = path.join(OUT, `${runid}-agent-browser-result.json`)
  const p = fs.existsSync(f) ? f : fs.existsSync(g) ? g : null
  if (!p) return null
  const result = JSON.parse(fs.readFileSync(p, 'utf8'))
  const text = result.finalText || ''
  // Reports number their lines per objective ("**2. DONE** — ... Price =
  // 133.33"), but the price rarely shares a sentence with the item name — the
  // original single-sentence regexes matched nothing on a fully successful run
  // (tbp1) and scored its claims UNVERIFIABLE. Split the report into
  // per-objective blocks on the leading numbers instead, and take the first
  // price-shaped figure inside each block.
  const blocks = {}
  const marks = []
  const re = /(?:^|\n)[^\S\n]*(?:\*\*|__)?([1-6])[.)]/g
  let m
  while ((m = re.exec(text))) marks.push({ n: Number(m[1]), i: m.index })
  for (let k = 0; k < marks.length; k++)
    blocks[marks[k].n] = text.slice(marks[k].i, marks[k + 1]?.i ?? text.length)
  const price = (s) => {
    const hit = s?.match(/price[^0-9]{0,24}(\d+(?:\.\d+)?)/i)
    return hit ? Number(hit[1]) : null
  }
  const grab = (re2) => {
    const hit = text.match(re2)
    return hit ? Number(hit[1]) : null
  }
  return {
    stopReason: result.stopReason,
    itemA: price(blocks[2]) ?? grab(/Item A[^.]*?price\s*=\s*(\d+(?:\.\d+)?)/i),
    itemB: price(blocks[3]) ?? grab(/Item B[^.]*?price\s*=\s*(\d+(?:\.\d+)?)/i),
    itemAAfter: price(blocks[4]) ?? grab(/cost changed to 150[^.]*?price\s*=\s*(\d+(?:\.\d+)?)/i),
  }
}

/**
 * Did the run ever attempt to create the line items?
 *
 * "No items remain" is satisfied both by a run that created two items and
 * deleted them, and by a run that never created any — so objective 6 would
 * otherwise pass vacuously for a run that only made a project and closed it.
 * The database cannot tell these apart after the fact; the transcript can at
 * least show whether the item names were ever sent to the tool.
 */
function attemptedItems(runid) {
  for (const arm of ['browser-pilot', 'agent-browser']) {
    const p = path.join(OUT, `${runid}-${arm}-transcript.jsonl`)
    if (!fs.existsSync(p)) continue
    const text = fs.readFileSync(p, 'utf8')
    return text.includes(`${runid} MTP Item A`) || text.includes(`${runid} MTP Item B`)
  }
  return null
}

const token = await login()
const projects = await collection('project', token)
const items = await collection('projectItem', token)

const report = []
for (const runid of runids) {
  const proj = projects.find((p) => p.name === `${runid} MTP Bench Project`)
  const mine = proj ? items.filter((i) => i.projectId === proj.projectId) : []
  const named = items.filter((i) => typeof i.name === 'string' && i.name.startsWith(`${runid} MTP Item`))
  const leftover = [...new Set([...mine, ...named])]
  const claims = claimedPrices(runid)

  const dupes = projects.filter((p) => p.name === `${runid} MTP Bench Project`).length
  const obj1 = Boolean(proj)
  const closed = proj ? /closed|archiv/i.test(String(proj.status)) : false
  const tried = attemptedItems(runid)
  // Only a run that actually created items can be credited with removing them.
  const obj6 = leftover.length === 0 && closed && tried === true

  const checks = [
    {
      n: 1,
      verifiable: true,
      pass: obj1,
      detail: proj
        ? `project ${proj.projectId} exists${dupes > 1 ? ` (WARNING: ${dupes} projects share this name)` : ''}`
        : 'project NOT FOUND',
    },
    { n: 2, verifiable: false, claimed: claims?.itemA, expected: expectedPrice(100, 25) },
    { n: 3, verifiable: false, claimed: claims?.itemB, expected: expectedPrice(200, 25) },
    { n: 4, verifiable: false, claimed: claims?.itemAAfter, expected: expectedPrice(150, 25) },
    { n: 5, verifiable: false, claimed: null, expected: null },
    {
      n: 6,
      verifiable: true,
      pass: obj6,
      detail:
        `${leftover.length} item(s) left, project status=${proj ? proj.status : 'n/a'}` +
        (tried === true
          ? ''
          : tried === false
            ? ' — VACUOUS: transcript shows the run never named either item, so nothing was removed'
            : ' — no transcript, cannot tell removal from never-created'),
    },
  ]

  console.log(`\n=== ${runid} === (run self-reported: ${claims?.stopReason ?? 'no result file'})`)
  for (const c of checks) {
    if (c.verifiable) {
      console.log(`  obj ${c.n}  ${c.pass ? 'PASS' : 'FAIL'}  ${c.detail}`)
    } else if (c.n === 5) {
      console.log(`  obj ${c.n}  UNVERIFIABLE  status destroyed by objective 6 cleanup`)
    } else {
      // A missing result file and an unparsed claim are both "no claim", not a
      // failed comparison — reporting them as INCONSISTENT would invent a defect.
      const has = typeof c.claimed === 'number' && Number.isFinite(c.claimed)
      const ok = has && Math.abs(c.claimed - c.expected) < 0.02
      const verdict = !has ? 'NO CLAIM PARSED' : ok ? 'claim consistent' : 'CLAIM INCONSISTENT'
      console.log(`  obj ${c.n}  UNVERIFIABLE  ${verdict} (claimed ${c.claimed}, rule gives ${c.expected})`)
    }
  }
  report.push({ runid, obj1, obj6, leftover: leftover.length, projectStatus: proj?.status ?? null })
}

// Residue from other runs changes list sizes for every later run, which is why
// --reset exists. Surface it so a run is never scored against a drifting app.
const residue = projects.filter((p) => /MTP Bench Project$/.test(p.name || ''))
console.log(
  `\nApp state: ${projects.length} projects total, ${residue.length} left by benchmark runs, ` +
    `${items.length} projectItems total.`,
)
if (residue.length > runids.length) {
  console.log('Prior-run residue is present — runs are NOT starting from a common baseline.')
  console.log('Capture a baseline (node bench/reset.mjs --snapshot) and run with --reset.')
}

fs.writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(report, null, 2))
