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

## Reporting rules

- **Success is verified externally**, against the app's API — never from the tool's own report.
- **N ≥ 5 per arm; report median and full range.** Single runs of an agentic system are noise:
  the same step has taken 8 turns and 30 turns on consecutive attempts.
- **Publish raw token counts alongside costs**, so figures survive price changes.
- **Pin versions**: agent-browser version, browser-pilot commit, model IDs, date.
- Known tool bugs that cost wall-clock time (e.g. agent-browser's cold-start hang) are reported
  **separately** rather than folded into a headline, in either direction.

## Known gaps

These are open, and the benchmark is not publishable until they are closed:

1. **No true database reset between runs.** The app's API exposes `delete-projectItem` but no
   `delete-project`, so closed projects accumulate and slowly change list sizes. A real reset
   needs a filesystem snapshot of the datastore, restored per run.
2. **Single application.** A benchmark run only against a private app cannot be reproduced by a
   reader. A neutral, publicly available target is required before publication.
3. **The task set was written while developing browser-pilot** against this app, which risks
   selection bias toward flows it handles well.
