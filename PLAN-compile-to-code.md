# Compile to code: the adoption critique, and what it costs to answer it

Written 2026-09-04 from a session that (1) role-played a target-market developer
rejecting sitelooper, (2) checked whether the briefing is load-bearing, (3) costed
the "emit a real Playwright spec" path against the actual data model in `src/`.

Companion to PLAN-go-to-market.md, which has the distribution plan. This one is about
the artifact the tool hands over, which is upstream of every distribution question.

---

## 1. The critique: why the target developer says no

Persona from PLAN-go-to-market.md, "Distribute through the agents": a developer in
Claude Code with a Playwright suite they resent. Ordered by how much each one blocks
adoption.

### 1.1 The headline number is in the wrong currency

The README prices the comparison in cents ($0.07 vs $0.19, "$0.00 replay"). CI spend is
not where the pain is. The number that decides adoption is in the same table and is not
foregrounded: **1212s repairdesk, 1451s odoo, 3043s atelyr** — 20 to 50 minutes of
babysitting per flow, plus instruction sizing.

A hand-written spec for the same flow is ~20 minutes and is readable at the end. So the
pitch currently reads: spend the time you would spend writing the test, get something you
cannot read, to save money you were not spending. The replay economics only beat *agent*
re-runs, and nobody was going to run an agent nightly. The real baseline is a script that
already replays in 20s for $0.00 and has done for years.

### 1.2 The flow is an unreviewable artifact that rewrites itself

`~/.sitelooper/flows/*.json` is "plain JSON" the way a compiled artifact is plain
bytes. Nobody reviews that diff in a PR.

Worse, recovery is compiled and re-pinned — the asset mutates at 2am because a cheap
model re-decided step 3, and the diff is churn no reviewer can evaluate. A test's job is
to encode intent and hold still while the app moves. This holds intent loosely and moves
with the app.

### 1.3 Effect gates are not assertions

The deepest one. The failure the README attacks (codegen confirming an empty sales
order) is real and well observed. But the fix checks *"the page changed the way it
changed during recording."* A test asserts *"the untaxed amount is 1250.00 and the status
is `sale`."*

The gap shows in the bench's own honest cells: "2/2 checkable", "4/4 (+2 n/a) — the
report-based objectives cannot be scored on a zero-model replay". So the deterministic
mode is the mode that cannot say what it saw, and the mode that can costs money and
turns. The scores lean on app-side verifiers (mutation log, JSON-RPC) that are bench
infrastructure a user does not get.

### 1.4 Nondeterminism in CI is a non-starter

The ladder is good engineering and a bad CI property. Tier B/C wake a model, so a red
build can go green because an LLM improvised, and a green build no longer means the
assertion held. A self-healing test that passes is indistinguishable from a broken test
that got papered over. Minimum ask: `--strict` (tier A only, drift = hard fail, ticket
for a human). Not in the command set today.

### 1.5 Shipping the app's DOM to a third-party provider

Recording and every drift repair send staging DOM — including anything resembling
customer data — to Novita/Zhipu. No self-host path documented up front, no data-handling
statement. This ends the conversation at any company with a security review, i.e. most of
the mid-market, not just the "regulated enterprise" of GTM route 2.

### 1.6 It does not fix what the developer actually resents

Not *writing* Playwright: flaky selectors, test-data setup/teardown, auth state, parallel
isolation, sharding, and reading a failure at 9am. Selectors are addressed well. On the
rest it is a regression — no fixtures, no workers, no trace viewer, no reporters, no
`--ui`, no integration with the runner the other 400 tests live in. Adoption means running
two test systems, and the new one cannot say *why* it failed in an openable form.

### 1.7 The benchmark is discounted, for reasons already in the repo

Self-run, arms configured by the author, targets chosen by the author. `browser-use
0/6 x3` reads as misconfiguration (PLAN-go-to-market.md concedes it: 135 schema errors).
workflow-use, Stagehand action caching, Magnitude, mabl, testRigor are absent.

Then the set churn undercuts determinism from inside: 24 → 24b → 26 → 28 → 28d, odoo
replays regressing 6/6 → 1/6 on a recorder defect, grafana swinging 4/6 → 6/6 by engine
build. The reading a skeptic takes: **flow correctness is coupled to engine version**, so
every upgrade is a re-benchmark the user has to run. Playwright at least fails in ways
that are the user's own fault.

