# Milestone — first defensible browser-pilot vs agent-browser head-to-head (2026-08-23)

This records a milestone: a clean, externally-verified, N≥3 comparison of the two arms on
identical cloud hardware, plus the fixes that got us there. Every number below is checked against
the target app's own mutation log by `bench/verify-repairdesk.mjs` — not self-reported. Raw
result files are in `bench/results-published/`; the running narrative and caveats live in
`bench/HANDOFF.md`. This file is the standalone summary.

## Bottom line

On the neutral `repairdesk` target, with the orchestrator on OpenRouter→Z.AI (`z-ai/glm-5.3`) and
browser-pilot's inner model on novita (`deepseek-v4-flash`):

| both 6/6 | **optimized browser-pilot** | agent-browser 0.34.0 |
|---|---|---|
| total cost (median, range) | **$0.072 ($0.066–0.110)** | $0.133 ($0.129–0.136) |
| orchestrator context | **~9.8 KB** | ~27.5 KB |
| correctness | 3/3 runs 6/6 | 4/4 runs 6/6 |

"Optimized browser-pilot" = coarse delegation + batching + escalation off. **~1.8× cheaper and
~2.8× lighter on orchestrator context at equal correctness.** The comparison *started* the sweep
with browser-pilot losing ($0.247 vs $0.133); the gap turned out to be **configuration, not
architecture**.

## How we got here (the arc)

The campaign began by discovering the cloud path didn't even run, and ended with browser-pilot
winning. Each step was diagnosed from evidence, fixed, and re-run.

1. **Cloud runs work at all.** `Agent isolation:"remote"` silently falls back to a local worktree;
   the real cloud path is `/schedule` routines on the **BrowserPilot** environment. Runbook also
   never set the inner provider, so browser-pilot's inner agent defaulted to `zhipu` (no key) and
   turn-capped 0/6. Fixed: `21092c7`.
2. **Spend ceiling.** `--maxUsd` (default $2), priced per turn via a shared `bench/pricing.mjs`
   so the live ceiling and `score.mjs` can't disagree. Fixed: `adbefe8`.
3. **browser-pilot inner blind start.** The inner agent guessed `goto localhost:3000` instead of
   using the page the caller opened, then port-scanned and looped sign-in 119×. Each `do` now
   carries the live page URL/title; guessed navigation forbidden. Fixed: `647b7f9`.
4. **The novita freeze — the big one.** browser-pilot cloud runs intermittently turn-capped 0/6.
   Root cause, proven by a per-turn sent-vs-received probe (`9a80c84`) and a live detector
   (`21a883d`): **novita's response cache dropped the orchestrator's history and replayed a stale
   prefix** on the arm's long inter-call gaps (`cbab5b6`). Not the model, not the harness. Fixed
   by moving the orchestrator to **OpenRouter→Z.AI** — same model and rate, correct caching
   (`2ebbc79`, settled `1d7b066`). Also fixed the inner-provider pricing bug this exposed
   (`ca873a7`).
5. **browser-pilot was losing on cost — and it was configuration.** Diagnosed the orchestrator
   micro-managing browser-pilot (one UI action per `do`) and the inner agent never batching.
   Three prompt changes, all on the same cheap inner model:
   - **Coarse delegation** (`--coarse`, `9bef84e`): hand over whole outcomes, let each command run
     to its own report instead of driving click-by-click.
   - **Anti-survey clause** (`9c2e090`): don't spend a command exploring/enumerating the UI.
   - **Batching by default** (`2c704fa`): the inner agent had a batch tool but *never used it*
     (0/783 do-calls) because operating-rule 1 ("one step at a time") contradicted rule 3a; fixed
     the contradiction and made batching the default for form-fills, plus a "read back any value
     before reporting it" clause.
6. **Escalation off (A3, `8a0a6ff`).** With the above, the only remaining cost tail was the
   inner model escalating to glm-5.3 on the hard step. Turning escalation off
   (`BROWSER_PILOT_FALLBACK_MODEL=none`) showed the hard step **passes on plain deepseek within
   budget** — escalation had been pure cost, never a rescue, all campaign. Cheaper *and* tighter.

### Cost ladder (browser-pilot, same cheap inner model throughout)

