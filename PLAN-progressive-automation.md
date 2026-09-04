# Progressive automation — Stage 1 plan

Goal of the programme: make sitelooper *learn*. Repeated successful work is converted from
model-driven execution into stored, validated, parameterised procedures that replay deterministically,
with the model used only where reality diverges from what previously worked (repair), and eventually
with recognition of template pages so one learned procedure serves many related pages. Source ideas:
`C:\info\progressive-automation\progressive-automation-notes.md`. Starting point: the tool and bench
described in `bench/MILESTONE-2026-08-23.md`.

This document is **Stage 1 only**: replay-first with repair-on-failure for the existing unit of
delegation (one `do` instruction), measured on the existing bench. Template-page recognition is Stage 2,
but Stage 1 deliberately records the data Stage 2 needs.

## Status (2026-08-23)

Implemented and committed on `main` (`e298f96` and follow-ups): recorder chains + per-step diffs,
`src/skills/{store,compile,replay,learn}.ts`, `src/daemon/fingerprint.ts`, the `run_skill` tool and
operating rule 3b, `--learn` / `skills` CLI, daemon-side Tier A, harness `--learn`, `score.mjs` `A_n`,
`bench/sweep.mjs`. 210 tests pass including the three fixture perturbations and the loop-level
replay→repair→variant path.

What the first real runs against the local repair-desk app taught (all fixed, all with tests):

1. **Id-bearing locators look unique and aren't.** `getByTestId('ticket-link-t15')` and
   `getByRole('link', { name: 'RD-1017' })` replayed *successfully* onto the previous run's ticket.
   Fix: compile demotes any candidate whose selector or name is id-like behind the semantic ones.
2. **"Ran" is not "worked".** The wrong-ticket replay passed every hard check (url pattern `:id`
   matched). Fix: page-change expectations that carry a parameter are hard — the step was recorded to
   surface `heading "{{v3}}"`, so it must surface the new title — with a presence check on the miss
   path so a value that was already on the page (filling a field with its default) does not false-fail.
3. **The agent's observation turns were implicit waits.** The app refreshes its list a beat after a
   create; the recorded click on "row 1" hit the stale row. Fix: a DOM-quiescence settle (250 ms quiet,
   2 s max) before each replayed step. Generic, no network-idle, instant on a static page.
4. **The model can mis-type a value.** It created `sm1 …` when asked for `sm1b …`; the typed value then
   did not occur in the instruction and stayed literal. `skills show` flags literals, and the `[skills]`
   listing now says which fixed values a procedure types so the agent can decline it.

Measured on the real app with `deepseek-v4-flash` as the inner model, three differently-worded
instructions for "sign in and create a ticket": run 1 — 14 turns, skill stored; run 2 — replay stopped
at the wrong-ticket step (caught by fix 2), agent repaired, variant stored; run 3 — variant replayed
11/11 on turn 1, one verifying snapshot, report: **3 turns**, variant validated, original superseded.

### First learning sweep (local, K=3, `lrn1`, 2026-08-23)

`node bench/sweep.mjs --k 3 --learn … --verify`, repairdesk target, orchestrator `zai-org/glm-5.3` on
novita (no OpenRouter key locally — the freeze tripwire stayed quiet), inner `deepseek-v4-flash`,
escalation off, coarse. Results in `bench/results-published/lrn1-*` and the learned store in
`bench/results-published/lrn1-skills/`.

