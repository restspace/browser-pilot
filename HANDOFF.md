# sleep-walker — improvements handoff

> **Status: all items below implemented (2026-07-09).** Landed in `agent/loop.ts`,
> `agent/tools.ts`, `agent/prompt.ts`, `cli.ts`, with tests in `test/loop.test.ts` and
> `test/browser.test.ts` (fixture extended in `test/fixture/page.html`). Full suite green (39 tests).
> No browser-primitive changes and no app-specific code were introduced. This file is kept as the
> rationale record; see each item's "Verify" note for the covering test.


Improvements identified from the first real-world run: driving atelyr's `MANUAL_TEST_PLAN.md` §7A
end-to-end against a production backend (write-up: `C:\dev\atelyr\docs\E2E_PASS7.md`, 40
instructions, ~21.8M prompt / 46k completion tokens on GLM 5.2 via novita). None of the atelyr
defects were tool artifacts — the browser layer held. The items below are about the **agent loop,
turn economy, and ergonomics**.

**Every proposal here honors the design boundary** (README → "Design boundary: the tool is
app-agnostic"): each is described using only terms the caller supplies (a selector, URL, or value).
Nothing named below encodes any specific app. If picking one up leads you toward writing an app's
class name or behavior into the tool, stop — it belongs in that app's `brief`, not here.

Priority: **P1 correctness → P2 turn economy & cost → P3 ergonomics/observability.** P1 items change
what callers can trust; do them first.

---

## What already works — do not regress

Confirmed solid in the run; keep these behaviors when refactoring:

- **Native dialog capture** (`daemon/dialogs.ts`) — both §7A.3 block messages came back verbatim
  with no `window.*` override dance. This is a headline feature vs. the old flow.
- **React-safe `fill`** (`daemon/inputs.ts`) — drove every controlled location/delivery form,
  including number inputs, with no per-field hacks.
- **`@ref` snapshots** (`daemon/refs.ts`, Playwright `ariaSnapshot({mode:'ai'})`) — refs resolved
  reliably across navigations.
- **Session persistence** — the login survived the entire multi-hour run; the browser daemon held
  state across the novita-balance pause.
- **Cross-instruction memory** (`daemon/state.ts`) — later instructions correctly recalled
  created names/ids from earlier ones.
- **Provider presets** (`agent/llm.ts`) — novita worked as a drop-in; the `403 NOT_ENOUGH_BALANCE`
  surfaced cleanly as an infra error (exit 2), not a crash.

---

## P1 — Correctness

### 1.1 Near-cap forced report (turn-cap must not misreport success)

**Symptom (dominant issue).** Over half the multi-assertion `do` calls hit the turn cap and
returned `status: "blocked"` / exit 1 **even though the work had actually succeeded**. Transcript
tails repeatedly show the agent had already gathered the answer ("This is exactly what the plan
expected. The detail shows…") and then spent its last turns on housekeeping instead of calling
`report`. A caller keying on exit codes reads real successes as failures — the worst outcome for a
test runner.

**Evidence it's loop-discipline, not capability.** Every manual recovery — a `--max-turns 4`
"report what you already saw" follow-up — produced a correct report in **1–2 turns**. The agent can
report tersely; the standard loop just never makes it prioritize reporting as the budget drains.

**Fix.** In `agent/loop.ts` `runInstruction`, when turns-remaining ≤ ~2, inject a system/user
message before the next `complete()`: *"You have N turns left. Call `report` now with your best
current assessment of what was done and verified; do not start new actions."* If the final turn
still doesn't produce a valid report, the synthesized fallback should say **"turn cap reached; work
may be partially complete — see actions log"** rather than a bare `blocked` that implies nothing
happened.

**Verify.** Extend `test/loop.test.ts`: a scripted provider that keeps emitting non-report tool
calls should receive the nudge message and, on the last turn, the loop should surface the
distinct "cap reached / may be partial" summary. Assert the nudge text appears in `state.messages`.

### 1.2 Actions log in the result, so resuming a capped instruction is mutation-safe

**Symptom (production hazard).** The duplicate `Moved 1 from A to B` ledger writes (atelyr §7A.6)
happened partly because a `do` hit the cap **mid-mutation** (right after clicking submit), and the
"continue where you left off" follow-up performed the same move again — neither the agent nor the
caller could tell the first had applied. On an append-only production backend this is unrecoverable.

**Fix (two parts, both generic).**
- Return an **actions log** in the `do` result: the ordered list of tool calls the instruction
  made (tool name + the caller-supplied args), not just the last ~12 `transcriptTail` lines. A
  caller deciding whether to resume can then see the last action attempted. This is fully generic —
  it reports tool names and the args the caller's own instruction produced.
- Strengthen the resume guidance in `agent/prompt.ts` `OPERATING_RULES`: *"If you are continuing a
  previously interrupted instruction, first observe current state and confirm whether your last
  action took effect before repeating it — never re-issue a state-changing action blind."*

Note 1.1 also mitigates this: a forced near-cap report makes the agent state "I clicked submit; it
may have applied" instead of capping silently mid-action.

**Verify.** `test/loop.test.ts`: assert the result includes an `actions` array whose entries match
the executed tool calls in order.

---

## P2 — Turn economy & cost

Fewer turns per step is the biggest lever on both cap-hits (P1) and token cost. These are the
generic gaps that made steps burn turns.

### 2.1 `click` robustness — fallback when a normal click can't land

**Symptom.** The agent repeatedly fell back to `eval document.querySelector(sel).click()` because
the plain `click` verb timed out on an element that was covered or marginally actionable (e.g.
closing an in-app tab). Each fallback cost turns and reached past the tool's own semantics.

**Fix.** In `agent/tools.ts` `click` (and the other single-target action verbs), on an
actionability timeout, retry with a scroll-into-view + a `force`/DOM-dispatch fallback, and report
which path succeeded. Optionally expose a `force?: boolean` arg. **Generic** — the target is the
caller's selector; the improvement is purely in how a click is executed.

**Verify.** `test/browser.test.ts` fixture: add an element behind a transparent overlay; assert
plain `click` recovers via the fallback rather than erroring.

### 2.2 Single-target verbs resolve `.first()` (or return a disambiguating error)

**Symptom.** `dblclick`/`click` on a selector that matched multiple nodes raised Playwright
strict-mode violations ("resolved to 6 elements"; duplicate rows resolved to 2). The agent
recovered by discovering `>> nth=0` mid-step — a wasted turn each time.

**Fix.** In `daemon/refs.ts` `resolveTarget` (or at the action call sites in `tools.ts`), for
single-element actions default to `.first()`, **or** catch the strict-mode error and return a
message like *"selector matched N elements; pass a more specific selector or an index"* so the
agent fixes it in one step instead of two. **Generic** — operates on the caller's selector only.
(Prefer the explicit-error route if silently taking `.first()` risks acting on the wrong element;
decide per-verb.)

**Verify.** Unit test on `resolveTarget` behavior; browser test asserting a multi-match `click`
either targets the first or returns the count-bearing error.

### 2.3 A `read` variant that returns values across *all* matches of a selector

**Symptom.** The agent leaned on `eval` to pull lists of values it couldn't get otherwise — e.g.
"all list-row `aria-label`s", "text of every matching cell". `read` only handles a single target,
so batch reads became `eval` one-offs.

**Fix.** Add a `read_all` (or `what:"each"`) mode in `agent/tools.ts` that returns an array of
text/attr/value across every element matching a **caller-supplied selector**. **Generic** — the
selector and attribute come from the instruction; the tool stays ignorant of what they mean.
Reduces `eval` reliance and turns.

**Verify.** Browser test: `read_all` over the fixture's repeated elements returns the expected
array.

### 2.4 `wait_for` — fail fast and informatively on values that never arrive

**Symptom.** `wait_for` on `count`/`text` sometimes burned the full timeout (5–10s + a turn) when
the asserted value never materialized — notably against virtualized lists where the rendered node
count differs from the logical count, so a `count=N` wait can't be satisfied by counting DOM rows.

**Fix.** Keep the immediate-return-if-already-satisfied behavior (the poll loop already checks
before sleeping — preserve it). Improve the failure: on timeout, return the last observed value
*and* a hint that the condition may be structurally unsatisfiable (e.g. observed value stable for
the whole wait). Document in the tool description that count/text waits are for values expected to
*change*, and that counting rendered nodes is unreliable for virtualized/windowed lists — the
caller should assert on a stable indicator supplied via the instruction/brief, not on rendered-row
counts. **Generic** — no app specifics; just clearer semantics and messaging.

**Verify.** Unit test the timeout message includes the last observed value; no behavior change on
the already-satisfied path.

### 2.5 Cost: stable-prefix reuse and lighter resend

**Symptom.** ~21.8M prompt tokens over 40 instructions. The system prompt (rules + ~16k briefing +
notes) is byte-stable but re-sent on every turn of every instruction; history trimming
(`daemon/state.ts`, 150k chars) bounds the message tail but not the prompt prefix.

**Fix (in priority order).**
1. Land 1.1/2.1–2.4 first — fewer turns is the dominant cost reduction.
2. Ensure the stable prefix stays **byte-identical** across turns so provider prompt-caching can
   discount it (the design already aims for this in `agent/prompt.ts`; add a test that the system
   prompt is byte-stable across a multi-instruction session, and document which providers cache).
3. Consider an opt-in lighter-briefing mode (summary in-prompt, full brief fetched on request)
   for very large briefings — only if 1–2 prove insufficient.

**Verify.** `test/prompt.test.ts` already checks prefix stability; extend it to assert stability
across simulated instruction N→N+1 with notes appended (notes must append *after* the frozen
prefix, not mutate it).

---

## P3 — Ergonomics & observability

### 3.1 Mid-instruction visibility in `--json` mode

**Symptom.** Running with `--json` (batch mode) gave no view of progress; a call that was about to
cap was invisible until the `blocked` result landed. `--verbose` streams `· tool args` to stderr
but I mostly ran `--json`.

**Fix.** Allow progress frames to stream to stderr even under `--json` (json stays on stdout), or
add a `--progress` flag independent of `--verbose`. Emit a running `turn k/N` counter so a watching
caller sees the budget draining. `shared/protocol.ts` already has `ProgressFrame`; `cli.ts` just
gates it on `--verbose`.

### 3.2 Reporting discipline in the system prompt

**Symptom.** The agent over-verified — re-snapshotting and re-reading after the assertions were
already answered — which fed the turn-cap problem.

**Fix.** Tighten `agent/prompt.ts` `OPERATING_RULES`: *"Report as soon as the instruction's
assertions are answered; do not re-verify what you've already confirmed. Prefer `read` over a full
`snapshot` for spot checks. Re-snapshot only after a navigation or a DOM change you caused."*
Generic guidance; no app specifics.

### 3.3 Caller-pattern guidance in the README usage contract

**Symptom (caller-side lesson).** Batching a whole plan sub-section into one instruction is what
blew the turn budget. One `do` per assertion (or small group), a lower `--max-turns`, and an
explicit report-only follow-up was the reliable pattern.

**Fix.** Add a short "Writing good instructions" note to `README.md`: scope each `do` to one
logical, verifiable step; don't pack many assertions into one instruction. (1.1 reduces how much
this matters, but the guidance is still worth stating.)

---

## Suggested order of work

1. **1.1 near-cap forced report** — converts most false `blocked` results into truthful reports and
   removes most report-only follow-up calls in one change. Highest value.
2. **1.2 actions log + resume guidance** — closes the production mutation-safety gap.
3. **2.1 click robustness**, **2.2 first/disambiguate**, **2.3 `read_all`** — the three that most
   reduce wasted turns (and thus cost and cap-hits).
4. **2.4 wait_for messaging**, **3.2 prompt discipline** — cheap, compounding.
5. **2.5 cost**, **3.1 progress**, **3.3 README** — polish once the above land.

Each item is scoped to `agent/loop.ts`, `agent/tools.ts`, `agent/prompt.ts`, `daemon/refs.ts`,
`daemon/state.ts`, or `cli.ts` — **no changes to the browser primitives are required**, and none of
these should introduce any app-specific knowledge.
