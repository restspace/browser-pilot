/**
 * External verification of a benchmark run, against the repair-desk app's own
 * mutation log.
 *
 * The reporting rules require that success is judged from the app, never from
 * the agent's own final report — an agent that hallucinates completion should
 * score zero, and only an outside check can catch that.
 *
 * This is the sibling of `verify.mjs`, which verifies the same task shape
 * against the private app. There, objective 6 deletes the run's own records and
 * so destroys the evidence for objectives 2-5, leaving four of six objectives
 * permanently UNVERIFIABLE. The repair-desk app was built to close exactly that
 * gap: it keeps an append-only mutation log at `GET /__log`, one entry per
 * successful write with `before`, `after` and — for parts — the server-computed
 * `price`. Deleting a part does not remove the entry that created it. So here:
 *
 *   obj 1  ticket created                          verifiable, from the log
 *   obj 2  part A created, cost 100, price 125     verifiable, from the log
 *   obj 3  part B created, cost 200, price 250     verifiable, from the log
 *   obj 4  part A cost -> 150, price 187.50        verifiable, from the log
 *   obj 5  ticket reached status Ready             verifiable, from the log
 *   obj 6  parts deleted, ticket archived          verifiable, log + /__state
 *
 * All six are checked against values the app itself recorded, so a run that
 * reports a price it never saw is caught: the claimed prices are parsed out of
 * the run's `finalText` and compared against what the log says the app actually
 * computed. A run claiming 133.33 where the app recorded 125.00 is the precise
 * failure mode this benchmark exists to detect, and it is reported loudly.
 *
 * WHAT THIS STILL DOES NOT ESTABLISH — read before quoting a pass.
 *
 * 1. The log proves the *app performed these writes*. It does not prove the
 *    agent drove them through the browser UI rather than by some other route —
 *    a direct `fetch` to `/api/tickets` produces an identical log entry. What
 *    bounds that is the harness restricting each arm to its own tool binary,
 *    not this verifier. If you loosen that restriction, these passes stop
 *    meaning what they appear to mean.
 *
 * 2. The log is cleared only by `POST /__reset`, and is otherwise cumulative
 *    across runs. Attribution to a single run therefore rests on two things:
 *    the runid embedded in every name the task creates, and whether the run was
 *    reset at its start. This reads `reset` from the run's result JSON and says
 *    so in the output; when it is false, the entries being scored may have been
 *    left by an earlier run using the same runid, and the verdict is only as
 *    trustworthy as the assumption that runids are not reused.
 *
 * 3. Ordering is checked only where it is cheap and load-bearing: the log is
 *    sequential, so objective 4's update is required to come after objective
 *    2's create (otherwise a cost of 150 could be the value the part was born
 *    with). Nothing else is ordered here — we do not check that the Ready
 *    transition preceded the deletes, that the deletes preceded the archive, or
 *    that no other client wrote to the app between this run's entries.
 *
 * 4. Objective 5 is scored as "the ticket reached Ready at some point", from an
 *    update entry, not from final state — objective 6 archives the ticket
 *    afterwards, and a later transition could move the status again. The task
 *    also asks the run to report the Ready *preconditions* it discovered; that
 *    is prose, and no external check of it is attempted.
 *
 * The `__` endpoints need no authentication, so unlike `verify.mjs` there is no
 * login step and no `APP_EMAIL`/`APP_PASSWORD` to supply. Point `APP_URL` at a
 * running app and go.
 *
 * Usage:
 *   node bench/verify-repairdesk.mjs r01 [...more runids]
 */
import fs from 'node:fs'
import path from 'node:path'

const APP = (process.env.APP_URL || 'http://127.0.0.1:4180').replace(/\/+$/, '')
const OUT = process.env.BENCH_OUT || 'bench/results'

const runids = process.argv.slice(2)
if (!runids.length) {
  console.error('usage: node bench/verify-repairdesk.mjs <runid> [runid...]')
  process.exit(2)
}

/** The app prices from cost and markup: price = round2(cost * (1 + markup/100)). */
const expectedPrice = (cost, markupPct) => Math.round(cost * (1 + markupPct / 100) * 100) / 100

const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : String(n))

/** Two prices agree if they agree to the cent; the app only ever emits 2dp. */
const samePrice = (a, b) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) < 0.005