| n | verified | orch cmds | total $ | orch $ | inner $ | inner $/instr | A_n (replayed / recorded actions) |
|---|---|---|---|---|---|---|---|
| 1 | 6/6 | 11 | 0.144 | 0.066 | 0.078 | 0.0071 | 0.11 (within-run reuse: part B replayed part A's skill) |
| 2 | 6/6 | 6 | 0.052 | 0.020 | 0.032 | 0.0054 | 0.38 |
| 3 | 6/6 | 10 | 0.090 | 0.029 | 0.062 | 0.0062 | 0.33–0.35 (5/10 instructions replayed, 4 full, 1 repaired) |

Reading it honestly:

- Correctness held (6/6 externally verified on every run; run 1's "claim mismatch" is the verifier reading
  Part A's final price as the objective-2 claim, a parsing quirk, not a fabrication).
- Cost fell (run 1 → runs 2–3: −64% and −37%), but **most of the total-cost swing is the orchestrator's
  decomposition variance** (6 vs 10 vs 11 commands), not learning. The learning-attributable signal is
  the inner cost *per instruction*: $0.0071 → $0.0054 → $0.0062, a 13–24% reduction, with A_n ≈ 0.35.
  Well short of the plan's run-5 ≤ 50% / A_5 ≥ 0.7 targets at n=3.
- Why A_n plateaus at ~0.35: (a) half the instructions on each run found no matching skill or the agent
  declined, because the orchestrator re-chunks the task differently each run and the store fragments —
  by run 3 there were 17 skills for ~8 distinct outcomes, most provisional, since the twin-merge only
  fires on an identical template or identical step sequence; (b) replay covers the *actions* but the
  agent still spends its own turns verifying and reporting, so per-instruction token cost falls less
  than action count does.
- What worked exactly as designed: validation/demotion (the add-part skill was repaired in run 1 and its
  variant reached 3/3 validated and superseded it), refusal from the wrong page, live read-backs.

### Locator durability: retarget row-clicks to the record link (2026-08-23)

Closed the "held only because the reset app has a single-row list" caveat. When the agent clicks a
container (a table row, list item) to open a record, `describeHandle` now retargets the recorded locator
to the single hyperlink inside it — whose accessible name is the record's id (`RD-1015`), which
parameterises to `{{v}}` — keeping the row's structural css as a fallback. So the nav step replays as
`getByRole('link', { name: '{{ref}}' })`, resolving the record by id rather than by row position.

Verified position-independently: the coupled flow replayed twice **without a reset between** (so the
second replay's list already held the first's ticket) created two distinct tickets (RD-1015, RD-1016) and
added each run's part to its *own* ticket — both fully Tier A (zero model), ~14s, confirmed against the
mutation log. Previously this worked only because a reset list has one row.

Remaining: a verification read located by positional css (`td:nth-child(6)`) is still brittle, but it is
now non-fatal at replay (skipped, not recovered) and, for reported values, superseded by the read-back
synthesis's stable-handle read — so it no longer forces recovery. The producing-step-must-replay-clean
point stands but is met for these flows.

### Verified model fallback + non-fatal reads → coupled flow fully zero-model (2026-08-23)

Two more changes, then the coupled flow replays end-to-end with no model calls:

1. **Verified model fallback for read-back** (the earlier "ask the model for the source" idea, done as a
   *fallback*): after `captureReadBack` runs deterministically, any value it could not pin by text (e.g. a
   non-unique value) is put to the model in one bounded turn via a `locate` tool; each answer is trusted
   only after it resolves to exactly that value (`captureReadBackAt`). Deterministic-first keeps the
   common case free; the model earns its turn only on stragglers.
2. **Reads are non-fatal in replay, and `read_all` may match many.** A `read`/`read_all` is an observation,
   not a state change — so a read whose locator no longer resolves is skipped with a warning and the
   replay continues, rather than stopping the whole procedure and forcing recovery. And `resolveChain` no
   longer requires a unique match for `read_all` (which reads across every row). This was the actual cause
   of the coupled flow's step 2 dropping to recovery: a trailing price-column `read_all` with a positional
   css locator failed after the real work (navigate → fill → submit) had already succeeded.

Result on the deliberately-coupled flow (sign-in+create+return-to-list → open-by-ref → add-part),
deepseek-recorded, replayed with a fresh runid three times: **2/2 success, both steps Tier A (zero model
calls), ~10s** — where the first version of this flow hard-blocked at step 2, and the previous version
completed only via strong-model recovery (~60s). The read-back (step 1 emits the live ticket id),
parameterised navigation (step 2 clicks the ticket by the threaded id), and non-fatal reads compose to
give the full progressive-automation payoff: a whole learned session replaying deterministically.

Still open (unchanged): navigation/verification locators that are whole-row-text or positional css are
brittle — they happened to hold here (single-row list on a reset app) but would drift on a populated,
non-resetting app; the recorder preferring a record's own link/testid over the row, and read-back reads
over agent-chosen positional reads, is the durability work. And a producing step must still replay clean
for its outputs to thread — met here, not guaranteed for larger skills.

### Parameterised intra-skill navigation (2026-08-23)

Addressed the reliability blocker from the previous entry. Three changes:

1. **Slot discovery now scans locator identifying values**, not just tool args. A record identifier that
   appears in the instruction and in a navigation locator's name/text (`getByRole('link', {name:
   'RD-1015'})`) becomes a slot, so the locator parameterises to `{{v}}` and replay navigates to this
   run's record. Guarded to record-specific values (a digit or id-like token, or an existing arg slot),
   so stable UI labels ("Save") that merely appear in the instruction stay literal.
2. **Unresolved references route to recovery, not a halt.** If a step needs an id an earlier step did not
   read back live (so the honesty rule dropped it), the flow soft-resolves the instruction to what IS
   known — the record's title — and recovers on the strong model, which finds the record by that. The
   repaired step is re-pinned.
3. Confirmed live on the deliberately-coupled flow (step 1 ends on the list, step 2 opens the ticket by
   id then adds a part): step 1 replays zero-model; step 2's id cannot thread (step 1 reported it without
   a labelled read), so it soft-resolves to the title, recovers on glm-5.3, succeeds, and re-pins — 2/2,
   no halt (previously: hard block at step 2).

**Read-back synthesis (option (c), done).** Every value a step reports is now captured at record time as
a durable read-back: `captureReadBack` (recorder) finds the live element showing the value and records a
`read` located by a stable handle — test id, structural path — explicitly *excluding* any candidate whose
identity equals the value (locating a price by "125.00" would never match a new price). So on replay the
step re-reads this run's id/price live and the next step threads it zero-model. Verified: step 1's
sign-in+create skill now carries a labelled `ticketReference` read and step 2 chains it. Chosen over (a)
[enforce a read via an extra loop turn — model-driven, costs a turn] and (b) [re-read at replay — needs a
selector, the same gap]; (c) is record-time, model-free, reuses trusted locator code, keeps the honesty
rule (it IS a live read at replay), and also fixes app-computed values being dropped on plain Tier-A
skill replay.

Residual: read-back synthesis pays off only when the *producing* step replays cleanly; a big multi-step
skill (sign-in+create+return-to-list) that itself drifts to recovery still may not emit the output
reliably. That is the general skill-robustness axis (solidify/validate skills over runs), not specific to
threading. Also still open: navigation locators whose "name" is a whole table row's text (date, status,
counts) are not replayable — the recorder should prefer the record's own link over the row when both were
in the click's ancestry.

### Solidified matching + strong-model recovery (2026-08-23)

Two changes after the first flow test:

1. **Flows carry their skills' parameter bindings.** At export each step stores the skill's slot values
   (with `{{runid}}`/`{{step.output}}` references), so `run` binds params from the flow rather than
   re-deriving them from the (reworded) instruction. This removes the "pinned step did not Tier-A match"
   failures — confirmed: a sign-in+create step replays zero-model from stored params on a fresh runid.
2. **Recovery goes straight to the strong model.** A step that failed to replay is not the straightforward
   case the cheap model recorded, so `run` recovers on the configured fallback model (even when per-step
   escalation is off) or an explicit `--recovery-model`, one shot, no cheap pre-attempt.
3. **Store fragmentation**: `sameProcedure` now merges by locator *kind* (and id-stripped selector
   skeleton), not exact literal, so two runs' "add a part" skills coalesce instead of proliferating.

Finding from the same test — the real reliability blocker is now visible: **skills that embed navigation
to a specific record**. Step 1 (sign-in+create) ends on the tickets list; step 2 (add part) was recorded
re-navigating list→ticket via record-specific locators, so on a new runid its replay drifts and even the
strong model struggles to recover from the half-navigated state. The flow references the ticket correctly
at the instruction level, but the skill's locators do not. Fix (Stage 2): parameterise intra-skill
navigation — a skill step that clicks a record link should bind that link from a parameter/output, the
same way instructions already do.

### Flows: whole-session record-and-replay (2026-08-23)

Built on top of Stage 1 (commit e519981): a session's resolved path is exported as a flow and replayed
with no orchestrator. First real test on the repairdesk task, inner model deepseek-v4-flash, escalation
off:

- **Record (run 1):** the orchestrator drove the task normally under `--learn`; the harness declared
  `runid` and exported a **9-step flow** at `stop`. It captured the chaining exactly — the ticket id
  step 2 reported threads into steps 3–9 as `{{02-create.ref}}`, and the runid as `{{runid}}`
  (`bench/results-published/flows/rdflow.json`). 6/6 externally verified.
- **Replay A (new runid `ft9`, no orchestrator):** **9/9 steps, 158s**. Four steps replayed pure
  (Tier A/B, zero model), three drifted → cheap-model repair → variant compiled and **re-pinned into the
  flow file** (self-healing). `{{02-create.ref}}` resolved to the live ticket id — proof both that
  inter-step threading works and that the honesty rule holds (an unresolved reference halts; it did not).
- **Replay B (new runid, healed flow):** **halted at step 3/9** — the inner model blocked on the
  agentic fallback for one step whose skill did not Tier-A match. The flow halted and returned state;
  external verify shows 1/6 with **zero false claims** — the halt-safety and no-fabrication guarantees
  both held under a genuine failure.

Reading it: the mechanism is sound and correctly halt-safe, and when the pinned skills replay it is
near-script (zero-model steps, no orchestrator). But replay reliability rides on the cheap inner model,
which is flaky on any step that still needs repair rather than a clean replay — so a K-run flow sweep is
not yet uniformly green at K=2. The levers are the same as for skills (solidify/merge skills so more
steps Tier-A match on the first replay) plus: (a) 01-open and a couple of others never Tier-A matched
even with a pinned skill — worth finding why bindSkill misses there; (b) a step that blocks on the
agentic fallback might be worth one escalation before halting, even with inner escalation otherwise off.


Next, in order: (1) merge skills by *outcome* rather than by template — same origin + same start page +
same step sequence modulo parameters already merges; extend to "same tools and same primary locator kinds
with different literals", and let a validated skill absorb a provisional one whose steps are a prefix
or superset; (2) Tier A will not fire under a rewording orchestrator, so measure the fixed-wording case
separately with a scripted caller (that is where A_n → 1 and cost → orchestrator-only); (3) K=5 with
N≥3 sweeps on the cloud routine with OpenRouter, plus a K=5 control sweep, before quoting any number in
the README; (4) the Stage 2 items below.

## Where we start from (what already exists)

| Need | Already there | Gap |
|---|---|---|
| Capture a trajectory | `ScriptRecorder` (`src/daemon/recorder.ts`): every successful tool call, with a **durable locator re-derived from the live DOM before the action** and verified to resolve to the exact element; appended to `script.jsonl` per instruction | Opt-in (`--script`); keeps only the *chosen* locator expr as a string, not the full candidate list; no post-conditions; not parameterised; no persistence beyond the session |
| Run a sequence without the model | `batch` tool (`executeBatch`) — ordered steps, stop at first failure, one combined state diff; per-step partial-outcome reporting | Steps come from the model each time; nothing is stored or reused |
| Detect what an action changed | `captureSignature`/`stateDiff` (`src/daemon/diff.ts`): url, title, alerts, added/removed lines | Produced as prose for the model, not stored as structured expectations |
| Recover from a failure | The agent loop itself, rule 10 ("continuing an interrupted instruction — observe before repeating") and the bail-out `actions` log | No mechanism hands a *partially replayed* procedure back to the loop |
| Measure | Bench harness + external verifier (`verify-repairdesk.mjs`), per-run cost/turn accounting | No cross-run state (each run starts from nothing), no "deterministic fraction" metric |

So Stage 1 is mostly plumbing between pieces that exist, plus a store, a replayer, and a metric.

## Key finding that shapes the design

The orchestrator's `do` instructions for the *same* bench step differ in wording **and in
decomposition** every run (`bench/results-published/noesc{1,2,3}-*-transcript.jsonl`): noesc1/2 bundle
"sign in + create ticket" in one `do`, noesc3 splits them into two; the add-part instruction is phrased
three different ways. Consequence:

- **Matching a new instruction to a stored procedure cannot be textual.** It has to be semantic.
- The cheapest semantic matcher we have is **the inner model on the turn it is already going to spend**.
  So the primary mechanism is: the agent is *shown* the candidate procedures for the page it is on and
  can invoke one as a tool. One turn to invoke + one to report, instead of 6–12 observe/act turns.
- A zero-LLM path (exact normalised instruction match → replay → synthesised report) is still worth
  having for scripted callers (CI test plans with fixed wording), but it will essentially never fire on
  the bench, so it is a stretch item, not the core.

This also means the **unit of storage is the instruction-sized procedure**, not the whole task — which
matches the notes' "procedural memory of subskills" (§9) better than monolithic caching anyway, and copes
with the orchestrator re-chunking the task.

## Architecture (Stage 1)

```
do "add a part named 'x7 RD Part A' with cost 100 and markup 25"
        │
        ▼
 [Tier A — stretch] exact normalised-template match → replay → synthesised report   (0 LLM calls)
        │ no match / failed
        ▼
 [Tier B — core] agent loop, turn 1 user message carries:
        [skills] 2 stored procedures may apply on this page:
          s_9f2: "add a part named '{{v1}}' with cost {{v2}} and markup {{v3}}"  (7 steps, 4/4 ok, last 2026-08-23)
          s_c41: "edit the part named '{{v1}}' so its cost changes to {{v2}}"    (5 steps, 3/4 ok)
        agent calls  run_skill({id:"s_9f2", params:{v1:"x7 RD Part A", v2:"100", v3:"25"}})
        │
        ▼
 replayer: precondition check → steps 1..n deterministically, each: resolve locator (fallback chain)
           → act → validate expectation → continue
        │ all pass                         │ step k fails
        ▼                                  ▼
 result to agent with live read-back      result: "ran 1..k-1 ok; step k failed: <why>; page now at <url>"
 values → agent reports                   agent continues agentically from there (rule 10 applies)
                                           → on success, the trajectory (replayed prefix + repair) is
                                             compiled as a new variant of the skill
        │
 [Tier C] no applicable skill → today's behaviour, recording on → compiled on success
