# Cloud run runbook

> **RULE — published runs are cloud-only.** Any run whose numbers will appear in
> bench/MATRIX-*.md (any arm, any target, cold runs and flow sweeps alike) runs on the
> cloud environment via a one-shot routine, never on a developer machine. Identical
> hardware with nothing competing is what makes cells comparable. The single exception
> is **atelyr** (private app behind a local mongod — cannot run in the cloud); its cells
> are labelled "(local)". Local runs are for debugging and smoke only, and their numbers
> are never published.

One benchmark run, on a fresh Linux cloud instance. Point a cloud session at this
file and give it a runid and an arm; everything else is here.

Runs are done this way so that every measurement comes off identical hardware
with no other processes competing, and so several can run at once. Each instance
is its own box, so there is no port or datastore juggling between parallel runs —
just give each one a distinct runid.

## What you need

- The repo, on `main`, up to date.
- `NOVITA_API_KEY` in the environment. **Never echo it** into output, a file, or
  a command line.
- Nothing else. The target app ships in this repo and needs no provisioning.

## 1. Set up

```sh
git fetch origin && git checkout main && git pull --ff-only
bench/cloud-setup.sh --with-arm-b
```

`--with-arm-b` installs `agent-browser` at the pinned version and is only needed
for the agent-browser arm, but it is harmless either way.

Record anything you had to fix. This script is young and its Linux paths are
lightly exercised; a correction is a useful result in its own right.

### One box, several sweeps

`--with-target` is repeatable, so bring up everything the session will need in
one go and run the sweeps back to back:

```sh
bench/cloud-setup.sh --with-target odoo --with-target grafana
```

Provisioning is the expensive part: pulling images and seeding Odoo costs
minutes per target, and doing it three times to run three sweeps was pure
waste. Setup is idempotent - it skips an image already cached and skips the
Odoo seed when the `bench` database exists - so a re-run costs seconds.

This is only safe because **every target now has a real per-run reset**
(`bench/app-reset.mjs`), applied before each replay. Until that landed the
sweep's reset was hardcoded to repairdesk's endpoint and silently 404'd on the
others, so state accumulated across runs and a fresh box was the only way to
get a clean baseline. Two results were scored against that and neither meant
what it appeared to: fwgr13's replays renamed run 1's dashboard, and fwod20
left three orders in the list at once.

So: reuse the box, never reuse the state. If a reset fails the sweep now halts
that run rather than replaying against a dirty app - treat a `reset-failed`
row as a stop, not a blip.

### One box per TARGET, boxes in parallel (standing pattern, 2026-09-01)

"One box, several sweeps" above is about not re-provisioning between sweeps
that share a box - it is NOT a reason to serialize independent targets.
Set 14 ran grafana, odoo and repairdesk back to back on one box: ~4 hours of
wall clock for ~1.5 hours of actual work per target. The targets share no
state, every box is its own sandbox, and concurrent routine runs from one
trigger demonstrably coexist (set 14 and fwkb1 ran side by side).

So the standing pattern for a multi-target set is **one routine run per
target, launched together**. Each run provisions only its own target
(`--with-target <t>` once), sweeps it, and publishes its own
`results/<tag>` branch. The ~10 minutes of per-box setup is the price of
cutting a set's wall clock to its longest sweep.

The one shared resource is the model API key. Every sweep hammers the same
OpenRouter account, and 429s have killed replays before (fwgr2). The retry
logic now honors Retry-After on a minute scale, so parallel sweeps absorb a
429 instead of dying - but if a parallel set shows 429-driven `blocked` rows,
stagger the launches by ~20 minutes rather than falling back to one box.

## 2. Run

Substitute `<ARM>` (`browser-pilot`, `agent-browser`, `playwright-mcp` or
`browser-use`) and `<RUNID>`, and `--target` (`repairdesk`, `odoo`, `grafana`):

```sh
export BROWSER_PILOT_PROVIDER=novita
node bench/harness.mjs \
  --arm <ARM> --target repairdesk \
  --task bench/tasks/repairdesk-ticket-flow.md \
  --provider novita --model zai-org/glm-5.3 \
  --runid <RUNID> --out bench/results --reset
```

