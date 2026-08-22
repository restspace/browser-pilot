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

## Arm B baseline break — 2026-08-21

**Every agent-browser row below was produced by agent-browser 0.16.3.** Measurement is
restarting against **0.34.0** (npm latest, published 2026-08-10), pinned in
`bench/cloud-setup.sh`. That is eighteen minor versions of behaviour change, so a03/a12/a13/a14
are a **closed baseline**: do not pool them with new runs, do not plot them on the same axes,
and do not compare a new browser-pilot run against an old agent-browser one. The
browser-pilot-side figures are unaffected by this.

This machine still had 0.16.3 installed at the time of writing. Upgrade before measuring here:

```sh
npm install -g agent-browser@0.34.0
```

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

**No complete-and-costed run exists on the new baseline *for the atelyr target*.** Three
attempts, three different failure modes.

Neutral target (`--target repairdesk`, the app that ships in `bench/app`), 2026-08-22:

| Run | Arm | Status | Turns | Wall | Ctx | Orch $ | Inner $ | Total $ |
|---|---|---|---|---|---|---|---|---|
| r01 | browser-pilot | **complete, all 6 objectives externally verified** | 16 | 769s | 19.2KB | 0.047 | 0.060 | 0.107 |
| r02 | agent-browser | fail: turn cap, **0/6**, never got past login | 120 | 1238s | 8.9KB | 0.228 | n/a | 0.228 |
| r03 | agent-browser | **complete, all 6 objectives externally verified** | 78 | 536s | 37.0KB | 0.284 | n/a | 0.284 |

Same target, first runs on **cloud Linux** (Claude Code routines, "BrowserPilot" environment,
one fresh 4-CPU/17GB Ubuntu box per arm, Node 22.22), 2026-08-22. Raw files are in
`bench/results-published/`, merged from the `results/<runid>` branches:

| Run | Arm | Status | Turns | Wall | Ctx | Orch $ | Inner $ | Total $ |
|---|---|---|---|---|---|---|---|---|
| c0822ab | agent-browser 0.34.0 | **complete, all 6 objectives verified against the mutation log** | 40 | 214s | 39.3KB | 0.179 | n/a | 0.179 |
| c0822bp | browser-pilot | fail: turn cap, **0/6**, 119 `do`s all blocked at sign-in (attempt 2; attempt 1 void, see below) | 120 | 4663s | 369.5KB | 0.112 | 7.214 | 7.326 |
| c0822bp2 | browser-pilot | **post-fix**: inner sign-in now succeeds first try, but still 0/6 turn-cap — orchestrator re-issued sign-in 119× and never advanced (see below) | 120 | 1543s | 172.2KB | 0.121 | 0.680 | 0.802 |

### First paired comparison (r01 vs r03), N=1 each — read the caveats

| | browser-pilot (r01) | agent-browser (r03) |
|---|---|---|
| Objectives verified | 6/6 | 6/6 |
| Turns | 16 | 78 |
| Wall | 769s | **536s** |
| Context to orchestrator | **19.2KB** | 37.0KB |
| Total cost | **$0.107** | $0.284 |

The shape matches what earlier atelyr runs suggested and neither arm is uniformly ahead:
agent-browser is **faster in wall-clock** while costing ~2.7x more and ~1.9x the orchestrator
context. browser-pilot's wall time is dominated by its inner model thinking; agent-browser's
commands are milliseconds each but it needs far more of them.

Caveats, all of which matter more than the numbers:

- **N=1 per arm.** Both arms are bimodal on this benchmark — r02 was the same arm, same task,
  same model, and scored 0/6 at the turn cap. A single success does not establish a rate.
- **r03 is inflated by an environment artifact.** A stale `r03` daemon left by a destroyed
  earlier attempt cost it ~230s of its 536s and ~11 of its 78 turns before it worked around it.
  Cleaned up, agent-browser's wall-clock advantage here would be *larger*, not smaller.
