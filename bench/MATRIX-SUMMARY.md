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
| sleep-walker, set 28 (fwrd42 on 81d2ea2) | 7/7 | $0.07 | 1212s |
| agent-browser | 6/6 | $0.19 | 67s |
| playwright-mcp (v0.1, ×3) | 6/6, 6/6, 6/6 | $0.42–0.50 | ~275s median |
| browser-use (v0.1, ×3) | 0/6, 0/6, 0/6 | $0.01–0.04 | ~154s median |

### kanboard (server-rendered PHP, drag-and-drop)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 (6/6) | $0.04 ($0.07) | 385s (1074s) |
| sleep-walker, set 28 (fwkb5 on 81d2ea2) | 6/6 | $0.21 | 1078s |
| agent-browser | **2/6 (turn-cap)** | $0.77 | 118s |

### grafana (React SPA)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 (6/6) | $0.48 ($0.18) | 2037s (1253s) |
| sleep-walker, set 28 (fwgr27 on 9dcc731) | 6/6 | $0.14 | 1381s |
| agent-browser | 6/6 | $1.05 | 448s |

### odoo (dense server-rendered CRUD)

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker | 6/6 (6/6) | $0.59 ($0.05) | 1651s (1094s) |
| sleep-walker, set 28 (fwod33 on 81d2ea2) | 6/6 | $0.15 | 1335s |
| agent-browser | 6/6 | $1.51 | 302s |

### atelyr (private React app; runs locally, the one exception to cloud-only)

The verifier can confirm only objectives 1 and 6 from the database, because the flow
deletes its own evidence; 2–5 are checked for arithmetic consistency of the run's claim,
which a zero-model replay does not make. "2/2" below means both checkable objectives held.

