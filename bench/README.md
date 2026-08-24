# browser-pilot benchmark harness

A comparison between **browser-pilot** and **agent-browser** that tries to be fair enough to
publish, including to a reader who would rather it weren't.

## Conflict of interest

This benchmark lives in browser-pilot's own repository and was written by browser-pilot's
authors. Treat the numbers accordingly. Everything needed to re-run it is here — harness, task
definitions, tool documentation, raw per-run results — so the honest response to disagreement is
to re-run it and publish a contradiction.

## What is actually being compared

The two tools are not the same kind of thing:

- **browser-pilot** contains a model. You give it an instruction (`browser-pilot do "..."`) and
  it works out the browser steps itself.
- **agent-browser** contains no model. It executes one browser action per command
  (`agent-browser click @e3`). Something else has to decide what those commands are.

So you cannot benchmark them head-to-head directly. What you can benchmark is **two complete
systems accomplishing the same goal**, and that is what this harness does:

```
Arm A: orchestrator O ──coarse instruction──► browser-pilot [inner model M] ──► browser
                      ◄──compact report──────

Arm B: orchestrator O ──agent-browser click @e3──► browser
                      ◄──snapshot (KBs)──────────
```

The layer-count difference **is the thing being measured**, not a confound to be normalised
away. browser-pilot's claim is that decomposition and page noise stay inside a cheap inner
model; agent-browser leaves both on the orchestrator. Cost is therefore reported as:

```
total = O_tokens × O_rate  +  M_tokens × M_rate
```

### Why not drive the arms with a coding agent

An earlier iteration drove one arm from a coding-agent session and the other from a subagent.
That was unusable for three reasons, all fixed here:

1. A general-purpose agent carries its own large system prompt and tool set, inflating per-turn
   tokens for reasons unrelated to the tool under test.
2. Its per-turn cost depends on how much unrelated context the session had already accumulated,
   so the same run costs wildly different amounts depending on when you run it.
3. Subagent transcripts were not reliably persisted, so exact token splits were unrecoverable.

Owning the loop makes every token attributable.

## Controls

| Held constant | How |
|---|---|
| Orchestrator model | Same `--provider`/`--model` in both arms |
| Harness | Literally the same file; arms differ only in which binary the one tool may invoke |
| Prompt scaffolding | Same system prompt, same tool schema, same caching strategy |
| Task | Same goal file, given as an **objective** — never a pre-decomposed step list |
| Session isolation | Both arms are told to pass `--session <runid>`, so no run inherits another's state |
| Command surface | Each arm may run only its own binary (enforced by the harness) |

### Deliberate asymmetries, and why they stay

- **Each arm gets its own tool's real `--help` text, verbatim.** That is what a user gets.
  agent-browser's is ~23KB against browser-pilot's ~4KB, because it has far more commands to
  document. Equalising this would mean editorialising one tool's documentation. Both armdocs
  are regenerated from the installed binary rather than hand-copied, so they cannot drift into
  editorialising — and they must be regenerated whenever either tool's version changes. Under
  agent-browser 0.16.3 the figure was ~12KB; the jump is the version bump, not a change of
  method.
- **agent-browser 0.34.0 ships a `skills` subsystem** (`agent-browser skills get core`) that
  loads workflow guidance written by its authors. Arm B's orchestrator can invoke it like any
  other subcommand, and it is part of the shipped tool, so it stays. This is worth stating
  plainly because it is the closest thing agent-browser has to the decomposition guidance
  browser-pilot carries internally, and a reader comparing the two should know arm B can reach
  for it. Whether a run actually does is visible in the `subcommands` breakdown.
- **browser-pilot's `--help` gained a "Sizing an instruction" section on 2026-08-21, and this
  is expected to improve its numbers.** Disclosed because the reader should judge it. The
  reasoning: runs varied 15 vs 45 `do` instructions for the same goal, at ~1.6KB of orchestrator
  context each, and instruction count is the single largest driver of the headline metric — yet
  the guidance on sizing existed only in the project's agent skill, never in the tool's own help.
  It is a real documentation defect, fixed in the shipped tool, and the benchmark then measures
  the tool as shipped. What would NOT be legitimate is putting the same advice in the harness
  system prompt: that is shared scaffolding, deliberately silent on decomposition, and coaching
  one arm there while the other gets nothing is a thumb on the scale. The armdoc is regenerated
  from `browser-pilot --help` rather than hand-copied, so it cannot drift into editorialising.
  **All browser-pilot runs before this date used the old help and are not comparable to runs
  after it.**
- **The inner model M is a property of the system, not a variable to match.** browser-pilot's
  claim includes "the inner model can be cheap", so the headline runs it in its recommended
  configuration. Sensitivity arms below exist to test whether that is the whole story.
