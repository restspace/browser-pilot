/**
 * repair-desk contract tests.
 *
 * These drive the app over real HTTP against a booted server, deliberately
 * *not* importing store.mjs or api.mjs. The benchmark's whole premise is that a
 * browser agent discovers the rules by reading them off the wire and off the
 * page, so the tests have to assert the same surface the agent sees: status
 * codes, and the exact wording of `error` and `unmet` strings.
 *
 * Written against SPEC.md rather than against the implementation.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// A fresh temp data dir per run, so a test run never touches bench/app/data and
// two runs can never see each other's dumps. The env var is set before the
// dynamic import because the module may read it at load time; `start({ dataDir })`
// is the contract we actually rely on, but setting both costs nothing.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-desk-test-'))
process.env.BENCH_APP_DATA_DIR = dataDir

const { start } = await import('../server.mjs')

let app
let base

const SEED_TICKETS = 14
const SEED_PARTS = 17
const CREDENTIALS = { email: 'bench@example.com', password: 'bench-pass-1234' }

beforeAll(async () => {
  app = await start({ port: 0, dataDir })
  base = `http://127.0.0.1:${app.port}`
})

afterAll(async () => {
  await app?.close?.()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// helpers

/**
 * One request. `cookie` is passed explicitly because fetch has no cookie jar —
 * every authenticated call in this file threads the sid captured at login.
 */
async function request(method, urlPath, { body, cookie } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  // 204s have no body; everything else in this API is JSON.
  const text = await res.text()
  let json = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: res.status, headers: res.headers, body: json, text }
}

/** Log in and return the `sid=...` cookie pair ready to send back. */
async function login(creds = CREDENTIALS) {
  const res = await request('POST', '/api/login', { body: creds })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie, 'login must issue a Set-Cookie').toBeTruthy()
  return setCookie.split(';')[0]
}

let sid

/**
 * Every test starts from seed. /__reset also drops sessions, so the login has
 * to happen after it — this is why we re-login per test rather than caching one
 * cookie across the file.
 */
beforeEach(async () => {
  const res = await request('POST', '/__reset')
  expect(res.status).toBe(204)
  sid = await login()
})

const GET = (p) => request('GET', p, { cookie: sid })
const POST = (p, body) => request('POST', p, { body, cookie: sid })
const PATCH = (p, body) => request('PATCH', p, { body, cookie: sid })
const DELETE = (p) => request('DELETE', p, { cookie: sid })

/** Add a part to a ticket, asserting it was accepted, and return it. */
async function addPart(ticketId, part) {
  const res = await POST(`/api/tickets/${ticketId}/parts`, part)
  expect(res.status, res.text).toBe(201)
  return res.body
}

// ---------------------------------------------------------------------------