- The `export` is **not optional** for the browser-pilot arm (harmless for the
  other). `--provider` configures the harness's orchestrator only; browser-pilot's
  inner agent resolves its own provider from `BROWSER_PILOT_PROVIDER` and
  defaults to `zhipu`, which has no key on the box. Without it every
  `browser-pilot do` fails instantly with "no API key" and the run turn-caps at
  0/6 — that was c0822bp attempt 1, the first cloud run. `cloud-setup.sh` now
  checks for this and warns.
- **Orchestrator provider.** `--provider novita` is the baseline, but novita's
  response cache intermittently drops the orchestrator's history on this arm and
  turn-caps the run at 0/6 (see HANDOFF, "novita drops the orchestrator's
  history"). To run the orchestrator elsewhere, keep `BROWSER_PILOT_PROVIDER=novita`
  (that is the *inner* model, which is unaffected) and change only `--provider`:
  `--provider openrouter --model z-ai/glm-5.3` (needs `OPENROUTER_API_KEY`; routes
  to Z.ai, logs the served backend and real USD cost in the result). The harness
  flags any dropped-history turn as `contextTruncations` in the result regardless
  of provider.
- `--reset` is **not optional**. It reloads the app's seed and clears its
  mutation log, which is what makes the run's recorded writes attributable to it.
- Expect 10-25 minutes of near-silence. **Do not end your turn while it runs** —
  on a worktree-backed session the working directory is deleted when your turn
  ends, and the harness will carry on writing into nothing. If your shell tool
  caps a foreground call below the run length, start it under a process manager
  and block on it *within* the same turn.
- Do not lower `--maxTurns`.
- `--maxUsd` defaults to 2.00: the harness prices orchestrator + inner tokens after
  every turn and stops at `stop=spend-cap` once the run crosses it. Leave it — a
  capped run is a legitimate result. Raise it only deliberately, and say so in the
  report.

### Before a rerun of the same runid

The harness passes `--session <runid>`, so a daemon orphaned by an abandoned run
of the same name will still be listening and answer slowly or not at all. One run
lost ~230s and ~11 turns to exactly this:

```sh
agent-browser session list      # then kill anything for this runid
```

## 3. Verify and score

```sh
node bench/verify-repairdesk.mjs <RUNID>
node bench/score.mjs <RUNID>
```

The verifier checks all six objectives against the app's own mutation log and
exits non-zero if any failed, or if the run reported a price the app never
computed.

## 4. Publish the results — this is how they survive

`bench/results/` is gitignored and the box is ephemeral, so **results not pushed
are results lost**. Copy them into the tracked directory and push a branch:

```sh
mkdir -p bench/results-published
cp bench/results/<RUNID>-* bench/results-published/

git checkout -b results/<RUNID>
git add bench/results-published
git commit -m "Add raw results for <RUNID>"
git push -u origin results/<RUNID>
```

**A branch, not `main`.** Parallel instances pushing to `main` would race and
some would lose; a branch per run cannot collide and gets merged centrally.

Three files should be there: `-result.json`, `-transcript.jsonl` and
`-mutationlog.json`. The mutation log matters most — it is the app's own record
of every write, and the only evidence that survives the run deleting its own
records and the box being destroyed.

## 5. Report back

Quote verbatim, because the session transcript may be the only other record:

1. `git log --oneline -1` and the branch you pushed.
2. The full contents of `<RUNID>-<ARM>-result.json`, including its `machine` block.
3. Full output of `verify-repairdesk.mjs` and `score.mjs`.
4. The run's `finalText`, in full, or "empty".
5. Anything you had to change to make the setup work, with exact commands.

## Rules

- **Do not push to `main`** and do not commit anything but the results files.
- **Do not retry more than once.** If you retry, report both attempts.
- **Clean up**: stop the target app and any browser or daemon you started.
- Report honestly. A turn cap, a 0/6, or a crash is a legitimate result. Do not
  massage a bad number or retry until it looks good — this benchmark is worthless
  if it flatters itself.
