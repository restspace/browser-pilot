/**
 * repair-desk http server: routing, static file serving, startup.
 *
 * Node stdlib only, by design — a reader must be able to clone the repo and run
 * `node bench/app/server.mjs` with no install step.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from './store.mjs'
import { createApi } from './api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(here, 'public')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Drift simulation for repair-bench validation: while a mode is set (via
 * /__drift?mode=labels), served frontend files are rewritten on the fly so
 * the app presents renamed controls without touching the files on disk.
 *
 *   labels  renames visible control wording only (testids/ids stay) — the
 *           localized drift a locator chain should survive via its label/text
 *           fallbacks, and the post-session repair pass should then promote
 *           those fallbacks.
 *   ids     renames three data-testid VALUES, leaving wording and element ids
 *           alone. This is the mode that bites a recording whose primary
 *           locators are test ids (every fwrd* store): the primary misses, the
 *           role fallback resolves, the replay fallthroughs, and repair
 *           promotes the role locator to primary. The app itself keeps
 *           working because the only selector app.js builds from a testid
 *           ([data-testid="new-ticket"]) contains the same string and is
 *           rewritten with it — and #modal-save is an ELEMENT id, untouched.
 *   both    ids + labels: the testid primary AND the role/label fallbacks are
 *           gone at once, so nothing is left in the chain but the recorded css
 *           path. That is the "chain dead" case triage sends to patch-segment
 *           (a model re-deriving the locator on the live page) or, when the
 *           page no longer resembles the recording, to re-record.
 *
 * The renames are written as whole `data-testid="..."` attributes rather than
 * bare words on purpose: a bare "modal-save" would also rewrite id="modal-save"
 * and the $('#modal-save') the app looks it up with, which would break the app
 * instead of drifting it.
 */
const LABEL_DRIFTS = [
  ['Add part', 'Attach part'],
  ['New ticket', 'Create ticket'],
  ['Mark ready', 'Set ready'],
]

const ID_DRIFTS = [
  ['data-testid="add-part"', 'data-testid="part-attach"'],
  ['data-testid="new-ticket"', 'data-testid="ticket-new"'],
  ['data-testid="modal-save"', 'data-testid="dialog-save"'],
]

const DRIFTS = {
  labels: LABEL_DRIFTS,
  ids: ID_DRIFTS,
  both: [...ID_DRIFTS, ...LABEL_DRIFTS],
}

const applyDrift = (body, file, mode) => {
  const rules = DRIFTS[mode]
  const ext = path.extname(file).toLowerCase()
  if (!rules || (ext !== '.js' && ext !== '.html')) return body
  let text = body.toString('utf8')
  for (const [from, to] of rules) text = text.split(from).join(to)
  return Buffer.from(text, 'utf8')
}

const sendFile = (res, file, driftMode = null) => {
  const body = applyDrift(fs.readFileSync(file), file, driftMode)
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    // A benchmark reader will edit public/ and reload; never let a cache hide that.
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Any unknown non-API path falls back to index.html so that reloading
 * `#/tickets/t3` still lands on the app rather than a 404.
 */
function serveStatic(req, res, url, driftMode = null) {
  const indexFile = path.join(PUBLIC_DIR, 'index.html')
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const candidate = path.resolve(PUBLIC_DIR, rel)

  // Reject anything that escapes public/ via .. before touching the disk.
  const inside = candidate === PUBLIC_DIR || candidate.startsWith(PUBLIC_DIR + path.sep)

  if (rel !== '' && inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    sendFile(res, candidate, driftMode)
    return
  }

  if (fs.existsSync(indexFile)) {
    sendFile(res, indexFile, driftMode)
    return
  }

  // The frontend is built separately; say so plainly rather than crashing.
  const body = 'repair-desk: public/index.html is missing'
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

/**
 * SPEC-GAP: the spec asks start() to return { server, port, close() }, but a
 * real port only exists once the socket is listening — and the tests use port 0.
 * start() therefore returns a promise for that object.
 */
export function start({ port = Number(process.env.PORT) || 4180, dataDir, fresh = false } = {}) {
  const store = createStore({ dataDir, fresh })
  const api = createApi({ store })

  let driftMode = null

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    // Test affordance, unauthenticated like /__reset: set or clear the UI
    // drift the static files are served with. GET /__drift reports it.
    if (url.pathname === '/__drift') {
      const mode = url.searchParams.get('mode')
      if (mode !== null) driftMode = mode && DRIFTS[mode] ? mode : null
      const body = JSON.stringify({ drift: driftMode })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
      return
    }

    Promise.resolve(api.handle(req, res, url))
      .then((handled) => {
        if (!handled) serveStatic(req, res, url, driftMode)
      })
      .catch((err) => {
        // A handler throwing must not take the process down mid-benchmark.
        if (res.headersSent) {
          res.destroy()
          return
        }
        const body = JSON.stringify({ error: 'Server error: ' + err.message })
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
      })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const actual = server.address().port
      console.log('repair-desk listening on http://127.0.0.1:' + actual)
      resolve({
        server,
        store,
        port: actual,
        close: () =>
          new Promise((done) => {
            // Keep-alive sockets would otherwise hold close() open until they
            // time out, which is long enough to look like a hung test run.
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  start({ fresh: process.argv.includes('--fresh') }).catch((err) => {
    console.error('repair-desk failed to start:', err.message)
    process.exitCode = 1
  })
}
