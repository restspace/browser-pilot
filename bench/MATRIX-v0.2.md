# v0.2 replay matrix (2026-09-02)

v0.1 measured four arms doing a task **for the first time**. This file measures
what happens on every run after that: the same recorded flow, replayed. Two
arms replay; the v0.1 first-run cells for agent-browser, playwright-mcp and
browser-use stand unchanged (those tools re-derive the task every run — their
"replay" cost is their first-run cost, every time — so re-running them would
have measured nothing new).

- **sleep-walker** (browser-pilot): set-15 sweeps — a fresh recording (n1)
  plus two flow replays (n2, n3) per target, candidate ladders + slots +
  effect gates + scoped model recovery.
- **playwright-codegen**: set-16 — the SAME n1 recordings emitted as literal
  Playwright scripts (`bench/codegen-replay.mjs`, commit 2c5f427): one locator
  per gesture, literal values and URLs, Playwright's own auto-waiting, no
  fallbacks, no effect gates, no recovery, no model. Two replays per target.

Success is **externally verified** per run — the app's mutation log
(repairdesk), JSON-RPC state (odoo, kanboard), or HTTP API state (grafana) —
never from the arm's self-report. Every raw count is in the run's published
files under bench/results-published/ (`results/<tag>` branches, merged).

## How the codegen arm was built, and the fairness line

`playwright codegen` itself is a human at a browser, which does not ship in a
benchmark box. The session recording already stores, for every gesture, the
locator expression codegen would have emitted (role/name first, the same
preference order), so the generator emits those verbatim. What a codegen user
gets, this arm gets:

- **Included**: every recorded gesture (goto/click/dblclick/fill/type/press/
  check/hover/drag/dialog/wait_for), strict and fatal on failure; recorded
  reads as best-effort scrapes (the "assertions added by hand" concession).
- **Excluded**: eval and screenshot steps — the recording model *looking* at
  the page to decide its next move. Codegen records no observation. Audited:
  none of the skipped evals mutate the page.
- **One rewrite**: the recorded runid is swapped for the replay's runid, in
  values and locator text alike. Any human shipping a codegen script
  parameterises that much. Nothing else — URLs keep their baked record ids,
  locators keep their baked literals; that is the point of the arm.

Known unfairness, both directions, disclosed where it bit:

- The recording includes the model's exploration and recovery gestures, which
  a human recording would not (this decided the odoo cell — see below).
- The recording's locators are *better* than typical codegen output: the
  recorder actively fights for testids and role/name and rejects unstable ids
  (this decided the kanboard cell — see below).

## The matrix

Per target: sleep-walker rows are n2/n3 flow replays (n1, the recording that
both arms share, shown for context). Codegen rows are r1/r2. "verified" counts
the app-side verifier's objectives; UNVERIFIABLE means the objective is
report-only and a static script produces no report — a structural limit of the
arm, listed as such rather than folded into pass or fail.

### repairdesk (in-repo SPA, stable routes, testids everywhere)

| arm | run | verified | model turns | cost | wall | script outcome |
|---|---|---|---|---|---|---|
| (shared recording) | n1 | 7/7 | 7 | $0.038 | 495s | — |
| sleep-walker | n2 | 7/7 | 12 | $0.004 | 80s | 6/6 steps |
| sleep-walker | n3 | 7/7 | 12 | $0.003 | 83s | 6/6 steps |
| codegen | r1 | **6/6** | 0 | $0.00 | 36s | **crashed 81/89, exit 1** |
| codegen | r2 | **6/6** | 0 | $0.00 | 36s | **crashed 81/89, exit 1** |

