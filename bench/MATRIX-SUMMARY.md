# sleep-walker vs the field — the two matrices that matter (2026-09-02)

Two questions decide whether this tool earns its place, and each gets one
matrix. **First contact**: given a goal it has never seen, how does
sleep-walker compare with the incumbents on success, cost, and clock?
**Every run after that**: once the flow is known, what does repeating it
cost, and does it stay correct? Success is always the app-side verifier's
count (mutation log / JSON-RPC / HTTP API state), never an arm's self-report.
Full per-run detail and failure anatomy: MATRIX-v0.1.md (first-run grid),
MATRIX-v0.2.md (replay grid + static-incumbent anatomy). Raw files:
bench/results-published/.

## Matrix 1 — first contact (success / cost / clock)

sleep-walker cells are the set-15 recordings (fresh goal, learning on,
current release 0.3.0 stack: glm-5.3 orchestrator, deepseek-v4-flash inner
with glm-5.3 escalation). agent-browser cells are the set-17 phase-A runs
(2026-09-02, same commit era, glm-5.3). playwright-mcp and browser-use ran
only in the v0.1 depth slice (repairdesk); those cells are quoted from
MATRIX-v0.1.md unchanged.

### repairdesk (in-repo SPA)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 7/7 | $0.04 | 495s |
| agent-browser | 6/6 | $0.19 | 67s |
| playwright-mcp (v0.1, ×3) | 6/6, 6/6, 6/6 | $0.42–0.50 | ~275s median |
| browser-use (v0.1, ×3) | 0/6, 0/6, 0/6 | $0.01–0.04 | ~154s median |

### kanboard (server-rendered PHP, drag-and-drop)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 | $0.05 | 398s |
| agent-browser | **2/6 (turn-cap)** | $0.77 | 118s |

### grafana (React SPA)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 | $0.75 | 1609s |
| agent-browser | 6/6 | $1.05 | 448s |

### odoo (dense server-rendered CRUD)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 | $0.57 | 1827s |
| agent-browser | 6/6 | $1.51 | 302s |

v0.1 corroboration for agent-browser (older build, K=3): odoo 6/6 ×3 at
$0.93–1.07; grafana 6/6, 0/6 (spend-cap), 6/6 at $1.33–2.02; repairdesk
6/6 ×3 at $0.13–0.81. The fresh cells above sit inside those ranges.

**Reading it**: on first contact sleep-walker is the *slowest* arm on every
target — deliberately: it drives a cheap inner model and spends extra work
recording verified locators, value provenance, and effect expectations as it
goes. What it buys with that time: the lowest cost on three of four targets
(2–5× cheaper than agent-browser on the light apps, ~2–3× on the heavy ones),
a 25/25 objective record including the kanboard board that turn-capped
agent-browser at 2/6 — and, invisibly in this matrix, the recording that
makes Matrix 2 exist. No other arm leaves anything behind.

## Matrix 2 — every run after the first (success / cost per repeat)

The same four flows, repeated. Three ways to repeat a flow exist in this
bench, plus the null option of just running the agent again:

- **sleep-walker replay** — the recorded flow re-run structurally, model
  waking only for drift (set 15, n2/n3).
- **agent-browser re-run** — no replay mode exists; repeating means paying
  the first-run cost again, every time (cells = Matrix 1, quoted as the
  recurring price).
- **agent-browser → authored script** — the same model writes a Playwright
  script from its own run's command log, replayed cold (set 17; $0 per
  repeat after a one-time ~$0.02–0.04 authoring call).
- **codegen-style script** — the recording emitted as literal
  Playwright code, no judgement (set 16; $0 per repeat).

| target | sleep-walker (r1, r2) | agent-browser re-run | authored script (r1, r2) | codegen (r1, r2) |
|---|---|---|---|---|
| repairdesk | **7/7, 7/7** · $0.004, $0.003 · 80s, 83s | 6/6 · $0.19 · 67s every time | 1/6, 1/6 · $0 · 31s | 6/6, 6/6 · $0 · 36s |
| kanboard | **6/6, 6/6** · $0.00, $0.00 · 19s, 19s | 2/6 · $0.77 · 118s every time | 5/6, 5/6 · $0 · 32s | 4/4 (+2 n/a), same · $0 · 62s |
| grafana | **6/6, 6/6** · $0.016, $0.025 · 714s, 735s | 6/6 · $1.05 · 448s every time | 0/6, 0/6 · $0 · 17s | 0/6, 0/6 · $0 · 35s |
| odoo | **6/6, 6/6** · $0.49, $0.04 · 1215s, 598s | 6/6 · $1.51 · 302s every time | 1/6, 1/6 · $0 · 77s | 0/6, 0/6 · $0 · 8s |

