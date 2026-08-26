# PLAN: eliminate the remaining "step has no usable skill" causes

Status: IMPLEMENTED 2026-08-26 (case 3 resume-merge + case 4a export lint) — route-by-cause recovery (the mitigation) and prose-cited
evidence backfill (fix for the observation-step cause) are already landed
(624c8c1, 04d8046). This plan covers the two structural causes left: resume
scaffolding (case 3) and skills that exist but cannot be entered (case 4).

## Case 3 — resume-scaffold steps

### The defect

When a record-run instruction blocks, `runEscalatingInstruction` hands the
strong model `escalationPrompt(instruction, first)` — "You are RESUMING an
instruction that a previous, weaker model could not complete…" plus the
failure report. That text goes through the normal `runInstruction` path, so
`beginInstruction` (loop.ts:199) records it as a **new instruction group**
whose text is the scaffold.

Downstream, everything degrades at once:

- `groupByInstruction` keeps success groups only, so the *failed original*
  (with the clean caller wording) is dropped and the *resume group* (with the
  scaffold text) becomes the flow step.
- The resume group's recording starts mid-crisis: its `url`/`fingerprint`
  context is wherever the browser happened to be when the first attempt gave
  up. The compiled skill's precondition describes that accidental mid-state,
  so on replay it correctly refuses every time → recovery every run.
- `discoverSlots` runs against the scaffold text, so the skill's template is
  unmatchable by any future natural instruction.

### The fix: record the continuation as a resume of the original, then merge

1. **recorder.ts** — add `resume?: true` to `RecordedInstruction`.
2. **loop.ts** — thread the caller's original instruction through the
   escalated attempt: `runEscalatingInstruction` passes
   `{ recordAs: { text: instruction, resume: true } }` in the second
   `runInstruction`'s opts; `beginInstruction` records THAT text plus the
   resume marker, never the scaffold. The scaffold still goes to the model —
   only the recording changes.
3. **flow.ts `groupByInstruction`** — merge a `resume` group into its
   immediate predecessor when the predecessor has the same instruction text:
   - instruction/context (`url`, `fingerprint`) from the ORIGINAL group — the
     real start state;
   - `entries` concatenated (both attempts' steps, in order);
   - `report` from the resume group (the final outcome);
   - `endUrl` = last navigation across both.
   Then the success-only filter runs as today. A resume group whose
   predecessor is missing (recording truncation) falls back to standing alone.
4. **Compile input** — with the merge, the flow step's skill compiles from the
   original start context over the combined recording. The failed attempt's
   flailing steps are included; that is acceptable — the validation lifecycle
   exists precisely to demote procedures that do not replay, and a skill that
   starts from the real page template at least *can* validate, unlike a
   mid-crisis one, which never can.

### Tests

- Unit (recorder/flow): a blocked group followed by a resume-marked success
  group merges into one step with the original text, original start context,
  combined entries, success report.
- Unit (loop, fake provider): escalation records the original text with
  `resume: true`, not the RESUMING scaffold.
- Regression: a resume group with NO predecessor stands alone unchanged.

## Case 4 — skill exists but cannot be entered

Two sub-causes, different treatments.

### 4a. Unthreaded references (`{{step.output}}` missing at replay)

Root cause: the producing step's tier-A replay only re-publishes what its
skill deterministically re-observes (labelled reads, url provenance). A ref
minted from a value that only the record-time model observed dies on replay.

Already mitigated by: url-part provenance (replay-v2), prose-cited evidence
backfill (624c8c1 — the read compiles, so the replay re-reads it live), and
route-by-cause (04d8046 — when it still happens, recovery is cheap-first).

Remaining fix — **surface the debt at build time, not replay time**:

- `buildFlow` gains an optional `publishes?: (skillId: string) => string[]`
  callback (alongside `bind`), answering "which output names does this skill
  re-publish deterministically" — labelled reads + `url.*` parts, computable
  from the stored skill's steps.
- After referencizing, lint every `{{sid.out}}`: if the producing step's
  skill does not publish `out`, attach a warning to the flow export
  (`browser-pilot flows export` prints it): *"{{02-create.dashboard_uid}}
  can only be re-observed by model recovery — consider re-recording so the
  value is read from the page."*
- No behavioural change at replay; this is a recording-quality signal, the
  moment the author can still do something about it.

### 4b. Precondition / fingerprint refusals

These are mostly correct behaviour (drift → refuse rather than act on the
wrong page), and the two wrong-refusal sources are addressed elsewhere:
resume-skills (case 3 above) and mid-state fingerprints. No change to the
gate itself. Route-by-cause already prices the fallout honestly: a refusal
of a pinned skill counts as `replay-failed` → strong model, which is right —
if the page really drifted, the repair IS the hard case.

## Order of work

1. Case 3 (recorder marker → loop threading → flow merge) — biggest payoff:
   it turns every escalated record-run step from a permanent recovery tax
   into a normal, convergeable skill.
2. Case 4a lint — small, independent, improves the authoring loop.
3. Re-record the three bench flows and rerun the sweeps (cloud, per
   [[bench-runs-cloud-only]]) so the warm rows reflect backfill +
   route-by-cause + resume-merge together.
