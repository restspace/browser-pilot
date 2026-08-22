# Benchmark handoff — 2026-08-21

State of the browser-pilot vs agent-browser benchmark. Everything described here is committed
on `main`; the working tree is clean and no processes were left running.

## Bottom line

**There is still not a publishable result, and the gap is no longer just run count.** h12 is the
first browser-pilot run that is complete, fully costed, and externally verified against the app
database. What blocks publication now is that the two headline metrics are known to be unsound
as measured: the context advantage is *conditional on how the orchestrator sizes its
instructions* rather than structural (h11 used 45 `do`s where h12 used 15), and commands-per-run
was *not comparable across arms* because agent-browser chains with `&&` and browser-pilot does
not. Both are now addressed — sizing guidance moved into the shipped `--help`, and the harness
splits chains into separate invocations — but that is precisely why **no run before 2026-08-21
is comparable to one after it**. The next step is a re-baseline, not more analysis of the runs
below. Three further harness defects (9-11) were found by review after h12 and a13 ran; neither
run is invalidated by them, but every earlier run's timeout accounting is.

## What exists

| Path | Purpose |
|---|---|
| `bench/harness.mjs` | One agent loop, both arms. Arms differ ONLY in which binary the single `run_command` tool may invoke, and that binary's own `--help` in the system prompt |
| `bench/tasks/atelyr-project-flow.md` | The goal, stated as objectives. `{{PLACEHOLDER}}`s are filled from env so credentials stay out of the repo |
| `bench/armdocs/*.md` | Each tool's verbatim `--help` |
| `bench/rates.json` | Dated USD rate card |
| `bench/score.mjs` | Prices runs; orchestrator and inner model costed separately |
| `bench/verify.mjs` | External success check against the app database. Only objectives 1 and 6 are verifiable — objective 6's cleanup destroys the evidence for 2-5 |
| `bench/reset.mjs` | Datastore snapshot/restore (`--snapshot`/`--restore`/`--status`), wired into the harness as `--reset`. Baseline captured 2026-08-21 (7 projects, 7 items) after clearing 19 bench projects |
| `bench/check-splitter.mjs` | Tests the shell-operator splitter against every recorded command |
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
| h11 | browser-pilot | died: task reaped at turn 59, no result JSON | 59 | ~2180s | 69.6KB | — | — |
| h12 | browser-pilot | **complete**, obj 1+6 externally verified | 17 | 1658s | 25.5KB | 0.060 | 0.531 |
| a12 | agent-browser | void: hit turn cap via harness defect 8 | 200 | 748s | 122.8KB | 0.60 | n/a |
| a13 | agent-browser | genuine fail: turn cap, stuck before obj 2 | 200 | 882s | 38.5KB | 0.39 | n/a |

Re-baseline runs (2026-08-21, after the help/harness changes; `--reset` on all three):

| Run | Arm | Status | Turns | Wall | Ctx | Orch $ | Inner $ |
|---|---|---|---|---|---|---|---|
| h13 | browser-pilot | complete, but **inner cost lost** (defect 12) | 17 | 648s | 15.5KB | 0.048 | — |
| h14 | browser-pilot | fail: turn cap, 119 `do`s all retrying sign-in | 120 | 1632s | 178.5KB | 0.130 | 0.781 |
| a14 | agent-browser | fail: turn cap, 200 `snapshot`s, never filled or clicked | 200 | 703s | 191.1KB | 0.227 | n/a |

**No complete-and-costed run exists on the new baseline.** Three attempts, three
different failure modes.

Discarded (not in results/): h03 (killed, ran concurrently with a03 — contention), h05 (killed by
a disconnect at 35 turns, **zero retries**, which is what confirmed the connection-pooling fix),
h09 (degenerate loop, see below), h10 (killed on request mid-run).

### Signals, not conclusions