- **Giving both arms a pre-written plan would erase the difference being measured**, because
  decomposition is precisely the work that moves between layers.

## Arms

| Arm | System | Purpose |
|---|---|---|
| A1 | O + browser-pilot (default inner model, escalation on) | headline |
| B1 | O + agent-browser | headline |
| A2 | O + browser-pilot with inner model = O | shows the win is not merely cheap-model arbitrage |
| A3 | O + browser-pilot, `--no-escalate` | isolates what escalation contributes |
| — | cold vs briefed | both arms get the **same** briefing file, byte for byte, or neither does |

`--script` replay is not a separate arm for agent-browser alone: browser-pilot records a
standalone Playwright spec from its own run (`--script`, then `browser-pilot script out.spec.ts`),
so both tools can reach a zero-LLM replay. The interesting question there is not cost per replay
but **how the script is obtained** and how many of its locators survive a re-run — measured
separately.

## Targets

| Target | Task file | Reproducible by a reader | Verifiable after cleanup |
|---|---|---|---|
| `bench/app` (repair desk, ships here) | `bench/tasks/repairdesk-ticket-flow.md` | yes — `node bench/app/server.mjs`, no install, credentials committed | yes, via the mutation log |
| atelyr (private) | `bench/tasks/atelyr-project-flow.md` | no | only objectives 1 and 6 |
| Odoo 17 (third-party, self-hosted) | _to be written_ | yes — `docker compose -f bench/thirdparty/odoo/docker-compose.yml up -d` then `bash bench/thirdparty/odoo/seed.sh` | yes, via a fresh `down -v` |

Every result published so far is from the private target. The neutral one exists so that can
change; see gap 2.

### Why a third-party target, and why Odoo

The first two targets share a weakness a sceptical reader will find immediately: we wrote both
of them. A tool that learns page structure can be flattered by pages its authors shaped. Odoo
is a real production ERP nobody here has touched — dense server-rendered CRUD, genuinely
multi-page flows (quote → sales order → invoice), and a UI that was never considered while
building the recorder.

It is self-hosted deliberately. Benchmarking against live public sites would mean fighting
anti-bot measures, which is both out of scope for this tool and useless as a measurement: a run
that dies on a CAPTCHA says nothing about browser-pilot. Self-hosting also gives the clean
per-run reset that K-replay sweeps require. Odoo was chosen over ERPNext purely on footprint —
two containers (2.3 GB) against the frappe stack's ten.

`--target` selects which one a run uses, and decides what `--reset` means. It defaults to
`atelyr`, so command lines recorded against earlier runs still reproduce.

## Running it

Against the neutral target, which is what a reader can actually do — no credentials to
provision, since the target defaults `APP_URL`, `APP_EMAIL` and `APP_PASSWORD` to the
committed ones (anything already set in the environment wins):

```sh
export NOVITA_API_KEY=...          # or ANTHROPIC_API_KEY

node bench/app/server.mjs &        # the app under test, port 4180

node bench/harness.mjs \
  --arm browser-pilot --target repairdesk \
  --provider novita --model zai-org/glm-5.3 \
  --task bench/tasks/repairdesk-ticket-flow.md \
  --runid r01 --out bench/results --reset
```

**Runs are made on cloud Linux instances**, one run per instance, so that every measurement
comes off identical hardware with nothing else competing for it and several runs can proceed at
once. `bench/CLOUD-RUNBOOK.md` is the single file a cloud session is pointed at: setup, run,
verify, and — the part that is easy to forget until a box is destroyed — pushing the raw
results to a branch, since `bench/results/` is gitignored and the instance is ephemeral. Each
run also records a `machine` block (platform, arch, node, cpu count, memory, tool version,
repo commit), so a published row can say what produced it.

On a fresh Linux box — a cloud instance, a container, a CI runner — `bench/cloud-setup.sh`
does all of the above and checks it: node version, build, a browser (the dependency is
`playwright-core`, which bundles none, so a bare container has nothing for browser-pilot's
`chrome → msedge → chromium` channel search to find), outbound network to the model API, and
the app itself. It installs `agent-browser` only with `--with-arm-b`, at a **pinned concrete
version** — currently 0.34.0 — never `latest`, so that two boxes set up a week apart cannot
quietly disagree. It sets up and verifies but never starts a run, since runs cost money.

**Arm B baseline break, 2026-08-21.** Every agent-browser figure in `HANDOFF.md` before this
date was produced by agent-browser 0.16.3. Measurement is restarting against 0.34.0, eighteen
minor versions later. Runs either side of that line are not comparable and must not be pooled
or plotted together; the old figures stay in the record as a closed baseline.

Against the private target, where the placeholders must be supplied:

```sh
export APP_URL=... APP_EMAIL=... APP_PASSWORD=...   # never committed

node bench/harness.mjs \
  --arm browser-pilot --target atelyr \
  --provider novita --model zai-org/glm-5.3 \
  --task bench/tasks/atelyr-project-flow.md \
  --runid h01 --out bench/results --reset
```

Swap `--arm agent-browser` for the other side. Add `--briefing <file>` for the briefed
condition. Each run writes `<runid>-<arm>-result.json` (aggregates) and
`<runid>-<arm>-transcript.jsonl` (every turn, every command, every token count); both record
the target, so a result file says what it was run against.

The harness checks the app answers on `APP_URL` before spending a single model token, and
exits with the reason if it does not. Three runs were once lost to an app that was down,
discovered forty turns in.

## Learning sweeps (progressive automation)

`--learn <dir>` puts the browser-pilot arm in learning mode with an isolated skill store: successful
instructions are compiled into stored procedures and later instructions replay them (see the root
README, "Learning"). The orchestrator prompt is untouched, so a sweep measures what the *tool* learned.
The result file gains a `learn` block — `deterministicFraction` (A_n: inner browser actions that ran by
replay ÷ all inner browser actions), `invoked`, `fullReplays`, `repaired`, `compiled`, `variants` — and
`score.mjs` shows `A_n` and `replayed` columns.

`bench/sweep.mjs` runs the same task K times in sequence against ONE shared store, resetting the app and
minting `<base>-n<k>` runids, and prints the per-n curve (cost, turns, A_n, verified objectives):

```sh
node bench/sweep.mjs --k 5 --base lrn --learn bench/results/lrn-skills --verify   --arm browser-pilot --target repairdesk --task bench/tasks/repairdesk-ticket-flow.md   --provider openrouter --model z-ai/glm-5.3 --coarse --out bench/results
```

Omit `--learn` for a control sweep of the same K. The claim under test is the notes' Pareto one: cost
and turns fall with n while externally verified correctness does not.

## Resetting between runs

State accumulates across runs, so runs are not comparable unless each starts from the same
baseline. `--reset` does this, and what it does depends on `--target`.

### `--target repairdesk`

Nothing to set up. `--reset` POSTs to the app's `/__reset`, which reloads the committed seed
in process. It takes milliseconds, stops no processes, and cannot half-fail — the restore
below once corrupted a datastore by dying midway through a delete. Resetting also clears the
app's mutation log, which is what makes a run's recorded writes attributable to that run.

### `--target atelyr`

`bench/reset.mjs` handles this at the filesystem level — there is no `mongodump` or
`mongosh` on this machine, only `mongod`, so a logical dump is not available.

Capture the baseline **once**, with the app in the state every run should start from:

```sh
node bench/reset.mjs --snapshot     # ~300MB, written outside the repo
node bench/reset.mjs --status
```

Then pass `--reset` to any run, which restores that baseline before the first command:

```sh
node bench/harness.mjs --arm browser-pilot ... --reset
```

Both snapshot and restore stop `mongod` and `rs2-server`, move the bytes, and restart via
`start-backend.ps1` — WiredTiger files cannot be copied safely while mongod holds them. So:

- **Never reset while the other arm is running.** It will take the backend out from under it.
- Processes are matched by instance path, not by image name, so an unrelated `mongod` is left
  alone.
- Whether a run was reset is recorded in both the transcript meta and the result JSON, so a
  published run states which baseline it started from.

## Reporting rules

- **Success is verified externally**, against the app's API — never from the tool's own report.
  One verifier per target, because they can establish very different things:
  - `node bench/verify-repairdesk.mjs <runid>` — reads the app's mutation log and final state
    and scores **all six objectives**, needing no credentials. It also cross-checks the prices
    the run *claimed* in its final report against the prices the app actually computed, and
    exits non-zero on a mismatch. A run that reports 133.33 where the app recorded 125.00 is
    the exact failure this benchmark exists to catch, and on this target it is caught.
  - `node bench/verify.mjs <runid>` — logs into the private app and inspects the surviving
    records. It can only establish objectives 1 and 6; see gap 5.
  Neither verifier can show the agent drove the app through the *browser* rather than by some
  other route. What bounds that is the harness restricting each arm to its own binary.
- **N ≥ 5 per arm; report median and full range.** Single runs of an agentic system are noise:
  the same step has taken 8 turns and 30 turns on consecutive attempts.
- **Publish raw token counts alongside costs**, so figures survive price changes.
- **Transcripts record command output**, capped at `--captureBytes` (default 4000, 0 disables) and
  redacted. Byte counts alone were not enough to diagnose a stalled run: three runs stalled at or
  before login and the transcripts could say only how large each observation was, not what it
  said. Secrets are masked in raw, URL-encoded and JSON-escaped form, since captured output is a
  far likelier place for a credential to surface than a command line is.
