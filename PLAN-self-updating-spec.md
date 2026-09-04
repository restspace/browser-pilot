# Self-updating compiled runner: high-level plan

Written 2026-09-04. Follows PLAN-compile-to-code.md, which argues the deliverable should be
a reviewable `@playwright/test` spec with the model at compile time only. This plan adds the
missing half: how a fully compiled spec, running under plain Playwright with no model, can
still **hand its failures to an agent and absorb the agent's adaptation back into itself**.

## The one design decision everything hangs on

**The spec is the source of truth and carries its own IR.** The emitted file has two zones:

- an **owned zone**: the `Skill[]`-equivalent rendered as readable typed constants
  (chains, identity guards, expectations, mints, loops) that the tool can parse back
  losslessly and codemod;
- a **user zone**: fixtures, extra assertions, setup/teardown, anything hand-written, which
  the tool never touches.

This kills the two-source-of-truth problem (flow JSON vs spec). The flow store becomes a
compile-time cache, not the thing users own. `~/.sitelooper/flows` stops being an asset
that mutates at 2am; the only thing that mutates is a diff in the user's repo.

Invariant to test from day one: `emit(lift(spec)) === spec` for the owned zone.

## The loop

```
record ──▶ converge (N clean tier-A replays) ──▶ emit spec ──▶ PR #1 (human reviews once)
                                                     │
              ┌──────────────────────────────────────┘
              ▼
   CI runs spec under plain Playwright, --strict, no model
              │ pass → green, means the assertion held
              │ fail → red + drift sidecar (which candidate resolved / missed,
              │        assertion that failed, interactive snapshot, trace)
              ▼
   `sitelooper repair --spec x.spec.ts --drift run.json`   (dev laptop or scheduled agent)
      1. lift spec → Skill[]
      2. triage (existing repair.ts: localized vs redesign by similarity)
      3. localized, fallback resolved → promoteFallback: pure codemod, no model
         localized, chain dead      → patchSegment via agent on the live app
         redesign                   → agent re-records that segment only
      4. fold sidecar stats into the chain constants (retire / demote candidates)
      5. re-emit owned zone; user zone untouched
      6. converge gate again on the patched spec
      7. open PR #2: "candidate #save-btn missed 3/12, promoted role locator"
```

The agent is in the loop, but only ever on a developer's machine or a scheduled repair job,
and only ever produces a diff. Run time stays deterministic. Self-healing becomes a pull
request. That is the trade PLAN-compile-to-code §3.5a asks for.

## Phases

| # | phase | what it delivers | leans on |
|---|---|---|---|
| 0 | **Rewire `script`** | `sitelooper script` reads the converged `Skill[]`, not `RecordedEntry[]`. Pick the owned-zone representation. | `cli.ts`, `codegen.ts` → new `emit.ts` |
| 1 | **Emitter, Tier 2** | Pure Playwright, chains as `.or()` + `.filter({hasText})`, expectations as `expect(...)`. Demoable, no runtime needed. Bench it as a fifth Matrix-2 column. | `makeLocator`, `specOf`, `consequentialExpectations` |
| 2 | **Runtime extraction** | `@sitelooper/runtime`: `resolveChain`, `settleDom`, `markPoint`, expectation checks, pulled out of `replay.ts` with no daemon/ledger deps. Tier 3 emit. Runtime writes the drift sidecar. `--strict`. | `replay.ts:955`, `recorder.ts:121` |
| 3 | **Lift** | Parse the owned zone back to `Skill[]`. Round-trip test. This is what makes the spec agent-editable. | ts-morph or a fixed-shape constant + JSON.parse |
| 4 | **Repair on spec** | `repair --spec --drift`: triage → codemod / agent patch / segment re-record → re-emit → converge gate → PR. Expose via the sitelooper skill so Claude Code can run it off a CI failure. | `repair.ts` triage, `promoteFallback`, `patchSegment` |
| 5 | **Convergence gate** | Per-step N clean tier-A replays before emit or before a repair PR opens. Floor N=2. | set-28 evidence |
| 6 | **Fits an existing suite** | Auth state, fixtures, params, mints → teardown docs, GitHub Action that runs the spec and uploads the sidecar. | — |

Order: 0 → 1 → 3 → 4 (Tier 2, promoteFallback-only repair) is the shortest path to a working
loop that needs no runtime. Then 2 to recover `point`, box yardstick, `ambiguousNth`, then 5, 6.

## What the agent is allowed to change

- **Cheap, no model:** reorder candidates, retire a candidate, widen a volatile matcher.
  Always a pure codemod from sidecar evidence.
- **Model, localized drift:** propose one new locator for one moved control, verified on
  the live page before it is written.
- **Model, redesign:** re-record one segment. Never the whole flow.
- **Never:** touch the user zone, weaken an expectation, delete an assertion. An expectation
  that no longer holds is a test failure for a human, not drift.

That last rule is what keeps a green build meaning something (PLAN-compile-to-code §1.4).

## Risks

1. **Owned-zone representation.** Too blob-like and reviewers cannot read the diff (back to
   §1.2). Too free-form and lift is fragile. Constrain the emitted shape hard and test
   round-trip on every fixture flow.
2. **User edits inside the owned zone.** Detect on lift: if the zone does not parse, refuse
   to repair and say why. Do not merge.
3. **Cross-run memory lives in CI artefacts.** Stats fold in only at repair time, so
   candidate retirement is slower than today's in-store `stats`. Acceptable for a test tool.
4. **Tier 2 may score well enough that Tier 3 is unnecessary.** Run the bench experiment
   before extracting the runtime.

## First commits

1. `sitelooper script` on the `Skill[]` path.
2. Emit Tier 2 for the set-28 flows; score with the existing verifiers.
3. Round-trip test harness: `lift(emit(skill))` deep-equals `skill`.
