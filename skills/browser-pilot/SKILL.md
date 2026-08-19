---
name: browser-pilot
description: Delegate a whole natural-language browser step — one with judgment or multiple assertions baked in — to an internal LLM agent loop that drives Playwright itself, instead of you clicking/filling/asserting element-by-element. Best for executing E2E test plans, multi-step flows, and app-specific verification against a written app briefing. Uses the `browser-pilot` CLI. For low-level, deterministic single-action DOM poking (one click, one fill, one read), prefer the `browser-testing` skill / `agent-browser` CLI instead — cheaper and no LLM tokens spent per action.
---

# browser-pilot: agent-in-the-loop browser automation

`browser-pilot` takes one natural-language instruction and returns one concise
structured result — `{status, summary, details?, evidence?}` — instead of you
issuing 4-6 selector-aware, wait-aware calls per logical step. An internal LLM
agent (GLM 5.2 via novita by default — already configured, `NOVITA_API_KEY` is
set) translates the instruction into Playwright tool calls against a
persistent browser, verifies the result, and reports back. You never touch
selectors, waits, dialogs, or quoting for the delegated step.

Check availability: `browser-pilot --help`. Already installed/linked on this
machine.

## Core loop

```sh
# deterministic verbs — no agent tokens spent
browser-pilot open http://localhost:5173
browser-pilot brief docs/AUTOMATION_GUIDE.md   # load app-specific conventions/selectors into the session
browser-pilot note "runid is k7x2"             # record run state the agent must know
browser-pilot peek [--selector css] [--interactive]
browser-pilot screenshot [path]

# the core verb — anything requiring judgment or multi-part assertions
browser-pilot do "log in as admin@example.com / pw123"
browser-pilot do "create a supplier organisation named 'k7x2 MTP Supplies Ltd' and confirm it appears in the Organisations list with the count incremented" --json

# housekeeping — answered immediately, even while a `do` is running
browser-pilot session list
browser-pilot stop [--all]                     # prints video paths if the session was recorded
browser-pilot config
```

- Exit codes: `0` succeeded · `1` failed/blocked · `2` infra error (no key, no browser, LLM unreachable).
- `--json` gives `{report, turns, usage, model}`; on any bail-out it also carries `actions` (the
  ordered tool calls that ran — check before blindly repeating a mutation), `transcriptTail`, and
  `finalState` (where the browser was left).
- `--verbose` / `--progress` stream the internal agent's turn-by-turn activity to stderr.

| Flag | Default | |
|---|---|---|
| `--max-turns` | 30 | agent turn cap per instruction |
| `--timeout` | 300 | wall-clock seconds for the whole instruction |
| `--turn-timeout` | 90 | wall-clock seconds for one LLM call — see below |

## Turning a run into a Playwright spec

If the point of the run is to end up with a committed test, start the session with `--script`:

```sh
browser-pilot --session flow --script open http://localhost:5173
browser-pilot --session flow do "log in as admin@example.com / pw123"
browser-pilot --session flow script tests/login.spec.ts   # standalone @playwright/test spec
```

Every successful action is captured with a durable locator resolved from the live DOM (testid →
role+name → label → id → text → CSS path) and verified against the page, so no `@ref` handles leak
into the output. One `test.step` per `do`. `wait_for` becomes a real assertion; `read` becomes a
commented-out one; anything unresolvable is a `TODO`, never a wrong selector. Review before
committing — it replays the path the agent took, detours included. `script --clear` discards the
recording; adding `--clear` to a write starts a fresh one.

## When a `do` misbehaves

Control commands do **not** queue behind the running instruction, so you can always look and
intervene:

```sh
browser-pilot session list             # is the daemon alive? answers in ms, mid-instruction
browser-pilot screenshot               # what is the browser actually looking at right now
browser-pilot stop --session <name>    # aborts the in-flight instruction, then exits
```

`stop` preempts rather than waits. The `do` you interrupted returns a `blocked` report with its
actions log — it does not hang, so a stuck run is always recoverable. If a control command *does*
hang, the daemon is genuinely wedged (kill the pid from `session list`); that is a bug worth
reporting, not the normal busy state.

A model that reasons without ever issuing a tool call is caught by a per-turn watchdog: the turn is
aborted at `--turn-timeout`, retried once with a nudge, and after three such turns the instruction
ends as `blocked` with the reasoning in `transcriptTail`. So a stall costs seconds, not the full
`--timeout`. If you see that report, the instruction was almost certainly too broad — split it.

## Writing good instructions

Scope each `do` to **one logical, verifiable step** — don't pack many independent assertions into
one instruction; that's what burns the turn budget and what makes the agent stall on planning.
Instructions asking for two unrelated artifacts at once ("report the console output *and* the
innerHTML of #root") are the classic failure case: ask for one, then the other. Put deterministic
sub-actions (navigation, screenshots, spot-checks) on `open`/`peek`/`screenshot` instead — free, no
agent tokens.

**Server response vs live DOM.** Every observation tool the agent has shows the live,
post-JavaScript DOM. It also has `fetch_source`, which returns the raw HTTP response body with no
JS executed, and it is instructed to call that before claiming anything about server-rendered
output — so an SSR bug (element absent from the source) is distinguished from a hydration bug
(present in the source, missing live). Reports name their source: "the live DOM contains…" vs "the
server response contains…". If a distinction matters to you, ask for it explicitly, and treat any
unattributed claim in a summary as an inference rather than an observation.

## Sessions

`--session <name>` (default `default`) owns a detached daemon with a persistent Chrome profile
under `~/.browser-pilot/sessions/<name>/` — logins and conversation history survive daemon
restarts. `brief` and `note` content survives history trimming. `stop` kills the daemon; the
profile stays.

## Recording a session

`--record` on the first call of a session (the one that launches the browser) records the whole
session to webm, one file per tab, under `~/.browser-pilot/sessions/<name>/video/`:

```sh
browser-pilot open http://localhost:5173 --session run1 --record
browser-pilot do "..." --session run1
browser-pilot stop --session run1              # prints:  video: .../video/page@<hash>.webm
```

Playwright only writes the video out when the browser context closes, so: it cannot be started or
stopped mid-session, nothing is readable until `stop`, and killing the daemon any other way loses
the recording entirely. `browser-pilot config` reports `recording` so you can check which mode a
running session is actually in — passing `--record` to an already-running session does nothing.

Use it when you need to show a human what happened, or to debug a flow that fails intermittently.
For a single moment, `screenshot` is cheaper and readable immediately.

## Design boundary — this tool is app-agnostic

`browser-pilot` itself has no knowledge of any specific app under test. All app-specific knowledge
(selectors, class names, gestures, URLs, workflow assumptions) belongs in the `brief` you load or
the instruction text you write — never assume the tool "knows" an app's UI. See the project README
(`C:\dev\browser-pilot\README.md`) for the full design rationale and the complete tool/provider
reference if you need more than this skill covers.