| arm | verified | cost | wall |
|---|---|---|---|
| sleep-walker, set 28 (fwat2 on 81d2ea2) | 6 reported, 2/2 checkable | $1.43 | 3043s |
| sleep-walker (v0.1 cells, for scale) | max‡, max‡, incomplete | $0.89, $0.85, $2.19 | 2042s, 1842s, 4550s |

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
| repairdesk | **7/7, 7/7** · $0.00, $0.00 · 24s, 23s (set 28); set 26: 7/7, 7/7 · 18s, 18s | 6/6 · $0.19 · 67s every time | 1/6, 1/6 · $0 · 31s | 6/6, 6/6 · $0 · 36s |
| kanboard | **4/4 (+2 n/a), same** · $0.00, $0.00 · 23s, 23s (set 28; the two report-based objectives cannot be scored on a zero-model replay); set 26: 21s, 21s | 2/6 · $0.77 · 118s every time | 5/6, 5/6 · $0 · 32s | 4/4 (+2 n/a), same · $0 · 62s |
| grafana | **6/6, 6/6** · $0.00, $0.00 · 47s, 47s (set 28, fwgr27: every step at tier A, zero model turns); set 26 as recorded: 5/6, 5/6 · $0.18, $0.55 · 661s, 1864s | 6/6 · $1.05 · 448s every time | 0/6, 0/6 · $0 · 17s | 0/6, 0/6 · $0 · 35s |
| odoo | **6/6, 6/6** · $0.16, $0.01 · 661s, 189s (set 26); **set 28 regressed: 1/6, 1/6** · $0.10, $0.03 · 1153s, 980s, flow reports success but the verifier finds two orders, see the set-28 row below | 6/6 · $1.51 · 302s every time | 1/6, 1/6 · $0 · 77s | 0/6, 0/6 · $0 · 8s |
| atelyr (local) | 8/8 flow steps, 2/2 checkable · $0.53, $0.06 · 2684s, 1548s (set 28; 164 then 93 model turns, converging: the delete step re-pinned onto its recovery and replayed 15/15 at zero turns on r2) | — | — | — |

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
| grafana (fresh recording fwgr26 on b90852a, set 27) | — | n1 6/6 · $0.39 · 1354s; **n2 halted 2/6** (69 turns); n3 6/6 · 159 turns · $0.72 · 1441s — the recording itself compiled clean (no cancelled dialog, no transient lines, no echoed input), and the create step's second click on the visualization picker crashed the tab to `chrome-error://chromewebdata/` on both replays; the replay then ran eleven more steps on the error page before the next segment refused. Since a7d5d88 a browser error page stops a replay at once. The diagnostic run diaggr1 (same flow and store on 8f65983, with Playwright's protocol log) showed it was never a crash: the create segment's third click on "New" toggled its menu shut, so `link "New dashboard"` did not resolve and the chain fell to its structural fallback `div > … > a:nth-of-type(1)`, which matched Grafana's footer "Support" link to grafana.com; the box has no outbound network, so the tab landed on `chrome-error://chromewebdata/`. Fixed on the resolver: a candidate that resolves inside a link leaving the recorded origin is never taken. (Set 27d later showed this reading was incomplete: the error page came from a popup tab opened by the sign-in skill's recorded "Support" click, adopted by the daemon as the active page. The resolver rule stands, but the cause was the tab, see rpgr14 below) |
| grafana (fwgr26 recording re-exported on 5e10158, set 27b, rpgr12) | r2 **6/6** · 64 turns · 528s — create step tier A 21/21 at 0 turns, no error page, no grafana.com navigation in either run | r1 **halted 1/6** but is not a measurement: the box killed its own first attempt at a 9m50s tool timeout (that attempt had already replayed the create head 4/4 and saved the dashboard) and re-ran under the same session id, so the persisted browser profile was already signed in, the sign-in skill missed its username field, and everything after was model recovery that stalled in Grafana's save drawer. r2 also showed the guard refusing a *recorded* primary click on the "Support" footer link in the sign-in skill (19-turn recovery); since 5e10158+1 the guard holds only fallback candidates to the origin, the recorded primary is trusted |
| grafana (fwgr26 recording re-exported on 372b439, set 27c, rpgr13) | r1 **6/6** · 64 turns · 737s (5/6 by verifier: the final report dropped one provisioned title); r2 **halted 1/6** · 58 turns · 851s | The sign-in fix held: both replays ran the sign-in skill past its recorded "Support" click with no fallback. But the create step's panel-editor click lost the tab again in both runs, and differently from set 27: the `toggle-viz-picker` test id and its role name had not rendered yet, the structural fallback `div > … > button` resolved at once against a header button that opens grafana.com, and the tab landed on the error page. r1 recovered (27 turns), r2's recovery spent its whole budget on the error page. Two rules follow, both app-agnostic: a positional guess is held for the resolve window whenever the chain also names the element, and a step that leaves the app (error page or another origin) returns the browser to the page it started from before handing over |
| grafana (fwgr26 recording re-exported on 28144ca, set 27d, rpgr14) | r1 **6/6** · 147 turns · 1678s (verifier 5/6, one title dropped from the final report); r2 **halted 1/6** · 75 turns · 401s | The head segment ran clean in both replays and ended on `/dashboard/new`, and the NEXT skill still refused because "the browser is at chrome-error://chromewebdata/". That finally located the error page: it is not a wrong click in the create segment at all. The sign-in skill carries a recorded stray click on the login page's "Support" link, a `target=_blank` link to grafana.com. On the offline box that tab lands on the browser error page, and the daemon adopts every new tab as the active page, so from that moment every skill was asked of the error page while the app sat in the first tab. diaggr1's protocol log shows the grafana.com request at the sign-in stage, seventeen seconds before the create segment. The rpgr12 guard "fixed" it by refusing that stray click; the fallback-only guard let it through again. Fixed at the daemon: a replay keeps its page whatever tabs open, and a new tab that lands on a browser error page is closed and the opener restored. The held-guess and geometry rules stand on their own evidence but were not the cause here |
| grafana (fwgr26 recording re-exported on a3d0430, set 27e, rpgr15) | r1 **6/6** · 71 turns · 463s (verifier 5/6: the final report named the dashboard but not its uid); r2 **6/6** · 45 turns · 261s | No error page anywhere in either run. Sign-in and create replayed at tier A with zero turns in both, the create step all 21 steps. r2 is the cheapest Grafana replay to date and re-pinned two steps onto their recoveries. What remains is ordinary drift, not a mechanism: the refresh picker's inner locator misses in both runs and the model recovers it, and the "Edit" button in step 04 changed name |
| grafana (fresh recording fwgr27 on 9dcc731, set 28) | n1 **6/6** · $0.14 · 1381s | n2 **6/6** · 0 turns · 47s; n3 **6/6** · 0 turns · 47s — the first Grafana recording whose replays never called the model. Five steps, every one at tier A on both replays, no error page, no fallback line. This is also the first store carrying geometry: 56 of 57 chains hold a point candidate. It did not help yet: the four drift tickets (panel-title headings whose names are per-run values) show the point tried and missed, because the element under the point was the title's inner span and the point sat second in the chain ahead of the anchored path. Both fixed after the run: the point walks up to the recorded kind, and orders last at compile and replay. The steps still resolved, by the anchored `[data-testid="header-container"] h2` path |
| repairdesk (fresh recording fwrd42 on 81d2ea2, set 28) | n1 **7/7** · $0.07 · 1212s | n2 **7/7** · 0 turns · 24s; n3 **7/7** · 0 turns · 23s — every drift ticket is a per-run ticket or part name re-bound by its identity-scoped locator |
| kanboard (fresh recording fwkb5 on 81d2ea2, set 28) | n1 **6/6** · $0.21 · 1078s | n2 and n3 **4/4 checkable** · 0 turns · 23s each, all five steps at tier A, no drift tickets |
| odoo (fresh recording fwod33 on 81d2ea2, set 28) | n1 **6/6** · $0.15 · 1335s | n2 **1/6** · 72 turns · 1153s; n3 **1/6** · 48 turns · 980s — both replays report flow success and the verifier disagrees: the create step's head segment ran, the next segment refused ("not on the page this procedure starts from", the browser was on a product list rather than the new quotation form), recovery then created a second quotation, so the customer holds two orders and every downstream check fails. Recovery also named its output `quotation_reference` where the flow expects `order_reference`, so steps 04–06 lost their reference and ran at tier B. Set 26's replays of this target were 6/6 verified. Open: where the head segment diverged, and the partial-replay draft it left behind |
| atelyr (fresh recording fwat2 on 81d2ea2, local, set 28) | n1 6 reported, **2/2 checkable** · $1.43 · 3043s | n2 8/8 flow · 164 turns · $0.53 · 2684s; n3 8/8 flow · 93 turns · $0.06 · 1548s — converging: three steps at tier A on both, the delete step re-pinned onto its recovery and replayed 15/15 at zero turns on n3, the edit step 11/11 at zero turns on both. First real use of a point candidate: the status combobox resolved by `elementAt(731, 251)` on both replays. Still model-recovered: the two add-item steps (their identity locators name the item, which is a per-run value the recording typed) and the status change |
| odoo (fwod33 recording replayed on f0ccede with scripts, set 28b, rpod4) | r1 **6/6** · 57 turns · 324s; r2 **1/6** · 67 turns · 488s (three orders) | The captured scripts locate the set-28 regression: the create chain replays cleanly through the save, then its last recorded click, which opens Odoo's product catalogue, had its effect captured at the moment the url gained the order id and before the navigation to the catalogue finished. The compiler therefore cut a segment boundary at a page the procedure was only passing through, with a precondition that can never hold on replay, and every replay hands the rest of the create step to recovery. Recovery sometimes creates the quotation again. Same recorder defect as Atelyr's sign-in, in the other direction: fixed by waiting until a navigating click's url has held still before its effect is captured. A fresh Odoo recording is needed to confirm, since the defect is in the store |
| atelyr (fwat2 recording replayed on 8f13981, local, set 28c, rpat1) | r1 **8/8 flow, 2/2 checkable** · 56 turns · 641s; r2 8/8 flow · 86 turns · 579s | The two Atelyr rules held: r1 ran sign-in, open, both add-item steps, edit and delete at tier A with zero turns (164 turns the run before). r1 then re-pinned four steps onto their recovery skills but kept the old skill's slot names in the flow, so r2 bound the wrong values and refused the delete step for a missing slot. Fixed: a re-pin re-derives the step's bindings by value |
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