| config | cost median | note |
|---|---|---|
| fine-grained | $0.247 | one-op-per-turn, orchestrator micro-manages |
| coarse | $0.118 | whole-outcome delegation |
| + anti-survey | $0.105 | no explore/enumerate commands |
| + batching | $0.084 | inner agent batches form-fills (tail to $0.311) |
| **+ no-escalate** | **$0.072** | tail gone; cheapest and tightest |

## Integrity / how the numbers are trusted

- **Success is external.** `verify-repairdesk.mjs` checks all six objectives against the app's
  mutation log and cross-checks any price the run *claimed* against what the app *computed*. This
  caught a real fabrication (`scref3`: the inner agent reported a $250 price the app never
  computed) that would otherwise have read as a clean 6/6 — the exact failure the benchmark
  exists to catch. The batching prompt's "read back any value before reporting" clause was added
  in response; no fabrication recurred.
- **Every run is attributable.** Result files carry a `machine` block, the orchestrator backend
  (`orBackends`), OpenRouter's own reported cost, `contextTruncations` (the freeze tripwire, which
  stays in permanently), and `spendUsd`.
- **agent-browser is the untouched control.** All browser-pilot-only changes are opt-in flags
  (`--coarse`) or its own inner prompt; agent-browser ran unchanged across all 8 sweep runs and
  the pair, and its numbers are strikingly stable ($0.129–0.136).

## How to reproduce

Cloud (the setup these numbers come from): `/schedule` a routine per run on the **BrowserPilot**
environment (`env_01LXSXQhPTpqR7t3TNAdeJYg`, has `OPENROUTER_API_KEY`), repo `restspace/browser-pilot`,
following `bench/CLOUD-RUNBOOK.md`. The command each run executes:

```sh
export BROWSER_PILOT_PROVIDER=novita           # inner model
export BROWSER_PILOT_FALLBACK_MODEL=none        # escalation off (A3)
node bench/harness.mjs --arm browser-pilot --target repairdesk \
  --task bench/tasks/repairdesk-ticket-flow.md \
  --provider openrouter --model z-ai/glm-5.3 --coarse \
  --runid <RUNID> --out bench/results --reset
```

agent-browser control: drop the two exports and `--coarse`, set `--arm agent-browser`. Verify and
score offline against a saved mutation log by replaying it into a stub that serves `/__log` and a
folded `/__state` (the app's `/__state` isn't published) — see the pattern used this session; then
`node bench/verify-repairdesk.mjs <RUNID>` and `node bench/score.mjs <RUNID>`.

## Open threads (not started)

1. **N≥5** on the optimized config to tighten the medians (current bp N=3, ab N=4).
2. **B2 — subagent-over-agent-browser arm.** Same two-level architecture with agent-browser as the
   substrate: isolates whether browser-pilot's edge is architecture (replicable) or its tuned
   implementation. A build; reuses the harness loop.
3. **Substrate micro-benchmark** — observation bytes + action-failure counts for raw Playwright vs
   agent-browser vs browser-pilot's inner tools; cheap way to answer "how much does agent-browser's
   curation beat raw Playwright" before building a full raw-Playwright arm.
4. **Predictive per-`do` budget.** Unnecessary on repairdesk (the hard step needs only default
   cheap-model turns), but the right general mechanism for a harder target: the orchestrator sets
   per-`do` `--max-turns`/`--fallback-model` by predicted difficulty — existing flags, a prompt
   clause, no new machinery.
5. **A harder / public target app** — repairdesk has no step that genuinely exceeds the cheap
   inner model's budget once thrashing is removed, which is why escalation proved unnecessary; a
   harder target is where escalation and the predictive cap would earn their keep.

## Caveats worth keeping in view

- N is small (3–4 per condition); quote medians *and* ranges, never a single run.
- This is one task on one target with one model pairing; the *direction* (config, not architecture,
  drove the gap) is well-evidenced, but the magnitudes are task-specific.
- browser-pilot's cost win rides on a cheap inner model doing more total token-work off the
  orchestrator; its correctness therefore depends on that model's honesty (see the scref3
  fabrication) — the external verifier is load-bearing, not optional.
- The benchmark lives in browser-pilot's own repo; the honest response to disagreement is to
  re-run it (everything needed is here) and publish a contradiction.
