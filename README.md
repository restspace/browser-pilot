# sleep-walker

**Drive a web app from natural language once; replay it afterwards with the model asleep.**

sleep-walker is a Playwright CLI with an LLM agent inside it. You give it one instruction at a
time - "sign in as ops@example.com, create a ticket titled 'k7 Bench' and report its id" - and it
works the live browser for you, then hands back one structured, verified result. Nothing about
selectors, waits, dialogs or quoting reaches you or the outer agent that is calling it.

Then, every instruction that succeeds is compiled into a **stored procedure**, and a whole session can be exported as a **flow**. The next time the same job runs,
sleep-walker replays the procedure deterministically — no model call, no tokens — and wakes the
model only for a step the app has changed underneath. On the benchmark below, a converged flow
replays a seven-step ticket workflow in 17 seconds for $0.00, verified against what the app's own
database says happened.

> Package and command are both `sleep-walker`. State lives under `~/.sleep-walker/`, env vars are
> `SLEEP_WALKER_*`. The old `browser-pilot` names still work as aliases.

## Why agent-driven browser automation does not rerun, and what sleep-walker does about it

Ask any browser agent to do a job and it will, mostly. Ask it to do the same job tomorrow and you'll
be paying the price again: the model re-reads every page, re-decides every click, and costs
$1–1.50 per run on a dense app. The obvious fix - have the agent write a script from what it did -
doesn't work. The reasons are structural, and can't be fixed with a better prompt:

- **The run's own values are baked in.** The record it created has an id, the url has a uid, the
  title carries a run marker. A script quotes them literally, so on the next run it opens
  yesterday's record — or, worse, works a *different* record to completion and reports success.
- **The page changes every time.** Ids in class names, positional selectors
  (`tr:nth-of-type(3)`), a textbox named after the current minute, a heading that renders only
  after a scroll. What the agent clicked was right once; the selector it left behind names a
  position, not a thing.
- **The agent's waits were implicit.** Every observation turn was a pause the app needed. A
  script has no turns, so it runs ahead of a list that refetches a second later.
- **Nobody checks the effect.** A click can "succeed" on the wrong element. A save can be refused
  by a dialog the script never saw. Codegen replays report green while the database is untouched;
  in this benchmark the strongest static script verified 14 of 48 objectives and confirmed an
  empty sales order.

sleep-walker's answer is to treat the recording as evidence to compile, not text to replay:

- **Durable locators with fallbacks.** Each action stores a chain of candidates — role and name,
  label, test id, a structural path last — and records which ones actually resolved on each replay,
  so a volatile candidate is retired by measurement, not by guesswork. A click on a table row is
  retargeted to the record's own link, whose name is its identifier. Each chain ends with where
  the element was: its box and the viewport. That box is the yardstick a positional guess is
  measured against, and, when every name has failed, the element at that point is taken as a last
  candidate only if it is the same kind of control. A locator, never a blind click.
- **Parameters, not literals.** Values you typed become slots. Values you *declared* (`var
  runid=k7`) become `{{runid}}`. A value one step read back and a later step used becomes
  `{{step.output}}`, threaded live between steps. A record id that first appeared in a url after a
  save is recognised as minted by this run and re-read from the browser on replay. What cannot be
  threaded is left blank and sent to recovery — never guessed.
- **Effect gates.** Every step records what changed on the page when it ran. On replay a step that
  ran but did not produce its recorded effect — the new title never appeared as a heading, an alert
  the recording never saw — stops the replay before the next step acts on the wrong state. An
  identity guard refuses to run a procedure on a page showing a different record than the one it
  was asked for.
- **Built for single-page apps.** The agent's observation turns were implicit waits; a replay has
  none, so every step first lets the DOM go quiet, and a navigation is given time to hydrate before
  its effects are checked. A click recorded to open a popup is skipped when that popup is already
  showing, because on a React toggle the same click would close it. A click that changed nothing
  at all while the recording shows an effect is retried once after the page settles. A fallback
  locator that resolves to a link leaving the app's origin is never taken.
- **A ladder, not a cliff.** Per step: replay the pinned procedure with zero model calls; if it
  cannot, recover on a cheap model with the partial replay in hand; escalate to the strong model
  only if that reports blocked; halt with per-step state only if that fails too. A recovery that
  validates is compiled and **re-pinned into the flow**, so a flow heals itself over runs.
- **Honest reports.** A replayed step reports only values it read back live or that came from your
  parameters. A value the recording captured as a literal is struck, never echoed from memory.
- **Nothing app-specific in the tool.** No selectors, gestures or workflow assumptions for any app
  live in sleep-walker. App knowledge goes in a per-session briefing you supply; every mechanism
  above is described in terms any web app satisfies. This is the design boundary that keeps a fix
  for one app from being a hack for it.

## Getting started