- **Runs have a spend ceiling.** `--maxUsd` (default 2.00, 0 disables) prices orchestrator +
  inner tokens after every turn with `bench/pricing.mjs` — the same formula `score.mjs` uses —
  and stops the run at `stopReason: "spend-cap"` once crossed; the result records `maxUsd` and
  the final `spendUsd`. This is the symmetric counterpart to the turn cap, which is not: a
  wasted agent-browser turn is one CLI call, a wasted browser-pilot turn is a sub-agent run plus
  an escalation, and c0822bp spent $7.21 on 119 identical blocked instructions before the turn
  cap caught it. A capped run is reported as capped, never discarded, and the ceiling is the
  same for both arms. If a run cannot be priced (a model missing from `rates.json`) the ceiling
  is not enforced and the transcript says so.
- **Quote `invocationCount`, never `commandCount`.** agent-browser chains with `&&`, so one
  recorded command can be several real invocations (a03: 70 recorded, 160 actual); browser-pilot
  never chains and is 1:1. `commandCount` is therefore not comparable across arms.
- **Report the `subcommands` breakdown with any context figure.** For browser-pilot the `do`
  count is what the context number tracks, and two runs of the same goal have differed threefold.
- **Pin versions**: agent-browser version, browser-pilot commit, model IDs, date.
- Known tool bugs that cost wall-clock time (e.g. agent-browser's cold-start hang) are reported
  **separately** rather than folded into a headline, in either direction.

## Known gaps

These are open, and the benchmark is not publishable until they are closed:

1. **Database reset is implemented but not yet exercised across a full sweep.** The app's API
   exposes `delete-projectItem` but no `delete-project`, so without a reset closed projects
   accumulate and slowly change list sizes. `bench/reset.mjs` now snapshots and restores the
   datastore at the filesystem level (see "Resetting between runs"); what is still missing is a
   sweep run end to end with `--reset` on every run, confirming the baseline actually holds.
   On the neutral target this problem mostly goes away — `--reset` there reloads the seed
   in-process in milliseconds, with no processes to stop and no filesystem copy to get wrong,
   and the harness now picks the right mechanism from `--target`. So this gap is really only
   open for the private target, and only until a sweep confirms the baseline holds.
2. **Single application — a second target now exists, but nothing has been run against it.**
   A benchmark run only against a private app cannot be reproduced by a reader.
   `bench/app/` is a neutral target that ships with this repo and needs no credentials or
   provisioning: `node bench/app/server.mjs`, zero dependencies (see `bench/app/README.md`),
   with `bench/tasks/repairdesk-ticket-flow.md` as the structurally equivalent task. What is
   still missing is results: **every number published so far comes from the private app.**
   This gap closes when a sweep has been run against the neutral target and the two targets'
   figures are reported side by side.
3. **The task set was written while developing browser-pilot** against this app, which risks
   selection bias toward flows it handles well. The neutral target reduces the app-specific
   part of this but not all of it: `repairdesk-ticket-flow.md` is deliberately a structural
   mirror of `atelyr-project-flow.md`, so it inherits the *shape* of a task set chosen with
   browser-pilot in hand, even though the app underneath is new. A genuinely independent task
   set — written by someone with no stake in the result — is the real fix.
4. **Orchestrator usage pattern, not the tool, drives the context result.** The context saving
   only appears when the orchestrator delegates coarsely (few `do` instructions). A run that
   drifts into many fine-grained `peek`/`config` calls lands at agent-browser's context figure —
   h11 did exactly that: 69.6KB over 59 turns, against h12's 25.5KB over 17. The headline metric
   is therefore bimodal across runs, not noisy around a mean, and must be reported as a spread
   with commands-per-run alongside it.
5. **Objectives 2-5 cannot be verified externally *on the private app*.** This is closed on the
   neutral target and open on the private one, so it constrains which target a published claim
   can rest on. `bench/app` keeps an append-only mutation log (`GET /__log`) recording every
   write with the computed price, which survives the run deleting its own records — so there a
   verifier can prove a part really was created at cost 100 and priced 125.00. The private app
   has no equivalent, and the rest of this entry describes it.

   Objective 6 requires the run to delete both
   line items and close the project, which destroys the very records that would prove objectives
   2-5 happened. After a run, the database can only confirm objective 1 (project exists) and
   objective 6 (items gone, project closed). `verify.mjs` therefore checks the run's *claimed*
   prices for arithmetic consistency against the app's pricing rule and labels them
   UNVERIFIABLE — a run could compute `100 / 0.75 = 133.33` without ever creating the item.
   Closing this needs a mid-run datastore snapshot, or a task variant that omits the cleanup.
