---
name: sitelooper
description: Delegate a whole natural-language browser step — one with judgment or multiple assertions baked in — to an internal LLM agent loop that drives Playwright itself, instead of you clicking/filling/asserting element-by-element. Best for executing E2E test plans, multi-step flows, and app-specific verification against a written app briefing. Uses the `sitelooper` CLI. For low-level, deterministic single-action DOM poking (one click, one fill, one read), prefer the `browser-testing` skill / `agent-browser` CLI instead — cheaper and no LLM tokens spent per action.
---

# sitelooper: agent-in-the-loop browser automation

`sitelooper` takes one natural-language instruction and returns one concise
structured result — `{status, summary, details?, evidence?}` — instead of you
issuing 4-6 selector-aware, wait-aware calls per logical step. An internal LLM
agent (GLM 5.2 via novita by default — already configured, `NOVITA_API_KEY` is
set) translates the instruction into Playwright tool calls against a
persistent browser, verifies the result, and reports back. You never touch
selectors, waits, dialogs, or quoting for the delegated step.

Check availability: `sitelooper --help`. Already installed/linked on this
machine.

## Core loop

```sh
# deterministic verbs — no agent tokens spent
sitelooper open http://localhost:5173
sitelooper brief docs/AUTOMATION_GUIDE.md   # load app-specific conventions/selectors into the session
sitelooper note "runid is k7x2"             # record run state the agent must know
sitelooper peek [--selector css] [--interactive]
sitelooper screenshot [path]

# the core verb — anything requiring judgment or multi-part assertions
sitelooper do "log in as admin@example.com / pw123"
sitelooper do "create a supplier organisation named 'k7x2 MTP Supplies Ltd' and confirm it appears in the Organisations list with the count incremented" --json

# housekeeping — answered immediately, even while a `do` is running
sitelooper session list
sitelooper stop [--all]                     # prints video paths if the session was recorded
sitelooper config
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
sitelooper --session flow --script open http://localhost:5173
sitelooper --session flow do "log in as admin@example.com / pw123"
sitelooper --session flow script tests/login.spec.ts   # standalone @playwright/test spec
```

Every successful action is captured with a durable locator resolved from the live DOM (testid →
role+name → label → id → text → CSS path) and verified against the page, so no `@ref` handles leak
into the output. One `test.step` per `do`. `wait_for` becomes a real assertion; `read` becomes a
commented-out one; anything unresolvable is a `TODO`, never a wrong selector. Review before
committing — it replays the path the agent took, detours included. `script --clear` discards the
recording; adding `--clear` to a write starts a fresh one.

For a flow whose steps have already converged into stored procedures (via `--learn`, see below),
`sitelooper compile <flow-name-or-path> [--out <dir>] [--force]` is the other route to a spec: no
session, no daemon, no model call — it emits an owned `<name>.flow.ts` (the flow plus one generated
step function per `FlowStep`, compiled straight from the stored locator chains) and a `<name>.spec.ts`
scaffold written once and never overwritten. It is compile-time only: no live-page measurement, no
point-candidate clicks, and no runtime recovery if a locator has since drifted — a drifted step fails
the spec outright rather than reasoning its way to the moved control. `compile` exits 2 when a step
never converged to a stored procedure. When a compiled spec later goes red or logs drift in CI,
see "Repairing a compiled spec after a red CI run" below — that's a `repair` job, not a `do`.

## Repairing a compiled spec after a red CI run

A compiled spec (`<name>.flow.ts` + `<name>.spec.ts`, from `compile` above) runs under plain
`@playwright/test` with no model in the loop — so when you land on a red run of one, don't reach
for `do`. Work the failure like this:

1. Read the Playwright report. Look for `[sitelooper drift] ...` lines (a locator's primary
   candidate missed but a recorded fallback covered — the test may still be green) and, on an
   actual failure, the `// @step <id> <segment>/<index>` anchor comment in the `.flow.ts` nearest
   the failing line — that's the step and candidate to focus on, not the whole flow.
2. Dry-run the repair first: `sitelooper repair <name.flow.ts> --var k=v ... --dry-run`. This
   performs the real triage and prints the change list without writing anything, so you can see
   what it *would* do before it touches the file.
3. If the change list looks right, run it for real with a convergence check and a fresh identity
   per run: `sitelooper repair <name.flow.ts> --var k=v --var runid=fix-{n} --converge 1`. `{n}`
   in a `--var` value becomes the run number, so a record-creating flow doesn't collide with
   itself across the repair run and the converge run(s).
