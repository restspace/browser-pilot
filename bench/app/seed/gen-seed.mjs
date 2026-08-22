/**
 * Regenerates seed/*.json deterministically.
 *
 * The seed is committed, so this script is not run at boot — it exists so the
 * fixture can be regenerated and reviewed as a diff rather than hand-edited.
 * Everything here is fixed: no Math.random, no new Date(). Change the tables
 * below and re-run with `node bench/app/seed/gen-seed.mjs`.
 *
 * Sizing rationale: 14 tickets against a page size of 10 gives a second page
 * that is partly full, so pagination is exercised without a run needing to
 * page through many screens. Statuses are spread so every filter value returns
 * a non-empty result, and one ticket is archived so the archived filter has
 * something to find.
 */
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const users = [
  { id: 'u1', email: 'bench@example.com', password: 'bench-pass-1234', name: 'Bench User' },
]

// [title, customer, status, archived, day, parts]
// parts: [name, cost, markup, quantity, supplier]
const TICKETS = [
  ['Espresso machine will not heat', 'Blue Fox Cafe', 'Closed', false, 5, [
    ['Thermostat', 100, 25, 1, 'Ardent Supply'],
    ['Boiler gasket', 12.5, 40, 2, 'Ardent Supply'],
  ]],
  ['Dough mixer trips the breaker', 'Marlow Bakery', 'Closed', false, 6, [
    ['Motor capacitor', 34, 30, 1, 'Northgate Parts'],
  ]],
  ['Chest freezer icing up', 'Pinehurst Grocers', 'Ready', false, 8, [
    ['Door seal', 48, 25, 1, 'Coldline Spares'],
    ['Defrost timer', 62.4, 20, 1, 'Coldline Spares'],
  ]],
  ['Dishwasher drains slowly', 'The Anchor Inn', 'Ready', false, 9, [
    ['Drain pump', 88, 35, 1, 'Northgate Parts'],
  ]],
  ['Till printer jams on receipts', 'Blue Fox Cafe', 'Draft', false, 12, [
    ['Print head', 145, 15, 1, 'Vantage Retail Tech'],
    ['Feed roller', 9.75, 60, 3, null],
  ]],
  ['Walk-in fridge alarm keeps sounding', 'Pinehurst Grocers', 'Draft', false, 13, [
    ['Temperature probe', 27, 45, 2, 'Coldline Spares'],
  ]],
  ['Extractor fan noisy at full speed', 'Marlow Bakery', 'Draft', false, 14, [
    ['Fan bearing set', 41.2, 30, 1, 'Northgate Parts'],
  ]],
  ['Glass washer leaves residue', 'The Anchor Inn', 'Ready', false, 15, [
    ['Rinse aid dosing pump', 76, 25, 1, 'Ardent Supply'],
  ]],
  ['Coffee grinder inconsistent grind', 'Blue Fox Cafe', 'Draft', false, 16, [
    ['Burr set', 210, 20, 1, 'Vantage Retail Tech'],
  ]],
  ['Proving cabinet humidity too low', 'Marlow Bakery', 'Draft', false, 19, [
    ['Humidistat', 58, 25, 1, null],
  ]],
  ['Card terminal will not pair', 'Pinehurst Grocers', 'Draft', false, 20, []],
  ['Ice machine producing hollow cubes', 'The Anchor Inn', 'Draft', false, 21, [
    ['Water inlet valve', 33.5, 40, 1, 'Coldline Spares'],
    ['Float switch', 18, 50, 0, 'Coldline Spares'],
  ]],
  ['Bain-marie thermostat drifting', 'Blue Fox Cafe', 'Closed', true, 22, [
    ['Control thermostat', 95, 25, 1, 'Ardent Supply'],
  ]],
  ['Under-counter fridge door misaligned', 'Marlow Bakery', 'Draft', false, 23, [
    ['Hinge kit', 22.8, 35, 1, 'Northgate Parts'],
  ]],
]

const at = (day, hour, minute) =>
  `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`

const tickets = []
const parts = []

TICKETS.forEach(([title, customer, status, archived, day, rows], i) => {
  const id = `t${i + 1}`
  tickets.push({
    id,
    ref: `RD-${1001 + i}`,
    title,
    customer,
    status,
    archived,
    createdAt: at(day, 9, 0),
  })
  rows.forEach(([name, cost, markup, quantity, supplier], j) => {
    parts.push({
      id: `p${parts.length + 1}`,
      ticketId: id,
      name,
      cost,
      markup,
      quantity,
      supplier,
      createdAt: at(day, 9, 10 + j * 5),
    })
  })
})

const write = (file, value) =>
  fs.writeFileSync(path.join(here, file), `${JSON.stringify(value, null, 2)}\n`)

write('users.json', users)
write('tickets.json', tickets)
write('parts.json', parts)

console.log(`seed: ${users.length} users, ${tickets.length} tickets, ${parts.length} parts`)