```

Every `do` result carries a `skill` block so cost and determinism are attributable.

### 1. Skill store — `src/skills/store.ts`

Persisted under `~/.sitelooper/skills/<origin-slug>/<id>.json` plus an `index.json` per origin.
Keyed by **origin** (scheme+host+port), not session: the point is that run N+1 benefits from run N.

```ts
interface Skill {
  id: string;                      // short hash
  origin: string;                  // "http://127.0.0.1:4180"
  template: string;                // instruction with param slots: "add a part named '{{v1}}' …"
  params: Record<string, { example: string; usedIn: number[] }>;   // slot → first-seen value, which steps use it
  preconditions: { urlPattern: string; fingerprint?: number[] };    // start page; fingerprint = Stage-2 data
  steps: SkillStep[];
  reportTemplate?: { summary: string; values: Record<string, string> }; // with slots, for Tier A
  stats: { uses: number; successes: number; partial: number; lastUsed: string; created: string;
           failedAtStep: Record<number, number> };                   // which step breaks, how often
  status: 'provisional' | 'validated' | 'demoted';                   // see promotion rules
  provenance: { session: string; instruction: string; model: string };
}

interface SkillStep {
  tool: string;
  args: Record<string, unknown>;           // with "{{v1}}" substitutions in string values
  locators: Record<string, LocatorChain>;  // ALL candidates in preference order, not one expr (§14 decision tree)
  expect?: {                               // derived from the recorded state diff; see §3
    urlPattern?: string;
    alertContains?: string;
    addedContains?: string[];              // soft in Stage 1: logged, not enforced
    readEquals?: string;                   // for wait_for/read steps: the recorded assertion
  };
  fingerprintBefore?: number[];            // Stage-2 data, cheap to collect now
}
```

`LocatorChain` is the structured form of what `candidatesFor()` already computes — `{kind:'testid'|'role'|
'label'|'placeholder'|'id'|'text'|'css', …, nth}` — so replay never has to parse/eval an expression
string, and can **fall through the chain** when the first candidate no longer resolves. The recorder
change is small: keep the structured candidates it already builds instead of discarding all but the
winner.

CLI: `sitelooper skills list [--origin …]`, `skills show <id>`, `skills rm <id>`, `skills clear
--origin …`. Skills must be inspectable and deletable — a wrong skill that keeps matching is worse than
none.

### 2. Compilation — `src/skills/compile.ts`

Runs at the end of a `do` whose report is `success` (never on failure/blocked — a recording is of what
worked, and the external verifier showed a "success" can still be a fabrication, so see promotion rules).

1. **Collect** the instruction's recorded steps (recording is forced on whenever learning is enabled;
   cost is page round-trips, not tokens).
2. **Parameterise**: any string literal in a step's `fill`/`type`/`select`/`goto`/`wait_for(text)` args
   that also occurs verbatim in the instruction text (≥ 2 chars, not a bare common word) becomes a slot
   `{{vN}}`; substituted in the template, the step args, the expectations and the report template. Values
   that do *not* occur in the instruction stay literal and are flagged in `skills show` (these are the
   "sensible defaults" the agent invented, e.g. a customer name — correct to replay, worth seeing).
3. **Normalise URLs** into patterns: path segments that are numeric, hex ≥ 8, uuid, or `[a-z]\d+` become
   `:id`; hash routes handled the same (`#/tickets/t15` → `#/tickets/:id`). Query strings dropped.
