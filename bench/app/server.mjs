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

const sendFile = (res, file) => {
  const body = fs.readFileSync(file)
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
function serveStatic(req, res, url) {
  const indexFile = path.join(PUBLIC_DIR, 'index.html')
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const candidate = path.resolve(PUBLIC_DIR, rel)

  // Reject anything that escapes public/ via .. before touching the disk.
  const inside = candidate === PUBLIC_DIR || candidate.startsWith(PUBLIC_DIR + path.sep)

  if (rel !== '' && inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    sendFile(res, candidate)
    return
  }

  if (fs.existsSync(indexFile)) {
    sendFile(res, indexFile)
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    Promise.resolve(api.handle(req, res, url))
      .then((handled) => {
        if (!handled) serveStatic(req, res, url)
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
