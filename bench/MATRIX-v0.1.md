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
  orchestrator/agent model; browser-pilot's inner tier is glm-5.2 with
  glm-5.3 escalation, disclosed below.
- Spend ceiling $2.00/run, turn cap 120, same task text, same harness
  (bench/harness.mjs), fresh browser state per run, `--reset` per run.
- browser-pilot runs use `--coarse` (its documented delegation mode);
  agent-browser/playwright-mcp issue their own native command/tool grain;
  browser-use is handed the task once (monolithic). The shape difference IS
  the subject of measurement (see README).

## Depth slice — repairdesk (in-repo app), all four arms

| arm | verified (K=3) | cost per run | median wall | invocations |
|---|---|---|---|---|
| browser-pilot | 6/6, 6/6, 6/6 | $0.42, $0.27, $0.60 | 787s | 7–11 `do` calls |
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

## Breadth slice — real apps, browser-pilot vs strongest incumbent

Incumbent = agent-browser, picked on depth-slice medians before breadth ran.

### Odoo 17 (dense server-rendered CRUD, hash routing)

| arm | verified | cost | stop |
|---|---|---|---|
| browser-pilot | 6/6, 5/6*, 6/6 | $1.91†, $0.62*, $0.45 | completed, 402*, completed |
| agent-browser | 6/6, 6/6, 6/6 | $1.07, $0.93, $0.97 | completed ×3 |

### Grafana 11 (React SPA, deep unnamed DOM)

| arm | verified | cost | stop |
|---|---|---|---|
| browser-pilot (bgr1, bgr2, bgr4) | 6/6, 6/6, 5/6 | $0.83, $1.10, $0.70 | completed �3 |
| agent-browser (agr1-3) | 6/6, 0/6, 6/6 | $1.53, $2.02, $1.33 | completed, **spend-cap**, completed |

(bgr4's 5/6 is an honest miss: dashboard saved with panels/tags/refresh
correct but no time range persisted. bgr3, the 402 casualty, stands on its
own branch at 4/6.)

### atelyr (private; runs locally) — INCOMPLETE

| arm | verified | cost | stop |
|---|---|---|---|
| browser-pilot | 1 run: partial (see note), 2× 402* | $1.26, — | completed, 402*, 402* |
| agent-browser | 3× 402* | — | 402* ×3 |

\* 402 = the OpenRouter account ran out of credit mid-run; these cells are
casualties, not arm results, and will be re-run. † bod1 ran during the
credit-crunch window and its wall/cost are inflated by 429-retry churn
(bod3, run after contention cleared: $0.45). The atelyr verifier also failed
to parse price claims from a successful run's report (verifier defect, to be
fixed before the reruns).

## What the completed cells say

1. Reliability on real apps: browser-pilot and agent-browser both complete
   Odoo and Grafana; agent-browser burned its whole $2 ceiling once in three
   Grafana runs (agr2, verified 0/6 — nothing saved). Page-heavy SPAs expose
   the flat-command shape's cost: every snapshot transits the orchestrator.
2. Cost on real apps: browser-pilot's clean-run range $0.45–1.10 vs
   agent-browser's $0.93–1.53 (+1 cap-out). On the small in-repo app the
   ranking reverses: agent-browser $0.13–0.14 medians vs browser-pilot
   $0.27–0.60. Layering pays off as pages get heavier, costs on light ones.
3. Wall clock: agent-browser is consistently ~2–3x faster than browser-pilot
   (its commands are seconds; a `do` is a whole sub-agent episode).
4. playwright-mcp is the consistency standout on the depth slice (three runs
   within $0.08) and a strong default incumbent for future matrices.
5. Inner-model disclosure: with Novita out of balance, browser-pilot's inner
   ran on OpenRouter glm-5.2 (~2/3 the price of glm-5.3). On its designed
   inner (deepseek-v4-flash, ~12x cheaper), its costs above would drop
   substantially; that configuration is unmeasured today and is claimed as
   possibility, not result.