async function getJson(pathname) {
  let res
  try {
    res = await fetch(`${APP}${pathname}`)
  } catch (err) {
    // fetch() reports a bare "fetch failed"; the useful code (ECONNREFUSED,
    // ENOTFOUND) is one level down in cause.
    const why = err.cause?.code || err.code || err.message
    console.error(`Cannot reach the repair-desk app at ${APP} (${why}).`)
    console.error('Start it first, e.g.:')
    console.error('  node bench/app/server.mjs')
    console.error('or set APP_URL to where it is listening.')
    process.exit(2)
  }
  if (!res.ok) {
    console.error(`${APP}${pathname} returned ${res.status}.`)
    console.error('Is that really the repair-desk app? The test affordances are /__state and /__log.')
    process.exit(2)
  }
  return res.json()
}

/** The result file may sit under either arm; find whichever this runid produced. */
function resultFile(runid) {
  for (const arm of ['browser-pilot', 'agent-browser', 'playwright-mcp', 'browser-use']) {
    const p = path.join(OUT, `${runid}-${arm}-result.json`)
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * Pull the run's own claimed prices out of its final report.
 *
 * Deliberately more tolerant than verify.mjs's equivalent, which requires the
 * price to sit in the same sentence as the item name. Reports here are usually
 * written one numbered line per objective, and phrasings vary a lot
 * ("price = 125.00", "price: $125.00", "the app computed $125.00"), so each
 * anchor is followed by a bounded window rather than a sentence. A window that
 * finds nothing yields null, which is reported as "no claim parsed" — never as
 * a mismatch, because failing to parse a claim is not evidence of a false one.
 */
function claims(runid) {
  const p = resultFile(runid)
  if (!p) return null
  const result = JSON.parse(fs.readFileSync(p, 'utf8'))
  const text = result.finalText || ''

  const near = (anchor) => {
    const re = new RegExp(`${anchor}[\\s\\S]{0,240}?price[^0-9$]{0,24}\\$?\\s*(\\d+(?:\\.\\d+)?)`, 'i')
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  // Fallback: the numbered line for an objective, taking its last money-looking
  // number — in a per-objective report that is nearly always the price.
  const fromObjectiveLine = (n) => {
    const line = text
      .split('\n')
      .find((l) => new RegExp(`^\\W{0,4}(?:\\*\\*)?${n}[.):]`).test(l.trim()))
    if (!line) return null
    const nums = [...line.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    return nums.length ? nums[nums.length - 1] : null
  }

  return {
    file: p,
    stopReason: result.stopReason,
    reset: result.reset,
    arm: result.arm,
    partA: near('Part A') ?? fromObjectiveLine(2),
    partB: near('Part B') ?? fromObjectiveLine(3),
    partAAfter: near('(?:changed|updated)?[^\\n]{0,40}\\b150\\b') ?? fromObjectiveLine(4),
  }
}

const [log, state] = await Promise.all([getJson('/__log'), getJson('/__state')])
if (!Array.isArray(log)) {
  console.error('GET /__log did not return an array — wrong app, or an old build.')
  process.exit(2)
}

const report = []
let anyFailure = false

for (const runid of runids) {
  const ticketTitle = `${runid} RD Bench Ticket`
  const partAName = `${runid} RD Part A`
  const partBName = `${runid} RD Part B`

  const entries = (action, entity) =>
    log.filter((e) => e.action === action && e.entity === entity)

  // --- objective 1: the ticket was created -------------------------------
  const ticketCreates = entries('create', 'ticket').filter((e) => e.after?.title === ticketTitle)
  const ticketCreate = ticketCreates[0] || null
  const ticketId = ticketCreate?.id ?? null
  const obj1 = Boolean(ticketCreate)

  // --- objectives 2 and 3: the parts were created at the right prices -----
  const partCreate = (name) => {
    const hits = entries('create', 'part').filter((e) => e.after?.name === name)
    return { hit: hits[0] || null, count: hits.length }
  }
  const a = partCreate(partAName)
  const b = partCreate(partBName)

  const checkCreate = ({ hit, count }, name, cost, markup) => {
    const want = expectedPrice(cost, markup)
    if (!hit) return { pass: false, price: null, detail: `no create entry for "${name}"`, want }
    const f = hit.after
    const problems = []
    if (f.cost !== cost) problems.push(`cost=${f.cost} (want ${cost})`)
    if (f.markup !== markup) problems.push(`markup=${f.markup} (want ${markup})`)
    if (!samePrice(f.price, want)) problems.push(`price=${money(f.price)} (want ${money(want)})`)
    if (ticketId && f.ticketId !== ticketId) problems.push(`on ticket ${f.ticketId}, not ${ticketId}`)
    const dup = count > 1 ? ` (WARNING: ${count} creates share this name)` : ''
    return {
      pass: problems.length === 0,
      price: f.price,
      partId: hit.id,
      seq: hit.seq,
      want,
      detail: problems.length
        ? `seq ${hit.seq} ${hit.id}: ${problems.join(', ')}${dup}`
        : `seq ${hit.seq} ${hit.id} cost=${f.cost} markup=${f.markup} price=${money(f.price)}${dup}`,
    }
  }
  const obj2 = checkCreate(a, partAName, 100, 25)
  const obj3 = checkCreate(b, partBName, 200, 25)

  // --- objective 4: part A's cost became 150, repriced to 187.50 ----------
  // Ordering matters here: an update that predates the create would mean the
  // 150 belongs to some other part's history, and a part born at 150 was never
  // "changed from 100".
  const wantAfter = expectedPrice(150, 25)
  const aUpdates = obj2.partId
    ? entries('update', 'part').filter((e) => e.id === obj2.partId && e.after?.cost === 150)
    : []
  const aUpdate = aUpdates.find((e) => samePrice(e.after?.price, wantAfter)) || aUpdates[0] || null
  const orderedOk = aUpdate && obj2.seq != null ? aUpdate.seq > obj2.seq : false
  const obj4 = {
    pass: Boolean(aUpdate) && samePrice(aUpdate.after?.price, wantAfter) && orderedOk,
    price: aUpdate?.after?.price ?? null,
    want: wantAfter,
    detail: !obj2.partId
      ? 'part A was never created, so nothing could be updated'
      : !aUpdate
        ? `no update entry setting ${obj2.partId} to cost 150`
        : `seq ${aUpdate.seq}: cost ${aUpdate.before?.cost} -> ${aUpdate.after?.cost}, ` +
          `price ${money(aUpdate.before?.price)} -> ${money(aUpdate.after?.price)} ` +
          `(want ${money(wantAfter)})` +
          (orderedOk ? `, after the create at seq ${obj2.seq}` : `, but NOT after the create at seq ${obj2.seq}`),
  }

  // --- objective 5: the ticket reached Ready -----------------------------
  // From the log, not from final state: objective 6 archives the ticket
  // afterwards and a later transition could have moved the status again.
  const readyEntry = ticketId
    ? entries('update', 'ticket').find((e) => e.id === ticketId && e.after?.status === 'Ready')
    : null
  const obj5 = {
    pass: Boolean(readyEntry),
    detail: !ticketId
      ? 'ticket was never created'
      : readyEntry
        ? `seq ${readyEntry.seq}: status ${readyEntry.before?.status} -> Ready`
        : `no update entry ever set ticket ${ticketId} to Ready`,
  }

  // --- objective 6: both parts gone, ticket archived ---------------------
  // The log says the writes happened; /__state says nothing crept back. Both
  // are required, because a delete followed by a re-create would satisfy the
  // log alone, and a run that never created a part would satisfy state alone.
  const deleted = (partId) =>
    partId ? entries('delete', 'part').some((e) => e.id === partId) : false
  const aDeleted = deleted(obj2.partId)
  const bDeleted = deleted(obj3.partId)
  const archiveEntry = ticketId
    ? entries('update', 'ticket').find((e) => e.id === ticketId && e.after?.archived === true)
    : null

  const survivingParts = (state.parts || []).filter(
    (p) => typeof p.name === 'string' && p.name.startsWith(`${runid} RD Part`),
  )
  const stateTicket = ticketId
    ? (state.tickets || []).find((t) => t.id === ticketId)
    : (state.tickets || []).find((t) => t.title === ticketTitle)

  const obj6 = {
    pass:
      aDeleted &&
      bDeleted &&
      Boolean(archiveEntry) &&
      survivingParts.length === 0 &&
      Boolean(stateTicket?.archived),
    detail:
      `part A ${aDeleted ? 'deleted' : 'NOT deleted'}, part B ${bDeleted ? 'deleted' : 'NOT deleted'}, ` +
      `archive entry ${archiveEntry ? `at seq ${archiveEntry.seq}` : 'ABSENT'}; ` +
      `state: ${survivingParts.length} part(s) surviving, ticket ` +
      (stateTicket ? `${stateTicket.id} archived=${stateTicket.archived}` : 'NOT PRESENT'),
  }

  // --- what the run said it saw ------------------------------------------
  const c = claims(runid)
  const claimChecks = [
    { n: 2, claimed: c?.partA ?? null, actual: obj2.price },
    { n: 3, claimed: c?.partB ?? null, actual: obj3.price },
    { n: 4, claimed: c?.partAAfter ?? null, actual: obj4.price },
  ]

  const objectives = [
    { n: 1, pass: obj1, detail: ticketCreate
      ? `seq ${ticketCreate.seq}: ticket ${ticketCreate.id} (${ticketCreate.after.ref}) "${ticketTitle}"` +
        (ticketCreates.length > 1 ? ` (WARNING: ${ticketCreates.length} tickets share this title)` : '')
      : `no create entry for a ticket titled "${ticketTitle}"` },
    { n: 2, pass: obj2.pass, detail: obj2.detail },
    { n: 3, pass: obj3.pass, detail: obj3.detail },
    { n: 4, pass: obj4.pass, detail: obj4.detail },
    { n: 5, pass: obj5.pass, detail: obj5.detail },
    { n: 6, pass: obj6.pass, detail: obj6.detail },
  ]

  console.log(`\n=== ${runid} === (run self-reported: ${c?.stopReason ?? 'no result file'})`)
  if (!c) {
    console.log(`  note: no result file in ${OUT} — objectives are still scored from the log,`)
    console.log('        but the run\'s claimed prices cannot be cross-checked.')
  } else if (c.reset !== true) {
    // Without a reset the log may hold another run's entries under the same
    // runid. Say it every time; a quiet caveat is one nobody reads.
    console.log(`  note: this run recorded reset=${c.reset} — the mutation log was NOT cleared at`)
    console.log('        its start, so these entries are only this run\'s if the runid is unique.')
  }

  for (const o of objectives) {
    console.log(`  obj ${o.n}  ${o.pass ? 'PASS' : 'FAIL'}  ${o.detail}`)
  }

  let mismatches = 0
  for (const cc of claimChecks) {
    const has = typeof cc.claimed === 'number' && Number.isFinite(cc.claimed)
    if (!has) {
      console.log(`  claim ${cc.n}  no claim parsed from the run's final report`)
      continue
    }
    if (typeof cc.actual !== 'number') {
      console.log(`  claim ${cc.n}  run reported ${money(cc.claimed)}, app recorded nothing to compare`)
      continue
    }
    if (samePrice(cc.claimed, cc.actual)) {
      console.log(`  claim ${cc.n}  ok — run reported ${money(cc.claimed)}, app recorded ${money(cc.actual)}`)
    } else {
      mismatches += 1
      console.log(
        `  claim ${cc.n}  *** MISMATCH *** run reported ${money(cc.claimed)}, ` +
          `app recorded ${money(cc.actual)} — the run reported a price the app never computed`,
      )
    }
  }

  // Doing the task TWICE is not a pass. fwrd16's replays executed the whole
  // lifecycle on two tickets (17 and 19 mutations against a clean run's 10)
  // and still scored 6/6, because a duplicate was only ever a warning — so
  // the corrupted flow that caused it read as a green run.
  const extraTickets = ticketCreates.length - 1
  if (extraTickets > 0) {
    console.log(
      `  *** DUPLICATE WORK *** ${ticketCreates.length} tickets created with this title ` +
        `(${ticketCreates.map((t) => t.after.ref).join(', ')}) — the run did its task more than once`,
    )
  }

  const passed = objectives.filter((o) => o.pass).length
  if (passed < objectives.length || mismatches || extraTickets > 0) anyFailure = true
  console.log(
    `  summary: ${passed}/${objectives.length} objectives PASS, ` +
      `${mismatches} price claim mismatch(es), ${extraTickets} duplicate ticket(s)` +
      (passed === objectives.length && !mismatches && !extraTickets ? '' : ' — RUN NOT CLEAN'),
  )

  report.push({
    runid,
    arm: c?.arm ?? null,
    reset: c?.reset ?? null,
    ticketId,
    objectives: Object.fromEntries(objectives.map((o) => [o.n, o.pass])),
    claimMismatches: mismatches,
    duplicateTickets: extraTickets,
    passed,
  })
}

// Residue changes what later runs see, which is why /__reset exists. Surface any
// bench ticket left active, whether or not it belongs to a runid on this command
// line — a stale ticket from run r03 is still noise in run r09's list view.
const benchTickets = (state.tickets || []).filter((t) => / RD Bench Ticket$/.test(t.title || ''))
const unarchived = benchTickets.filter((t) => !t.archived)
console.log(
  `\nApp state: ${(state.tickets || []).length} tickets total, ${benchTickets.length} left by ` +
    `benchmark runs (${unarchived.length} still active), ${(state.parts || []).length} parts total, ` +
    `${log.length} mutation log entries.`,
)
for (const t of unarchived) {
  console.log(`  RESIDUE: ${t.id} "${t.title}" status=${t.status} is not archived`)
}
if (benchTickets.length > runids.length) {
  console.log('Prior-run residue is present — runs are NOT starting from a common baseline.')
  console.log('Reset the app between runs (POST /__reset) so each run owns its log.')
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'verify-repairdesk.json'), JSON.stringify(report, null, 2))

process.exit(anyFailure ? 1 : 0)