Requires Node 20+, an installed Chrome or Edge (or `SLEEP_WALKER_EXECUTABLE`), and an API key for
one OpenAI-compatible provider.

```sh
npm install -g sleep-walker            # or, from a checkout: npm install && npm link
export NOVITA_API_KEY=...              # any preset: zhipu, novita, openrouter, openai (see Providers)
sleep-walker config set provider novita
sleep-walker doctor                    # node, browser, provider, key — no daemon needed
```

Drive a page:

```sh
sleep-walker open https://demo.playwright.dev/todomvc
sleep-walker do "Add two todos: 'write the report' and 'send it'. Tick the first one off, then report how many items the footer counter shows as left."
```

`do` returns `{status, summary, evidence}`; the counter it reports was read back from the page.
Add `--verbose` to watch the agent, `--headed` to watch the browser.

Record a flow and replay it:

```sh
# 1. record: one --learn session, the caller deciding each step as it goes
sleep-walker --session run1 --learn open http://app.local/
sleep-walker --session run1 var runid=k7          # what will differ next time → {{runid}}
sleep-walker --session run1 do "sign in as ops@example.com / {{env:APP_PASSWORD}} and create a ticket titled 'k7 Bench'; report its id"
sleep-walker --session run1 do "on that ticket add a part 'k7 Part A' cost 100 markup 25; report the price"
sleep-walker --session run1 stop --save-flow ticket-flow

# 2. replay: no caller, new value, fresh app
sleep-walker run ticket-flow --var runid=m3 --progress
#   [OK] 01-signin  (replay)   ← pinned procedure, zero model calls
#   [OK] 02-add     (replay)
#   ticket-flow: 2/2 steps, 8s — success
```

`sleep-walker flow list | show <name>` and `sleep-walker skills list | show <id>` show what was
kept; flows are plain JSON under `~/.sleep-walker/flows/`. A `run` prints per-step tier (A = zero
model), turns spent and drift tickets, and `--json` returns all of it.

**Sizing an instruction.** One `do` is one logical, verifiable step: a goal plus the check that it
worked. Several UI actions inside one instruction is normal — that is the point. Too big (several
unrelated goals) stalls on planning; too small (one click) pays an agent loop for what `peek` gives
free.

