# Overnight build — engineer how BP CREATES and REPAIRS skills

Authorised 2026-08-23 (James → bed). Scope: full build. OpenRouter budget ~$2 for
validation sweeps. Principle from the design conversation:

> Don't hand-engineer individual skills — engineer the MECHANISM by which BP creates
> them. Skill boundaries must be intrinsic to the app (page-template seams), not tied
> to the orchestrator's arbitrary instruction chunking. Adoption of a skill must go
> through the promote/demote lifecycle, never force-pin an unproven one. The hard
> "how to fix a drifted skill" work is SLOW MODE — it happens AFTER the session, by a
> smart subagent draining a drift work-list — never inline during the run.

Root cause established this session (flow5, K=4, OpenRouter): re-pin is non-monotonic.
Zero-model steps went 7/12 → 3/12 → 3/12 and wall-clock rose, because runFlow
force-pins a freshly-compiled `provisional` (uses=1) skill from a single model
recovery — usually MORE fragile than the clean original — which then fails next run,
recovers, re-pins another provisional: churn. Store bloated to 24 skills for a
12-step flow. Steps NEVER re-pinned kept their originals and reached `validated
uses 4` (reliable zero-model). Evidence in bench/results/flow5-*.

## Validation harness
- App up at 127.0.0.1:4180 (repairdesk). `node bench/reset-app.mjs`.
- Key: `source <scratchpad>/or.env` (OPENROUTER_API_KEY), `export BROWSER_PILOT_PROVIDER=openrouter`.
- Sweep: `node bench/sweep.mjs --k 4 --base <b> --learn bench/results/<b>-skills --flow <b> --arm browser-pilot --target repairdesk --task bench/tasks/repairdesk-ticket-flow.md --provider openrouter --model z-ai/glm-5.3 --coarse --verify --out bench/results`
- Success signal: every run 6/6 verified AND zero-model step fraction MONOTONE non-decreasing across n2→n4 (the thing that's broken today).
- Per-run tiers: read bench/results/<b>-n<k>-flowrun.json (steps[].tier / turns / repinned).

## Task checklist (tick as done; commit + test each)

- [x] 1. Lifecycle-gated adoption (kill force-pin churn) — DONE da4048f; flow6 sweep: 6/6 all runs, store churn killed (9 skills vs 24), but exposed two cascade defects fixed in b7b27e8 (goto-first refusal race; recovery value-name drift)
      - Remove the force-pin in runFlow (server.ts ~546). Never overwrite step.skill
        with a just-compiled provisional.
      - Per flow step, each run: resolve CANDIDATE skills for the step's procedure
        from the store (same template+origin / sameProcedure), ordered
        (validated desc, successRate desc, uses desc). Replay best-first until one
        succeeds (cap ~3 tried). recordOutcome on each attempt so the store's own
        promote(2nd success)/demote(2 strikes) lifecycle runs.
      - Only after a candidate is `validated` does it become the step's preferred pin.
        A recovery variant enters the store provisional and must EARN the pin by
        validating across runs; a flaky one demotes and drops out of selection.
      - step.skill stays as a hint/cache; selection each run is by track record so a
        bad hint can't dominate. Keep the clean original as fallback candidate.
      - VALIDATE with a sweep; expect monotone zero-model fraction.

- [x] 2. Drift telemetry / repair tickets (recording only; NO inline repair) — DONE: LocatorMiss + DriftTickets in flow result; sweep.mjs writes <runid>-drift.json
      - On each segment/step replay, emit a structured DriftTicket when the primary
        locator missed (fallthrough) or the step failed: { flow, step/segment id,
        skill id, similarity (replay.similarity), missedLocator + the fallback that
        worked (or none), recovery used (bool), pageUrlPattern }.
      - Write tickets to bench/results/<runid>-drift.json (and surface count in flowrun).
      - similarity is the localized-vs-redesign classifier: high sim + missed locator
        = localized drift (patchable); low sim = broad redesign (re-record).

- [x] 3. Segmentation — one skill per page-template segment, not per instruction — DONE: compileSkills() splits at url-pattern seams, seq{chain,index,of}, recorder captures fingerprintAfter at seams, chain replay w/ per-segment lifecycle; unit + two-page fixture browser tests; flow7 sweep validating
      - In compile: split the recorded step run at page-template transitions
        (URL-pattern change via urlPattern(), and/or structural fingerprint drop).
        Capture a fingerprint at each segment start (today only captured once per
        instruction). Compile ONE skill per segment, each scoped to the page it runs
        on (its own startUrl/urlPattern + fingerprint precondition).
      - An instruction's learn output becomes an ORDERED LIST of segment skills.
        Flow/replay composes them: each segment gated by its own precondition, each
        independently Tier-A or recoverable. A drift in one segment can't cascade —
        the next segment refuses unless the page matches its template.
      - Keep app-agnostic: seam = "page template changed", never app-specific.
      - Heaviest/riskiest. Full unit + browser tests. VALIDATE with a sweep; expect
        the coarse sign-in+create monolith to auto-split and each half to converge.

- [x] 4. Post-session repair subagent (SLOW MODE, after the run) — DONE b7b27e8: src/skills/repair.ts + `skills repair --drift <file> [--dry-run] [--model M]`; closed-loop fixture tests; bench app /__drift affordance for live validation
      - A command / script that reads a run's DriftTickets and, per ticket:
        * high similarity + a working fallback → the chain already self-healed; record
          that the fallback should be promoted (cheap, no model).
        * high similarity + no fallback resolved → localized drift: a smart model
          re-derives the moved control's locator on the live/recorded page and patches
          just that segment's chain; new skill validated before adopting.
        * low similarity → broad redesign: flag the segment/flow for a fresh record run
          (do not patch selectors).
      - Runs OUTSIDE the timed run, driven by the recovery/strong model. Emits a
        summary of what it patched vs flagged.
      - Hard to validate without a drifted-app fixture — build a minimal fixture
        (perturb repairdesk selectors) or a fixture-page variant to exercise it.

## Working rules
- Commit + run tests after each sub-piece. Never leave the tree broken.
- Update this checklist and PLAN-progressive-automation.md as items land.
- Record a project memory when a piece completes, so context compaction is safe.
- Budget: stop launching sweeps if spend nears ~$2 (each ~$0.10-0.30). Log spend.
