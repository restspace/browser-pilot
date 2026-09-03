# sleep-walker vs the field — the two matrices that matter (2026-09-03)

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

sleep-walker cells are the set-26 recordings (2026-09-03, build e048128:
fresh goal, learning on, release 0.3.0 stack: glm-5.3 orchestrator,
deepseek-v4-flash inner with glm-5.3 escalation), with the set-24 cell they
replaced in parentheses. agent-browser cells are the set-17 phase-A runs
(2026-09-02, same commit era, glm-5.3). playwright-mcp and browser-use ran
only in the v0.1 depth slice (repairdesk); those cells are quoted from
MATRIX-v0.1.md unchanged.

### repairdesk (in-repo SPA)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 7/7 (7/7) | $0.09 ($0.14) | 819s (1120s) |
| agent-browser | 6/6 | $0.19 | 67s |
| playwright-mcp (v0.1, ×3) | 6/6, 6/6, 6/6 | $0.42–0.50 | ~275s median |
| browser-use (v0.1, ×3) | 0/6, 0/6, 0/6 | $0.01–0.04 | ~154s median |

### kanboard (server-rendered PHP, drag-and-drop)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 (6/6) | $0.04 ($0.07) | 385s (1074s) |
| agent-browser | **2/6 (turn-cap)** | $0.77 | 118s |

### grafana (React SPA)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 (6/6) | $0.48 ($0.18) | 2037s (1253s) |
| agent-browser | 6/6 | $1.05 | 448s |

### odoo (dense server-rendered CRUD)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 (6/6) | $0.59 ($0.05) | 1651s (1094s) |
| agent-browser | 6/6 | $1.51 | 302s |

(Set 26 recordings against set 24: the two light apps got cheaper and
faster, the two heavy apps dearer and slower — a first-contact recording is
a model-driven procedure and varies run to run; set 24's odoo and grafana
recordings happened to be efficient ones, set 26's took longer paths.
Recording time is dominated by the inner model's latency, not the engine:
fwrd41's ten instructions replayed in 18 seconds total.)

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
| repairdesk | **7/7, 7/7** · $0.00, $0.00 · 18s, 18s | 6/6 · $0.19 · 67s every time | 1/6, 1/6 · $0 · 31s | 6/6, 6/6 · $0 · 36s |
| kanboard | **6/6, 6/6** · $0.00, $0.00 · 21s, 21s | 2/6 · $0.77 · 118s every time | 5/6, 5/6 · $0 · 32s | 4/4 (+2 n/a), same · $0 · 62s |
| grafana | **5/6, 5/6** · $0.18, $0.55 · 661s, 1864s (set 26 as recorded; the set-24 recording re-exported on the fixed engine, rpgr10: 6/6, 6/6 · ≈$0.01, ≈$0.08 · 151s, 272s) | 6/6 · $1.05 · 448s every time | 0/6, 0/6 · $0 · 17s | 0/6, 0/6 · $0 · 35s |
| odoo | **6/6, 6/6** · $0.16, $0.01 · 661s, 189s | 6/6 · $1.51 · 302s every time | 1/6, 1/6 · $0 · 77s | 0/6, 0/6 · $0 · 8s |

(sleep-walker cells are set 26 — fwrd41, fwkb4, fwgr25, fwod32 on build
e048128, 2026-09-03 — replacing set 24. Set 26 in one line: repairdesk and
kanboard replay every step at tier A with zero model turns, 18s and 21s,
$0.00; odoo verified 6/6 on all three runs but its replays paid 91 and 35
turns where set 24 paid 6 — the fresh recording's sign-in navigated to the
recording run's own action id (a minted value the compiler left literal
after `=`) and expected a `cids` url key odoo did not add this time, both
fixed on c64270f; grafana's fresh recording verified 6/6 and both replays
5/6 at 96 and 184 turns — its sign-in's only recorded effect was a transient
"Loading" status line (fixed on 46ace89), its create step went through a
Cancel click on a dialog that does not recur, and objective 1 fails because
that recording never read the provisioned panel titles back from the page,
so a replay has nothing to republish. The grafana row therefore keeps the
rpgr10 cell alongside: same task, the set-24 recording, re-exported by the
fixed engine, 6/6 on both replays. What follows is the set-24 account,
kept because its diagnosis is what the fixes above came from.

Set 24 — fwrd40, fwkb3, fwgr23, fwod31 on build b9ccbca — replaced set 15
for repairdesk/kanboard/odoo and set 23 (fwgr22) for grafana. Success is the sweep's inline verifier, run right
after each replay; the post-sweep `*-verify.txt` files show earlier runs as
"not found" only because the sweep resets the target between runs. kanboard
replays: 4/4 app-state objectives verified plus both report-only objectives
answered from the flow's own step reports — scored 6/6, as in set 15; the
codegen arm cannot answer report objectives at all.

What moved, and why. repairdesk converged: both replays ran all eight steps
at tier A with zero model turns in 17 seconds (set 15 spent ~12 turns
re-deriving its first step). odoo's recovery cascade is gone: 182 and 121
turns fell to 6 and 6, all in the sign-in step, whose second recorded click
does not show its recorded page changes within the gate. kanboard and
grafana REGRESSED against their previous cells (0 turns/19s; 6/6, 6/6),
and every cause was engine-side, introduced by the correctness pass that
b9ccbca carries (f24bdf9) or exposed by it: a slot used only in a recorded
expectation had become a required param bound by origin, so a skill whose
origin value was not published refused to bind at all (grafana 05-open at
19 and 44 turns; kanboard-n3 03-create at 14); kanboard's due-date textbox
is named after the current clock minute, so the fill's expectation could
never match (12–23 turns per replay); a column name published with a
trailing space was an identity marker compared byte-for-byte (kanboard
03-create refused on n2); and grafana renders its third panel heading only
on scroll, so the replay read two titles and objective 1 failed on both
replays. The rebuild gate (test/rebuild.test.ts) had measured the first of
these — fwod27 38→32 and fwgr14 20→18 cross-step refs — but ran against a
stale dist/ and passed. All four are fixed on f727c89 (0d59158, 24ac868,
f727c89: expectation slots re-inlined rather than parameterised; clock and
calendar tokens masked at compile and replay; whitespace-insensitive
identity; an unresolved reference the pinned procedure cannot use no longer
skips tier A; one page sweep before a read is skipped; the gate refuses a
dist older than src). The set-24b rows below replay the SAME set-24 flows
and stores on f727c89, which is the only clean A/B of those fixes; set 24's
own cells stand as recorded. Earlier intermediate runs: fwgr2[0-2]-*,
rpgr[2-6]-*.)