**Briefing.** Everything the DOM will not tell an agent about your app goes in a page of markdown
loaded with `brief <file.md>`: where things are, house conventions ("Apply only previews, Save
persists"), credentials as `{{env:NAME}}` markers, what not to touch.

### The full command set

```sh
sleep-walker open <url> | brief <file.md> | note "<text>" | peek [--selector css] | screenshot [path]
sleep-walker do "<instruction>" [--json] [--progress] [--max-turns N] [--timeout S] [--no-escalate]
sleep-walker var <name>=<value>                    # declare a run variable (learning session)
sleep-walker skills list | show <id> | rm <id> | repair --drift <run-drift.json>
sleep-walker flow list | show <name>
sleep-walker run <flow> [--var k=v ...] [--json] [--progress]
sleep-walker script [out.spec.ts]                  # emit a plain Playwright spec from the recorded actions
sleep-walker session list | stop [--all] [--save-flow <name>]
sleep-walker doctor | config | config set <key> <value>
```

Global flags: `--session <name>` (one daemon and browser per session), `--learn`, `--headed`,
`--record` (webm per tab), `--script`, `--verbose`, `--progress`, `--json`. Exit codes: `0`
succeeded, `1` failed or blocked, `2` infrastructure (no key, no browser, LLM unreachable).

## Current matrix

Two questions decide whether the tool earns its place. **First contact**: given a goal it has
never seen, how does sleep-walker compare with the incumbents? **Every run after that**: once the
flow is known, what does repeating it cost, and does it stay correct? Success is always the
app-side verifier's count (mutation log, JSON-RPC or HTTP API state), never an arm's self-report.
All cells are cloud runs on identical hardware, one box per target; full detail in
[bench/MATRIX-SUMMARY.md](bench/MATRIX-SUMMARY.md).

**Matrix 1 — first contact.** sleep-walker: set 26 (2026-09-03, build e048128; glm-5.3
orchestrator, deepseek-v4-flash inner with glm-5.3 escalation). agent-browser: set 17, same era,
glm-5.3.

| target | sleep-walker | agent-browser |
|---|---|---|
| repairdesk (in-repo SPA) | 7/7 · $0.07 · 1212s (set 28; set 26: 7/7 · $0.09 · 819s) | 6/6 · $0.19 · 67s |
| kanboard (PHP, drag-and-drop) | 6/6 · $0.21 · 1078s (set 28; set 26: 6/6 · $0.04 · 385s) | **2/6 (turn-cap)** · $0.77 · 118s |
| grafana (React SPA) | 6/6 · $0.14 · 1381s (set 28; set 26: 6/6 · $0.48 · 2037s) | 6/6 · $1.05 · 448s |
| odoo (dense CRUD) | 6/6 · $0.15 · 1335s (set 28; set 26: 6/6 · $0.59 · 1651s) | 6/6 · $1.51 · 302s |
| atelyr (private React app, local) | 6 reported, 2/2 checkable · $1.43 · 3043s (set 28) | — |

On first contact sleep-walker is the slowest arm on every target, by design: it drives a cheap
inner model and spends the extra time recording verified locators, value provenance and effect
expectations. What that buys is the lowest cost on every target (2–19× cheaper), a 25/25 objective
record including the board that turn-capped agent-browser at 2/6, and the recording that makes
Matrix 2 exist.

**Matrix 2 — every run after the first.** The same four flows repeated: sleep-walker replays (set
24, two replays each) against re-running the agent, against a Playwright script the agent authored
from its own run, and against literal codegen from the recording.

| target | sleep-walker replay (r1, r2) | agent re-run | authored script | codegen |
|---|---|---|---|---|
| repairdesk | **7/7, 7/7** · $0.00, $0.00 · 24s, 23s (set 28) | 6/6 · $0.19 · 67s every time | 1/6, 1/6 · $0 | 6/6, 6/6 · $0 |
| kanboard | **4/4 checkable, same** · $0.00, $0.00 · 23s, 23s (set 28; two objectives are report-based and a zero-model replay writes no report) | 2/6 · $0.77 · 118s every time | 5/6, 5/6 · $0 | 4/4 (+2 n/a) · $0 |
| grafana | **6/6, 6/6** · $0.00, $0.00 · 47s, 47s (set 28, zero model turns); set 26 as recorded: 5/6, 5/6 · $0.18, $0.55 · 661s, 1864s | 6/6 · $1.05 · 448s every time | 0/6, 0/6 · $0 | 0/6, 0/6 · $0 |
| odoo | **6/6, 6/6** · $0.16, $0.01 · 661s, 189s (set 26); set 28 regressed to 1/6, 1/6 by the verifier, under investigation | 6/6 · $1.51 · 302s every time | 1/6, 1/6 · $0 | 0/6, 0/6 · $0 |
| atelyr | 8/8 flow steps, 2/2 checkable · $0.53, $0.06 · 2684s, 1548s (set 28; 164 then 93 model turns, converging) | — | — | — |

Set 24 also caught two engine regressions of its own (kanboard's replays at 22 and 37 turns
where set 15 needed none; grafana's replays losing objective 1 and recovering one step at 19 and
44 turns). Every cause was a testable engine rule — a clock-stamped textbox name in an
expectation, a trailing space in an identity marker, an expectation-only value promoted to a
required parameter, a heading that renders only on scroll — and all are fixed on build f727c89.
The clean A/B is to replay the same set-24 flows and stores on the fixed build (set 24b):

| target | set 24 replays (b9ccbca) | set 24b replays (f727c89) |
|---|---|---|
| kanboard | 22 and 37 turns · 272s, 555s | **0 and 0 turns · 56s, 56s** · 4/4 app-state objectives both |
| grafana | 4/6, 5/6 · 19 and 44 turns | **6/6, 6/6** · 29 and 44 turns · 151s, 272s on 08cf104, with the same recording's flow re-exported by the fixed engine (one export rule needed that) and paired with its replay-refined store |
| odoo (set 26 recording) | 6/6, 6/6 · 91 and 35 turns | **6/6 · 31 turns · 213s** on 6ad5cde with the same pairing; the rest is the app's own url state varying between runs |

The grafana row shows the shape of most of this work: the set-24 grafana
cell as recorded was 4/6 and 5/6, and each miss was a rule in the engine
(a read discounted as an echo of a recorded scroll; a flow that referenced
a typed value as another step's output). Fixing the rules and re-exporting
the same recording gives 6/6 on both replays. Fresh recordings since then
(fwgr24, fwgr25, fwgr26) each added a rule of the same kind — an accidental
"Discard changes?" dialog, a dialog opened and cancelled, transient status
and alert lines — until fwgr26 compiled clean and instead lost every replay to an
error page. Five runs were spent finding out why: the sign-in skill carried
a recorded stray click on a `target=_blank` link to grafana.com, the box has
no network, the new tab landed on a browser error page, and the daemon
adopted that tab as the page to work on. The replay now keeps its page
whatever tabs open, a tab that lands on an error page is closed, and a
fallback that resolves to a link leaving the recorded origin is never
taken. Full detail, including the
runs that did not work, is in [bench/MATRIX-SUMMARY.md](bench/MATRIX-SUMMARY.md).

Reading it: static scripts are free and mostly wrong; re-running the agent is reliable and costs
the full price forever; sleep-walker's repeat cost trends to zero without the correctness trending
anywhere, and where it does not, the cause has so far always been a specific engine rule rather
than the app.

## Reference

### Providers

The LLM layer is a generic OpenAI-compatible adapter with presets; any endpoint works by setting
`baseUrl` and `model` directly.

| Preset | Base URL | Default model | Escalation model | Key env var |
|---|---|---|---|---|
| `zhipu` (default) | `https://api.z.ai/api/paas/v4` | `glm-5.2` | — | `GLM_API_KEY` / `ZHIPU_API_KEY` |
| `novita` | `https://api.novita.ai/openai` | `deepseek/deepseek-v4-flash` | `zai-org/glm-5.3` | `NOVITA_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `z-ai/glm-5.2` | — | `OPENROUTER_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `gpt-5-mini` | — | `OPENAI_API_KEY` |

Every field resolves **flag > env > config file > preset**: `--provider`, `--model`,
`--base-url`, `--fallback-model`; `SLEEP_WALKER_PROVIDER`, `SLEEP_WALKER_MODEL`,
`SLEEP_WALKER_FALLBACK_MODEL`, `SLEEP_WALKER_BASE_URL`, `SLEEP_WALKER_API_KEY`;
`sleep-walker config set <provider|model|fallbackModel|baseUrl|apiKey> <value>` →
`~/.sleep-walker/config.json`. Prefer env for the key. The benchmark stack is
`SLEEP_WALKER_PROVIDER=openrouter`, model `deepseek/deepseek-v4-flash`, fallback `z-ai/glm-5.3`.

**Escalation on blocked.** An instruction the routine model reports as `blocked` is retried once
on the escalation model, on the same browser and history, told it is resuming so it re-checks
state before repeating anything that could double-apply. A verified `failure` is not retried, nor
is an operator stop. Both attempts are billed into the returned `turns` and `usage`; the report's
`escalation` object says whether the retry rescued it. `--no-escalate`, or a fallback model of
`none`, turns it off.

### Configuration

| Env / flag | Default | |
|---|---|---|
| `SLEEP_WALKER_CHANNEL` | `chrome` → `msedge` → bundled | browser channel |
| `SLEEP_WALKER_EXECUTABLE` | — | explicit browser binary |
| `SLEEP_WALKER_HEADED=1`, `--headed` | headless | visible window (first call of a session) |
| `SLEEP_WALKER_HOME` | `~/.sleep-walker` | sessions, skills, flows, config |
| `SLEEP_WALKER_SKILLS=1`, `--learn` | off | learning mode; `SLEEP_WALKER_SKILLS_DIR` relocates the store |
| `SLEEP_WALKER_FLOWS_DIR` | `~/.sleep-walker/flows` | flow files |
| `SLEEP_WALKER_RECORD=1`, `--record` | off | webm per tab; paths printed by `stop` |
| `SLEEP_WALKER_SCRIPT=1`, `--script` | off | record every action as a replayable Playwright step |
| `--max-turns` | 30 | agent turn cap per instruction |
| `--timeout` | 300 | wall-clock seconds per instruction |
| `--turn-timeout` | 90 | seconds for one LLM call before it is aborted and nudged |

### What the outer agent sees

`do` prints a one-line result, or with `--json` the full
`{report: {status, summary, details?, evidence?}, turns, usage, model}`. On a turn or time cap
the result also carries `actions`, the ordered tool calls that ran, so a caller can verify state
before resuming rather than repeat a mutation. Nothing else lands in the caller's context: the
agent's snapshots, retries and tool chatter stay inside the daemon.

### What it will not do

- **Canvas-rendered content** (charts, drawn grids, images) has no DOM to read or verify; the
  agent reports blocked and says so.
- **Anti-bot evasion, CAPTCHA solving, crawling** are out of scope. sleep-walker is for testing
  and driving apps you operate or are authorised to test.
- **Vision**: the agent is text-only; it reads the accessibility tree and DOM. Screenshots are
  for you.
- **Guessing credentials**: a rejected or missing credential is an immediate blocked report,
  never a retry loop. `{{env:NAME}}` markers are how you supply them.

### Claude Code skill

`skills/sleep-walker/SKILL.md` is the canonical copy of the bundled skill:

```sh
mkdir -p ~/.claude/skills/sleep-walker
cp skills/sleep-walker/SKILL.md ~/.claude/skills/sleep-walker/SKILL.md
```

### Development

```sh
npm run build                         # tsc -> dist/
npm test                              # unit tests
BP_BROWSER_TESTS=1 npx vitest run     # + browser-backed replay and perturbation tests (needs Chrome/Edge)
```

The recording-path regression gate (`test/rebuild.test.ts`) recompiles real published
recordings and pins what they compile to; it runs the built engine, so build before testing.
Benchmark procedure, arms, targets and the cloud runbook live under `bench/`.
