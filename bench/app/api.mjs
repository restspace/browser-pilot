/**
 * API route handlers for repair-desk.
 *
 * Everything under /api/ apart from login needs a session; the test affordances
 * under /__ are deliberately unauthenticated so a harness can inspect state
 * without holding a cookie.
 */
import crypto from 'node:crypto'
import { STATUSES, withPrice } from './store.mjs'

const PAGE_SIZE = 10

const ALLOWED_TRANSITIONS = {
  Draft: ['Ready'],
  Ready: ['Draft', 'Closed'],
  Closed: [],
}

const send = (res, status, body) => {
  if (body === undefined) {
    res.writeHead(status)
    res.end()
    return true
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
  return true
}

const fail = (res, status, error, extra) => send(res, status, { error, ...extra })

/**
 * Multiple cookies arrive in a single header, and other tooling may well have
 * set its own, so pick `sid` out of the list rather than assume it stands alone.
 */
const readCookie = (req, name) => {
  const header = req.headers.cookie
  if (!header) return null
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=')
    if (eq === -1) continue
    if (piece.slice(0, eq).trim() === name) return decodeURIComponent(piece.slice(eq + 1).trim())
  }
  return null
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // A body this large can only be a mistake here; refuse it rather than buffer it.
      if (size > 1000000) {
        reject(Object.assign(new Error('body too large'), { tooLarge: true }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

// --- validation -------------------------------------------------------------
// SPEC-GAP: the spec fixes the wording of the `unmet` strings and of the
// not-found and transition errors, but for field validation asks only for "a
// human sentence naming the field". The sentences below are that.

const trimmedString = (value) => (typeof value === 'string' ? value.trim() : '')

/** Numbers may arrive as strings from a form; Number() coercion is specified. */
const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return NaN
  return Number(value)
}

function validateTicketCreate(body) {
  const title = trimmedString(body.title)
  if (!title) return { error: 'Title is required' }
  const customer = body.customer === undefined || body.customer === null ? '' : String(body.customer)
  return { value: { title, customer } }
}

function validatePartFields(body, { partial }) {
  const patch = {}

  if (!partial || body.name !== undefined) {
    const name = trimmedString(body.name)
    if (!name) return { error: 'Name is required' }
    patch.name = name
  }

  for (const field of ['cost', 'markup']) {
    if (partial && body[field] === undefined) continue
    const label = field === 'cost' ? 'Cost' : 'Markup'
    const n = toNumber(body[field])
    if (!Number.isFinite(n)) return { error: label + ' must be a number' }
    if (n < 0) return { error: label + ' must be zero or more' }
    patch[field] = n
  }

  if (body.quantity === undefined || body.quantity === null) {
    if (!partial) patch.quantity = 1
  } else {
    const n = toNumber(body.quantity)
    if (!Number.isFinite(n)) return { error: 'Quantity must be a number' }
    if (!Number.isInteger(n)) return { error: 'Quantity must be a whole number' }
    if (n < 0) return { error: 'Quantity must be zero or more' }
    patch.quantity = n
  }

  if (body.supplier === undefined) {
    if (!partial) patch.supplier = null
  } else if (body.supplier === null) {
    patch.supplier = null
  } else if (typeof body.supplier === 'string') {
    // An empty supplier is stored as null so that "has no supplier" has exactly
    // one representation for the Ready check and for the UI to render.
    const s = body.supplier.trim()
    patch.supplier = s === '' ? null : s
  } else {
    return { error: 'Supplier must be text' }
  }

  return { value: patch }
}

/**
 * The discovery objective. Every failing part is reported, in id order, so an
 * agent reading the page learns the whole rule from a single rejection.
 */
function readyFailures(parts) {
  if (parts.length === 0) {
    return ['A ticket needs at least one part before it can be marked Ready']
  }
  const unmet = []
  for (const part of parts) {
    if (typeof part.supplier !== 'string' || part.supplier.trim() === '') {
      unmet.push('Part "' + part.name + '" has no supplier')
    }
    if (!(part.quantity >= 1)) {
      unmet.push('Part "' + part.name + '" has quantity ' + part.quantity + ', which must be at least 1')
    }
  }
  return unmet
}

export function createApi({ store }) {
  /** Sessions live here only, and are deliberately never dumped to data/. */
  const sessions = new Map()

  const sessionUser = (req) => {
    const sid = readCookie(req, 'sid')
    if (!sid) return null
    const userId = sessions.get(sid)
    if (!userId) return null
    return store.findUserById(userId)
  }

  const publicUser = (user) => ({ id: user.id, email: user.email, name: user.name })

  function listTickets(res, params) {
    const status = params.get('status')
    const q = (params.get('q') || '').trim().toLowerCase()
    const archived = params.get('archived')

    let items = store.tickets().slice()

    if (archived === 'all') {
      // both, no filter
    } else if (archived === 'true') {
      items = items.filter((t) => t.archived === true)
    } else {
      items = items.filter((t) => t.archived !== true)
    }

    if (status && status !== 'all') items = items.filter((t) => t.status === status)

    if (q) {
      items = items.filter((t) =>
        [t.title, t.ref, t.customer].some((field) => String(field ?? '').toLowerCase().includes(q)),
      )
    }

    items.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
      // Newest first on a tie: ids are counters, so compare their numeric tail.
      return Number(b.id.slice(1)) - Number(a.id.slice(1))
    })

    const total = items.length
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const requested = Number.parseInt(params.get('page') ?? '', 10)
    const page = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), totalPages)
    const start = (page - 1) * PAGE_SIZE

    const pageItems = items.slice(start, start + PAGE_SIZE).map((t) => ({
      ...t,
      partCount: store.partsFor(t.id).length,
    }))

    return send(res, 200, { items: pageItems, page, pageSize: PAGE_SIZE, total, totalPages })
  }

  function patchTicket(res, ticket, body) {
    const unarchiving = body.archived === false

    // An archived ticket is frozen apart from the PATCH that un-archives it.
    if (ticket.archived && !unarchiving) return fail(res, 409, 'Ticket is archived')

    const patch = {}

    if (body.title !== undefined) {
      const title = trimmedString(body.title)
      if (!title) return fail(res, 400, 'Title is required')
      patch.title = title
    }

    if (body.customer !== undefined) {
      patch.customer = body.customer === null ? '' : String(body.customer)
    }

    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') return fail(res, 400, 'Archived must be true or false')
      patch.archived = body.archived
    }

    if (body.status !== undefined) {
      const next = body.status
      if (!STATUSES.includes(next)) {
        return fail(res, 400, 'Status must be one of ' + STATUSES.join(', '))
      }
      // SPEC-GAP: the spec allows three transitions and rejects "any other
      // transition", which read literally covers a no-op X -> X. We follow that
      // literal reading; the UI only ever offers the legal transitions anyway.
      if (!ALLOWED_TRANSITIONS[ticket.status].includes(next)) {
        return fail(res, 409, 'Cannot move a ticket from ' + ticket.status + ' to ' + next)
      }
      if (next === 'Ready') {
        const unmet = readyFailures(store.partsFor(ticket.id))
        if (unmet.length) return fail(res, 409, 'Ticket is not ready', { unmet })
      }
      patch.status = next
    }

    return send(res, 200, store.updateTicket(ticket, patch))
  }

  /**
   * Returns true when the request belonged to the API surface, so the server can
   * fall through to static file serving when it did not.
   */
  async function handle(req, res, url) {
    const p = url.pathname
    const method = req.method

    if (!p.startsWith('/api/') && !p.startsWith('/__')) return false

    let body = {}
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      let raw
      try {
        raw = await readBody(req)
      } catch (err) {
        return fail(res, err.tooLarge ? 413 : 400, 'Request body could not be read')
      }
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw)
        } catch {
          // A malformed body is an ordinary 400, never an unhandled throw.
          return fail(res, 400, 'Request body is not valid JSON')
        }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'Request body must be a JSON object')
      }
    }

    // --- test affordances: not linked from the UI, and unauthenticated -------

    if (p === '/__reset' && method === 'POST') {
      store.reset()
      sessions.clear()
      return send(res, 204)
    }
    if (p === '/__state' && method === 'GET') return send(res, 200, store.snapshot())
    if (p === '/__log' && method === 'GET') return send(res, 200, store.log)
    if (p.startsWith('/__')) return fail(res, 404, 'No such route: ' + p)

    // --- login, the one unauthenticated /api/ route -------------------------

    if (p === '/api/login' && method === 'POST') {
      const user = store.findUserByEmail(body.email ?? '')
      if (!user || user.password !== body.password) {
        return fail(res, 401, 'Email or password is not recognised')
      }
      const sid = crypto.randomUUID()
      sessions.set(sid, user.id)
      const text = JSON.stringify({ user: publicUser(user) })
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
        // No Secure: this app is plain http on the loopback interface only.
        'Set-Cookie': 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax',
      })
      res.end(text)
      return true
    }

    const user = sessionUser(req)
    if (!user) return fail(res, 401, 'Not signed in')

    if (p === '/api/logout' && method === 'POST') {
      const sid = readCookie(req, 'sid')
      if (sid) sessions.delete(sid)
      res.writeHead(204, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' })
      res.end()
      return true
    }

    if (p === '/api/me' && method === 'GET') return send(res, 200, { user: publicUser(user) })

    if (p === '/api/tickets' && method === 'GET') return listTickets(res, url.searchParams)

    if (p === '/api/tickets' && method === 'POST') {
      const checked = validateTicketCreate(body)
      if (checked.error) return fail(res, 400, checked.error)
      return send(res, 201, store.createTicket(checked.value))
    }

    const ticketMatch = /^\/api\/tickets\/([^/]+)$/.exec(p)
    if (ticketMatch) {
      const id = decodeURIComponent(ticketMatch[1])
      const ticket = store.findTicket(id)
      if (!ticket) return fail(res, 404, 'No such ticket: ' + id)
      if (method === 'GET') {
        return send(res, 200, { ticket, parts: store.partsFor(id).map(withPrice) })
      }
      if (method === 'PATCH') return patchTicket(res, ticket, body)
      return fail(res, 405, 'Method ' + method + ' is not allowed here')
    }

    const partsMatch = /^\/api\/tickets\/([^/]+)\/parts$/.exec(p)
    if (partsMatch && method === 'POST') {
      const id = decodeURIComponent(partsMatch[1])
      const ticket = store.findTicket(id)
      if (!ticket) return fail(res, 404, 'No such ticket: ' + id)
      // SPEC-GAP: "rejects all further mutation" is read as covering the
      // ticket's parts as well, since a part exists only within a ticket.
      if (ticket.archived) return fail(res, 409, 'Ticket is archived')
      const checked = validatePartFields(body, { partial: false })
      if (checked.error) return fail(res, 400, checked.error)
      return send(res, 201, withPrice(store.createPart(id, checked.value)))
    }

    const partMatch = /^\/api\/parts\/([^/]+)$/.exec(p)
    if (partMatch) {
      const id = decodeURIComponent(partMatch[1])
      const part = store.findPart(id)
      if (!part) return fail(res, 404, 'No such part: ' + id)
      const ticket = store.findTicket(part.ticketId)
      if (ticket && ticket.archived) return fail(res, 409, 'Ticket is archived')

      if (method === 'PATCH') {
        const checked = validatePartFields(body, { partial: true })
        if (checked.error) return fail(res, 400, checked.error)
        return send(res, 200, withPrice(store.updatePart(part, checked.value)))
      }
      if (method === 'DELETE') {
        store.deletePart(part)
        return send(res, 204)
      }
      return fail(res, 405, 'Method ' + method + ' is not allowed here')
    }

    return fail(res, 404, 'No such route: ' + p)
  }

  return { handle, sessions }
}
