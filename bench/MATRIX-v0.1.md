# v0.1 comparison matrix — DRAFT (2026-08-24)

Four arms, four targets, K=3 per cell. Success is **externally verified** per
run — from the app's own mutation log (repairdesk), JSON-RPC state + tracking
(odoo), or HTTP API state (grafana) — never from the agent's self-report.
Costs are USD per run, orchestrator + inner tokens priced at catalogue rates
(bench/rates.json); every raw count is in the run's published result file on
its `results/<runid>` branch.

Status: DRAFT. Seven runs were casualties of an OpenRouter credit exhaustion
(API 402 mid-run) and await re-running; they are marked. Nothing in this file
is adjusted or substituted — a capped or truncated run is reported as itself.

## Conditions held constant

- Model: z-ai/glm-5.3 via OpenRouter (Z.AI backend) as every arm's
  orchestrator/agent model; sleep-walker's inner tier is glm-5.2 with
  glm-5.3 escalation, disclosed below.
- Spend ceiling $2.00/run, turn cap 120, same task text, same harness
  (bench/harness.mjs), fresh browser state per run, `--reset` per run.
- sleep-walker runs use `--coarse` (its documented delegation mode);
  agent-browser/playwright-mcp issue their own native command/tool grain;
  browser-use is handed the task once (monolithic). The shape difference IS
  the subject of measurement (see README).

## Depth slice — repairdesk (in-repo app), all four arms

| arm | verified (K=3) | cost per run | median wall | invocations |
|---|---|---|---|---|
| sleep-walker | 6/6, 6/6, 6/6 | $0.42, $0.27, $0.60 | 787s | 7–11 `do` calls |
| agent-browser | 6/6, 6/6, 6/6 | $0.81, $0.14, $0.13 | 138s | 78–103 commands |
| playwright-mcp | 6/6, 6/6, 6/6 | $0.42, $0.42, $0.50 | 275s | 73–85 tool calls |
| browser-use | 0/6, 0/6, 0/6 | $0.01, $0.01, $0.04 | 154s | 1 (monolithic) |

- playwright-mcp's cell is dpm2/dpm3/dpm4. dpm1 froze on a provider-side
  request stall (a harness defect, fixed in 9e2ed75) after 23 clean turns and
  is recorded as a harness artifact, not an arm result.
- browser-use could not reliably emit its own action schema through this
  model (135 validation errors in one run); smoke run smk4bu proved the same
  configuration CAN pass (4/6, $0.13), so the cell reads as high-variance
  model fit, not a harness fault. Disclosed: vision off, same model as all
  arms — this is "browser-use on the benchmark's model", not peak browser-use.

## Breadth slice — real apps, sleep-walker vs strongest incumbent

Incumbent = agent-browser, picked on depth-slice medians before breadth ran.

### Odoo 17 (dense server-rendered CRUD, hash routing)

| arm | verified | cost | stop |
|---|---|---|---|
| sleep-walker | 6/6, 5/6*, 6/6 | $1.91†, $0.62*, $0.45 | completed, 402*, completed |
| agent-browser | 6/6, 6/6, 6/6 | $1.07, $0.93, $0.97 | completed ×3 |

### Grafana 11 (React SPA, deep unnamed DOM)

| arm | verified | cost | stop |
|---|---|---|---|
| sleep-walker (bgr1, bgr2, bgr4) | 6/6, 6/6, 5/6 | $0.83, $1.10, $0.70 | completed ×3 |
| agent-browser (agr1-3) | 6/6, 0/6, 6/6 | $1.53, $2.02, $1.33 | completed, **spend-cap**, completed |

(bgr4's 5/6 is an honest miss: dashboard saved with panels/tags/refresh
correct but no time range persisted. bgr3, the 402 casualty, stands on its
own branch at 4/6.)

### atelyr (private; runs locally) — INCOMPLETE

| arm | verified | cost | stop |
|---|---|---|---|
| sleep-walker | 1 run: partial (see note), 2× 402* | $1.26, — | completed, 402*, 402* |
| agent-browser | 3× 402* | — | 402* ×3 |