- **Windows, not Linux**, and both runs were on the same developer machine.
- r01's inner model was deepseek-v4-flash throughout, with no escalation. A different inner
  model moves its cost line and nothing else.
- **r03's verification is not independently re-checkable.** See the gap below.

### First cloud pair (c0822ab vs c0822bp) — and the sign-in loop, settled

The two arms ran concurrently on identical fresh boxes, which is the setup the runbook was
written for. agent-browser's figure is clean: 6/6 in 214s for $0.18, the fastest and cheapest
complete run of that arm so far (no stale daemon this time — r03's 230s penalty is gone, and
the cloud box is quicker than the Windows workstation). browser-pilot's figure is a failure,
and this time the failure is fully diagnosable because the transcript now stores command output:

- **Attempt 1 (void, not published):** every `do` failed instantly with "no API key". The
  runbook never exported `BROWSER_PILOT_PROVIDER`; the harness's `--provider` configures the
  orchestrator only, and browser-pilot's inner agent defaulted to `zhipu`. Fixed in
  `cloud-setup.sh` and `CLOUD-RUNBOOK.md` (commit 21092c7). 5.5 minutes, orchestrator tokens
only; its files were archived on the box and not published.
- **Attempt 2 (published as c0822bp):** the orchestrator opened the app correctly at turn 1
  (`browser-pilot open http://127.0.0.1:4180/` → "Repair Desk — …#/tickets"). On the very
  first `do` ("Sign in…"), the inner agent did **not** look at the page it was on: its first
  action was `page.goto http://localhost:3000`, which failed, leaving the tab on
  `chrome-error://chromewebdata/`. It then spent 17 turns port-scanning localhost from inside
  the browser, reported "the app is unreachable", and — because the daemon keeps the inner
  conversation across `do` calls — every one of the next 118 sign-in instructions re-read that
  history and answered "still not running". The orchestrator rephrased the instruction five
  ways and never tried `browser-pilot reset` or re-`open`. 78 minutes; $7.21 of inner-model
  tokens (19.8M prompt, of which 8.4M went to the glm-5.3 escalation that every blocked
instruction triggers).
- **This is h14's failure too.** h14 (2026-08-21, atelyr target) was "119 `do`s re-issuing
  sign-in" and could not be explained because only byte counts were recorded. Same arm, same
  shape, same count. Two sightings in two days on two targets: the browser-pilot arm is
  bimodal because of one product defect, not noise.

**The defect is in browser-pilot, not the harness or the orchestrator.** `src/agent/loop.ts`
pushes the caller's instruction as the user message with no statement of the current page URL
or title. The system prompt says "if you don't know the current page state, call snapshot
first" — r01's model did; c0822bp's guessed a URL and navigated away from the page the caller
had set up. Two cheap fixes, both app-agnostic: (1) prefix each instruction with the live
`page.url()`/title so the model never has to guess where it is; (2) a rule that the browser is
already on the caller's page and a guessed `goto` to a different origin is not an acceptable
first move. A third, orthogonal: when an instruction reports `blocked` on a page whose URL
differs from the session's last successful one, say so in the report — the orchestrator had
no signal that its tool had wandered off.

Until that lands, **do not run an N=5 sweep on this arm**: a third of the runs will be $7
turn-caps that measure the defect, not the tool.

Setup notes from the cloud boxes, for the record: `cloud-setup.sh --with-arm-b` needed no
fixes on Ubuntu 24.04 (apt deps, Chromium 1228 download, app start, all clean, ~40s).
agent-browser 0.34.0 declares `node >=24` and the image has 22.22 — npm printed `EBADENGINE`
and installed anyway; it ran fine, but a box with a stricter npm would refuse it. Both sessions
found `bin/browser-pilot.js` flipped to mode 755 by `npm link`; now committed that way.

### Post-fix rerun (c0822bp2): the inner fix worked, and exposed the layer beneath it

