# Benchmark handoff — 2026-08-21

State of the browser-pilot vs agent-browser benchmark. Everything described here is committed
on `main`; the working tree is clean and no processes were left running.

## Bottom line

**The harness is built and validated. There is not yet a publishable result.** No browser-pilot
run has finished that is simultaneously (a) complete, (b) fully costed, and (c) free of the
harness artefacts found along the way. One run is needed to pair against the completed
agent-browser run.

## What exists

| Path | Purpose |
|---|---|
| `bench/harness.mjs` | One agent loop, both arms. Arms differ ONLY in which binary the single `run_command` tool may invoke, and that binary's own `--help` in the system prompt |
| `bench/tasks/atelyr-project-flow.md` | The goal, stated as objectives. `{{PLACEHOLDER}}`s are filled from env so credentials stay out of the repo |
| `bench/armdocs/*.md` | Each tool's verbatim `--help` |
| `bench/rates.json` | Dated USD rate card |
| `bench/score.mjs` | Prices runs; orchestrator and inner model costed separately |
| `bench/README.md` | Methodology, conflict-of-interest statement, deliberate asymmetries, open gaps |

## Results so far

| Run | Arm | Status | Turns | Wall | Ctx→orch | Orch $ | Inner $ |
|---|---|---|---|---|---|---|---|
| a03 | agent-browser | **complete, all 6 objectives** | 70 | 960s | 71.9KB | 0.550 | n/a |
| h01 | browser-pilot | **complete, all 6 objectives** | 20 | 2440s | 30.0KB | 0.109 | *pre-fix, unmeasured* |
| h02 | browser-pilot | died: transport | 13 | 1469s | 20.4KB | 0.060 | 0.553 |
| h04 | browser-pilot | died: transport | 18 | 3344s | 26.9KB | 0.127 | 0.785 |
| h06 | browser-pilot | died: API 400 | 2 | 36s | 0.6KB | 0.003 | — |
| h07 | browser-pilot | died: DNS | 11 | 847s | 11.2KB | 0.031 | 0.200 |
| h08 | browser-pilot | died: 403 no balance | 1 | 4s | — | — | — |

Discarded (not in results/): h03 (killed, ran concurrently with a03 — contention), h05 (killed by
a disconnect at 35 turns, **zero retries**, which is what confirmed the connection-pooling fix),
h09 (degenerate loop, see below), h10 (killed on request mid-run).

### Signals, not conclusions

- **Context into the orchestrator is consistently ~2.5x lower for browser-pilot** (30KB vs 72KB,
  and every partial run sits in the same band). This is the mechanism the tool claims.
- **Wall clock is consistently 2.5–3.5x worse for browser-pilot** (2440–3344s vs 960s), because
  individual `do` instructions take 5–11 minutes.
- **Escalation is expensive**: in h02, glm-5.3 was 4 of 14 instructions but **76% of inner cost**.
  Only visible because of the per-model tracking added this session.

All of the above is n=1 per arm. Do not publish any of it.

## Harness defects found and fixed

Seven. Five would have biased the published result **against** browser-pilot, which is worth
stating given whose repo this is.

1. **180s command timeout** — killed browser-pilot's legitimate work (its own instruction budget
   is 300s, more with escalation); agent-browser's commands take seconds, so it was untouched.
   Now 900s.
2. **Connection pooling** — browser-pilot leaves multi-minute gaps between model calls (439s,
   687s observed); pooled keep-alive sockets were dead by reuse and global `fetch` returned them
   anyway. Killed two runs. Now `node:https` with `keepAlive:false`.
3. **Inner cost unmeasurable** — a session mixing two model tiers could only be priced to a
   $0.46–$4.55 range. Fixed by adding `usageByModel` to browser-pilot itself.
4. **Session contamination** — the `default` session held a 17k-char briefing from earlier work;
   a "cold" run would have silently inherited it. Both arms now pin `--session <runid>`.
5. **Echoed assistant message** — glm-5.3 returns `reasoning_content`, which the same endpoint
   rejects on echo-back with a bare 400. The message is now rebuilt from wire-format fields only.
6. **Unredacted credentials** — the app password appeared verbatim in transcripts and result
   files, which are meant to be published. Both are now redacted on write.
7. **No degenerate-loop guard** — an orchestrator issued one identical read-only command 119
   times and burned the whole turn cap. Guard added: nudge at 4 identical commands, abandon at 8,
   compares command text only so it is arm-neutral. NOTE: added after observing it hurt
   browser-pilot's arm — mechanical and symmetric, but disclose it.

## How to resume

Prerequisites: RS2 backend on `127.0.0.1:3100` (`C:\dev\rs2-instance\start-backend.ps1`), atelyr
dev server (`cd C:\dev\atelyr && npm run dev`, binds IPv6 — use `localhost`, not `127.0.0.1`), and
a funded `NOVITA_API_KEY`.

```sh
cd C:/dev/browser-pilot
export BROWSER_PILOT_PROVIDER=novita
export APP_URL='http://localhost:5173/project-manager'
export APP_EMAIL='mtp-e2e@atelyr.com' APP_PASSWORD='...'

# browser-pilot arm  (~40-55 min)
nohup node bench/harness.mjs --arm browser-pilot --provider novita \
  --model 'zai-org/glm-5.3' --task bench/tasks/atelyr-project-flow.md \
  --runid h11 --out bench/results > bench/results/h11.log 2>&1 &

# agent-browser arm  (~16 min) — pre-warm first, see gotchas
nohup node bench/harness.mjs --arm agent-browser --provider novita \
  --model 'zai-org/glm-5.3' --task bench/tasks/atelyr-project-flow.md \
  --runid a11 --out bench/results --maxTurns 200 > bench/results/a11.log 2>&1 &

node bench/score.mjs
```

**Run the arms sequentially, never concurrently** — they contend for CPU and the browser, which
distorts wall clock unequally (many short commands vs few long ones).

### Gotchas that cost time

- **agent-browser's first command after a cold start hangs** (>45s, seen 5 times). Kill it and
  retry; the retry takes ~0.4s. Pre-warm before a timed run and report the hang separately.
- **Vite survives `TaskStop`** — the wrapper dies, the process does not. Kill the PID holding
  port 5173 directly.
- **Do not mass-kill chrome.exe.** Benchmark browsers are not distinguishable by name; on this
  machine all 54 chrome processes were the user's own. Match on command line first.
- Stop stale sessions between runs: `browser-pilot stop --session <runid>`.

## Before this can be published

Unchanged from `bench/README.md`, all still open:

1. **No true database reset.** The app API exposes `delete-projectItem` but no `delete-project`,
   so closed projects accumulate and slowly change list sizes across runs. A real reset needs a
   filesystem snapshot of `C:\dev\rs2-instance\mongo-data` restored per run — no `mongodump` or
   `mongosh` is installed, only `mongod`.
2. **Single, private application.** A reader cannot reproduce a run against atelyr. A neutral
   public target is required.
3. **Task provenance.** The task set was written while developing browser-pilot against this app,
   which risks selection bias toward flows it handles well.
4. **N >= 5 per arm**, reporting median and range. Variance is large: identical setups have
   completed the task and looped uselessly.

## Suggested next steps, in order

1. One clean paired run (h11/a11) to confirm the harness end to end.
2. Filesystem snapshot/restore of the datastore, wired as a `--reset` step.
3. A neutral public target app + its own task file.
4. The N=5 sweep across arms A1/B1, then the sensitivity arms (A2 inner model = orchestrator,
   A3 `--no-escalate`).