\* 402 = the OpenRouter account ran out of credit mid-run; these cells are
casualties, not arm results, and will be re-run. † bod1 ran during the
credit-crunch window and its wall/cost are inflated by 429-retry churn
(bod3, run after contention cleared: $0.45). The atelyr verifier also failed
to parse price claims from a successful run's report (verifier defect, to be
fixed before the reruns).

## What the completed cells say

1. Reliability on real apps: sleep-walker and agent-browser both complete
   Odoo and Grafana; agent-browser burned its whole $2 ceiling once in three
   Grafana runs (agr2, verified 0/6 — nothing saved). Page-heavy SPAs expose
   the flat-command shape's cost: every snapshot transits the orchestrator.
2. Cost on real apps: sleep-walker's clean-run range $0.45–1.10 vs
   agent-browser's $0.93–1.53 (+1 cap-out). On the small in-repo app the
   ranking reverses: agent-browser $0.13–0.14 medians vs sleep-walker
   $0.27–0.60. Layering pays off as pages get heavier, costs on light ones.
3. Wall clock: agent-browser is consistently ~2–3x faster than sleep-walker
   (its commands are seconds; a `do` is a whole sub-agent episode).
4. playwright-mcp is the consistency standout on the depth slice (three runs
   within $0.08) and a strong default incumbent for future matrices.
5. Inner-model disclosure: with Novita out of balance, sleep-walker's inner
   ran on OpenRouter glm-5.2 (~2/3 the price of glm-5.3). On its designed
   inner (deepseek-v4-flash, ~12x cheaper), its costs above would drop
   substantially; that configuration is unmeasured today and is claimed as
   possibility, not result.

## v0.2 addendum — sleep-walker column rerun on the latest build (2026-08-26)

The bp arm only, K=3 per target. repairdesk/odoo/grafana ran on the SAME
cloud environment as their v0.1 cells (runids c2rd*/c2od*/c2gr*, one
results/<runid> branch each, run 2026-08-25 evening UTC); atelyr ran locally
on the Windows box (runids m2at*), matching where the other arms ran it.
Conditions as v0.1 EXCEPT the two deliberate changes:

- **The build** (commit e9f8968): replay v2 (evidence-based page/record
  re-resolution), navigation-by-recorded-destination fallback, and component
  recipes (seeded monaco/CodeMirror/contenteditable/combobox procedures with
  mandatory verification reads). Each run got a fresh per-run components
  file — seed recipes only, no cross-run learning, cells independent.
- **The inner model**: the designed configuration v0.1 disclosed as
  unmeasured — deepseek-v4-flash with glm-5.3 escalation, via OpenRouter
  with a Baidu provider preference (order, not a hard pin — xdf2). The
  result files do not record which backend served the flash calls.

Orchestrator glm-5.3 (OpenRouter/Z.AI), `--coarse`, $2.00 ceiling, turn cap
120, `--reset`, external verification per run, all unchanged.

| target | verified (K=3) | cost per run | wall | v0.1 bp cell (verified / cost) |
|---|---|---|---|---|
| repairdesk (cloud) | 6/6, 6/6, 6/6 | $0.058, $0.051, $0.161 | 843s, 666s, 858s | 6/6 x3 / $0.42, $0.27, $0.60 |
| odoo (cloud) | 6/6, 6/6, 6/6 | $0.223, $0.135, $0.063 | 1312s, 849s, 610s | 6/6, 5/6*, 6/6 / $1.91†, $0.62*, $0.45 |
| grafana (cloud) | 6/6, 6/6, 6/6 | $0.167, $0.225, $0.500 | 1512s, 1743s, 1306s | 6/6, 6/6, 5/6 / $0.83, $1.10, $0.70 |
| atelyr (local) | max‡, max‡, incomplete | $0.89, $0.85, $2.19 | 2042s, 1842s, 4550s | 1 partial + 2x 402 / $1.26, — |