With the blind-start fix (commit 647b7f9) the inner agent is no longer the problem: the first
`do` signed in cleanly in 5 turns, landed on `#/tickets`, and named the "New ticket" button;
every later `do` correctly reported "already signed in". Inner cost fell from $7.21 to $0.68
(no instruction ever went `blocked`, so the glm-5.3 escalation that dominated c0822bp never
fired), and the spend ceiling logged $0.80 without needing to trip.

But the run still turn-capped at **0/6**, for a defect one layer up: the **orchestrator issued
`browser-pilot do "sign in…"` 119 times and never once issued an instruction about creating a
ticket** (non-signin `do` count: 0; mutation log empty). It received a clear success and a
description of the tickets page every time and did not advance to objective 1.

This is not the inner agent and not the harness plumbing — it is the orchestrator (glm-5.3,
driving the benchmark) failing to progress. Two things make it worse than plain model variance:

- **The loop guard never fired.** `repeatedOutput` (bench/harness.mjs) nudges only on
  *byte-identical* output, deliberately, to stop an arm escaping it by changing one string.
  But each sign-in success is worded slightly differently (ticket counts, "Signed in" vs "No
  login form was shown"), so `sameOutputRuns` never reached the threshold and the orchestrator
  got no advisory at all across 119 near-identical turns. A guard keyed on semantic sameness,
  or simply on "same subcommand + same reported status N turns running", would have caught it —
  but any such guard changes the comparison and must be applied to both arms and disclosed.
- **The same orchestrator model completed this exact task as r01** (16 turns, 6/6). So glm-5.3
  is capable of it; c0822bp2 is the bad half of the bimodal outcome HANDOFF already flagged,
  now seen cleanly with a working inner agent. N is still 1 per condition.

**Not fixed here, on purpose.** The remaining defect is orchestrator behaviour, and the obvious
levers — a smarter loop guard, an orchestrator prompt that lists objectives as a checklist, a
lower `--maxTurns` for this arm — all change what the benchmark measures and so are a
methodology decision, not a bug fix. What IS in hand: the inner agent is sound, and a
recurrence now costs ≤$2 instead of $7. Suggested next step 0b covers where to take the
orchestrator question.

### Gap: the mutation log does not survive the app

The log is in-memory only. Stopping `bench/app/server.mjs` destroys it, so a run can only be
verified while the app that saw it is still up. I could not re-verify r03 after the fact for
exactly this reason — the pass is recorded in the run's report and nowhere else, which is
weaker than the design intends. Persisting the log alongside `data/*.json`, or having the
harness dump `/__log` into `bench/results/` at the end of a run, would make a verified run
auditable later instead of only in the moment.

r02 (agent-browser 0.34.0) is **not a usable timing data point**: 910 of its 1238 seconds were
the harness's own `'close'` bug (see gotchas), and its first command was killed by the timeout.
Its *failure* is real, though, and the mutation log confirms it — 0 entries, so the run never
wrote anything. What happened:

- Turn 1 opened the app and took the run's **only** snapshot. `subcommands` for the whole run:
  `open: 1, snapshot: 1, fill: 238, click: 119`.
- Turn 2 filled email and password and clicked Sign in. **All three succeeded** — login worked.
- Turns 3-120 repeated that same three-command sequence 118 more times against a form that was
  no longer on the page, ignoring the harness's degenerate-loop advice at `repeat: 118`.

Two things fed the loop, and both are worth writing down because they are about the tool
surface rather than the model having a bad day:

1. **It never took a second snapshot**, so having logged in successfully it had no evidence of
   that and no refs for anything past the login form.
2. **`fill` on a stale ref reports success.** `fill @e4` and `fill @e5` returned `✓ Done` with
   exit 0 against a form that had gone; only `click @e6` failed. Two of three commands saying
   "working" is close to worst-case input for a model deciding whether to retry.

N=1, and the loop may not reproduce. It needs re-running on the fixed harness before anyone
draws a conclusion from it.

`node bench/verify-repairdesk.mjs r01` → 6/6 PASS, 0 claim mismatches, 0 residue left active.
Subcommands: 13 `do`, 1 `open`, 1 `config`, 1 `peek`. No escalation — the whole run stayed on
`deepseek/deepseek-v4-flash`. The agent discovered the Ready precondition by reading the
rejection off the page, set a supplier on both parts, and retried; the mutation log shows those
two writes at seq 5-6, immediately before the successful transition at seq 7.

**This is the first run in the whole benchmark where objectives 2-5 were verified at all**,
rather than reported by the agent and checked only for arithmetic self-consistency. That is the
mutation log doing its job, not the tool performing better.

Do NOT compare r01's $0.107 against h12's $0.591. Different app, different task instance, and
a different inner model (r01 ran deepseek-v4-flash throughout; h12's inner spend was GLM). It
is a first data point on a new target, N=1, and nothing more. The agent-browser arm has never
been run against this target, so there is no paired comparison here yet.

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
- ~~**agent-browser's first command after a cold start hangs**~~ — **this was our bug, fixed
  2026-08-22.** agent-browser was never slow. `runCommand` resolved only on `'close'`, which
  waits for the stdio pipes; agent-browser leaves a detached daemon holding them after the CLI
  exits, so `'close'` never fired and the harness sat on a command that had already printed its
  output until the timeout killed it. Measured directly against the real CLI: **60s timeout
  waiting on `'close'`, 1.8s waiting on `'exit'`, byte-identical output.** The harness now
  resolves on `'exit'` with a 500ms grace for trailing output. Pre-warming "worked" because a
  second command on a live session reuses the daemon rather than spawning one.
  **Consequence for the record:** any agent-browser run whose session was not pre-warmed has
  ~900s of dead time in its wall clock and `commandMs`, and a spurious `timeouts: 1`. r02 lost
  910 of 1238s this way. Earlier a-runs were manually pre-warmed per the advice above, so they
  are less affected, but which ones and by how much is not recoverable from what was kept.
- **Sweep agent-browser sessions before reusing a runid.** The harness passes `--session
  <runid>`, so a daemon left by an abandoned run of the same name is still listening and
  answers slowly or not at all. r03 spent ~230s and ~11 turns fighting a stale `r03` daemon
  before routing around it. `agent-browser session list`, then kill, before any rerun.
- **A run launched by a subagent dies with that subagent's worktree.** A remote/worktree agent
  that starts the harness and then ends its turn leaves it writing into a deleted directory:
  the process keeps calling the model and produces nothing recoverable. Block on the run inside
  the turn, and point `--out` at an absolute path outside the worktree.
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

0. ~~Fix the inner agent's blind start~~ **Done 2026-08-22**: every `do` now ends with a
   `[browser] You are currently on <url> — "<title>"` line (with an explicit warning on
   `chrome-error://` and `about:blank`), and operating rule 2 forbids a guessed `goto` or any
   port/hostname probing. Live check against the local app with c0822bp's exact first
   instruction: signed in, 5 turns, never left port 4180 (n=1). The harness also gained a
   spend ceiling (`--maxUsd`, default 2.00, `stop=spend-cap`) so a recurrence costs $2, not
   $7. **Next: rerun the browser-pilot arm on the cloud** (`/schedule` a routine on the
   BrowserPilot environment pointed at `bench/CLOUD-RUNBOOK.md`; one routine per arm, ~4 min
   to provision, results come back as `results/<runid>` branches to merge). Done as c0822bp2 —
   inner agent fixed, but see 0b.

0b. **Decide the orchestrator-loop question** (surfaced by c0822bp2, see "Post-fix rerun"). The
   benchmark orchestrator looped on sign-in for a whole run while the inner agent kept
   succeeding. This is a methodology call, not a bug: options are (a) accept it as bimodal
   variance and let N≥5 average it out — cheap now that a bad run is ≤$2; (b) add a loop guard
   keyed on "same subcommand + same status for N turns" rather than byte-identical output,
   applied to BOTH arms and disclosed; (c) give the orchestrator an explicit objective
   checklist. (b)/(c) change what is measured — get a human decision before shipping either.
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