### 1.8 Bus factor and shelf-signal

v0.3.0, one author, renamed last week, and npm still serves `browser-pilot@0.4.2` — a
*higher* version under the old name, so the first impression is a package abandoned in
favour of something more junior. No MCP server, no plugin, no Action.
`bash.exe.stackdump` at repo root, ~50 screenshots in root, Windows-only tested. None of
it is the engine's fault; all of it is what gets judged in the first 90 seconds.

### 1.9 The one that should worry most

PLAN-go-to-market.md writes **"Persona = James."** The target market is currently defined
as the author. Every decision above — 20-minute recordings are fine, JSON flows are
readable, self-healing is a feature, model-in-CI is acceptable — is coherent if the user
is the author and incoherent if the user has a team, a reviewer, and a security
questionnaire.

---

## 2. Finding: the briefing is not load-bearing (retires 1.6's onboarding half)

Question asked: does a *user* need to write the briefing, given every briefing we have was
written by an agent?

Checked in the repo:

- `--briefing` is optional in the harness (`bench/harness.mjs:364`, `readIfSet`).
- The fairness control is `bench/README.md:129` — "both arms get the **same** briefing
  file, byte for byte, **or neither does**". The published matrix runs are the *neither*
  case.
- What the arms actually get is the task file. Its "Notes on the environment" is three
  lines, none of them app knowledge: do not wait for network idle (long-poll), autocomplete
  needs an option chosen not typed, list views refresh async. Two are workarounds for
  engine gaps since closed (DOM-quiet, effect gates); the third is a generic web fact.
- No brief `.md` files exist under `bench/`. No stored session briefings on this machine.

**So the 25/25 is a cold record. The briefing mechanism is documented as a prerequisite
and earned zero objectives in the matrix.**

### Actions

1. **README: stop presenting the briefing as a prerequisite.** It currently reads "app
   knowledge goes in a per-session briefing you supply", which lands as *write a page of
   prose about your app before this works*. Free win in the first five minutes.
2. **Briefings are an output, not an input.** Every one we have was agent-written after
   exploration. Nobody authors one; someone *reviews* one — and a page of English about
   your own app is cheap to review, unlike a locator-chain blob.
