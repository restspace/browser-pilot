# Provenance: one ledger for everything the run itself made

Written 2026-08-28, after takes 5-8 of the v0.2 repairdesk sweep and the
fwgr6/fwod6 cloud runs. Successor to PLAN-replay-v2.md, which introduced
provenance for url-minted values; this generalises that mechanism and makes
it the ONLY way a run-scoped value reaches a replayable artifact.

## The evidence this plan rests on

Seven defects in six takes, all one family — a value or a procedure from the
RECORDING run surviving into a replay:

| where it leaked | symptom |
| --- | --- |
| read-back pinned to `tr:nth-of-type(1)` | replay published seed ref RD-1014 |
| runid inside a `scoped` anchor, un-slotted | anchor matched nothing, fell to positional |
| dashboard uid inside a skill TEMPLATE (62×) | n2 edited n1's dashboard |
| a sibling step's skill adopted by re-pin | two steps ran one read-only skill, mutated nothing, reported success |
| positional fallback kept after an anchor was dropped | published RD-1014 again, tier A, zero turns |
| `t15` below the 4-char minting floor | literal `#/tickets/t15` in six flow steps |
| session dir survived a restart | flow contained the task twice; both replays executed it twice |

Each was found by reading a drift file after a two-hour sweep, and each fix
was correct and narrow. The rate of discovery is not falling, and twice a fix
was incomplete in the same way: the rule it enforced already existed in two
or three other places (`flow.ts:175`, `flow.ts:466`, `freshUrlIds`), and
`canAdoptPin` guards the re-pin path while the export path grew the identical
defect independently. That is the signature of an invariant with no home.

## The invariant

> No value, identifier, or procedure belonging to the recording run may appear
> in a replayable artifact except as a binding that the next run re-resolves
> from its own evidence.

Artifacts: skill templates, step args, locator chains, expectations, report
templates, flow instructions, flow params, preconditions.

## Why the current design leaks

Run-scoped knowledge is threaded as **strings**, recovered by **text
matching**, gated by **shape heuristics** (`identifierLike`, `isIdLike`, a
minimum length, "does it occur in the instruction"). Three consequences:

1. Recognition is positional in the pipeline. `discoverSlots` can only slot
   what it can see in THIS instruction's text, so a uid minted two
   instructions ago is app furniture.
2. The gates are duplicated per call site, so a fix lands in one of three.
3. Substitution is post-hoc regex over already-built artifacts, which is why
   `replaceToken` needed guards against rewriting the inside of identifiers
   and of markers it had already placed (fwod5 shipped
   `{{02-create.o_{{01-open.url.q.view_type}}_view_o_group_tabl}}`).

## Mechanism: the RunLedger

One session-scoped registry. Every run-scoped value is entered ONCE, with
typed provenance saying how a later run re-derives it.

```ts
type Binding =
  | { from: 'var'; name: string }                              // caller declared it
  | { from: 'input' }                                          // the run typed it
  | { from: 'url'; step: StepRef; label: string }              // p1 | h0 | q.action
  | { from: 'output'; step: StepRef; name: string; path?: string } // report value / JSON leaf
  | { from: 'readback'; step: StepRef; spec: ElementSpec };    // re-read from the page

interface LedgerEntry {
  value: string;          // what it was on the recording run — EXAMPLE ONLY
  marker: string;         // {{v3}} / {{02-create.ref}}
  binding: Binding;
  kind: 'identifier' | 'name' | 'text';
  known: boolean;         // caller-vouched => usable as record identity
  firstSeen: { instruction: number; step: number };
}
```

`RunLedger` exposes exactly one predicate and one rewriter:

- `runValuesIn(text): LedgerEntry[]` — the single place any component asks
  "does this string carry something this run made?"
- `slot(text): SlottedString` — returns the text with markers substituted,
  boundary rules and marker-safety applied once, in one implementation.

Every producer consults it: `discoverSlots`, `buildFlow`'s referencizing,
`identityHints`, `urlPattern`, expectation building, report templating. The
heuristics survive only as *entry* criteria — deciding whether a newly seen
url part is worth banking is cheap to get wrong, because a missed entry costs
a model turn while a wrong one is caught by the scanner below.

## Mechanism: the ElementSpec

Match specs become one structure with typed roles, replacing the flat
candidate array whose ordering carried meaning implicitly:

```ts
interface ElementSpec {
  identity?: { container: string; text: SlottedString; within?: string };
  handles: Candidate[];   // testid | role+name | label | placeholder | text
  path?: Candidate;       // structural / nth — positional, last resort
  evidence: { urlPattern: string; fingerprint?: number[]; rowCells: string[] };
}
```

The rules that are currently spread across `candidatesFor`, `verifiedChain`,
`resolveChain`, `stranded` and the read-drop become properties of the type:

- `identity.text` is always slotted. An anchor that cannot be slotted is not
  an anchor — it never enters the spec.
- `identity` must resolve to exactly one element on the page that produced it.
- `path` is never sufficient for a spec whose purpose is to name a record: a
  read that publishes a ledger `identifier` and has no `identity` and no
  `handles` publishes nothing.
- Resolution order and the identity guard live in one resolver, with policy
  flags (`requireIdentity`, `allowMultiple`, `waitForRecord`) instead of
  positional convention.

## Run 1 to run N, end to end

**Run 1, instruction start.** Ledger seeded with caller vars (`runid`) as
`{from:'var'}` entries, `known: true`. Page url, fingerprint and visible text
captured as the segment's evidence.

**Run 1, before each action.** `prepare()` resolves the target to a handle and
describes it once. The ledger supplies the identity candidates: values present
in the element's row, narrowed to the cell that carries them, uniqueness-
checked against the live page. Handles come from testid/role/label/placeholder,
the structural path becomes `path`. **Every string entering the spec goes
through `ledger.slot()` at capture time** — parameterisation stops being a
later regex pass over finished artifacts.

**Run 1, after each action.** Anything the run just made is entered in the
ledger with its binding: a new url part (`{from:'url', step, label:'p1'}`), a
read-back value (`{from:'readback', step, spec}`), a JSON leaf of a response
the run read (`{from:'output', path:'dashboard.uid'}`), an identifier cited
only in the report's prose (pinned to the page, then `readback`). This is the
step that fixes grafana: the uid is banked when it appears, so the NEXT
instruction naming it slots it instead of embedding it.

**Run 1, compile.** Params are ledger entries, not rediscovered by scanning:
`example` is the recorded value, `binding` says how to get this run's own,
`known` decides identity. `requireText` is the subset of `known` identity
entries the page already showed at segment start.

**Run 1, export.** Flow steps carry markers and bindings. Then the **scanner**:
walk every artifact and assert no `ledger.runValuesIn(...)` hit survives
verbatim. A hit is a hard error naming the artifact, the value and its
binding — this is where t15, the uid, the stranded anchors and the duplicated
take all become one failing test instead of seven drift-file readings.

**Run N, step start.** A fresh ledger, seeded with run N's caller vars. Each
binding resolves against THIS run's evidence: `url` reads the live page's part
by label; `output` reads the value this run's earlier step published;
`readback` re-runs its ElementSpec against the live page; `input` takes the
caller's parameter. A binding that cannot resolve fails loudly — the step goes
to recovery with a stated reason, and never proceeds with a blank or a
recorded value.

**Run N, element location.** The resolver tries `identity` first, polling for
the record while the app paints (the deferred-refetch case), then `handles`,
then `path` only when the spec is not identity-bearing and the caller allows
it. Fallthroughs are counted as drift, as now.

## What this subsumes

`freshUrlIds` + the two duplicate length gates; `discoverSlots`'s three
recognition paths; `stranded`; the positional-read rule; `identityAnchor`'s
narrowing and uniqueness check; `derived` params; `jsonLeaves`;
`proseIdentifiers`; `provenanceValues` and `referencedValues` in the flow
runner. All become one entry path and one lookup.

Procedure identity is the same invariant one level up, so `canAdoptPin`'s two
rules generalise: a flow step owns its skill, and ownership is recorded in the
ledger rather than re-derived — which closes the export-side variant of the
defect that the re-pin gate already covers.

## Phases

1. **Ledger + scanner, no behaviour change.** Build the registry, populate it
   from today's producers, run the scanner in WARN mode over existing sweeps.
   It should immediately reproduce the seven known leaks; if it does not, the
   ledger is incomplete and that is the first thing to fix.
2. **Move recognition.** `discoverSlots` and `buildFlow` consult the ledger
   instead of their own heuristics. Delete the duplicate gates. Scanner to
   ERROR on export.
3. **Slot at capture.** `prepare()` slots strings as it builds them; the
   post-hoc `substitute` pass shrinks to the instruction template only.
4. **ElementSpec.** Collapse the candidate array into the typed structure and
   the single resolver.
5. **Verifier strictness** (independent, do first if cheap): extra mutations
   and extra created records fail a sweep instead of warning. fwrd16 scored
   6/6 while doing the task twice.

## Risks

- **Over-slotting.** A legitimate app constant that happens to equal a run
  value would be parameterised. Mitigated by requiring *provenance* for entry,
  not text equality: a value enters only when the run demonstrably produced it.
- **Bindings that cannot re-resolve.** Strictly better than today's silent
  wrong value, but it converts some passes into recoveries. The `readback`
  binding exists to keep that cost low.
- **Migration surface.** Phases 1-2 are additive and verifiable against the
  published sweeps in `bench/results-published/`; phases 3-4 touch the hot
  path and need the browser tests green at each step.