- **Context into the orchestrator is ~2.5x lower for browser-pilot when the orchestrator sizes
  its instructions well** (25.5KB vs 72KB) — conditional, not structural. The mechanism is
  instruction COUNT, not instruction type. Measured with the new `subcommands` field:

  | run | `do` | `peek` | other | ctx |
  |---|---|---|---|---|
  | h12 | 15 | 0 | open 1, config 1 | 25.5KB |
  | h11 | 45 | 8 | open 1, config 1, reset 2 | 69.6KB |

  Both delegated; h11 simply chopped the same goal into three times as many pieces, at a nearly
  identical ~1.6KB of context per instruction either way. An earlier reading of this file blamed
  h11 on `peek` polling — that was wrong, and the counts disprove it. The lever is chunk size,
  which is why browser-pilot's `--help` now carries an "Sizing an instruction" section (see
  README, deliberate asymmetries). Report the spread and the `do` count, never the best run.
- **Wall clock is consistently 2.5–3.5x worse for browser-pilot** (2440–3344s vs 960s), because
  individual `do` instructions take 5–11 minutes.
- **Escalation is expensive**: in h02, glm-5.3 was 4 of 14 instructions but **76% of inner cost**.
  Only visible because of the per-model tracking added this session.

- **The loop guard is now advisory only** (settled 2026-08-21). It had compared byte-identical
  command text, which a13 evaded by alternating `'a13 MTP Bench'` and `'a13 MTP'` while looping
  on the same dropdown. It now compares **output**, since identical output means nothing was
  learned however the command was worded, and it **appends a hint to the tool result without
  suppressing the command or ending the run** — the turn cap is the only terminator. Rationale:
  every terminating version can bias an outcome, and biases unevenly, because agent-browser
  legitimately re-reads far more than browser-pilot and the task file itself warns that list
  views refresh asynchronously. A false abort corrupts a result; a missed loop wastes ~$0.60 of
  a run that was going to be discarded. Disclose that this is the third guard revision.
- **The advisory guard fires correctly and is ignored.** a14 issued the same `snapshot` 200 times
  and took **184 advisories** without changing course, burning its whole cap. That is the
  accepted cost of advisory-only, but the cost is NOT symmetric: the same failure shape cost
  $0.23 on agent-browser and $0.91 on browser-pilot (h14), because each wasted turn there is a
  whole sub-agent run rather than one CLI call. If runs keep looping, the cheap correction is a
  lower `--maxTurns` for the browser-pilot arm, or a spend ceiling — NOT a return to aborting on
  repetition, which is what biased earlier versions.
- **agent-browser completed 1 of 3 attempts.** a03 finished in 70 turns; a12 was void (defect 8);
  a13 genuinely hit the 200-turn cap without reaching objective 2, stuck selecting the project
  when creating a line item. Combined with browser-pilot's h11-vs-h12 split, both arms show
  bimodal outcomes — complete, or stuck in a loop — rather than a tight distribution.

