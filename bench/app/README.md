# repair-desk

A neutral benchmark target app: a small workshop repair-ticket tool. It exists
so the sitelooper/agent-browser benchmark (`bench/README.md`) has a target
a reader can actually reproduce. The existing benchmark task ran only against
a private app, which nobody outside this repo can stand up — that's an open
gap the benchmark itself calls out ("Single application" / "a neutral,
publicly available target is required before publication"). This app closes
it.

## Running it

Zero dependencies — Node stdlib only, no npm install:

```sh
node bench/app/server.mjs
```

Listens on `127.0.0.1:4180` by default (override with `PORT`). On startup it
logs:

```
repair-desk listening on http://127.0.0.1:4180
```

Open that URL in a browser. `--fresh` on the command line reloads from
`seed/` before starting.

## Login

Credentials are committed in `seed/users.json` so a reader can reproduce a
run without provisioning anything:

- email: `bench@example.com`
- password: `bench-pass-1234`

**This app must never be exposed to a network.** The password is plaintext,
sessions are in-memory only, and there is no rate limiting or transport
security — it is meant to run on `127.0.0.1` for the duration of a benchmark
run and nothing else.

## Domain

A workshop repair desk. **Tickets** are repair jobs; each ticket owns zero or
more **parts** (components used on the job). A ticket has a status of
`Draft`, `Ready`, or `Closed`, plus an `archived` flag. A part has a cost, a
markup percentage, a quantity, and an optional supplier.

The app computes each part's **price** server-side from its cost and markup.
The price is never stored — it's derived on every read — and the frontend
only ever displays what the server sends; it never recomputes it itself.

Moving a ticket to `Ready` is rejected unless preconditions on its parts are
met. The rejection response names exactly what's unmet, and the UI renders
that text visibly, so the rules are discoverable by reading the page rather
than by reading the server code.

## Resetting state

```
POST /__reset
```

Reloads the store from `seed/`, clears the mutation log, and drops all
sessions — instantly, in-process. There's no filesystem snapshot/restore step
here: this app keeps its whole state in memory and dumps to `data/` on every
write, so a reset is just "reload from seed and respond." That's a deliberate
simplification against `bench/reset.mjs`, which the *other* benchmark target
needs specifically because it sits on a real database (mongod) that can't be
reset in-process and has to be stopped, copied, and restarted at the
filesystem level instead. Nothing like that is needed here.

## Simulated UI drift

```
GET /__drift?mode=labels|ids|both
GET /__drift?mode=           -> clears it
GET /__drift                 -> reports the current mode
```

Unauthenticated, like `/__reset`, and deliberately not a data mutation: while
a mode is set the server rewrites the static `.js`/`.html` it serves on the
fly, so the *same* app presents renamed controls without a single file on disk
changing. That is what makes a repair run reproducible — reset the drift and
the app is byte-for-byte what the recording saw.

| mode | what it renames | what it exercises |
|---|---|---|
| `labels` | visible wording: "Add part" -> "Attach part", "New ticket" -> "Create ticket", "Mark ready" -> "Set ready" | a chain whose primary is a role/text locator. Invisible to a recording whose primaries are test ids. |
| `ids` | three `data-testid` values: `add-part` -> `part-attach`, `new-ticket` -> `ticket-new`, `modal-save` -> `dialog-save` | the test-id primary misses, the role fallback resolves: fallthrough -> drift ticket -> `promote-fallback` (no model). |
| `both` | `ids` + `labels` together | testid primary *and* role/label fallbacks gone at once; only the recorded css path is left, so triage sends it to `patch-segment` (a model re-deriving the locator on the live page) or to re-record. |

`ids` renames whole `data-testid="..."` attributes rather than bare words, so
`id="modal-save"` and the `$('#modal-save')` the app looks it up with are left
intact and the app keeps *working* while being harder to *find*. Drift is
server state, not store state: `/__reset` does not clear it, and it does not
survive a server restart.

## Verification endpoints

Two read-only endpoints exist for the harness, not for the agent under test
(they're not linked from any page):

```
GET /__state   -> { tickets, parts, users }   (passwords omitted)
GET /__log     -> the mutation log, an array
```

`/__log` is the important one, and it exists for a specific reason: the
benchmark task this app serves ends by having the agent delete the parts it
created and archive the ticket — which destroys the very records that would
otherwise prove the earlier objectives happened. `/__state` at that point
shows nothing, because there's genuinely nothing left. The mutation log is
append-only and survives everything except an explicit `/__reset`, so it's
the only way to confirm, after a run has cleaned up after itself, that a part
really was created with cost 100 and priced at 125.00, that its cost was
later changed to 150, and that it was subsequently deleted rather than never
having existed. Each entry records the action, the entity, and the full
before/after state (including computed price for parts) — without it,
objectives that get cleaned up by design would be unverifiable.

## Layout

```
bench/app/
  SPEC.md      the build spec (authoritative contract)
  server.mjs   http server, routing, static file serving
  store.mjs    in-memory store, seed load, dump-on-write, mutation log
  api.mjs      API route handlers
  seed/        committed seed data (users.json, tickets.json, parts.json)
  data/        runtime dump target (gitignored)
  public/      index.html, app.js, styles.css
  test/        vitest suite
```

See `SPEC.md` for the full API surface and business rules.