3. **`sitelooper brief --from-flow`.** The recording already contains most of it:
   measured chains, effect expectations, discovered conventions ("Apply previews, Save
   persists"; atelyr objective 5 is literally *discover the precondition and report it*).
   Emitting a briefing from a converged flow makes flow #2 on the same app much cheaper
   than flow #1 — the compounding story the GTM plan wants and does not have. Today flow
   #2 pays near-full first-contact price.

### What genuinely cannot be generated

Short, and mostly safety not capability:

1. **Credentials** — `{{env:NAME}}` markers. Already right.
2. **Don't-touch boundaries.** An agent cannot know the "Sync to Xero" button is real.
   This is a blocklist, not a briefing, and it should be surfaced loudly because it is the
   thing that scares people about pointing an agent at their app.
3. **Intent the DOM cannot express** — which of three Save buttons the business means.

### Risk to watch

An agent-written briefing is partly circular: the same model family reads the app, writes
its interpretation, and reads that back as authority. A misconception gets laundered into
a confidently-worded fact.

More important structurally: **the briefing is where app-specific hacks go to hide.** The
strongest design boundary in the repo is "nothing app-specific in the tool". A generated
briefing relocates violations of it into a per-app text file where they stop showing up as
engine failures and stop pressuring a real fix. The odoo autocomplete note is exactly that
shape — it looks like app knowledge and is really a general rule about comboboxes the
engine should measure.

**Discipline: anything an agent writes into a briefing is a candidate engine rule until
proven app-specific.** Worth grepping existing briefings with that question — that is
probably where the next four engine rules are, the same way each set-24 miss turned out to
be a rule.

---

## 3. Compile to code: cost and what is lost

The proposal that answers 1.1–1.5 at once: **the deliverable is a reviewable
`@playwright/test` spec, not a runtime that replays.** Model at compile time only.

### 3.1 Not today's codegen

`src/daemon/codegen.ts` (259 lines) compiles `RecordedEntry[]` — the raw first-contact
recording — and that arm scored 14/48 with a confirmed-empty sales order. The real
compiler takes `Skill[]` from a **converged** flow, after replays have measured the
chains. Different input, comparable order of work.

### 3.2 Most semantics are already data

| Skill construct | Playwright form | cost |
|---|---|---|
| `LocatorCandidate` (9 kinds) | `makeLocator` (`recorder.ts:65`) is already a switch producing Playwright expressions — emit source instead of a `Locator` | trivial |
| chain fallbacks | `locator.or(...)`, ordered identity → handles → path (`specOf`) | easy inline; loses measurement |
| `scoped` | `page.locator(container, {hasText}).locator(sel)` | 1:1 |
| `volatileMatcher` (clock wildcarding) | a regex literal in source | direct, more legible as source |
| params `{{vN}}` | test params / fixtures | trivial |
| `derived` / minted ids | `const id = await readUrlPart(page,'p3')` | trivial, clearer in code than JSON |
| `StepExpectation` | `expect(page).toHaveURL(re)`, `expect(getByText(x)).toBeVisible()` | easy — **the whole win** |
| `preconditions.requireText` | assertion at segment entry | easy |
| `loop {body, while, max}` | `while (await loc.count()) { … }` | direct |
| `settleDom`, dialogs | helper / `page.on('dialog')` | small; dialogs already emitted |

The compile-time intelligence survives intact and gets *better*:
`consequentialExpectations`/`isEchoLine` choosing which effect is worth asserting, and
`specOf` ranking identity above handles above path, become visible decisions the user can
read and strengthen.

### 3.3 Where the cost actually is

Not the emitter (~2 weeks). It is **extracting a runtime**: `resolveChain`, `settleDom`,
point-marking and the box-plausibility check live inside `replay.ts` (1463 lines)
entangled with the daemon, the ledger, `StepExecutor` and the gate stack. A
dependency-free `@sitelooper/runtime` is ~1 week of careful surgery.

Estimate to something a stranger would merge into a real suite: **5–6 weeks.**

| work | est |
|---|---|
| emitter (skill → spec: 9 candidate kinds, slots, minted, expectations, loops) | 2 wk |
| runtime extraction from `replay.ts` | 1 wk |
| convergence gate + `repair`/`refine` codemod | 1–2 wk |
| fixtures, auth state, parametrisation so it fits an existing suite | 1 wk |

It also **deletes** work: most of `report.ts` (580 lines) — struck literals,
values-read-back-live, the honesty machinery — exists to keep a prose-returning runtime
truthful. A spec does not need it; assertions either hold or they do not.

### 3.4 Three tiers; pick 3, offer 2

- **Tier 1 — pure Playwright, one locator per step.** Today's codegen. 14/48. Dead.
- **Tier 2 — pure Playwright, fallbacks inlined** as `.or()` chains with
  `.filter({hasText})` identity guards. Zero deps, fully readable, more expressive than
  expected: chain order, identity-carrying fallbacks, volatile-name matching all survive.
  Loses `point`, the box yardstick, `stayOnOrigin`, `ambiguousNth`.
- **Tier 3 — spec + thin imported runtime.** `await sw.click(page, CHAIN, {identity,
  origin})`. Everything preserved.

**Recommendation: Tier 3, with the chain rendered as readable source rather than a blob,
and Tier 2 available as `--no-runtime` for people who will not take the dependency.**

The property that matters in both: **the model is at compile time only.** Compile time is
slow, expensive, once, on a developer's laptop. Run time is Playwright — offline,
deterministic, no inference call. That single split kills 1.4 and 1.5 outright.

### 3.5 What is necessarily lost

**a. Cross-run memory. The only genuine loss.** `stats` (`uses`, `successes`,
`fallthroughs`, `failedAtStep`), retire-a-candidate-by-measurement, and the re-pin loop
all need a mutable store the tool owns. A `.spec.ts` is a snapshot with nowhere to record
"candidate 3 missed twice in October".

Recoverable: runtime writes a drift sidecar, `sitelooper refine ./x.spec.ts` codemods
the chain constants. That is a mutating file in the user's repo again — **except it is now
a diff.** Convergence stops being automatic and becomes a pull request ("candidate
`#save-btn` missed 3/12 replays, demote it"). Lose self-healing, gain a reviewer. For a
*test* tool that is the correct trade, and it is what flips 1.2 rather than papering over
it.

**b. The recovery ladder, at run time.** Tier B/C do not exist in a spec; a failure is a
failure. That is the requested feature. The ladder relocates to a dev-time
`sitelooper repair --spec x.spec.ts --drift run.json` producing a patch.

**c. Segment selection.** `seq{chain,index,of}` plus per-segment url/fingerprint
preconditions let replay *enter* a procedure part-way. A linear spec runs top to bottom.
Mostly irrelevant for a test; the mid-flow recovery entry point goes away.

**d. `point` candidates**, unless Tier 3. Recorded box + viewport + role cannot be a
selector string — it needs live DOM marking plus the same-kind-of-control check. The most
runtime-dependent thing in the codebase.

**e. `mints` as a safety property.** In replay it guards restart semantics (the fwod13
double-order). In a spec, a re-run after a mid-test failure just makes a second record.
Standard Playwright territory, solved with fixtures and teardown — but it becomes the
user's job, and the docs must say so rather than imply it is handled.

### 3.6 The catch that decides whether this works

**A spec is only as good as the convergence it was compiled from.** Emit from a
first-contact recording and you ship codegen with nicer comments. So the compile must be
gated: N clean tier-A replays before a flow earns a spec.

That makes wall-clock worse — record, converge, *then* emit — and simultaneously fixes
1.1. Twenty minutes for an opaque JSON blob is a bad trade. Twenty minutes for a verified,
assertion-carrying Playwright spec the user reviews once and owns forever is a good one.
Same work, different artifact, different sale: **from "runtime that replays" to "compiler
that writes the test you would have written, having actually checked that it works."**
Nobody else is selling that, and the matrix already proves the capability exists.

---

## 4. Where this leaves PLAN-go-to-market.md

That plan's closing caution — "every week on the engine now is a week not on packaging" —
needs one amendment. This is not engine work. It is the artifact the packaging would be
distributing, and packaging a runtime nobody will put in CI is wasted.

Ordering suggestion, replacing weeks 1–3 of its table:

| week | do |
|---|---|
| 1 | npm deprecate `browser-pilot`; default provider; Mac test; no-credential demo; README: briefing is optional, not a prerequisite |
| 2–3 | emitter: `Skill[]` → `@playwright/test` spec, Tier 2 (no-runtime) first because it needs no extraction and is demoable |
| 4 | runtime extraction; Tier 3; `--strict` on `run` |
| 5 | convergence gate; `repair --spec`; `brief --from-flow` |
| 6 | GitHub Action replaying **the emitted spec**, not the flow; bench page; workflow-use row |
| 7+ | Show HN on the benchmark; ten reference teams |

The demo that sells it: *record once, watch it converge, `sitelooper script` out a spec
you read on screen, delete sitelooper, run the spec under plain Playwright, it passes.*
That is a two-minute video and it answers 1.1 through 1.5 without a word of argument.

## 5. Open questions for the next session

1. Is `sitelooper script` on the converged `Skill[]` path or still the raw-recording
   path? (Today: raw — `cli.ts` → `codegen.ts` over `RecordedEntry[]`.) Rewiring it is the
   first commit.
2. How many clean tier-A replays should gate a compile? Set 28's grafana hit zero turns on
   both replays; odoo needed 28d. Two is probably the floor, and the gate should be per
   *step*, not per flow.
3. Does Tier 2 (`.or()` + `.filter({hasText})`) actually score on the bench? Cheapest real
   experiment available: emit Tier 2 specs from the set-28 flows and score them with the
   existing verifiers, as a fifth Matrix-2 column beside codegen. If Tier 2 lands near
   sitelooper replay, the runtime dependency may be unnecessary and the whole objection
   set collapses for free.
4. Grep the agent-written briefings for content that is really an engine gap (section 2
   risk).