- **Commands-per-run is NOT comparable across arms.** `commandIsAllowed` is a prefix check and
  the command runs through a shell, so `agent-browser X && agent-browser Y` counts as one
  command. Now measured by the `subcommands`/`invocationCount` fields: **a03 recorded 70 commands
  but made 160 real invocations (2.3x), a13 recorded 196 and made 215.** browser-pilot's arm is
  1:1 — it never chains. So every per-command figure for agent-browser (count, ms, and a03's 4
  non-zero exits, which are chains that short-circuited) is understated by roughly 2x. Quote
  `invocationCount`, not `commandCount`. **Settled 2026-08-21: the harness now splits on
  top-level shell operators and runs each segment as its own invocation**, honouring `&&`/`||`
  short-circuiting and logging skipped segments. Dropping the shell entirely was rejected because
  it would remove agent-browser's ability to chain at all — a genuine ergonomic advantage of a
  fast deterministic CLI — and so would penalise it for a harness convenience. Splitting keeps
  the chaining, makes counts comparable, checks every segment against the allow-list instead of
  only the first, and closes chaining as a way past the repeat detector. The splitter is
  quote-aware (agent-browser's `eval` payloads are JavaScript containing `&&` and `;`) and is
  tested against all 475 recorded commands by `bench/check-splitter.mjs`: 475 commands → 598
  segments, 59 chains, and exactly one previously-run command now refused
  (`... 2>/dev/null`, a top-level redirect, correctly outside the sandbox).

- **Three of the four newest runs stalled at or before login, and the cause is not the backend.**
  h14 spent 119 `do`s re-issuing sign-in; a14 took 200 snapshots and never once called `fill` or
  `click`; a13 looped on a dropdown. Measured and ruled out: backend latency right after a
  restore is 88ms on the first query and ~7ms after, and a manual UI login works with no console
  errors. One suggestive detail: a14's very first `snapshot -i --compact` returned **27 bytes**
  (effectively empty) before every later snapshot returned an identical 982, which points at the
  orchestrator acting on an empty first observation and never re-orienting. Worth capturing
  command OUTPUT in the transcript — currently only byte counts are stored, which is why this
  cannot be settled from the recorded runs.

All of the above is n=1 per arm. Do not publish any of it.

## Harness defects found and fixed

Thirteen. Five would have biased the published result **against** browser-pilot, which is worth
stating given whose repo this is; defect 8 biased it against agent-browser. Defects 9-11 came
from a review by a second session and were confirmed by measurement here before being fixed —
9 and 11 had never fired on a real run, and 10 had been silently mis-measuring every timeout.

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
8. **The degenerate-loop guard could never abort** (found in a12, fixed). The nudge branch
   suppressed the repeated command and `continue`d *without* appending it to `commands`, but the
   repeat count was derived from that executed history. The tally therefore stuck at exactly the
   nudge threshold forever: the guard re-nudged every turn and never reached the abort threshold.
   a12 spent its entire 200-turn cap re-proposing one `eval` command — 128 nudges, 0 aborts — and
   the guard meant to stop that burned the run instead. The count is now over *proposals* rather
   than executions, so it escalates 4 → 8 and abandons; unit-checked as nudging once at 4 and
   aborting at 8. Disclose that defect 7 was added after it hurt browser-pilot and defect 8 was
   found after it hurt agent-browser — the guard has now cost each arm one run.
9. **The nudge broke tool-call protocol** (found in review, fixed). It pushed a bare user message
   and continued, leaving the assistant's `tool_use` with no matching `tool_result`. The
   Anthropic API rejects that with a 400 and `post()` treats 4xx as terminal, so any Anthropic
   run would have died at the first nudge; novita/GLM tolerates it, which is the only reason a12
   survived 128 of them. The nudge is now delivered as the tool result for that call.
10. **The command timeout could never fire correctly** (found in review, fixed). With
    `shell:true` the child is `cmd.exe` and the CLI is a grandchild, so `child.kill()` killed the
    shell only; the CLI kept the inherited stdio pipes open and `close` never fired. Measured:
    a 2s timeout on a 60s grandchild was still blocked after 15s. The harness would hang until
    the orphan exited on its own rather than at `timeoutMs`. Now kills the tree (`taskkill /T /F`)
    with a 10s drain backstop, and `isError` is set explicitly for killed commands instead of
    relying on `code === null` being non-zero.
11. **reset.mjs matched no mongod** (found in review before ever being run, fixed). The instance
    path was backslash-doubled into a PowerShell single-quoted string, which does no escape
    processing; measured against the live process, the doubled needle matched 0 of 1 mongod and
    the plain path matched 1. `--restore` would have killed rs2-server, left mongod holding the
    datastore, and thrown with the backend half-down and nothing to restart it.

12. **Inner cost was lost whenever the agent stopped its own session** (found in h13, fixed).
    Usage was read once at the end from `browser-pilot config`, but a task whose last objective is
    cleanup ends with `browser-pilot stop` — killing the daemon that holds the counters. The
    later `config` then spawned a FRESH daemon and truthfully reported zero, so h13 finished
    complete but uncosted. Usage is now sampled after every command while the daemon is alive,
    keeping the high-water mark and ignoring a drop to zero (a new daemon, not progress).
    `config` is ~200ms and is not recorded as one of the run's commands.
13. **The restore corrupted the datastore on its first real execution** (fixed, see commit
    9352171). Delete-then-copy plus asynchronous Windows handle release left mongo-data with 29
    of 45 files and the backend down. Restore now renames aside, copies, then deletes, and rolls
    back on failure. The snapshot taken ninety seconds earlier is what made it recoverable.

## How to resume

Prerequisites: RS2 backend on `127.0.0.1:3100` (`C:\dev\rs2-instance\start-backend.ps1`), atelyr
dev server (`cd C:\dev\atelyr && npm run dev`, binds IPv6 — use `localhost`, not `127.0.0.1`), and
a funded `NOVITA_API_KEY`.

The bench login is the seeded local account `mtp-e2e@atelyr.com`; its password is recorded in
`C:\dev\atelyr\docs\E2E_PASS12.md` ("Login / seeding") and deliberately not repeated here — these
files are meant to be publishable. The user record must still exist at
`C:\dev\rs2-instance\data-store\main\users\records\mtp-e2e%40atelyr.com.json`; if a datastore
restore has removed it, re-seed per that doc. Check `NOVITA_API_KEY` has balance before starting
a 45-minute run — h08 burned a slot on a 403 `NOT_ENOUGH_BALANCE`.

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

- **Launch runs as a detached OS process, not as a tracked background task.** A run tied to an
  agent harness's background-task lifecycle can be reaped mid-run: h11 was killed at turn 59
  (~37 min in) with no result JSON, and because stdout is block-buffered the `.log` file was
  empty — only the line-buffered transcript survived. Use `nohup ... &`, or on Windows
  `Start-Process -WindowStyle Hidden -RedirectStandardOutput ...`. Judge progress from the
  transcript, never from the `.log`.
- **agent-browser's first command after a cold start hangs** (>45s, seen 5 times). Kill it and
  retry; the retry takes ~0.4s. Pre-warm before a timed run and report the hang separately.
- **Vite survives `TaskStop`** — the wrapper dies, the process does not. Kill the PID holding
  port 5173 directly.
- **Do not mass-kill chrome.exe.** Benchmark browsers are not distinguishable by name; on this
  machine all 54 chrome processes were the user's own. Match on command line first.
- Stop stale sessions between runs: `browser-pilot stop --session <runid>`.

## Before this can be published

Unchanged from `bench/README.md`, all still open:

1. **Database reset is written but never executed.** `bench/reset.mjs` snapshots and restores
   `mongo-data/` **and** `data-store/` (the seeded bench login lives in the latter; restoring
   Mongo alone logs every later run out) and is wired into the harness as `--reset`. No
   `mongodump`/`mongosh` is installed, only `mongod`, hence the filesystem copy. It has not been
   run once: doing so stops the backend, and no window was free. Capture a baseline before the
   sweep, and decide first whether to clear the 19 accumulated bench projects.
2. **Single, private application.** A reader cannot reproduce a run against atelyr. A neutral
   public target is required.
3. **Task provenance.** The task set was written while developing browser-pilot against this app,
   which risks selection bias toward flows it handles well.
4. **N >= 5 per arm**, reporting median and range. Variance is large: identical setups have
   completed the task and looped uselessly.

## Suggested next steps, in order

1. **Capture the datastore baseline.** `bench/reset.mjs` is written and wired as `--reset` but
   has never been executed, because doing so stops the backend and no window was free. Two
   decisions first: whether to clear the 19 accumulated bench projects before snapshotting, and
   that the snapshot must include `data-store/` (the seeded bench login lives there — restoring
   `mongo-data/` alone would log every later run out).
2. **Re-baseline both arms.** browser-pilot's `--help` gained instruction-sizing guidance and
   the harness changed how it counts and runs commands, so no run before 2026-08-21 is
   comparable to one after. Everything resets once, here.
3. A neutral public target app + its own task file.
4. The N=5 sweep across arms A1/B1, then the sensitivity arms (A2 inner model = orchestrator,
   A3 `--no-escalate`).