4. **Derive expectations** from the state diff captured around each state-changing step (`captureSignature`
   before/after — already happens, just not kept): url pattern after, first alert text, added lines. Text
   gets the same slot substitution so `"Added part x7 RD Part A"` becomes checkable for the next run.
5. **Drop pure-observation noise**: `snapshot` is never recorded already; `screenshot` steps are *kept*
   (the caller wants them). Orientation `read`s are kept too — they cost nothing at replay and their
   live values are what the agent reports. Trajectory minimisation is Stage 2.
6. **Dedupe**: if a skill with the same origin + template already exists, update stats; if the template
   differs but the step sequence is structurally identical (same tools/locators, different literals), merge
   as one skill with an extra example. Otherwise store new.
7. **Fingerprint** the start page (see §6) and each step's pre-state. Cheap; Stage 2 needs it.

### 3. Replay — `src/skills/replay.ts`

`replaySkill(session, skill, params, opts)`:

- **Precondition**: current url matches `preconditions.urlPattern` (with params). If not, refuse with
  "not on the expected page" — never replay state-changing steps from the wrong place.
- **Per step**: substitute params → resolve the locator by walking the chain until one resolves to exactly
  one element (record which candidate won: a fallthrough is a drift signal worth counting) → run it
  through the existing `dispatch()` path so React-safe fill, robust click, dialog capture and recording
  all behave identically → **validate**: the action threw = fail; `expect.urlPattern` mismatch after the
  step = fail; `readEquals`/`wait_for` not met = fail; `addedContains`/`alertContains` mismatch = *warn*
  (logged into stats, not a failure, until Stage 1 data shows they are reliable).