‡ atelyr's verifier can externally confirm only objectives 1 and 6 (the
task's own cleanup destroys the evidence for 2–5; those are checked as
claim-consistency only). m2at1 and m2at2 passed both verifiable objectives
with all four claims consistent — the maximum score the verifier can award.
m2at3 hit the $2 spend ceiling at turn 28 (obj 6 unfinished) and is an arm
result, not a casualty: the first completed-K atelyr cell, at 2 clean of 3.

What changed vs v0.1, in the cells' own terms:

1. **27 of 27 cloud objective-checks passed** — the first all-6/6 sweep of
   any arm across three targets, including grafana's Notes/monaco objective
   (obj 3), previously bp's costliest page. The seeded monaco set-value
   recipe fired and VERIFIED exactly once in every grafana run (attested in
   each run's published components.json: r_f2510e uses=1, successes=1).
2. **Cost dropped roughly 3–7x per target** (repairdesk $0.05–0.16 vs
   $0.27–0.60; odoo $0.06–0.22 vs $0.45–1.91; grafana $0.17–0.50 vs
   $0.70–1.10). Two causes, not separable in this data: the ~12x-cheaper
   inner model, and the recipes removing the long widget fights. On the
   depth slice this also flips v0.1's ranking — bp is now the cheapest arm
   on repairdesk (v0.1 medians: agent-browser $0.13–0.14).
3. **The atelyr cell exists now** — v0.1 had no completed atelyr column at
   all. Two of three runs completed and verified at ceiling; the third
   shows the target's real difficulty (spend-capped, 4550s), not infra.
4. v0.1's note 5 (the flash inner "claimed as possibility, not result") is
   now measured: this whole addendum IS that configuration. Escalation to
   glm-5.3 occurred in 6 of 9 cloud runs and resolved cleanly every time
   (the order-not-only provider preference, xdf2).
5. A local Windows rerun of the same three targets (runids m2rd*/m2od*/
   m2gr*, 2026-08-25 afternoon) produced the same verified profile at
   similar costs (17 of 18 objective-runs 6/6); it is superseded by the
   cloud cells above for comparability and kept only in local
   bench/results.

## v0.2 controlled grid — all arms rerun same-day (2026-08-26)

The incumbent caveat above is now closed: every arm was rerun on 2026-08-26
under identical conditions — same cloud environment, same pinned versions
(agent-browser 0.34.0, @playwright/mcp 0.0.79, browser-use 0.13.8), same
orchestrator (z-ai/glm-5.3 via OpenRouter, backend Z.AI on every run), same
harness commit (8f8da6d), clean provider weather, K=3 sequential per cell,
externally verified per run, raw files on results/<runid> branches
(c2ard*/c2aod*/c2agr*/c2pm*/c2bu*; atelyr cells local, m2at*/m2aat*).

### repairdesk (depth slice)

| arm | run type | verified (K=3) | cost per run | median wall |
|---|---|---|---|---|
| **sleep-walker — flow replay**§ | warm | 6/6, 6/6 | $0.460, $0.531 | 748s |
| sleep-walker | cold | 6/6, 6/6, 6/6 | $0.058, $0.051, $0.161 | 843s |
| agent-browser | cold | 6/6, 6/6, 6/6 | $0.129, $0.147, $0.123 | 274s |
| playwright-mcp | cold | 6/6, 6/6, 6/6 | $0.563, $0.440, $0.453 | 823s |
| browser-use | cold | 2/6, 0/6, 0/6 | $0.058, $0.013, $0.013 | 150s |

### Odoo 17

| arm | run type | verified | cost | stop |
|---|---|---|---|---|
| **sleep-walker — flow replay**§ | warm | 6/6, 6/6 | $0.850, $0.253 | success x2 |
| sleep-walker | cold | 6/6, 6/6, 6/6 | $0.223, $0.135, $0.063 | completed x3 |
| agent-browser | cold | 6/6, 6/6, 6/6 | $1.248, $0.440, $1.062 | completed x3 |

### Grafana 11

| arm | run type | verified | cost | stop |
|---|---|---|---|---|
| **sleep-walker — flow replay**§ | warm | 6/6, **1/6** | $0.370, $0.179 | success, **halted** |
| sleep-walker | cold | 6/6, 6/6, 6/6 | $0.167, $0.225, $0.500 | completed x3 |
| agent-browser | cold | 6/6, 6/6, **2/6** | $1.402, $1.087, $2.003 | completed x2, **spend-cap** |

§ **flow replay = the repeated-testing use case.** sleep-walker's warm
mode: one orchestrated run records a flow at cold cost (repairdesk $0.167,
odoo $0.165, grafana $0.352 — sweeps fwrd2/fwod3/fwgr3, cloud, commits
496a2ef/6269b78), then runs 2..N replay it with NO orchestrator. K=2
replays per target shown. No incumbent arm has an equivalent mode, so an
incumbent's repeated-run cost is its cold row every time. Replay costs are
the inner-model recovery tokens priced at the recovery model's rate (a
deliberate over-estimate); a pure deterministic replay prices to $0, and
observation-heavy steps still recover on the model — which is why replay
cost does NOT beat the cold row on the cheap repairdesk target and why
these rows are EXPERIMENTAL, matching the product label. The grafana 1/6
is an honest halt: one replay's recovery could not re-do the Stat panel
type switch and the flow stopped rather than fabricate.

