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
  agent-browser's is ~12KB against browser-pilot's ~3KB, because it has more commands to
  document. Equalising this would mean editorialising one tool's documentation.
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

## Running it

```sh
export NOVITA_API_KEY=...          # or ANTHROPIC_API_KEY
export APP_URL=... APP_EMAIL=... APP_PASSWORD=...   # task placeholders; never committed

node bench/harness.mjs \
  --arm browser-pilot \
  --provider novita --model zai-org/glm-5.3 \
  --task bench/tasks/atelyr-project-flow.md \
  --runid h01 --out bench/results
```

Swap `--arm agent-browser` for the other side. Add `--briefing <file>` for the briefed
condition. Each run writes `<runid>-<arm>-result.json` (aggregates) and
`<runid>-<arm>-transcript.jsonl` (every turn, every command, every token count).

## Resetting between runs

State accumulates across runs, so runs are not comparable unless each starts from the same
baseline. `bench/reset.mjs` handles this at the filesystem level — there is no `mongodump` or
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
  `node bench/verify.mjs <runid>` does this: it logs into the app and inspects the resulting
  records. Note its limits, which are structural — see gap 5 below.
- **N ≥ 5 per arm; report median and full range.** Single runs of an agentic system are noise:
  the same step has taken 8 turns and 30 turns on consecutive attempts.
- **Publish raw token counts alongside costs**, so figures survive price changes.
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
2. **Single application.** A benchmark run only against a private app cannot be reproduced by a
   reader. A neutral, publicly available target is required before publication.
3. **The task set was written while developing browser-pilot** against this app, which risks
   selection bias toward flows it handles well.
4. **Orchestrator usage pattern, not the tool, drives the context result.** The context saving
   only appears when the orchestrator delegates coarsely (few `do` instructions). A run that
   drifts into many fine-grained `peek`/`config` calls lands at agent-browser's context figure —
   h11 did exactly that: 69.6KB over 59 turns, against h12's 25.5KB over 17. The headline metric
   is therefore bimodal across runs, not noisy around a mean, and must be reported as a spread
   with commands-per-run alongside it.
5. **Objectives 2-5 cannot be verified externally.** Objective 6 requires the run to delete both
   line items and close the project, which destroys the very records that would prove objectives
   2-5 happened. After a run, the database can only confirm objective 1 (project exists) and
   objective 6 (items gone, project closed). `verify.mjs` therefore checks the run's *claimed*
   prices for arithmetic consistency against the app's pricing rule and labels them
   UNVERIFIABLE — a run could compute `100 / 0.75 = 133.33` without ever creating the item.
   Closing this needs a mid-run datastore snapshot, or a task variant that omits the cleanup.