- **Stop at first failure.** Return a structured result:
  `{ok, stepsRun, stepsTotal, failedAt?, reason?, values: {…live read-backs…}, url, fallthroughs}`.
- Honour the instruction's abort signal and deadline like any tool.

Live read-back values are always what the page said *now*, never the recorded value — this preserves the
"never report a number you did not observe" rule that the scref3 fabrication made load-bearing.

### 4. Integration into the loop — Tier B (core)

- **Candidate listing** (`src/skills/match.ts`): on each `do`, look up skills for the current origin
  whose `preconditions.urlPattern` matches the current url (Stage 2 adds fingerprint ranking). Cap at ~5,
  ordered by success rate then recency. Rendered into the per-instruction user message alongside the
  existing `[browser]` location line, **not** into the system prompt (keeps the cached prefix stable).
- **New tool `run_skill`** in `src/agent/tools.ts`: `{id, params}`; returns the replay result as text
  with the same `[state: …]` diff the batch tool produces. Validation of params against the skill's
  slots happens before anything runs.
- **Prompt clause** (operating rule 3b): *"If a listed stored procedure matches the instruction, call
  `run_skill` with it as your FIRST action rather than rediscovering the steps. If it reports a failure
  part-way, continue from the page state it left — observe first, do not re-issue any state-changing
  action it already ran. Still read back every value you report."*