### atelyr (private; both arms local, same machine)

| arm | verified‡ | cost | stop |
|---|---|---|---|
| sleep-walker (m2at) | max‡, max‡, incomplete | $0.89, $0.85, $2.19 | completed x2, spend-cap |
| agent-browser (m2aat) | max‡ (no claims), max‡ (no claims), incomplete | $2.01, $1.89, $2.02 | spend-cap, completed, spend-cap |

‡ as defined above: objectives 1+6 externally confirmed is the verifier's
ceiling. Both completed agent-browser runs reached it but reported no
parseable price claims (bp's claims all checked out); m2aat3 capped with the
project still open. m2aat1 capped AFTER finishing the work — both its
verifiable objectives pass.

### What the controlled grid says

1. **Reliability**: sleep-walker is the only arm at 6/6 on every cloud run
   (9/9). agent-browser's grafana spend-cap RECURRED under clean conditions
   (c2agr3, $2.00, 2/6) — v0.1's capped cell was the arm's real behaviour on
   heavy SPAs, not a credit-crunch artifact. playwright-mcp remains the
   consistency runner-up (6/6 x3, $0.44–0.56, within $0.12). browser-use's
   v0.1 zero largely reproduces (2/6, 0/6, 0/6): every run self-reported
   "completed" — only external verification tells them apart, which is the
   benchmark's reason for existing.
2. **Cost, same-day comparison**: sleep-walker is cheapest on every target
   — repairdesk $0.05–0.16 vs agent-browser's $0.12–0.15 (v0.1's ranking
   reversal confirmed gone), Odoo 3–7x cheaper ($0.06–0.22 vs $0.44–1.25),
   Grafana 4–6x cheaper ($0.17–0.50 vs $1.09–2.00), atelyr ~2.2x cheaper
   with cleaner completions.
3. **Wall clock**: agent-browser keeps its speed crown where it completes
   (274s median on repairdesk vs bp's 843s) — the layering trade-off is
   real and stated: bp spends wall time on sub-agent episodes and buys back
   verified completions and cost.
4. Weather effect quantified: playwright-mcp moved <15% between v0.1 and
   v0.2; agent-browser's odoo/grafana costs moved ~10–30%. The v0.1
   comparisons were directionally right; the grid above supersedes them.

## Flows: superseded section

The flow-replay measurements previously quoted here (local swg4 sweep) are
superseded by the cloud flow-replay rows inside the v0.2 controlled grid
above (sweeps fwrd2/fwod3/fwgr3, one results/<base> branch each). Getting
those rows honest surfaced and fixed four machinery defects in one day:
unpriced replay tokens, report-value refs dying on tier-A replays,
digitless minted ids escaping url-provenance, and 429s killing whole
flowruns — all in the changelog between 9fa1af1 and 6269b78.