describe('auth', () => {
  it('signs in with the committed credentials and returns the user without the password', async () => {
    const res = await request('POST', '/api/login', { body: CREDENTIALS })
    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id: 'u1',
      email: 'bench@example.com',
      name: 'Bench User',
    })
  })

  it('sets an HttpOnly, SameSite=Lax, non-Secure sid cookie', async () => {
    const res = await request('POST', '/api/login', { body: CREDENTIALS })
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toMatch(/^sid=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    // Plain http only — a Secure cookie would simply never come back.
    expect(setCookie).not.toMatch(/;\s*Secure/i)
  })

  it('rejects a wrong password with 401 and no cookie', async () => {
    const res = await request('POST', '/api/login', {
      body: { email: 'bench@example.com', password: 'not-the-password' },
    })
    expect(res.status).toBe(401)
    // SPEC-GAP: the spec pins the *frontend* copy ("Email or password is not
    // recognised") but never states the API's error string, so we only assert
    // that some human sentence is present for the page to render.
    expect(typeof res.body.error).toBe('string')
    expect(res.body.error.length).toBeGreaterThan(0)
    expect(res.headers.get('set-cookie')).toBeFalsy()
  })

  it('rejects an unknown email with 401', async () => {
    const res = await request('POST', '/api/login', {
      body: { email: 'nobody@example.com', password: 'bench-pass-1234' },
    })
    expect(res.status).toBe(401)
  })

  it('requires a session on a protected read route', async () => {
    const res = await request('GET', '/api/tickets')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('requires a session on a protected write route', async () => {
    const res = await request('POST', '/api/tickets', { body: { title: 'Nope' } })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('returns the current user from /api/me', async () => {
    const res = await GET('/api/me')
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe('bench@example.com')
    expect(res.body.user).not.toHaveProperty('password')
  })

  it('logs out, after which the same cookie no longer works', async () => {
    const out = await POST('/api/logout')
    expect(out.status).toBe(204)
    const after = await GET('/api/me')
    expect(after.status).toBe(401)
    expect(after.body).toEqual({ error: 'Not signed in' })
  })
})

// ---------------------------------------------------------------------------

describe('ticket create and validation', () => {
  it('creates a ticket with the next ref and id from the counter', async () => {
    const res = await POST('/api/tickets', {
      title: 'Fridge fan replacement',
      customer: 'Test Co',
    })
    expect(res.status).toBe(201)
    // Seed ends at t14 / RD-1014, and the counter never reuses a value.
    expect(res.body.id).toBe('t15')
    expect(res.body.ref).toBe('RD-1015')
    expect(res.body.title).toBe('Fridge fan replacement')
    expect(res.body.customer).toBe('Test Co')
    // SPEC-GAP: the spec never states the starting status explicitly, but the
    // transition table only makes sense if a new ticket starts in Draft.
    expect(res.body.status).toBe('Draft')
    expect(res.body.archived).toBe(false)
    expect(typeof res.body.createdAt).toBe('string')
  })

  it('defaults customer to the empty string when omitted', async () => {
    const res = await POST('/api/tickets', { title: 'No customer given' })
    expect(res.status).toBe(201)
    expect(res.body.customer).toBe('')
  })

  it('rejects a missing title with a 400 naming the field', async () => {
    const res = await POST('/api/tickets', { customer: 'Test Co' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/title/i)
  })

  it('rejects a whitespace-only title, because required means non-empty after trim', async () => {
    const res = await POST('/api/tickets', { title: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/title/i)
  })

  it('404s a ticket that does not exist, naming the id', async () => {
    const res = await GET('/api/tickets/t999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'No such ticket: t999' })
  })
})

// ---------------------------------------------------------------------------

describe('parts and the price rule', () => {
  // The three pairs called out in the spec's Tests section. They are the exact
  // numbers the benchmark verifier looks for, so they are asserted literally.
  it.each([
    [100, 25, 125],
    [200, 25, 250],
    [150, 25, 187.5],
  ])('computes price for cost %d markup %d as %d', async (cost, markup, price) => {
    const part = await addPart('t11', { name: 'Priced part', cost, markup })
    expect(part.cost).toBe(cost)
    expect(part.markup).toBe(markup)
    expect(part.price).toBe(price)
  })

  it('creates a part with the documented defaults', async () => {
    const part = await addPart('t11', { name: 'Defaulted part', cost: 10, markup: 0 })
    expect(part.id).toBe('p18') // seed ends at p17
    expect(part.ticketId).toBe('t11')
    expect(part.quantity).toBe(1)
    expect(part.supplier).toBe(null)
    expect(part.price).toBe(10)
  })

  it('coerces numeric strings with Number()', async () => {
    const part = await addPart('t11', {
      name: 'Stringly typed',
      cost: '100',
      markup: '25',
      quantity: '2',
    })
    expect(part.cost).toBe(100)
    expect(part.markup).toBe(25)
    expect(part.quantity).toBe(2)
    expect(part.price).toBe(125)
  })

  it('rejects a cost that is not a number', async () => {
    const res = await POST('/api/tickets/t11/parts', {
      name: 'Bad cost',
      cost: 'not-a-number',
      markup: 25,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cost/i)
  })

  it('rejects a negative cost', async () => {
    const res = await POST('/api/tickets/t11/parts', { name: 'Cheap', cost: -1, markup: 25 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cost/i)
  })

  it('rejects a missing part name', async () => {
    const res = await POST('/api/tickets/t11/parts', { cost: 10, markup: 10 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/name/i)
  })

  it('rejects a missing markup', async () => {
    const res = await POST('/api/tickets/t11/parts', { name: 'No markup', cost: 10 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/markup/i)
  })

  it('recomputes price when the cost is updated', async () => {
    // p1 is seeded at cost 100 / markup 25 => 125.
    const before = await GET('/api/tickets/t1')
    expect(before.body.parts.find((p) => p.id === 'p1').price).toBe(125)

    const res = await PATCH('/api/parts/p1', { cost: 200 })
    expect(res.status).toBe(200)
    expect(res.body.cost).toBe(200)
    expect(res.body.markup).toBe(25) // an untouched field survives a partial patch
    expect(res.body.price).toBe(250)
  })

  it('recomputes price when the markup is updated', async () => {
    const res = await PATCH('/api/parts/p1', { markup: 50 })
    expect(res.status).toBe(200)
    expect(res.body.price).toBe(150)
  })

  it('serves parts with price on the ticket detail view', async () => {
    const res = await GET('/api/tickets/t1')
    expect(res.status).toBe(200)
    expect(res.body.ticket.ref).toBe('RD-1001')
    expect(res.body.parts.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(res.body.parts.map((p) => p.price)).toEqual([125, 17.5]) // 12.5 * 1.4
  })

  it('deletes a part', async () => {
    const res = await DELETE('/api/parts/p2')
    expect(res.status).toBe(204)
    const after = await GET('/api/tickets/t1')
    expect(after.body.parts.map((p) => p.id)).toEqual(['p1'])
  })

  it('404s an unknown part, naming the id', async () => {
    const res = await DELETE('/api/parts/p999')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'No such part: p999' })
  })

  it('never stores the derived price on disk', async () => {
    await addPart('t11', { name: 'Disk check', cost: 100, markup: 25 })
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'parts.json'), 'utf8'))
    for (const part of onDisk) expect(part).not.toHaveProperty('price')
  })
})

// ---------------------------------------------------------------------------

describe('the Ready precondition', () => {
  it('rejects a ticket with no parts, with the exact wording', async () => {
    // t11 ("Card terminal will not pair") is the seeded Draft with zero parts.
    const res = await PATCH('/api/tickets/t11', { status: 'Ready' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'Ticket is not ready',
      unmet: ['A ticket needs at least one part before it can be marked Ready'],
    })
  })

  it('rejects a part with no supplier, quoting the part name', async () => {
    // t10's only part, p13 "Humidistat", is seeded with supplier: null.
    const res = await PATCH('/api/tickets/t10', { status: 'Ready' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'Ticket is not ready',
      unmet: ['Part "Humidistat" has no supplier'],
    })
  })

  it('rejects a part with quantity 0, quoting the quantity', async () => {
    // t12 has p14 (valid) and p15 "Float switch" with quantity 0.
    const res = await PATCH('/api/tickets/t12', { status: 'Ready' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'Ticket is not ready',
      unmet: ['Part "Float switch" has quantity 0, which must be at least 1'],
    })
  })

  it('treats an empty-string supplier as missing', async () => {
    // The rule is "non-empty supplier", so "" must fail the same way null does.
    await addPart('t11', { name: 'Blank supplier', cost: 10, markup: 10, supplier: '' })
    const res = await PATCH('/api/tickets/t11', { status: 'Ready' })
    expect(res.status).toBe(409)
    expect(res.body.unmet).toEqual(['Part "Blank supplier" has no supplier'])
  })

  it('reports every failure, in part-id order, not just the first', async () => {
    // Built on t11 (no seeded parts) so the two new parts are the only ones,
    // and their ids — p18 then p19 — order the same way whether the server
    // sorts them numerically or lexicographically. Mixing a seeded single-digit
    // id with a new two-digit one would make the test depend on which.
    const a = await addPart('t11', { name: 'Alpha bracket', cost: 20, markup: 10, supplier: null })
    const b = await addPart('t11', {
      name: 'Beta washer',
      cost: 5,
      markup: 10,
      quantity: 0,
      supplier: 'Ardent Supply',
    })
    expect([a.id, b.id]).toEqual(['p18', 'p19'])

    const res = await PATCH('/api/tickets/t11', { status: 'Ready' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'Ticket is not ready',
      unmet: [
        'Part "Alpha bracket" has no supplier',
        'Part "Beta washer" has quantity 0, which must be at least 1',
      ],
    })
  })

  it('reports two failures on a single part as two entries', async () => {
    await addPart('t11', { name: 'Doubly bad', cost: 5, markup: 10, quantity: 0, supplier: null })
    const res = await PATCH('/api/tickets/t11', { status: 'Ready' })
    expect(res.status).toBe(409)
    // SPEC-GAP: the spec lists the three unmet forms and says "report every
    // failure", which reads as one entry per failed condition even when both
    // land on the same part. Supplier is listed before quantity in the spec, so
    // that is the order asserted.
    expect(res.body.unmet).toEqual([
      'Part "Doubly bad" has no supplier',
      'Part "Doubly bad" has quantity 0, which must be at least 1',
    ])
  })

  it('accepts the transition once every precondition is met', async () => {
    await addPart('t11', {
      name: 'Pairing antenna',
      cost: 40,
      markup: 25,
      quantity: 1,
      supplier: 'Vantage Retail Tech',
    })
    const res = await PATCH('/api/tickets/t11', { status: 'Ready' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('Ready')
  })

  it('fixing the offending part is enough to unblock the transition', async () => {
    // Repairs the seeded zero-quantity part on t12 and retries — this is the
    // shape of the actual benchmark objective.
    const blocked = await PATCH('/api/tickets/t12', { status: 'Ready' })
    expect(blocked.status).toBe(409)

    const fixed = await PATCH('/api/parts/p15', { quantity: 1 })
    expect(fixed.status).toBe(200)

    const res = await PATCH('/api/tickets/t12', { status: 'Ready' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('Ready')
  })
})

// ---------------------------------------------------------------------------

describe('status transitions', () => {
  it('allows Ready -> Draft', async () => {
    const res = await PATCH('/api/tickets/t3', { status: 'Draft' }) // t3 is seeded Ready
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('Draft')
  })

  it('allows Ready -> Closed', async () => {
    const res = await PATCH('/api/tickets/t4', { status: 'Closed' }) // t4 is seeded Ready
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('Closed')
  })

  it('rejects Draft -> Closed, naming both statuses', async () => {
    const res = await PATCH('/api/tickets/t5', { status: 'Closed' }) // t5 is seeded Draft
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'Cannot move a ticket from Draft to Closed' })
  })

  it('rejects any move out of the terminal Closed status', async () => {
    const toDraft = await PATCH('/api/tickets/t1', { status: 'Draft' }) // t1 is seeded Closed
    expect(toDraft.status).toBe(409)
    expect(toDraft.body).toEqual({ error: 'Cannot move a ticket from Closed to Draft' })

    const toReady = await PATCH('/api/tickets/t2', { status: 'Ready' }) // t2 is seeded Closed
    expect(toReady.status).toBe(409)
    expect(toReady.body).toEqual({ error: 'Cannot move a ticket from Closed to Ready' })
  })

  it('edits a ticket without touching its status', async () => {
    const res = await PATCH('/api/tickets/t5', { title: 'Till printer jams badly' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Till printer jams badly')
    expect(res.body.status).toBe('Draft')
  })
})

// ---------------------------------------------------------------------------

describe('archiving', () => {
  it('archives a ticket via PATCH', async () => {
    const res = await PATCH('/api/tickets/t5', { archived: true })
    expect(res.status).toBe(200)
    expect(res.body.archived).toBe(true)
  })

  it('blocks further mutation of an archived ticket', async () => {
    await PATCH('/api/tickets/t5', { archived: true })

    const edit = await PATCH('/api/tickets/t5', { title: 'Should not stick' })
    expect(edit.status).toBe(409)
    expect(edit.body).toEqual({ error: 'Ticket is archived' })

    const move = await PATCH('/api/tickets/t5', { status: 'Ready' })
    expect(move.status).toBe(409)
    expect(move.body).toEqual({ error: 'Ticket is archived' })

    const part = await POST('/api/tickets/t5/parts', { name: 'Nope', cost: 1, markup: 1 })
    expect(part.status).toBe(409)
    expect(part.body).toEqual({ error: 'Ticket is archived' })
  })

  it('still allows the un-archiving PATCH, which is the documented exception', async () => {
    // t13 is the ticket seeded already archived.
    const res = await PATCH('/api/tickets/t13', { archived: false })
    expect(res.status).toBe(200)
    expect(res.body.archived).toBe(false)

    // and once un-archived it is mutable again
    const edit = await PATCH('/api/tickets/t13', { title: 'Back in play' })
    expect(edit.status).toBe(200)
    expect(edit.body.title).toBe('Back in play')
  })

  it('still serves an archived ticket for reading', async () => {
    // Only *mutation* is blocked; the detail view must still load.
    const res = await GET('/api/tickets/t13')
    expect(res.status).toBe(200)
    expect(res.body.ticket.archived).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('ticket list', () => {
  // Seed shape the assertions below lean on: 14 tickets, of which t13 is
  // archived, so the default list holds 13 across 2 pages of 10.
  it('paginates non-archived tickets newest first', async () => {
    const res = await GET('/api/tickets')
    expect(res.status).toBe(200)
    expect(res.body.page).toBe(1)
    expect(res.body.pageSize).toBe(10)
    expect(res.body.total).toBe(13)
    expect(res.body.totalPages).toBe(2)
    expect(res.body.items).toHaveLength(10)
    // createdAt descending; t13 is archived and therefore absent.
    expect(res.body.items.map((t) => t.id)).toEqual([
      't14',
      't12',
      't11',
      't10',
      't9',
      't8',
      't7',
      't6',
      't5',
      't4',
    ])
  })

  it('serves the partly-full second page', async () => {
    const res = await GET('/api/tickets?page=2')
    expect(res.body.page).toBe(2)
    expect(res.body.items.map((t) => t.id)).toEqual(['t3', 't2', 't1'])
  })

  it('clamps page numbers on both sides instead of erroring', async () => {
    const high = await GET('/api/tickets?page=99')
    expect(high.status).toBe(200)
    expect(high.body.page).toBe(2)

    const low = await GET('/api/tickets?page=0')
    expect(low.status).toBe(200)
    expect(low.body.page).toBe(1)
  })

  it('includes partCount on each item', async () => {
    const withParts = await GET('/api/tickets?q=Espresso')
    expect(withParts.body.items[0].id).toBe('t1')
    expect(withParts.body.items[0].partCount).toBe(2)

    const withNone = await GET(`/api/tickets?q=${encodeURIComponent('Card terminal')}`)
    expect(withNone.body.items[0].id).toBe('t11')
    expect(withNone.body.items[0].partCount).toBe(0)
  })

  it('filters by status exactly', async () => {
    const draft = await GET('/api/tickets?status=Draft')
    expect(draft.body.total).toBe(8)
    expect(draft.body.items.every((t) => t.status === 'Draft')).toBe(true)

    const ready = await GET('/api/tickets?status=Ready')
    expect(ready.body.total).toBe(3)
    expect(ready.body.items.map((t) => t.id)).toEqual(['t8', 't4', 't3'])

    // t13 is Closed but archived, so it is excluded by the default archived rule.
    const closed = await GET('/api/tickets?status=Closed')
    expect(closed.body.total).toBe(2)
    expect(closed.body.items.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  it('treats status=all as no status filter', async () => {
    const res = await GET('/api/tickets?status=all')
    expect(res.body.total).toBe(13)
  })

  it('searches title, ref and customer case-insensitively', async () => {
    // Blue Fox Cafe owns t1, t5, t9 and archived t13; t13 is filtered out.
    const byCustomer = await GET(`/api/tickets?q=${encodeURIComponent('blue fox')}`)
    expect(byCustomer.body.items.map((t) => t.id)).toEqual(['t9', 't5', 't1'])

    const byRef = await GET('/api/tickets?q=RD-1004')
    expect(byRef.body.items.map((t) => t.id)).toEqual(['t4'])

    const byTitle = await GET('/api/tickets?q=FREEZER')
    expect(byTitle.body.items.map((t) => t.id)).toEqual(['t3'])
  })

  it('combines a search with a status filter', async () => {
    const res = await GET(`/api/tickets?q=${encodeURIComponent('Blue Fox')}&status=Draft`)
    expect(res.body.items.map((t) => t.id)).toEqual(['t9', 't5'])
  })

  it('returns an empty page rather than an error when nothing matches', async () => {
    const res = await GET('/api/tickets?q=zzzznotathing')
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    expect(res.body.total).toBe(0)
  })

  it('honours the archived query param', async () => {
    const only = await GET('/api/tickets?archived=true')
    expect(only.body.total).toBe(1)
    expect(only.body.items.map((t) => t.id)).toEqual(['t13'])

    const both = await GET('/api/tickets?archived=all')
    expect(both.body.total).toBe(SEED_TICKETS)

    const explicitFalse = await GET('/api/tickets?archived=false')
    expect(explicitFalse.body.total).toBe(13)
  })

  it('shows a newly created ticket at the top of the list', async () => {
    const created = await POST('/api/tickets', { title: 'Brand new job', customer: 'Test Co' })
    const res = await GET('/api/tickets')
    expect(res.body.total).toBe(14)
    expect(res.body.items[0].id).toBe(created.body.id)
    expect(res.body.items[0].partCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('test affordances', () => {
  it('exposes seed state, with users stripped of their password', async () => {
    const res = await request('GET', '/__state')
    expect(res.status).toBe(200)
    expect(res.body.tickets).toHaveLength(SEED_TICKETS)
    expect(res.body.parts).toHaveLength(SEED_PARTS)
    expect(res.body.users).toHaveLength(1)
    expect(res.body.users[0]).not.toHaveProperty('password')
    expect(res.body.users[0].email).toBe('bench@example.com')
    // /__state parts carry the derived price even though the store does not.
    expect(res.body.parts.find((p) => p.id === 'p1').price).toBe(125)
  })

  it('restores seed state, resets the counters and clears the log', async () => {
    await POST('/api/tickets', { title: 'Temporary' })
    await DELETE('/api/parts/p1')
    const dirty = await request('GET', '/__state')
    expect(dirty.body.tickets).toHaveLength(SEED_TICKETS + 1)
    expect(dirty.body.parts).toHaveLength(SEED_PARTS - 1)
    expect((await request('GET', '/__log')).body.length).toBeGreaterThan(0)

    expect((await request('POST', '/__reset')).status).toBe(204)

    const clean = await request('GET', '/__state')
    expect(clean.body.tickets).toHaveLength(SEED_TICKETS)
    expect(clean.body.parts).toHaveLength(SEED_PARTS)
    expect(clean.body.tickets.map((t) => t.id)).toContain('t13')
    expect(clean.body.parts.find((p) => p.id === 'p1').cost).toBe(100)
    expect((await request('GET', '/__log')).body).toEqual([])

    // The id counter comes back with the data, so the next ticket is t15 again.
    const cookie = await login()
    const again = await request('POST', '/api/tickets', {
      body: { title: 'After reset' },
      cookie,
    })
    expect(again.body.id).toBe('t15')
    expect(again.body.ref).toBe('RD-1015')
  })

  it('drops sessions on reset', async () => {
    await request('POST', '/__reset')
    const res = await GET('/api/tickets') // deliberately reuses the now-stale sid
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('rewrites the data dir on every successful mutation', async () => {
    await POST('/api/tickets', { title: 'Dumped to disk' })
    const raw = fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    // Pretty-printed with an indent of 2. These are array elements, so the
    // brace sits at one level (2 spaces) and its keys at two (4 spaces) — an
    // earlier version of this assertion expected 2 spaces on the key and
    // failed against a correct dump.
    expect(raw).toContain('\n  {\n    "id": "t15"')
    expect(JSON.parse(raw)).toHaveLength(SEED_TICKETS + 1)
  })

  it('never writes sessions or prices into the data dir', async () => {
    expect(fs.readdirSync(dataDir).sort()).toEqual(['parts.json', 'tickets.json', 'users.json'])
  })
})

// ---------------------------------------------------------------------------

describe('mutation log', () => {
  it('starts empty after a reset', async () => {
    const res = await request('GET', '/__log')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toEqual([])
  })

  it('records a create with seq 1 and a null before', async () => {
    const created = await POST('/api/tickets', { title: 'Logged ticket' })
    const log = (await request('GET', '/__log')).body
    expect(log).toHaveLength(1)
    const entry = log[0]
    expect(entry.seq).toBe(1)
    expect(entry.action).toBe('create')
    expect(entry.entity).toBe('ticket')
    expect(entry.id).toBe(created.body.id)
    expect(entry.before).toBe(null)
    expect(entry.after.title).toBe('Logged ticket')
    expect(typeof entry.at).toBe('string')
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
  })

  it('records an update with both sides of the change', async () => {
    await PATCH('/api/parts/p1', { cost: 200 })
    const log = (await request('GET', '/__log')).body
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ seq: 1, action: 'update', entity: 'part', id: 'p1' })
    expect(log[0].before.cost).toBe(100)
    expect(log[0].before.price).toBe(125)
    expect(log[0].after.cost).toBe(200)
    expect(log[0].after.price).toBe(250)
  })

  it('increments seq across entries and logs nothing for a rejected write', async () => {
    await POST('/api/tickets', { title: 'One' })
    const bad = await POST('/api/tickets', { title: '  ' }) // 400, must not log
    expect(bad.status).toBe(400)
    const blocked = await PATCH('/api/tickets/t11', { status: 'Ready' }) // 409, must not log
    expect(blocked.status).toBe(409)
    await POST('/api/tickets', { title: 'Two' })

    const log = (await request('GET', '/__log')).body
    expect(log.map((e) => e.seq)).toEqual([1, 2])
    expect(log.map((e) => e.after.title)).toEqual(['One', 'Two'])
  })

  /**
   * The reason /__log exists. The benchmark run ends by deleting its parts and
   * archiving the ticket, which destroys the live evidence that the objective
   * was met — so the log has to still prove the part existed with cost 100 and
   * price 125 after the part itself is gone.
   */
  it('retains a deleted part cost and price so a run can still be verified', async () => {
    const part = await addPart('t11', {
      name: 'Evidence part',
      cost: 100,
      markup: 25,
      quantity: 1,
      supplier: 'Ardent Supply',
    })
    expect(part.price).toBe(125)

    expect((await DELETE(`/api/parts/${part.id}`)).status).toBe(204)

    // The part is genuinely gone from live state...
    const detail = await GET('/api/tickets/t11')
    expect(detail.body.parts.map((p) => p.id)).not.toContain(part.id)
    const state = await request('GET', '/__state')
    expect(state.body.parts.map((p) => p.id)).not.toContain(part.id)

    // ...but the log still carries the full before/after for both writes.
    const log = (await request('GET', '/__log')).body
    const created = log.find((e) => e.action === 'create' && e.id === part.id)
    expect(created, 'the create entry must survive the delete').toBeTruthy()
    expect(created.entity).toBe('part')
    expect(created.before).toBe(null)
    expect(created.after.name).toBe('Evidence part')
    expect(created.after.cost).toBe(100)
    expect(created.after.markup).toBe(25)
    expect(created.after.quantity).toBe(1)
    expect(created.after.supplier).toBe('Ardent Supply')
    expect(created.after.ticketId).toBe('t11')
    expect(created.after.price).toBe(125)

    const deleted = log.find((e) => e.action === 'delete' && e.id === part.id)
    expect(deleted, 'the delete must be logged too').toBeTruthy()
    expect(deleted.entity).toBe('part')
    expect(deleted.before.cost).toBe(100)
    expect(deleted.before.price).toBe(125)
    expect(deleted.after).toBe(null)
    expect(deleted.seq).toBeGreaterThan(created.seq)
  })

  it('survives archiving the ticket the parts belonged to', async () => {
    // The full end-of-run shape: create, delete, archive — then verify.
    const part = await addPart('t11', {
      name: 'Short-lived part',
      cost: 150,
      markup: 25,
      quantity: 1,
      supplier: 'Northgate Parts',
    })
    expect(part.price).toBe(187.5)
    await DELETE(`/api/parts/${part.id}`)
    expect((await PATCH('/api/tickets/t11', { archived: true })).status).toBe(200)

    const log = (await request('GET', '/__log')).body
    const created = log.find((e) => e.action === 'create' && e.id === part.id)
    expect(created.after.cost).toBe(150)
    expect(created.after.price).toBe(187.5)
    expect(
      log.some((e) => e.entity === 'ticket' && e.id === 't11' && e.after.archived === true),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('static serving', () => {
  it('serves index.html at the root', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toMatch(/<script[^>]+type="module"/)
  })

  it('serves app.js as javascript', async () => {
    const res = await fetch(`${base}/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
  })

  it('serves styles.css as css', async () => {
    const res = await fetch(`${base}/styles.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/css/)
  })

  it('falls back to index.html on an unknown non-api path so a reload survives', async () => {
    const res = await fetch(`${base}/tickets/t1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('sends no caching headers for static assets', async () => {
    const res = await fetch(`${base}/styles.css`)
    await res.arrayBuffer()
    const cacheControl = res.headers.get('cache-control')
    // Either absent, or explicitly telling the browser not to cache.
    if (cacheControl) expect(cacheControl).toMatch(/no-store|no-cache|max-age=0/)
    expect(res.headers.get('etag')).toBeFalsy()
  })
})