### Set 24b — the same flows on the fixed build (replay-only A/B)

| target | set 24 replays (b9ccbca) | set 24b replays (f727c89) |
|---|---|---|
| kanboard (fwkb3 flow, rpkb1) | 22 and 37 turns · 272s, 555s · $0.010, $0.014 | **0 and 0 turns · 56s, 56s · $0.00** · 4/4 app-state objectives both; every step tier A |
| grafana (fwgr23 flow, rpgr7) | 4/6, 5/6 · 19 and 44 turns · 286s, 601s | 4/6, 6/6 · 23 and 56 turns · 399s, 815s — not fixed by f727c89; see below |
| grafana (fwgr23 flow, rpgr8 on 4b15bb4) | as above | **5/6, 5/6** · 30 and 30 turns · 415s, 272s — objective 1 now passes on both (all three titles read at tier A); objective 5 fails on both because 05-open is still a model recovery that does not persist the refresh setting |
| grafana (fresh recording fwgr24 on 58579d3, set 25) | — | n1 6/6 · $0.50 · 1839s; **n2 halted 2/6** (59 turns); n3 6/6 · 120 turns · 1062s — the model's create step went through an accidental "Discard changes?" dialog that the compiler made a required effect; fixed on 5c124dc (a recorded dialog that does not open is conditional UI) |
| grafana (fwgr23 recording re-exported on 5c124dc, rpgr9: flow AND skills recompiled) | as above | r1 halted 1/6; r2 6/6 · 51 turns · 459s — the raw recompile was poorer than the published, replay-refined store, and the rebuild bound two steps with no params (fixed 08cf104) |
| grafana (fwgr23 recording, flow re-exported on 08cf104 + published store, rpgr10) | as above | **6/6, 6/6** · 29 and 44 turns · 151s, 272s · ≈$0.01, ≈$0.08 — steps 01–04 and 06 at tier A with 0 turns; 05 still recovers on a drifted locator in its stored skill |
| odoo (fwod32 recording, set 26b, rpod3 on 6ad5cde) | 6/6, 6/6 · 91 and 35 turns · 661s, 189s | published store + re-exported flow: **6/6 · 31 turns · 213s**; store and flow recompiled: 6/6 · 81 and 84 turns · 475s, 739s — the compile-side goto fix shows, but a raw recompile carries none of the two replays' locator evidence and the app's own url state (a menu click landing on a url with fewer state keys than the recording's) still sends the sign-in to recovery |
| grafana (fresh recording fwgr26 on b90852a, set 27) | — | n1 6/6 · $0.39 · 1354s; **n2 halted 2/6** (69 turns); n3 6/6 · 159 turns · $0.72 · 1441s — the recording itself compiled clean (no cancelled dialog, no transient lines, no echoed input), and the create step's second click on the visualization picker crashed the tab to `chrome-error://chromewebdata/` on both replays; the replay then ran eleven more steps on the error page before the next segment refused. Since a7d5d88 a browser error page stops a replay at once. The diagnostic run diaggr1 (same flow and store on 8f65983, with Playwright's protocol log) showed it was never a crash: the create segment's third click on "New" toggled its menu shut, so `link "New dashboard"` did not resolve and the chain fell to its structural fallback `div > … > a:nth-of-type(1)`, which matched Grafana's footer "Support" link to grafana.com; the box has no outbound network, so the tab landed on `chrome-error://chromewebdata/`. Fixed on the resolver: a candidate that resolves inside a link leaving the recorded origin is never taken |
| grafana (fwgr25 recording recompiled on 5a84407, set 26c, rpgr11) | 5/6, 5/6 · 96 and 184 turns | **halted 1/8 twice** — the sign-in stopped on a recorded `alert "Error loading RSS feed"` toast (alert lines are transient since d32f9dd) and the rebuild had compiled the resumed create attempt alone, so its segment expected the retry's page (fixed 075b251); the dismissed-dialog pass itself did what it should — the recompiled store carries no Cancel click and no Discard-dialog expectation |

