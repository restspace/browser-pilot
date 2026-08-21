/**
 * Datastore snapshot/restore for the benchmark.
 *
 * The atelyr backend keeps state in two places under the RS2 instance dir:
 *   mongo-data/   WiredTiger files for the app data (projects, projectItems, ...)
 *   data-store/   RS2 file data store (users, incl. the seeded bench login)
 *
 * Neither can be copied safely while mongod holds them, so both snapshot and
 * restore stop the backend, move bytes, and start it again. There is no
 * mongodump or mongosh on this machine, which is why this is a filesystem copy.
 *
 * Usage:
 *   node bench/reset.mjs --snapshot     capture the current state as the baseline
 *   node bench/reset.mjs --restore      roll the datastore back to that baseline
 *   node bench/reset.mjs --status       report whether a snapshot exists
 *
 * The snapshot lives outside the repo (~300MB) — override with BENCH_SNAPSHOT_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import net from 'node:net'

const INSTANCE = process.env.RS2_INSTANCE_DIR || 'C:\\dev\\rs2-instance'
const SNAPSHOT = process.env.BENCH_SNAPSHOT_DIR || path.join(INSTANCE, 'bench-snapshot')
const DIRS = ['mongo-data', 'data-store']
const START_SCRIPT = path.join(INSTANCE, 'start-backend.ps1')
const STAMP = 'SNAPSHOT.json'

const say = (m) => console.log(`[reset] ${m}`)

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

// Synchronous sleep: this script is a linear sequence of stop/copy/start steps,
// so blocking is simpler than threading async waits through the copy.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(1000)
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    sock.on('timeout', () => done(false))
  })
}

/**
 * Kill only the processes belonging to THIS instance. Matching on image name
 * alone would take out any other mongod the user happens to be running, which
 * is the same trap the chrome.exe warning in HANDOFF.md describes.
 */
function stopBackend() {
  // Interpolated into a PowerShell SINGLE-quoted string, which does no escape
  // processing — so the path goes in verbatim. Doubling the backslashes here
  // (a JS-string reflex) produced a needle that matched zero mongod processes,
  // which would have killed rs2-server, left mongod holding the datastore, and
  // thrown with the backend half-down and nothing to restart it.
  const needle = INSTANCE
  const killed = ps(`
    $n = '${needle}'
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='mongod.exe'" |
      Where-Object { $_.CommandLine -like "*$n*" })
    # rs2-server is launched with -WorkingDirectory $inst and no path arguments,
    # so its command line need not mention the instance dir; match on image path.
    $procs += @(Get-CimInstance Win32_Process -Filter "Name='rs2-server.exe'")
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    ($procs | ForEach-Object { "$($_.Name):$($_.ProcessId)" }) -join ' '
  `)
  say(killed ? `stopped ${killed}` : 'nothing to stop')
}

async function waitForPort(port, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await portOpen(port)) === want) return true
    sleep(500)
  }
  return false
}

async function startBackend() {
  say('starting backend')
  const out = ps(`& '${START_SCRIPT}'`)
  if (out) console.log(out)
  if (!(await waitForPort(3100, true, 60000))) throw new Error('rs2-server did not come up on 3100')
  say('backend up on 127.0.0.1:3100')
}

/**
 * Windows releases a dead process's file handles asynchronously, so a delete
 * issued the instant the port frees can still fail with EPERM/EBUSY partway
 * through — which is how a restore once left mongo-data with 29 of its 45
 * files. Retry until the OS lets go.
 */
function rmWithRetry(target, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(err.code)) throw err
      sleep(500)
    }
  }
}

function copyTree(from, to) {
  rmWithRetry(to)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

/**
 * Replace `live` with a copy of `from` without ever leaving it half-deleted.
 *
 * The obvious implementation — delete then copy — destroys the datastore if it
 * fails in between, and it did exactly that: a partial delete left mongo-data
 * unusable and only the snapshot made it recoverable. Renaming first means a
 * failure at any point leaves either the original or the restored copy intact,
 * never a mixture.
 */
function swapIn(from, live) {
  const aside = `${live}.replacing`
  rmWithRetry(aside)
  if (fs.existsSync(live)) fs.renameSync(live, aside)
  try {
    fs.cpSync(from, live, { recursive: true })
  } catch (err) {
    // Put the original back rather than leaving nothing behind.
    rmWithRetry(live)
    if (fs.existsSync(aside)) fs.renameSync(aside, live)
    throw err
  }
  rmWithRetry(aside)
}

async function withBackendDown(fn) {
  stopBackend()
  if (!(await waitForPort(27017, false, 30000))) throw new Error('mongod still holding 27017')
  if (!(await waitForPort(3100, false, 30000))) throw new Error('rs2-server still holding 3100')
  // A free port does not mean the handles are closed; give Windows a moment
  // before touching the files, so the retry loops are a backstop not the norm.
  sleep(2000)
  say('backend down')
  fn()
  await startBackend()
}

const mode = process.argv[2]

if (mode === '--status') {
  const stamp = path.join(SNAPSHOT, STAMP)
  if (!fs.existsSync(stamp)) {
    console.error(`[reset] no snapshot at ${SNAPSHOT}`)
    process.exit(1)
  }
  console.log(fs.readFileSync(stamp, 'utf8'))
} else if (mode === '--snapshot') {
  await withBackendDown(() => {
    for (const d of DIRS) {
      say(`snapshotting ${d}`)
      copyTree(path.join(INSTANCE, d), path.join(SNAPSHOT, d))
    }
    fs.writeFileSync(
      path.join(SNAPSHOT, STAMP),
      JSON.stringify({ instance: INSTANCE, dirs: DIRS, takenAt: new Date().toISOString() }, null, 2),
    )
  })
  say(`snapshot written to ${SNAPSHOT}`)
} else if (mode === '--restore') {
  if (!fs.existsSync(path.join(SNAPSHOT, STAMP))) {
    console.error(`[reset] no snapshot at ${SNAPSHOT} — run --snapshot first`)
    process.exit(1)
  }
  await withBackendDown(() => {
    for (const d of DIRS) {
      say(`restoring ${d}`)
      swapIn(path.join(SNAPSHOT, d), path.join(INSTANCE, d))
    }
  })
  say('datastore restored to baseline')
} else {
  console.error('usage: node bench/reset.mjs --snapshot | --restore | --status')
  process.exit(2)
}