Codegen's best target — and both runs report failure after doing all the work.
The final gesture (a click on the show-archived checkbox, part of the
recording's own verification tail) resolves instantly and never becomes
actionable within 30s, deterministically, on Windows and Linux alike. The
verified work and the exit code disagree; nothing in a static script can tell
which one is lying. Also disclosed: a locator baked with the recorded ticket
id (`ticket-row-t15`) resolved correctly only because a fresh reset re-mints
ids deterministically — luck, not robustness.

### kanboard (server-rendered PHP, drag-and-drop)

| arm | run | verified | model turns | cost | wall | script outcome |
|---|---|---|---|---|---|---|
| (shared recording) | n1 | 6/6 | 7 | $0.046 | 398s | — |
| sleep-walker | n2 | 4/4 + 2 report | 0 | $0.00 | 19s | 6/6 steps |
| sleep-walker | n3 | 4/4 + 2 report | 0 | $0.00 | 19s | 6/6 steps |
| codegen | r1 | 4/4 (+2 UNVERIFIABLE) | 0 | $0.00 | 62s | 22/22 clean |
| codegen | r2 | 4/4 (+2 UNVERIFIABLE) | 0 | $0.00 | 62s | 22/22 clean |

Codegen's genuine win, including the drag to "Work in progress" and — checked
by JSON-RPC after each replay — zero contact with the seed tasks. Why it won
is the instructive part: the recorded locators were **title-keyed**
(`hasText: '<runid>'`), which the runid swap re-targets, and SQLite re-minted
the same task id (4) after every reset, so even id-shaped state lined up.
Title-keyed locators are exactly what the recorder fights to produce; kanboard
shows that when the locators are already semantic, replaying them without the
ladder works. The warts still showed at the edges: both runs missed the same
two reads on a locator with the recorded **time of day** baked into it
(`Due date: 12/31/2026 17:40`), and the two report-only objectives are
unanswerable. sleep-walker replays the same flow 3× faster with the reports.

### grafana (React SPA, minted uids, animated editor)

| arm | run | verified | model turns | cost | wall | script outcome |
|---|---|---|---|---|---|---|
| (shared recording) | n1 | 6/6 | 7 | $0.750 | 1609s | — |
| sleep-walker | n2 | 6/6 | 74 | $0.144 | 583s | 9/9 steps |
| sleep-walker | n3 | 5/6 | 133 | $0.250 | 592s | 9/9 steps |
| codegen | r1 | **0/6** | 0 | $0.00 | 35s | **crashed 23/89, exit 1** |
| codegen | r2 | **0/6** | 0 | $0.00 | 34s | **crashed 23/89, exit 1** |

Total loss, and not where predicted. The expected killer — the goto at gesture
66 to `/d/<uid-minted-during-recording>/...` — was never reached: both runs
died 43 gestures earlier, clicking the freshly created panel's title while the
editor was still animating in. The element resolves immediately
(`<h2 id="_r2o_" ...>` — note the React useId our recorder rejects on sight)
and never becomes actionable. The generator had skipped **50** observation
steps from this recording — the model watching the page settle between
gestures — and those pauses turn out to be load-bearing. Playwright's
actionability auto-wait is not a substitute for knowing what you are waiting
for. Confirmed by API after both runs: no dashboard was ever created. The uid
goto and the settings-save silent-drop check both remain untested behind this
earlier wall, with the drop-check unobservable to this arm in principle.

### odoo (dense server-rendered CRUD, minted record ids in URLs)

| arm | run | verified | model turns | cost | wall | script outcome |
|---|---|---|---|---|---|---|
| (shared recording) | n1 | 6/6 | 10 | $0.571 | 1827s | — |
| sleep-walker | n2 | 6/6 | 182 | $0.492 | 1215s | 8/8 steps |
| sleep-walker | n3 | 6/6 | 121 | $0.045 | 598s | 8/8 steps |
| codegen | r1 | **0/6** | 0 | $0.00 | 8s | **crashed 27/88, exit 1** |
| codegen | r2 | **0/6** | 0 | $0.00 | 4s | **crashed 27/88, exit 1** |

Died on a strict-mode violation: a recorded click's `button "Activate"`
locator matched **31 elements** on the Apps kanban. **Caveat, in codegen's
favour**: that gesture came from the recording model's exploration detour — a
human codegen recording would not have wandered into Apps, so this cell
overstates codegen's fragility at gesture 27 specifically. It does not change
the destination: the baked `id=21` goto waiting at gesture 54 points at a
record confirmed by JSON-RPC not to exist in the replay's database, so a
tidied script dies there instead — failure deferred, not avoided. Confirmed
after both runs: no record of any run, seed or otherwise, was touched.

## What the cells say

1. **Static replay is bimodal, and the mode is a property of the app, not
   the script.** Stable routes plus semantic names (repairdesk, kanboard):
   near-perfect, free, fast. Minted ids or animation-gated interactivity
   (grafana, odoo): zero, deterministically, in the first third of the
   script. There is no middle: no cell in this matrix shows codegen partially
   degrading — it either walks the flow or hits a wall.
2. **The exit code and the truth are strangers.** repairdesk: exit 1 with 6/6
   app-verified work, twice. The inverse — exit 0 over a silently wrong
   outcome — is the standing failure mode this bench's effect gates exist to
   kill (fwkb1's wrong-column move, fwgr19-n3's dropped time range), and a
   static script has no organ for noticing either direction.
3. **What the model was doing in the recording was work, not overhead.** The
   grafana script died precisely where 50 observation steps were cut out.
   Recording-as-code keeps the gestures and discards the judgement; this
   matrix prices the judgement.
4. **Reports are part of the task.** Every target has objectives whose answer
   is something read off the page. A static script can scrape text but cannot
   answer; those objectives are structurally UNVERIFIABLE for this arm.
5. **The sleep-walker cost column is the trade stated plainly.** Its replays
   pay $0.00 exactly where codegen also succeeds, and $0.04–$0.49 exactly
   where codegen scores zero — the recovery machinery bills only when it is
   the difference between a result and a wall. (The odoo/grafana replay churn
   is tracked as an open improvement; fwod30-n3 at $0.045 is the trend line.)

## Raw data

Set 15 (sleep-walker): fwrd39, fwkb2, fwgr19, fwod30 — sweep.json, per-run
flowrun/drift/script files. Set 16 (codegen): cgrd2, cgkb1, cggr1, cgod1 —
per-replay spec.mjs (the generated script itself), log, result.json. All under
bench/results-published/. The local Windows smoke (cgrd1, identical outcome to
cgrd2) is in the session record but not published as a matrix cell — published
cells are cloud-only per bench/CLOUD-RUNBOOK.md.

Conditions: commit 2c5f427 for all set-16 runs; set-15 runs at b12636a. Same
task files, same resets, same verifiers as v0.1. Codegen boxes ran with no
model API key exported — $0.00 is by construction, not by accounting.
