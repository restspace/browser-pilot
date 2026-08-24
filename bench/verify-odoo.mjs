/**
 * External verification of a benchmark run against Odoo's own database, over
 * the JSON-RPC API. Same contract as verify-repairdesk.mjs: success is judged
 * from the app, never from the agent's final report.
 *
 * The odoo target has no rollback (see harness TARGETS): attribution rests on
 * every created record carrying the runid in its name, and this script only
 * ever matches those exact names.
 *
 *   obj 1  customer "<runid> Bench Customer", city Benchville   res.partner
 *   obj 2  an order for that customer exists with >=1 line      sale.order
 *   obj 3  the order has exactly two lines                      sale.order.line
 *   obj 4  first line's quantity ended as 5, second as 2        sale.order.line
 *   obj 5  the order was CONFIRMED at some point                mail tracking
 *   obj 6  the order ended cancelled                            sale.order.state
 *
 * Objectives 2-4 are verified from FINAL state, so this cannot distinguish "the
 * run went 3 -> add line -> 5" from "the run typed 5 straight in". The mutation
 * ordering that the repairdesk log makes checkable is simply not recorded by
 * Odoo at line level; what is recorded is the state chatter on the order
 * (mail.tracking.value), which is what lets obj 5 survive obj 6 overwriting the
 * state to cancelled. If that query is refused, obj 5 is reported UNVERIFIABLE
 * rather than failed — an access rule change should not fail runs silently.
 */
import fs from 'node:fs'
import path from 'node:path'

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:8069/').replace(/\/$/, '')
const DB = process.env.ODOO_DB || 'bench'
const LOGIN = process.env.APP_EMAIL || 'admin'
const PASSWORD = process.env.APP_PASSWORD || 'admin'
const OUT = process.env.BENCH_OUT || 'bench/results'

const runids = process.argv.slice(2)
if (!runids.length) {
  console.error('usage: node bench/verify-odoo.mjs <runid> [runid...]')
  process.exit(2)
}

let rpcId = 0
async function rpc(service, method, args) {
  const res = await fetch(`${APP_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'call', params: { service, method, args } }),
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.data?.message || body.error.message)
  return body.result
}

const uid = await rpc('common', 'login', [DB, LOGIN, PASSWORD])
if (!uid) {
  console.error('could not authenticate to odoo — check APP_EMAIL/APP_PASSWORD/ODOO_DB')
  process.exit(2)
}
const kw = (model, method, args, kwargs = {}) =>
  rpc('object', 'execute_kw', [DB, uid, PASSWORD, model, method, args, kwargs])

const report = []
let anyFailure = false

for (const runid of runids) {
  const objectives = []
  const obj = (n, pass, detail) => {
    objectives.push({ n, pass, detail })
    if (pass !== true) anyFailure = true
  }

  const partners = await kw('res.partner', 'search_read', [[['name', '=', `${runid} Bench Customer`]]], {
    fields: ['name', 'city'],
  })
  const partner = partners[0]
  obj(1, Boolean(partner && partner.city === 'Benchville'),
    partner ? `city=${JSON.stringify(partner.city)}` : 'customer not found')

  let order = null
  let lines = []
  if (partner) {
    const orders = await kw('sale.order', 'search_read', [[['partner_id', '=', partner.id]]], {
      fields: ['name', 'state', 'amount_untaxed', 'order_line'],
    })
    // The task creates exactly one; more than one means the run thrashed, and
    // no single order can then be said to be "the" one it reports on.
    if (orders.length === 1) order = orders[0]
    obj(2, orders.length === 1 && order.order_line.length >= 1,
      `orders for customer: ${orders.length}${order ? `, lines: ${order.order_line.length}` : ''}`)
    if (order) {
      lines = await kw('sale.order.line', 'read', [order.order_line], {
        fields: ['product_id', 'product_uom_qty', 'price_unit', 'price_subtotal'],
      })
      const products = new Set(lines.map((l) => l.product_id?.[0]))
      obj(3, lines.length === 2 && products.size === 2,
        `${lines.length} lines, ${products.size} distinct products`)
      const qtys = lines.map((l) => l.product_uom_qty)
      obj(4, lines.length === 2 && qtys[0] === 5 && qtys[1] === 2, `quantities: ${qtys.join(', ')}`)
    } else {
      obj(3, false, 'no single order to check')
      obj(4, false, 'no single order to check')
    }
  } else {
    obj(2, false, 'no customer, so no order')
    obj(3, false, 'no customer, so no order')
    obj(4, false, 'no customer, so no order')
  }

  if (order) {
    // "Was confirmed" cannot be read from final state (obj 6 overwrites it), so
    // read the order's tracked state changes instead.
    let confirmed = null
    try {
      const msgs = await kw('mail.message', 'search_read',
        [[['model', '=', 'sale.order'], ['res_id', '=', order.id]]], { fields: ['tracking_value_ids'] })
      const trackIds = msgs.flatMap((m) => m.tracking_value_ids)
      if (trackIds.length) {
        const tracks = await kw('mail.tracking.value', 'read', [trackIds], {
          fields: ['field_id', 'old_value_char', 'new_value_char'],
        })
        confirmed = tracks.some((t) => /sale|order/i.test(t.new_value_char || ''))
      } else {
        confirmed = false
      }
      obj(5, confirmed, confirmed ? 'state tracking shows confirmation' : 'no confirmation in state tracking')
    } catch (err) {
      objectives.push({ n: 5, pass: 'UNVERIFIABLE', detail: `tracking query refused: ${err.message}` })
    }
    obj(6, order.state === 'cancel', `final state=${order.state}, ref=${order.name}`)
  } else {
    obj(5, false, 'no order')
    obj(6, false, 'no order')
  }

  const passed = objectives.filter((o) => o.pass === true).length
  console.log(`\n${runid}: objectives passed ${passed}/${objectives.length}`)
  for (const o of objectives) console.log(`  obj ${o.n}: ${o.pass === true ? 'PASS' : o.pass === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'FAIL'} — ${o.detail}`)
  report.push({ runid, order: order?.name ?? null, objectives, passed })
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'verify-odoo.json'), JSON.stringify(report, null, 2))
process.exitCode = anyFailure ? 1 : 0