- **Repair → learning**: when a `run_skill` failed at step k and the instruction nevertheless ends in
  `success`, compile the full trajectory (replayed prefix + agent's repair) as a **variant** of the
  original skill; the original's `failedAtStep[k]` count increments. When a variant outperforms the
  original it becomes the listed one (the original is `demoted`, kept for inspection).
- **Escalation interplay**: none needed in Stage 1 — escalation is already off in the optimised config,
  and a skill failure just hands the agent a page and a log, exactly like a resumed bail-out.

### 4a. Walkthrough: how a matching skill drives the inner loop

**Before turn 1 (no LLM).** The `do` handler looks up skills for this origin whose start-page url
pattern matches the live url and appends them to the *user* message after the instruction:

```
On the ticket detail page for 'x7 RD Bench Ticket' (ref RD-1015), add a part named exactly
'x7 RD Part A' with cost 100 and markup 25. Submit, wait for it to appear, report its price.

[browser] http://127.0.0.1:4180/#/tickets/t15 — "RD-1015 · x7 RD Bench Ticket"
[skills] stored procedures that apply on this page:
  s_9f2  "add a part named '{{v1}}' with cost {{v2}} and markup {{v3}}"   7 steps · validated 4/4 · reads back: partPrice
  s_c41  "edit the part named '{{v1}}' so its cost changes to {{v2}}"     5 steps · validated 3/4 · reads back: partPrice
```

**Turn 1.** The model's one tool call: `run_skill({id:"s_9f2", params:{v1:"x7 RD Part A", v2:"100", v3:"25"}})`.
That *is* the matching — done by the model on the turn it would have spent on `snapshot`.

**Tool execution (no LLM).** `replaySkill` validates params and the precondition url, then for each
step substitutes params, resolves the locator by walking the candidate chain, runs it through the same
`dispatch()` the agent's own calls use, and checks the step's expectation. `read` steps return their
*live* value. The tool result reads like a batch result:

```
replayed s_9f2: 7/7 steps ok
  1 click   getByRole('button',{name:'Add part'})    ok
  2 fill    getByLabel('Name') ← "x7 RD Part A"      ok
  …
  6 wait_for text_contains "x7 RD Part A"            ok (met)
  7 read    partPrice → "125.00"
[state: +1 row in parts table ("x7 RD Part A · 100 · 25% · 125.00")]
```

**Turn 2.** `report` with `partPrice: "125.00"`. Two turns instead of 6–10. Afterwards (no LLM) the
success bumps `s_9f2.stats`.

**Failure path.** The app renamed Save → Add. Steps 1–4 replay; step 5's chain finds nothing; replay
stops and returns `4/7 ok, FAILED at step 5 … not run: 6, 7 … [browser] form still open, nothing
submitted`. Turn 2 the agent is in ordinary agentic mode from that page state: rule 3b/10 → `snapshot`,
turn 3 → batch `[click Add, wait_for, read]`, turn 4 → report. Fields are not re-filled or
double-submitted because the result said exactly what ran. After the success, `compile` stitches the
skill's steps 1–4 + the recorded repair actions into a provisional **variant**; `failedAtStep[5]++` on
the original. Once the variant validates it replaces the original in the listing.

The model therefore *chooses* and *binds*; it never sees individual steps replay; it *resumes* on
failure with a rule it already has; it still *reports*, so live read-back guarantees are unchanged.
Tier A (§8) is the only path that bypasses the model, and it falls into this one on partial failure.

### 5. Promotion rules (what counts as evidence)

- First compile → `provisional`. Listed to the agent, marked "(unverified: 1 run)".
- Second clean end-to-end replay (`ok: true` and the instruction's report is `success`) → `validated`.
- A failed replay at the same step twice in a row → `demoted` from listing until a variant succeeds.
- Stage 1 keeps it this simple on purpose; the notes' cost/probability optimisation (§15) needs the data
  this produces first.

### 6. Stage-2 groundwork: structural page fingerprint — `src/daemon/fingerprint.ts`

Minimal version of notes §11: in-page function walks the DOM, emits normalised paths
(`body/main/section/div/button`, tags + roles + stable classes, no text/ids/hashes), hashes each into a
fixed 1024-dim bag, L2-normalised. ~100 lines, one round trip, stored on every compiled skill and step.
**Stage 1 does not act on it** beyond computing cosine similarity to the skill's stored start-page
fingerprint and logging it in the replay result — so that by the end of Stage 1 we have `(similarity,
replay outcome)` pairs from real runs and can set a threshold from data instead of guessing.

### 7. Metrics and bench

- `do` result gains `skill: { listed: n, invoked?: id, stepsReplayed, stepsTotal, repaired: bool,
  fallthroughs, similarity }`.
- Harness (`bench/harness.mjs`) gains `--learn <store-dir>`: sets `SITELOOPER_SKILLS=1` with an
  isolated skills home so bench runs never pollute (or read) the user's real store, and records per run:
  **deterministic fraction** `A_n = tool actions executed by replay / total tool actions`, skill hit count,
  repairs, plus the existing cost/turns/tokens.
- A **learning sweep** mode: run the same task K times *sequentially* with the store shared across runs
  and a fresh `--reset` + runid each time; `score.mjs` emits the `A_n`, cost, turns and verified
  correctness **per n**. This is the notes' §18 curve, directly.
- **Perturbation test** (notes §20), not on the bench app yet but on `test/fixture/page.html`: a compiled
  skill, then the fixture served with (a) a button renamed → locator chain fall-through, no repair
  needed; (b) a field removed → step fails → agent repairs → variant compiled; (c) an inserted confirm
  dialog → `dialog_expect` missing → fails → repaired. Asserts the handoff never double-applies.

### 8. Tier A — zero-LLM replay (stretch, do last)

If the incoming instruction, normalised (case, whitespace, quotes) and with slot values captured by the
template regex, matches a `validated` skill exactly → replay without any model call → if `ok`, synthesise
the report from `reportTemplate` with live read-back values substituted; if not `ok`, fall into Tier B with
the partial result already in the first user message. Flag the result `skill.tier: 'A'`. This is what
makes a fixed-wording CI test plan approach zero marginal inference cost; it is not what the bench
exercises.

## Implementation order

1. Recorder keeps structured `LocatorChain` + state diff per step; recording forced on under
   `SITELOOPER_SKILLS=1` / `--learn`. Tests: existing `codegen.test.ts` still passes (codegen reads
   `chain[0].expr`).
2. `compile.ts` + `store.ts` + `skills` CLI. Tests: parameterisation, url normalisation, dedupe/merge, round-trip.
3. `replay.ts` + `run_skill` tool + candidate listing + prompt clause. Tests against the fixture page,
   including the three perturbations and the partial-failure handoff.
4. Auto-compile on success, variant-on-repair, promotion rules. Test: two-run fixture sequence promotes.
5. Fingerprint module, stored + logged. Test: same page twice → 1.0; fixture vs perturbed fixture → high;
   fixture vs bench app → low.
6. Harness `--learn`, learning sweep, `score.mjs` per-n metrics. Run locally first (repairdesk is local,
   `node bench/app/server.mjs`), then the cloud routine for N≥3 sweeps of K=5.
7. Tier A, if 1–6 land cleanly.

Each step is committed on `main` as it lands, with the README section for skills written at step 3 (the
outer-agent contract changes: the skill doc must tell the orchestrator that repeated steps get cheaper
and that it should not re-split work unnecessarily).

## Success criteria for Stage 1

On a repairdesk learning sweep of K=5 sequential runs (optimised config, escalation off, same cheap inner
model), externally verified:

- correctness stays 6/6 on every run (non-negotiable — the verifier decides, not the report);
- run-5 cost ≤ 50% of run-1 cost (run 1 ≈ $0.072 today; the floor is the orchestrator's own ~7 turns);
- `A_5` ≥ 0.7 deterministic fraction of inner tool actions;
- no skill ever replays a state-changing action from the wrong page (precondition refusals logged, zero
  wrong-page mutations in the mutation log);
- the three fixture perturbations pass with no double-applied action.

And qualitatively: `skills show` output is readable enough that a human can tell what a stored procedure
will do before it runs.

## Decisions taken in this plan (flag if you disagree)

- **Skill = instruction-sized procedure, invoked by the inner agent as a tool** (Tier B) rather than a
  separate zero-LLM front door as the core. Driven by the orchestrator-wording finding above; Tier A is
  kept as a stretch for fixed-wording callers.
- **Deterministic parameterisation** (literal co-occurrence between instruction and step args), no model
  call at compile time. Cheap, auditable, good enough for names/numbers/urls; semantic slot naming is a
  Stage 2 nicety.
- **Store on first success but mark provisional; validate on second.** One success is evidence, not proof
  (scref3).
- **Skills keyed by origin, stored in the user's home, isolated for bench runs.** App-agnostic boundary
  preserved: nothing app-specific is compiled into the tool; everything app-specific lives in the store
  the tool *learned*, which the user can inspect and delete.
- **Soft expectations in Stage 1** (log, don't fail) for diff-derived text checks; hard for url, action
  errors and recorded assertions. Lets us measure false-failure rates before tightening.

## Explicitly out of scope (Stage 2+)

- Template/family recognition across *different* pages (fingerprint nearest-skill lookup, URL families,
  variants) — Stage 1 only collects the vectors.
- Trajectory minimisation (dropping orientation reads/detours), cross-instruction subskill discovery
  (`login(site)` shared by many instructions), Playwright-code export of skills (codegen already exists
  for the raw recording; skills export can reuse it).
- The cost/probability mechanism-selection optimiser (§15) and learned thresholds (§12).
- Demotion on environmental drift beyond the simple two-strikes rule.

## Multi-run flow sweep: full 6-objective flow, record-once then replay (2026-08-23)

Ran `bench/sweep.mjs --flow` (K=4) on the full `repairdesk-ticket-flow` task (6
objectives: create ticket, add two parts, edit a cost, drive status to Ready
under its precondition, remove both parts, archive). First added the missing
`--flow` parse to the sweep (it computed `flowsDir`/`replayOnly` from
`own.flow` but never populated it). Run 1 records with the orchestrator
(GLM-5.3, novita) in a `--learn` session and exports flow `rd-flow`; runs 2-4
replay that flow with **no orchestrator** (`sitelooper run`), each app-reset
and re-parameterised by runid, each externally scored against `/__log`.

Result — every run 6/6 objectives externally verified:

| run | mode | verified | orch cmds | wall_s | notes |
|-----|------|----------|-----------|--------|-------|
| n1  | record (orchestrator) | 6/6 | 11 | 1442 | $0.4565; compiled 11 skills |
| n2  | replay (no orchestrator) | 6/6 | 0 | 803 | 11/11 steps ran |
| n3  | replay (no orchestrator) | 6/6 | 0 | 472 | 11/11 steps ran |
| n4  | replay (no orchestrator) | 6/6 | 0 | 508 | 11/11 steps ran |

Per-step honesty (consistent across n2/n3/n4): all 11 steps carry a pinned
skill, but they replay in three tiers —
- **Tier A, genuinely zero-model** (0 turns): add part A, add part B, both
  edits (steps 02-05). The core mutation steps are deterministic.
- **Tier B, small inner-agent** (`run_skill`, 2-5 turns): the status-change,
  report, and final-verify steps (06-08, 11).
- **Full recovery every run** (`tier:null`, 12-22 turns): sign-in+create (01),
  remove-both-parts (09), archive (10). Their pinned skill does not replay
  cleanly, so each falls to the recovery model (deepseek-v4-flash) from scratch.

So the strong, defensible claim is **orchestrator-free**: the caller pays once
(run 1), and later executions reproduce the entire 6-objective outcome with no
orchestrator in the loop, faster than the record run (~8-13 min vs 24 min).
It is **not** end-to-end zero-model: 3 of 11 steps recover via the cheap model
on every replay. `repinned:0` on all replays — the flow-recovery path is not
yet healing those steps back into the flow, so they never converge to Tier A.

Known reporting gap: the sweep prints `usd=0` for replay runs because
`flowrun.json` carries no cost field. That is a measurement gap, not truth —
the recovery/Tier-B steps spend real (cheap) inner-model tokens. Next durability
targets: (a) make sign-in/create, bulk-remove, and archive compile into stable
replayable skills (the remove step is a repeat-until-empty loop the single-shot
recorder captures poorly); (b) wire the flow-recovery path to re-pin an improved
skill so a recovered step converges to Tier A on the next run; (c) price inner
spend in flow replays so the cost curve is honest.

## Converging the unstable flow steps (2026-08-23)

The flow1 sweep left 3 of 11 steps recovering on the model every replay
(sign-in/create, remove-both-parts, archive) and `repinned:0` — nothing healed.
Root causes, found by reading the stored skills rather than guessing:

- The action **locators were already durable** (testid+role chains); the earlier
  "raw @eNN handle" theory was wrong — `describeTarget` re-derives chains from
  @refs. What actually broke replay:
- **Fatal inspection steps.** The sign-in skill carried ~11 `eval` DOM probes the
  model used to orient itself; an `eval` assumes the record-time DOM and, unlike
  a read (which replay skips on failure), is *fatal* — so the skill stopped
  part-way and recovered every run. Archive had the same via a trailing `eval`.
- **No re-pin on recovery.** `runFlow` only re-pinned when `result.skill.repaired`
  was set, which a fresh model recovery never sets — so a recovered step recovered
  again next run and never converged.
- **Remove was a hard-coded pair**, not a loop over the parts.

Four changes (durable-chains item turned out already done):
1. **compile: strip inspection-only steps** (`eval`, `screenshot`, unreported
   reads); keep actions and the read-backs that feed reported values.
2. **compile: `foldLoops` + `coalesceControls`** — collapse a run of identical
   action groups that differ only in a per-record id into one generic `loop`
   step that repeats while its guard locator still matches. Coalesce first
   folds away the recorder's uneven `dialog_expect` re-arming that otherwise
   misaligns the groups. Conservative: distinct fields never fold. New `loop`
   support in `replaySkill` (`runOneStep` extracted, `runLoop` added).
3. **runFlow: re-pin on recovery** — when a pinned skill fails to replay and only
   the model finishes the step, pin the freshly-compiled skill so it converges.

### Measured — flow2 sweep (K=4, same 6-objective task)

| run | mode | verified | notes |
|-----|------|----------|-------|
| n1 | record | 6/6 | sign-in skill compiled to 14 steps (was 25) — inspection stripped |
| n2 | replay, no orchestrator | 6/6 | 2 steps recovered, **repinned 3** (flow1 was 0) |
| n3 | replay, no orchestrator | **5/6** | halted at the status-Ready precondition step (300s timeout) |
| n4 | replay, no orchestrator | 6/6 | |

What the fixes bought, honestly:
- **Strip inspection: works.** No skill carries `eval`/`screenshot` any more; the
  sign-in skill shrank 25→14 steps and no longer dies on a probe.
- **Re-pin: works mechanically** (`repinned:3` vs `0`) but does **not** yet give
  reliable convergence — the sign-in step recovered on both n2 and n3, so the
  recovery-compiled skill still isn't replaying clean. More work needed there.
- **The dominant reliability risk is now a genuinely hard step**, not a skill bug:
  "discover the preconditions for status Ready, satisfy them" is exploratory and
  ran 17 turns (success) on n2 but 27 turns (300s timeout) on n3. That variance
  is model-bound; skills don't capture open-ended discovery well.
- **The loop only fires when one instruction iterates over records.** flow2's
  orchestrator issued the two deletes as *separate* BP calls, so there was no
  in-instruction repetition to fold — the loop is orchestrator-chunking-dependent.

### Loop proven directly (browser test, no model)

Because Novita ran out of balance mid-session (a flow3 sweep 403'd on the first
orchestrator call), the loop was proven without an orchestrated sweep: a
browser-gated test records deleting two rows, confirms `compileSkill` folds them
into one `loop` step, and replays it against a **three**-row list — the loop runs
until the list is empty, clearing a list *longer* than the one recorded, zero
model. That is the generalisation the fold is for.

### Still open
- Recovery-compiled skills don't reliably converge to Tier A (re-pin lands but the
  next replay still drifts) — needs the recovery recording to compile a cleaner,
  more positional-independent skill.
- The status-precondition step needs either a higher per-step budget or to be left
  as an explicitly model-driven step in the flow.
- A fresh orchestrated flow sweep to re-measure end-to-end is blocked on Novita
  balance.

## OpenRouter for both roles + fold fix (2026-08-23)

Novita ran out of balance, so both roles were moved to OpenRouter (no code change
needed — orchestrator via `--provider openrouter`, inner agent via
`SITELOOPER_PROVIDER=openrouter`). Pairing: **glm-5.3 orchestrator + glm-5.2
inner, escalation off** (the OpenRouter preset carries no fallback).

### flow4 sweep (K=4, OpenRouter) — all four runs 6/6

| run | mode | verified | wall_s | cost |
|-----|------|----------|--------|------|
| n1 | record | 6/6 | 763 | $0.041 |
| n2 | replay, no orchestrator | 6/6 | 348 | $0 orch |
| n3 | replay, no orchestrator | 6/6 | 179 | $0 orch |
| n4 | replay, no orchestrator | 6/6 | 296 | $0 orch |

OpenRouter is both cheaper and faster than the novita run: the record run cost
**$0.041** (vs novita's $0.457, ~11× cheaper) and replays ran ~180–350s (vs
novita ~470–610s). Reliability was better too — 4/4 clean vs novita's 3/4.
Re-pin fired (3 on n2, 2 on n3). Convergence is still partial: sign-in (01) and
the read-heavy verify (08) recover run-to-run; 06-create converged to zero-model.

### Fold defect found and fixed

The fresh OpenRouter skills exposed a real bug: consecutive **read-backs** (same
shape, per-record ids) were folding into `loop` steps — reads observe, they do not
iterate. Non-fatal on replay (a read-loop repeats a harmless read to its cap) but
wrong, and it was degrading exactly the read-heavy verify step's convergence.
Fixed: `foldLoops` now only folds groups anchored on a **click** with no
read/read_all/eval/screenshot inside. Regression test added; the delete-loop
browser test still passes under the stricter rule. A clean re-measure (flow5) runs
with the fix in place.

### flow5 (clean, fold fix) — re-pin is non-monotonic

All 4 runs 6/6 verified; record $0.042. But zero-model steps went **7/12 → 3/12 →
3/12** across the replays, and wall-clock rose (269 → 772 → 520s). The fold fix
worked (0 read-loops; the read-heavy verify step replayed zero-model on n2), but
the bigger finding is that **re-pin does not converge — it can degrade the flow.**

Root cause: the head step (sign-in + create, one big instruction) does not replay
deterministically. When it recovers, the model drives the browser into a slightly
different state, which trips the *next* steps' preconditions even though their
skills were unchanged — so a single non-deterministic head step cascades into
several downstream recoveries. Re-pinning the head with a recovery-compiled skill
does not fix it (that skill is just as non-deterministic), and replacing a clean
recorded skill with a recovery-compiled one is often a downgrade.

Correctness is never at risk — recovery rescues every run, so verified stays 6/6 —
but the promise "cheaper over successive runs" is not met by blind re-pin.

Recommended next (not yet done — a design decision):
- Do NOT blindly replace a step's skill on first recovery. Either keep the
  original and add the recovery as a *variant*, letting the existing
  promote-on-2nd-success / demote-on-2-strikes lifecycle pick the winner, or only
  replace after the original has failed K times.
- Attack the head step directly: split sign-in into its own small deterministic
  skill so its recovery can't cascade into create/add/edit.

### OpenRouter-for-both: settled

Both roles run on OpenRouter with no code change (glm-5.3 orchestrator + glm-5.2
inner, escalation off). Across flow4+flow5, 8/8 runs were 6/6 verified, the record
run costs ~$0.04 (vs novita $0.46), and replays run ~2× faster than novita. That
part is a clear win; the convergence work is where the open problem now sits.

## 2026-08-24 — overnight build: the design decision landed (and validated)

Both "recommended next" items above were built overnight, plus the drift/repair
machinery (spec: PLAN-overnight.md; commits da4048f..93a28b5):

1. **Lifecycle-gated adoption** replaced the blind re-pin: candidates are chosen
   per run by track record (validated > success rate > uses; demoted excluded),
   failures recorded so promote/demote governs adoption, and a step re-pins only
   to a validated skill that just replayed cleanly.
2. **Segmentation**: compile splits recordings at page-template seams (url
   pattern change + a live structural fingerprint captured at each seam) into a
   chain of per-page skills (`seq {chain,index,of}`), each independently gated,
   recoverable, and promotable. The sign-in+create monolith now auto-splits.
3. **Drift telemetry**: every primary-locator miss becomes a structured
   DriftTicket (with the localized-vs-redesign similarity attached) in
   `<runid>-drift.json`. Recording only — never inline repair.
4. **Post-session repair** (`sitelooper skills repair --drift <file>`):
   promote proven fallbacks (no model), model-patch dead locators on the live
   page into provisional variants that must earn adoption, flag redesigns for
   re-record.

flow7 validation (K=4 + post-repair replay, OpenRouter glm-5.3): 6/6 verified
every run; zero-model steps 5/8 on every replay run — **monotone at last** (flow5
was 7/12→3/12→3/12). The head chain validated to 7/7; store stayed at 14 skills
(flow5: 24 for fewer steps). Running `skills repair` on run 4's 11 tickets gave
3 fallback promotions + 1 honest re-record flag; the next replay emitted 4
tickets (11→4) and was the fastest of the sweep. The remaining tier-B steps
(06 supplier-gate branch, 07 delete-loop order, 08 list verify) recover on app
logic/non-determinism, not selector drift — the next frontier is behavioural
branches inside skills, not locators.

Two cascade defects found and fixed by the sweeps: goto-first skills were
refused by start-url (redirect race — now replay skips the start-page gate when
step 1 navigates), and recovery models renaming read-back keys broke
`{{step.output}}` threading (now aliased when cosmetically equal).

The bench app gained `/__drift?mode=labels` (serve renamed control wording
in-memory) for repair validation against simulated redesigns.
