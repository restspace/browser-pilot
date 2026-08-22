# repair-desk: neutral benchmark target app — BUILD SPEC

This is the authoritative contract. Backend, frontend and seed data are built in
parallel against it. If something here is ambiguous, pick the simplest reading
and add a `SPEC-GAP:` comment at the point of use rather than inventing a
divergent contract.

## Purpose (read this — it explains constraints that look arbitrary)

This app is the target of a published benchmark comparing two browser-automation
tools. Consequences:

- **Zero dependencies.** node stdlib only. No express, no bundler, no npm install.
  A reader must be able to `node bench/app/server.mjs` on a clean checkout.
- **Deterministic.** Same seed + same actions => same visible output. No
  `Math.random()` in anything the user can see, no relative timestamps ("2 hours
  ago") in the UI. IDs are assigned from a counter, not randomly.
- **Typical, not adversarial, and not minimal.** The DOM is the cost surface for
  one of the two tools under test, so it must look like an ordinary business web
  app: nav bar, page header, labelled form fields, help text, footer. Do not
  golf the markup to make pages small, and do not pad it to make them big. No
  canvas, no iframes, no shadow DOM, no ARIA-hostile markup.
- **Every error message the server produces must be rendered visibly in the DOM.**
  An agent discovers the business rules by reading them off the page. An error
  that only reaches the console is a bug.

## Layout

    bench/app/
      SPEC.md          this file
      server.mjs       http server, routing, static file serving, startup
      store.mjs        in-memory store, seed load, dump-on-write, mutation log
      api.mjs          API route handlers
      seed/            users.json tickets.json parts.json  (committed)
      data/            runtime dump target (gitignored)
      public/          index.html app.js styles.css
      test/app.test.mjs

## Domain

A workshop repair desk. **Tickets** (a repair job) each own **parts** (components
used in the job). A part has a cost and a markup; the app computes its price.

### price rule

    price = round2(cost * (1 + markup / 100))

`round2(n)` = `Math.round(n * 100) / 100`. Computed **server-side only**. Never
stored in the JSON files; always derived on read. The frontend renders whatever
the server sends and never recomputes it.

Formatted in the UI to exactly 2 decimals with a leading currency symbol, e.g.
`$125.00`.

## Entities

### user  (seed/users.json)

    { "id": "u1", "email": "bench@example.com", "password": "bench-pass-1234", "name": "Bench User" }

Plaintext password is intentional: these credentials are committed so a reader
can reproduce a run. This app must never be exposed to a network.

### ticket  (seed/tickets.json)

    { "id": "t1", "ref": "RD-1001", "title": "Espresso machine will not heat",
      "customer": "Blue Fox Cafe", "status": "Draft", "archived": false,
      "createdAt": "2026-01-05T09:00:00.000Z" }

- `status`: one of `Draft`, `Ready`, `Closed`.
- `ref`: `RD-` + a counter starting at 1001, assigned on create, never reused.
- `id`: `t` + counter.

### part  (seed/parts.json)

    { "id": "p1", "ticketId": "t1", "name": "Thermostat", "cost": 100,
      "markup": 25, "quantity": 1, "supplier": "Ardent Supply",
      "createdAt": "2026-01-05T09:10:00.000Z" }

- `cost`, `markup`, `quantity`: numbers. `supplier`: string or `null`.
- `id`: `p` + counter.

## Business rules

### status transitions

Allowed: `Draft -> Ready`, `Ready -> Draft`, `Ready -> Closed`.
`Closed` is terminal. Any other transition => 409 with
`{ "error": "Cannot move a ticket from X to Y" }`.

### the Ready precondition  (the discovery objective — get this exactly right)

Moving a ticket to `Ready` is rejected unless ALL hold:

1. the ticket has at least one part
2. every part has a non-empty `supplier`
3. every part has `quantity >= 1`

On rejection: **409** with

    { "error": "Ticket is not ready", "unmet": ["...", "..."] }

`unmet` strings, in this order and wording (the `<name>` is wrapped in literal
double-quote characters):

- no parts: `A ticket needs at least one part before it can be marked Ready`
- missing supplier: `Part "<name>" has no supplier`
- bad quantity: `Part "<name>" has quantity <q>, which must be at least 1`

Check parts in `id` order; report every failure, not just the first.

The frontend must render `error` and every `unmet` line as visible text.

### archiving

`archived` is set via PATCH. An archived ticket is hidden from the default list
(see `archived` query param) and rejects all further mutation with 409
`{ "error": "Ticket is archived" }` — except a PATCH that sets `archived: false`.

### validation

- ticket create: `title` required, non-empty after trim; `customer` optional (default `""`).
- part create: `name` required non-empty; `cost` and `markup` required, finite, `>= 0`;
  `quantity` optional integer `>= 0`, default `1`; `supplier` optional, default `null`.
- Any validation failure => **400** `{ "error": "<human sentence naming the field>" }`.
- Unknown id => **404** `{ "error": "No such ticket: <id>" }` / `No such part: <id>`.
- Numbers arriving as strings ("100") are coerced with `Number()`; `NaN` is a 400.

## HTTP API

JSON in, JSON out. `Content-Type: application/json`. Session via an
`sid` cookie (`HttpOnly`, `SameSite=Lax`, no `Secure` — this is plain http).
Sessions live in memory only and are NOT persisted to data/.

Every route under `/api/` except `/api/login` requires a valid session; without
one respond **401** `{ "error": "Not signed in" }`.

| method | path | body | success |
|---|---|---|---|
| POST | `/api/login` | `{email,password}` | 200 `{user:{id,email,name}}` + Set-Cookie |
| POST | `/api/logout` | — | 204, clears cookie |
| GET | `/api/me` | — | 200 `{user}` |
| GET | `/api/tickets` | query: `status`, `q`, `page`, `archived` | 200 `{items,page,pageSize,total,totalPages}` |
| POST | `/api/tickets` | `{title,customer}` | 201 ticket |
| GET | `/api/tickets/:id` | — | 200 `{ticket, parts:[partWithPrice]}` |
| PATCH | `/api/tickets/:id` | `{title?,customer?,status?,archived?}` | 200 ticket |
| POST | `/api/tickets/:id/parts` | `{name,cost,markup,quantity?,supplier?}` | 201 partWithPrice |
| PATCH | `/api/parts/:id` | `{name?,cost?,markup?,quantity?,supplier?}` | 200 partWithPrice |
| DELETE | `/api/parts/:id` | — | 204 |

`GET /api/tickets` detail:

- `pageSize` = 10. `page` is 1-based, default 1, clamped to `[1, totalPages]`.
- `status` filters exactly; absent or `all` means no status filter.
- `q` is a case-insensitive substring match over `title`, `ref` and `customer`.
- `archived`: absent/`false` => only non-archived; `true` => only archived; `all` => both.
- sorted by `createdAt` descending, tie-broken by `id` descending (newest first).
- each item is the ticket plus `partCount`.

`partWithPrice` = the stored part plus a computed `price`.

## Test affordances

Not linked from any page and not discoverable through the UI. They exist for the
harness, not for the agent under test.

| method | path | effect |
|---|---|---|
| POST | `/__reset` | reload from `seed/`, clear the mutation log, drop all sessions, rewrite `data/`. 204 |
| GET | `/__state` | `{tickets, parts, users}` — users **without** `password`. Parts include `price`. |
| GET | `/__log` | the mutation log, an array |

### mutation log

Append-only, in memory, reset only by `/__reset`. One entry per successful write:

    { seq, at, action, entity, id, before, after }

- `seq` starts at 1 and increments.
- `at` is an ISO timestamp.
- `action` is one of `create`, `update`, `delete`.
- `entity` is `ticket` or `part`.
- `before` is `null` for creates; `after` is `null` for deletes.
- For parts, `before`/`after` include the computed `price`.

**Why this exists:** the benchmark task ends by deleting the parts and archiving
the ticket, which destroys the evidence that earlier objectives were met. The log
survives that, so a verifier can prove a part really was created with cost 100
and priced 125.00 even though the part no longer exists. This is the whole point
of the endpoint — do not skip fields to save space.

## Persistence

- On boot: if `data/*.json` all exist, load them. Otherwise copy `seed/` into
  memory and immediately dump to `data/`.
- On **every** successful mutation, dump the full store back to `data/*.json`
  (`users.json`, `tickets.json`, `parts.json`), pretty-printed with 2 spaces and
  a trailing newline. Synchronous writes are fine and preferred — this app is
  single-user and correctness beats throughput.
- `--fresh` CLI flag, or `POST /__reset`, reloads from `seed/`.
- The data dir is `BENCH_APP_DATA_DIR` if set, else `bench/app/data`. Tests rely
  on this to point at a temp dir.
- Never persist `price` (derived) or sessions.

## Server

- Port from `PORT`, default **4180**. Bind `127.0.0.1`.
- On listen, log exactly: `repair-desk listening on http://127.0.0.1:<port>`
- Export a `start({ port, dataDir })` returning `{ server, port, close() }` so
  tests can boot it in-process on an ephemeral port; only run automatically when
  the module is the entry point.
- Serve `public/` statically: `/` => `index.html`; correct Content-Type for
  `.html`, `.js`, `.css`, `.svg`, `.ico`. Any unknown non-`/api/` path serves
  `index.html` so client routing survives a reload.
- No caching headers on `public/` (a benchmark reader will edit and reload).

## Frontend

Plain ES modules, no framework, no build step. Loaded as
`<script type="module" src="/app.js">`.

### routing

Hash-based: `#/login`, `#/tickets`, `#/tickets/<id>`. Unknown hash => `#/tickets`.
No session => redirect to `#/login`. Reloading any URL must land on that view.

### deliberate async behaviour

After a create or delete the list/detail view refetches **after a delay** of
`window.__LIST_DELAY_MS` (default **600**, settable via a `listDelayMs` query
param on the page URL). This reproduces a real property of production SPAs —
lists that refresh a beat after the mutation — which is a documented trap in the
existing benchmark task. Do not remove it, and do not make it configurable
through the UI. While the refetch is pending, show a visible `Refreshing…`
indicator with `data-testid="refreshing"`.

### views

**Login** (`#/login`) — email + password inputs with real `<label>`s, submit
button, and an error region that shows `Email or password is not recognised` on
401.

**Ticket list** (`#/tickets`) — nav bar with app name and a Sign out button; page
header; a filter row with a status `<select>` (All / Draft / Ready / Closed), a
search `<input>`, and a "Show archived" checkbox; a "New ticket" button opening
a modal; a `<table>` of tickets (Ref, Title, Customer, Status, Parts, Created)
where the ref cell is a link to the detail view; pagination controls showing
`Page X of Y` with Previous/Next buttons.

**Ticket detail** (`#/tickets/<id>`) — breadcrumb back to the list; ticket header
with ref, title, customer, a status badge, and buttons for the legal transitions
from the current status plus an Archive button; a parts `<table>` (Name, Cost,
Markup, Qty, Supplier, Price, and per-row Edit / Delete buttons); an "Add part"
button opening a modal.

**Modals** — a real focus-trapped dialog over a backdrop, with labelled fields,
Save and Cancel, used for new ticket, add part, and edit part. Deleting a part
opens a confirm dialog naming the part. Use `<dialog>`.

**Error region** — one shared, always present in the DOM, `data-testid="error"`,
empty when there is nothing to show. On a 409 with `unmet`, render the `error`
sentence followed by a `<ul>` of the `unmet` strings.

### markup requirements

- Every interactive element gets a stable `data-testid`. Naming: `login-email`,
  `login-password`, `login-submit`, `new-ticket`, `ticket-row-<id>`,
  `status-filter`, `search`, `show-archived`, `page-prev`, `page-next`,
  `add-part`, `part-row-<id>`, `part-edit-<id>`, `part-delete-<id>`,
  `status-to-<Status>`, `archive`, `modal-save`, `modal-cancel`, `confirm-yes`,
  `confirm-no`, `error`, `refreshing`.
- Every form control has an associated `<label for>`.
- Buttons contain real text, never icon-only.
- Tables use `<thead>`/`<tbody>` with `<th scope="col">`.
- Money right-aligned; the price cell carries `data-testid="part-price-<id>"`.

### styling

`styles.css`, hand-written, a few hundred lines. An ordinary clean business UI:
system font stack, a restrained palette, a sticky nav, cards, a real table with
zebra striping, status badges in distinct colours, focus rings that are visible.
It should look like a competent internal tool. No CSS framework, no CDN.

## Tests

`test/app.test.mjs`, vitest, run by the repo's existing `npm test`. Boot the
server in-process on an ephemeral port against a temp data dir; hit it with
`fetch`.

Cover: login success + failure; auth required on a protected route; ticket
create + validation failure; part create with the price computed correctly
(cost 100 markup 25 => 125.00; cost 200 markup 25 => 250.00; cost 150 markup 25
=> 187.50); part update recomputing price; every branch of the Ready
precondition, including the exact `unmet` wording and multiple simultaneous
failures; a legal transition succeeding once preconditions are met; an illegal
transition; archive blocking mutation; list filtering, search and pagination;
`/__reset` restoring seed state; and the mutation log retaining a part's cost and
price after that part is deleted.