4. Review the printed change list line by line ("candidate promoted", "new locator", "chain
   reordered", "step re-pinned to variant ..."). This is the diff a human would otherwise have to
   reconstruct from the `.flow.ts` diff by hand.
5. Refuse anything that weakens an expectation. `repair` already refuses this on its own — a
   dropped assertion exits 1 rather than writing — but treat that refusal as final, not something
   to work around by editing the flow yourself; an assertion that stopped holding is a real test
   failure for a human to look at, not drift.
6. If `repair` reports a step **needs re-record** rather than proposing a fix, don't try to hand-
   patch the `.flow.ts` — it's regenerated in full on every `compile`/`repair` and hand edits are
   detected and refused on the next repair anyway. Instead, `--learn` a fresh session for that
   segment, converge it, and `compile` again.
7. Once `repair` has written the file (`converged: true` / "wrote ... (N change(s); the .spec.ts
   was not touched)"), commit only the `.flow.ts` diff and open it as a PR, with the printed
   change list as the PR description — that list is already the reviewer-facing summary of what
   changed and why.

Never touch the `.spec.ts` for this: it's the user's file and `repair` never rewrites it.
`repair` itself never touches anything outside a throwaway temp store until the very last
step (the file write) — the runs it performs against the live app to triage and converge are
real runs, so treat `--converge n` as `n` additional real executions against the app, same as
any other run.

## Learning mode — repeated work gets cheaper

If you will run the same kind of steps against a site more than once (a test plan you re-run, a flow
across many similar records), start the session with `--learn`. Every `do` that succeeds is compiled
into a stored, parameterised procedure; on later `do`s that start on the same page the internal agent
is offered those procedures, replays one deterministically, and only reasons about steps that no longer
work. A run that took 14 internal turns the first time typically takes 2–3 the next, with the same
report shape and every value still read back from the live page.

```sh
sitelooper --session t1 --learn open http://localhost:5173
sitelooper --session t1 do "sign in as admin@example.com / pw123 and create a project named 'k7 Demo'"
sitelooper skills list                    # what has been learned for each site
sitelooper skills show <id>               # the steps, their fallbacks, what is a parameter
```

Two habits make it work well: keep the *values* in the instruction text (a name, a cost, a url) — that
is how they become parameters rather than hard-coded literals — and keep instruction boundaries stable
across runs (one `do` = one whole outcome, as above), so the procedure learned last time matches the
outcome asked for this time. The store lives per site under `~/.sitelooper/skills/`; `skills rm`
removes anything you do not want replayed.

## When a `do` misbehaves

Control commands do **not** queue behind the running instruction, so you can always look and
intervene:

```sh
sitelooper session list             # is the daemon alive? answers in ms, mid-instruction
sitelooper screenshot               # what is the browser actually looking at right now
sitelooper stop --session <name>    # aborts the in-flight instruction, then exits
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
under `~/.sitelooper/sessions/<name>/` — logins and conversation history survive daemon
restarts. `brief` and `note` content survives history trimming. `stop` kills the daemon; the
profile stays.

## Recording a session

`--record` on the first call of a session (the one that launches the browser) records the whole
session to webm, one file per tab, under `~/.sitelooper/sessions/<name>/video/`:

```sh
sitelooper open http://localhost:5173 --session run1 --record
sitelooper do "..." --session run1
sitelooper stop --session run1              # prints:  video: .../video/page@<hash>.webm
```

Playwright only writes the video out when the browser context closes, so: it cannot be started or
stopped mid-session, nothing is readable until `stop`, and killing the daemon any other way loses
the recording entirely. `sitelooper config` reports `recording` so you can check which mode a
running session is actually in — passing `--record` to an already-running session does nothing.

Use it when you need to show a human what happened, or to debug a flow that fails intermittently.
For a single moment, `screenshot` is cheaper and readable immediately.

## Design boundary — this tool is app-agnostic

`sitelooper` itself has no knowledge of any specific app under test. All app-specific knowledge
(selectors, class names, gestures, URLs, workflow assumptions) belongs in the `brief` you load or
the instruction text you write — never assume the tool "knows" an app's UI. See the project README
(`C:\dev\sitelooper\README.md`) for the full design rationale and the complete tool/provider
reference if you need more than this skill covers.