(kanboard sleep-walker replays: 4/4 app-state objectives verified plus both
report-only objectives answered from the flow's own step reports — scored
6/6 here; the codegen arm cannot answer report objectives at all. The grafana
row is set 23 (fwgr22, build 1d5be69). It replaced set 21's fwgr21 cell of
5/6, 5/6 · $0.014, $0.003 · 274s, 109s, whose miss was objective 6: the flow
had no way to publish the dashboard uid, since every read needed a DOM
element — `read what=url` closed that. All three fwgr22 runs verified 6/6 by
the sweep's inline verifier (bench/results-published/fwgr22-sweep.json; the
post-sweep fwgr22-verify.txt shows n1/n2 as "dashboard not found" only
because the sweep resets the target between runs). Both replays HALTED at
step 7 — a report-only final-verification step, after all six objectives
were persisted — on an OpenRouter HTTP 402 (account credits), which is why
the walls are 714s/735s rather than fwgr21's 274s/109s: that includes the
failed recovery. Steps 01/02/04 replayed at tier A with 0 turns; 03/05/06
replayed their skills in full but through 2–3 cheap-model turns each,
because the tier-A replay of 02-create publishes the uid as `dashboard_url`
rather than under the recording's `dashboard_uid` name — an unthreaded
reference, not drift. Earlier intermediate runs: fwgr2[01]-*, rpgr[2-6]-*.)

**Reading it**: the static scripts are free and mostly wrong (14/48 verified
objectives for the strongest of them, and odoo's authored script confirmed an
**empty order and left it active** — the wrong-record class sleep-walker's
effect gates exist to kill). Re-running the agent is reliable and costs the
full price forever — $1.05–1.51 per repeat on the heavy apps. sleep-walker's
replays verify 26/26 objectives at $0.00 where the flow has converged
(repairdesk, kanboard — 19–83 seconds a run) and at $0.02–0.49 where recovery
still fires (grafana, odoo — the convergence trend line: odoo fell from
$0.49 to $0.04 between its two replays, grafana from $0.14/$0.25 at set 15 to
$0.016/$0.025 here). The recurring cost of a known flow
trends to zero without the correctness trending anywhere. On the clock: sleep-walker's wall and cost columns are the same metric in
disguise — both measure how much model the replay still needed. A converged
replay (zero model turns) runs at the engine's floor of ~20–30s and is the
fastest *correct* repeat on record: kanboard 19s here, and repairdesk's
previous sweep (fwrd38) replayed at 27s with 0 turns — 2.5–6× faster than
re-running the agent. The slower cells above are un-converged flows paying
for recovery turns: fwrd39's 80s includes ~12 turns re-deriving its first
step (a tracked recording-quality regression), and grafana/odoo carry
74–182 turns from the two open drift defects — falling with the cost as
repair folds them in (odoo 1215s → 598s, 182 → 121 turns). The statics'
short walls elsewhere are mostly time-to-crash, not time-to-done (grafana
authored: 17s to die at login; odoo codegen: 8s to die on the Apps page).

## Conditions and caveats, so the numbers stay honest

- Same task files, same resets, same app-side verifiers for every cell.
  All published runs cloud-only (bench/CLOUD-RUNBOOK.md), one box per target.
- sleep-walker's inner model changed between v0.1 and set 15 (glm-5.2 →
  deepseek-v4-flash); its v0.1-era first-run costs were $0.27–1.91. The
  incumbents' orchestrator model (glm-5.3) is unchanged throughout.
- playwright-mcp and browser-use have no cells outside repairdesk; the v0.1
  depth slice picked agent-browser as the strongest incumbent, and every
  later set compares against it.
- Every static-script replay (authored and codegen) exited non-zero on every
  run — including repairdesk codegen, which verified 6/6 while reporting
  failure. Exit codes and the truth are uncorrelated in static replay; the
  success columns above are the verifier's, not the scripts'.

Sets: 15 (fwrd39/fwkb2/fwgr19/fwod30), 16 (cg\*), 17 (au\*), v0.1 depth/breadth
(d\*/b\*/agr\*). Commits: set 15 @ b12636a, sets 16–17 @ 2c5f427/a9ca517.