(The set-25 rows measure one thing: the flow-export rule "an echoed input is
not an output" (4b15bb4) can only show on a flow exported by the fixed
engine. A fresh model-driven recording is a different procedure every time
and fwgr24's happened to be a bad one, so the honest way to isolate the
export rule was to re-export the known-good fwgr23 recording deterministically
— bench/rebuild-flow.mjs does exactly that — and replay it. rpgr10 is the
resulting cell. Costs for replay-only runs are estimated from set 24's rates
for the same models and turn counts; the sweep's own runs carry OpenRouter's
accounted cost.)

(rpgr7 showed the two grafana fixes on f727c89 had the wrong diagnosis. The
third panel title was never a scroll problem: the recording's own
scroll_into_view to that heading put its name in the set of values the skill
"set", so the later read of it was discounted as an echo and dropped. And
05-open's blank `{{04-open.tag}}` is bound to a param the skill DOES use —
the tag word also sits in the dashboard url slug — so the "unused reference"
rule could not apply; the real defect is that the flow referenced, as
04-open's output, a value 04-open's own instruction had typed. Both fixed on
4b15bb4: only a step that can set or select something contributes to the
echo set, and a report value that echoes the step's own instruction is an
input, not an output. The second is a flow-export rule and needs a fresh
recording to show; the first applies to the stored skills as they are, and
rpgr8 replays the same fwgr23 flow on 4b15bb4 to measure it.)

**Reading it**: the static scripts are free and mostly wrong (14/48 verified
objectives for the strongest of them, and odoo's authored script confirmed an
**empty order and left it active** — the wrong-record class sleep-walker's
effect gates exist to kill). Re-running the agent is reliable and costs the
full price forever — $1.05–1.51 per repeat on the heavy apps. sleep-walker's
set-24 replays verified 47/50 objectives as recorded, and with the grafana
flow re-exported on the fixed engine (rpgr10) the four flows replay 50/50;
the three set-24 misses were all engine defects named above, not drift in
the app. Where the
flow has converged the repeat is free and fast — repairdesk at $0.00 and 17
seconds, 4× faster than re-running the agent and the fastest *correct*
repeat on record; odoo, the densest app in the set, at $0.002 and 3–4
minutes, down from $0.49/$0.04 and 20/10 minutes in set 15. sleep-walker's
wall and cost columns are the same metric in disguise — both measure how
much model the replay still needed — and a converged replay runs at the
engine's floor of ~20s. The recurring cost of a known flow trends to zero
without the correctness trending anywhere, and when it does not (kanboard
and grafana here) the cause has each time been a specific, testable engine
rule rather than the app. The statics' short walls elsewhere are mostly
time-to-crash, not time-to-done (grafana authored: 17s to die at login;
odoo codegen: 8s to die on the Apps page).

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

Sets: 26 (fwrd41/fwkb4/fwgr25/fwod32 @ e048128), 25 (fwgr24 @ 58579d3;
rpgr9/rpgr10 re-exports @ 5c124dc/08cf104), 24 (fwrd40/fwkb3/fwgr23/fwod31
@ b9ccbca), 24b (rpkb1/rpgr7 @ f727c89; rpgr8 @ 4b15bb4), 15
(fwrd39/fwkb2/fwgr19/fwod30 @ b12636a), 16 (cg\*), 17 (au\*) @
2c5f427/a9ca517, v0.1 depth/breadth (d\*/b\*/agr\*).
