/**
 * In-memory store for repair-desk, with a synchronous dump to data/ after every
 * successful mutation and an append-only mutation log.
 *
 * The whole store is small enough (tens of records) that rewriting all three
 * JSON files on every write costs nothing and removes any question of the dump
 * drifting from memory.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SEED_DIR = path.join(here, 'seed')
const DEFAULT_DATA_DIR = path.join(here, 'data')

const FILES = { users: 'users.json', tickets: 'tickets.json', parts: 'parts.json' }

export const STATUSES = ['Draft', 'Ready', 'Closed']

export const round2 = (n) => Math.round(n * 100) / 100

/** price is derived on every read and never persisted — see SPEC "price rule". */
export const priceOf = (part) => round2(part.cost * (1 + part.markup / 100))

export const withPrice = (part) => ({ ...part, price: priceOf(part) })

/**
 * Paths are resolved against this module rather than process.cwd(): the tests
 * run from the repo root and a benchmark harness may run the server from
 * anywhere, so cwd is not a reliable anchor.
 */
export function resolveDataDir(dataDir) {
  const chosen = dataDir || process.env.BENCH_APP_DATA_DIR || DEFAULT_DATA_DIR
  return path.resolve(here, chosen)
}

// Ids are `<letter><counter>`; the numeric tail is what orders them.
const idNum = (id) => {
  const n = Number(String(id).slice(1))
  return Number.isFinite(n) ? n : 0
}

const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))

const writeJson = (dir, file, value) =>
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`)

export function createStore({ dataDir, fresh = false } = {}) {
  const dir = resolveDataDir(dataDir)

  const state = { users: [], tickets: [], parts: [] }
  const log = []
  let seq = 0
  const counters = { ticket: 1, ref: 1001, part: 1 }

  const loadSeed = () => {
    state.users = readJson(SEED_DIR, FILES.users)
    state.tickets = readJson(SEED_DIR, FILES.tickets)
    state.parts = readJson(SEED_DIR, FILES.parts)
  }

  const loadData = () => {
    state.users = readJson(dir, FILES.users)
    state.tickets = readJson(dir, FILES.tickets)
    state.parts = readJson(dir, FILES.parts)
  }

  const hasData = () => Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)))

  /**
   * Counters are rebuilt from the loaded records rather than persisted, so a
   * hand-edited data dir cannot hand out an id that is already taken. Refs are
   * derived from the ref column directly because a ticket's ref and its id
   * counter are allowed to drift apart in principle.
   */
  const syncCounters = () => {
    counters.ticket = state.tickets.reduce((m, t) => Math.max(m, idNum(t.id) + 1), 1)
    counters.part = state.parts.reduce((m, p) => Math.max(m, idNum(p.id) + 1), 1)
    counters.ref = state.tickets.reduce((m, t) => {
      const n = Number(String(t.ref).replace(/^RD-/, ''))
      return Number.isFinite(n) ? Math.max(m, n + 1) : m
    }, 1001)
  }

  const dump = () => {
    fs.mkdirSync(dir, { recursive: true })
    writeJson(dir, FILES.users, state.users)
    writeJson(dir, FILES.tickets, state.tickets)
    writeJson(dir, FILES.parts, state.parts)
  }

  /**
   * Every successful write goes through here so that the log entry and the disk
   * dump can never get out of step with the in-memory change.
   *
   * `before`/`after` are already-snapshotted plain objects — for parts the
   * caller passes the priced form, because the log is the only surviving
   * evidence of a part's cost and price once the part has been deleted.
   */
  const record = (action, entity, id, before, after) => {
    seq += 1
    log.push({
      seq,
      at: new Date().toISOString(),
      action,
      entity,
      id,
      before: before ?? null,
      after: after ?? null,
    })
    dump()
  }

  const load = () => {
    if (!fresh && hasData()) {
      loadData()
      syncCounters()
      return
    }
    loadSeed()
    syncCounters()
    dump()
  }

  load()

  const findTicket = (id) => state.tickets.find((t) => t.id === id) || null
  const findPart = (id) => state.parts.find((p) => p.id === id) || null

  /** Parts of a ticket in id order — the Ready precondition reports in this order. */
  const partsFor = (ticketId) =>
    state.parts.filter((p) => p.ticketId === ticketId).sort((a, b) => idNum(a.id) - idNum(b.id))

  return {
    dir,
    state,
    log,

    users: () => state.users,
    tickets: () => state.tickets,
    parts: () => state.parts,

    findTicket,
    findPart,
    partsFor,

    findUserByEmail: (email) =>
      state.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null,
    findUserById: (id) => state.users.find((u) => u.id === id) || null,

    createTicket({ title, customer }) {
      const ticket = {
        id: `t${counters.ticket}`,
        ref: `RD-${counters.ref}`,
        title,
        customer,
        status: 'Draft',
        archived: false,
        createdAt: new Date().toISOString(),
      }
      counters.ticket += 1
      counters.ref += 1
      state.tickets.push(ticket)
      record('create', 'ticket', ticket.id, null, { ...ticket })
      return ticket
    },

    updateTicket(ticket, patch) {
      const before = { ...ticket }
      Object.assign(ticket, patch)
      record('update', 'ticket', ticket.id, before, { ...ticket })
      return ticket
    },

    createPart(ticketId, fields) {
      const part = {
        id: `p${counters.part}`,
        ticketId,
        name: fields.name,
        cost: fields.cost,
        markup: fields.markup,
        quantity: fields.quantity,
        supplier: fields.supplier,
        createdAt: new Date().toISOString(),
      }
      counters.part += 1
      state.parts.push(part)
      record('create', 'part', part.id, null, withPrice(part))
      return part
    },

    updatePart(part, patch) {
      const before = withPrice(part)
      Object.assign(part, patch)
      record('update', 'part', part.id, before, withPrice(part))
      return part
    },

    deletePart(part) {
      const before = withPrice(part)
      state.parts = state.parts.filter((p) => p.id !== part.id)
      record('delete', 'part', part.id, before, null)
    },

    /** POST /__reset: back to seed, log cleared, data/ rewritten. */
    reset() {
      loadSeed()
      syncCounters()
      log.length = 0
      seq = 0
      dump()
    },

    /** GET /__state — passwords are stripped, parts carry their derived price. */
    snapshot: () => ({
      tickets: state.tickets.map((t) => ({ ...t })),
      parts: state.parts.map(withPrice),
      users: state.users.map(({ password, ...rest }) => rest),
    }),
  }
}
