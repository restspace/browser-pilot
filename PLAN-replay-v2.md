# Replay v2: evidence-based re-resolution, no load-bearing heuristics

Written 2026-08-25, after the first record-once/replay-K sweeps on real apps
(swo = odoo, swg = grafana, swa = atelyr; branches results/sw*-n*). Successor
work to PLAN-progressive-automation.md Stage 1 and PLAN-overnight.md.

## The evidence this plan rests on

Record runs are now cheap and reliable: with the flash inner
(SITELOOPER_MODEL=deepseek/deepseek-v4-flash, provider order Baidu,
escalation glm-5.3), swo-n1 verified 6/6 at $0.199 and swg-n1 6/6 at $0.396.
Replays are not: every real-app replay halted early —

- swg-n2/n3 both halted at step 04-open. Drift ticket: "after step 11
  expected url http://127.0.0.1:3000/d/afw6yy5xxq4u8e/:id but browser is at
  http://127.0.0.1:3000/d/afw711m2aifb4a/:id". The flow baked run 1's
  GENERATED dashboard uid into a URL expectation; each replay mints a new one.
- swo-n2/n3 halted at steps 2-3 on the odoo hash-route equivalent
  (action=:id segments reduced, but record-bearing segments kept literal).
- repairdesk flows replay 6/6 (2026-08-23 sweeps) because its URLs are
  stable. Real apps mint identifiers per run; that is the whole difference.

The element-level machinery needs no change: candidate chains resolved
first-unique-wins (replay.ts resolveChain) replayed tier-A 7/7 actions with
zero model turns wherever the flow reached them. What is missing is the layer
above: WHICH page/record to be on.

## Why not extend isIdLike

The current answer — urlPattern reduces "id-like" segments (compile.ts
isIdLike, stableFirst) — makes a shape heuristic load-bearing. It failed on
grafana's uid (`afw711m2aifb4a` reads as a word-ish slug) and will fail again
in both directions: every app brings a new id alphabet, and real names
("X230-Pro") look like ids. A heuristic that must be RIGHT is a defect
generator. Heuristics stay, but only where being wrong costs one extra
comparison: ordering candidate chains, choosing which segment to try
generalising first. Decisions about matching move onto evidence.

## Mechanism 1 — provenance: values the flow itself minted

The grafana uid is not an id-detection problem: run 1 CREATED the dashboard,
and the uid first appeared in the post-create navigation URL. Every later
occurrence is downstream of that step's output.

- Compile time (skills/compile.ts): collect per-step observed outputs — the
  post-navigation URL (split into segments) and created-record identifiers
  visible in the step's state diff. Any LATER literal (in a URL expectation,
  precondition, locator, or arg) equal to one of those outputs becomes a
  reference to that step's outcome, exactly as discoverSlots already turns
  instruction literals into {{vN}} — same mechanism, new value source.
  Guard against coincidence the same way discoverSlots does (length >= 4,
  exact token match, first-appearance wins).
- Replay time (daemon/server.ts runFlow + skills/replay.ts): after each step,
  capture the same outputs from the LIVE run (current URL, diff) and bind
  them into the parameter map for later steps. The flow layer already
  threads step outputs into later instruction text (softResolveInstruction);
  this extends the binding to URL expectations and locator params.

Correct by construction: the replay creates its own dashboard, captures its
own uid from where the browser lands, and later steps use that.

## Mechanism 2 — observed variance: environmental ids

Odoo's menu/action ids pre-exist the run (no provenance) but differ across
databases/sessions. No shape needed there either — volatility can prove
itself:

- Store run 1's URLs LITERALLY (stop reducing at record time).
- Make URL preconditions/expectations SOFT on segment mismatch: if the path
  shape and the remaining segments match, proceed optimistically instead of
  halting. (Today's hard fail is what turned a one-segment difference into a
  dead flow — and it also makes the evidence uncollectible.)
- If the step then succeeds (its element chain resolved, its expectation
  held), the differing segment has demonstrated volatility: generalise
  exactly that segment in the stored pattern, permanently. This is the
  skills lifecycle (provisional -> validated on 2nd clean success) applied
  to URL segments. Segments that never vary stay exact, keeping matching
  precision that blanket wildcarding would destroy.

## Order of application on a URL miss

1. Provenance binding already substituted? Then there is no miss — the
   expectation was written against the replay's own value.
2. Soft-match: shape + other segments match -> proceed, confirm-or-halt on
   the step outcome; on success, persist the generalisation.
3. Semantic re-find (stretch): if the step still cannot proceed and the flow
   knows a list/search page from an earlier step, re-find the record by its
   runid-embedded NAME before falling back to model recovery. Page-level
   analogue of stableFirst's philosophy.
4. Model recovery (existing) — now the last rung, not the second.

## Sweep-harness fixes to land with it

- A spend-capped/incomplete run 1 saves no flow; sweep.mjs then runs replays
  that write 0-byte flowrun files and look like runs (swa-n2/n3). Detect the
  missing flow and SKIP with an explicit row instead.
- sweep verify is repairdesk-only; take a --verify-cmd so odoo/grafana/atelyr
  sweeps self-verify per run.

## Validation

Re-run exactly the three sweeps (swo2/swg2/swa2 bases, same commands,
flash inner) and require: replays reach the end on odoo + grafana with
verified >= record run - 1, A_n monotone non-decreasing, and at most one
model-recovery step per replay. atelyr additionally needs a cheaper record
run (glm-5.2 inner or raised cap) before its replays are testable at all.

## Task checklist

- [x] 1. Per-step output capture at record time (recorder/compile): post-nav
      URL segments + created ids from diffs, stored on the step.
- [x] 2. Provenance substitution pass in compile.ts (extend discoverSlots
      value sources); params bound from live outputs in runFlow.
- [x] 3. Soft URL matching + confirm-on-success segment generalisation
      (urlMatches callers in replay.ts/flow.ts; persistence in store.ts).
- [x] 4. Demote isIdLike to ordering-only (stableFirst keeps it; matching
      paths stop consulting it).
- [x] 5. sweep.mjs: skip-and-mark replays when the flow was never saved;
      --verify-cmd.
- [ ] 6. Validation sweeps swo2/swg2/swa2; record per-n curves in
      bench/MATRIX-v0.1.md as a follow-up section.
