# browser-pilot

An agent-in-the-loop Playwright CLI. One natural-language instruction in, one concise structured
result out — instead of 4–6 selector-aware, quoting-aware, wait-aware CLI calls per logical step.

An internal LLM agent (default **GLM 5.2** via Z.ai's OpenAI-compatible API) translates each
instruction into typed, in-process Playwright tool calls against a persistent browser, then reports
back a validated `{status, summary, details?, evidence?}`. The caller (you, or an outer agent like
Claude Code) never touches selectors, waits, dialogs, or quoting.

## Design boundary: the tool is app-agnostic

**browser-pilot must never contain knowledge of any specific application under test.** No app's
selectors, class names, gestures, URLs, or workflow assumptions belong in the code — not in a verb,
not in a default, not in a prompt. The tool works for testing *any* web app; the moment a primitive
can't be described without naming something specific to one app, it does not belong here.

Where app-specific knowledge goes instead: the **session briefing** (`brief <file.md>`) and the
instruction text. Selector maps, "close the detail tab via `.data-tab-close`", "this form needs a
logo URL" — all of that is the *caller's* input, carried per session, never compiled in.

Litmus test for any new primitive or default: *state what it does using only terms the caller
supplies (a selector, a URL, a value).* If you can, it's generic and fine. If you find yourself
writing an app's class name or behavior into the tool, stop — it belongs in that app's brief.
(Corollary: a real gap surfaced by one app is usually a **generic** weakness in an existing verb —
e.g. `click` needing a fallback when an element is covered — not a bespoke app-shaped verb.)

## Install

```sh
npm install        # builds via prepare
npm link           # optional: puts `browser-pilot` on PATH
```

Requires Node 20+, an installed Chrome or Edge (or set `BROWSER_PILOT_EXECUTABLE`), and an API key
for one of the provider presets:

```sh
browser-pilot config set provider novita   # persist your default provider
export NOVITA_API_KEY=...                  # key via env (preferred) or `config set apiKey ...`
```

`npm link` symlinks the global `browser-pilot` at this checkout, so a rebuild here is immediately
live in every other repo — no re-link needed after `npm run build`.

### Claude Code skill

`skills/browser-pilot/SKILL.md` is the canonical copy of the bundled skill. Claude Code loads
skills from `~/.claude/skills/`, so install (or refresh after editing) with:

```sh
mkdir -p ~/.claude/skills/browser-pilot
cp skills/browser-pilot/SKILL.md ~/.claude/skills/browser-pilot/SKILL.md
```

Edit the repo copy, never the installed one — otherwise changes are lost on the next refresh.

## The outer-agent usage contract

```sh
# deterministic verbs — no agent tokens spent
browser-pilot open http://localhost:5173
browser-pilot brief docs/AUTOMATION_GUIDE.md        # load app conventions into the session
browser-pilot note "runid is k7x2"                  # record run state the agent must know
browser-pilot peek [--selector css] [--interactive] # a11y snapshot / URL / title, direct
browser-pilot screenshot [path]

# the core verb — anything requiring judgment
browser-pilot do "log in as admin@example.com / pw123"
browser-pilot do "create a supplier organisation named 'k7x2 MTP Supplies Ltd' and confirm it appears in the Organisations list with the count incremented" --json

# recording (opt-in, see below)
browser-pilot script tests/flow.spec.ts                # emit a Playwright spec from what was done

# housekeeping
browser-pilot session list
browser-pilot stop [--all]                          # prints video paths if --record was used
browser-pilot config
```

- **Exit codes**: `0` instruction succeeded · `1` failed/blocked · `2` infra error (no key, no
  browser, LLM unreachable).
- `do` prints a one-line human result, or the full report with `--json`:
  `{report: {status, summary, details?, evidence?}, turns, usage, model}`. On a turn/time-cap
  bail-out the result also carries `actions` — the ordered tool calls that ran, so you can verify
  state before resuming rather than blindly repeating a mutation. If a blocked instruction was
  retried on the escalation model, `escalation` records that handoff and `turns`/`usage` cover
  both attempts (see [Escalation on blocked](#escalation-on-blocked)).
- `--verbose` streams the internal agent's actions and a per-instruction token count to stderr;
  `--progress` streams just the actions (turn-numbered) and composes with `--json`.
- Nothing else lands in your context — the internal agent's snapshots, retries, and tool chatter
  stay inside the daemon.

### Writing good instructions

Scope each `do` to **one logical, verifiable step** — don't pack many independent assertions into a
single instruction. A tightly-scoped instruction completes and reports well inside the turn budget;
an over-packed one risks exhausting it mid-way. The agent reports as soon as the step's assertions
are answered, so smaller steps also mean tighter, cheaper reports. Deterministic sub-actions
(navigation, a screenshot, a spot-check) belong on the `open`/`peek`/`screenshot` verbs, which spend
no agent tokens at all.

## Recording a Playwright script

Start a session with `--script` (or `BROWSER_PILOT_SCRIPT=1`) and every action the internal agent
takes is captured as a replayable step; `browser-pilot script [out.spec.ts]` writes them out as a
standalone `@playwright/test` spec — one `test.step` per `do` instruction, in order.

```sh
browser-pilot --session flow --script open http://localhost:5173
browser-pilot --session flow do "log in as admin@example.com / pw123"
browser-pilot --session flow do "create an organisation named 'Acme' and confirm it lists"
browser-pilot --session flow script tests/acme.spec.ts     # → a spec you can run and commit
```

The hard part is that the agent drives the page through `@ref` handles from its own a11y snapshot,
which mean nothing outside that session. So each target is re-described against the live DOM
**before** the action runs (afterwards the element may be gone), preferring `data-testid` →
role+name → label → placeholder → a hand-written `id` → text → a structural CSS path, and the
resulting expression is then replayed against the page to confirm it resolves to exactly the element
that was acted on. That costs one round trip per action, which is why recording is opt-in.

What that buys you, and what it doesn't:

- Actions that **failed** are not recorded — a recording is of what worked.
- `wait_for` becomes a real assertion (`toBeVisible`, `toHaveText`, `toHaveCount`, …).
- `read`/`read_all` become **commented-out** assertions carrying the value observed at record time.
  The agent reads to orient itself as often as to verify, so which of those you want to assert is a
  judgment call the generator leaves to you.
- Anything it could not pin down is a `TODO` comment, never a silently-wrong selector: an
  unverified locator, an element it could not describe, and tab switches (which need a real second
  page handle).
- Steps are appended to `<session dir>/script.jsonl` as they happen, so a recording survives a
  daemon restart or a hard kill. `script --clear` discards them; `script <path> --clear` writes then
  discards, which is how you record several independent specs in one session.
- The output is a **starting point, not a finished test**. Review it: it replays the path the agent
  happened to take, exploratory detours included.

`--script` and `--record` are independent — video is a recording of what happened, this is a
recording you can re-run.

## Sessions

Each `--session <name>` (default `default`) owns a detached daemon with a persistent Chrome
profile under `~/.browser-pilot/sessions/<name>/` — logins survive daemon restarts. The internal
agent keeps one running conversation per session, so instruction N+1 knows what instructions
1..N created and discovered; `brief` and `note` content survives history trimming and daemon
restarts. `stop` kills the daemon; the profile stays.

`session list`, `stop`, `config` and `screenshot` are served without queueing behind the command in
flight, so a misbehaving `do` can always be observed and killed — `stop` aborts it, and the caller
waiting on that `do` gets a blocked report with its actions log rather than a hang.

## What the internal agent gets

Typed in-process tools (no shell, no quoting): `snapshot` (a11y tree with `@ref` handles),
`click` / `dblclick` / `modifier_click` / `right_click`, `fill` (**React-safe by default**: native
value setter + input/change events, clear-then-set on number inputs), `type`, `press`, `select`,
`check`, `hover`, `scroll_into_view`, `drag` (mouse drag with synthetic HTML5-DnD fallback),
`wait_for` (visible/hidden/text/count — networkidle deliberately not offered), `read`, `eval`,
`fetch_source` (raw HTTP response body, no JS — the server-rendered source, which every other tool
is not), `goto`, `back`, `tabs`, `upload`, `download`, `set_viewport`, `set_offline`, `screenshot`,
`dialog_expect` (native confirm/alert/prompt policy + capture), and the mandatory terminal
`report` — validated against a JSON schema, with one retry turn on invalid output.

## Providers

The LLM layer is a generic OpenAI-compatible adapter with named presets:

| Preset | Base URL | Default model | Escalation model | Key env var |
|---|---|---|---|---|
| `zhipu` (default) | `https://api.z.ai/api/paas/v4` | `glm-5.2` | — | `GLM_API_KEY` / `ZHIPU_API_KEY` |
| `novita` | `https://api.novita.ai/openai` | `deepseek/deepseek-v4-flash` | `zai-org/glm-5.3` | `NOVITA_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `z-ai/glm-5.2` | — | `OPENROUTER_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `gpt-5-mini` | — | `OPENAI_API_KEY` |

Every field resolves with the precedence **flag > env > config file > preset**:

- flags: `--provider`, `--model`, `--base-url`, `--fallback-model` (per `do` call)
- env: `BROWSER_PILOT_PROVIDER`, `BROWSER_PILOT_MODEL`, `BROWSER_PILOT_FALLBACK_MODEL`,
  `BROWSER_PILOT_BASE_URL`, `BROWSER_PILOT_API_KEY` (key accepted for any provider)
- config file: `browser-pilot config set <provider|model|fallbackModel|baseUrl|apiKey> <value>` →
  `~/.browser-pilot/config.json`, re-read on every instruction (no daemon restart needed);
  `config set <key> ""` clears. Prefer env for the key — `config set apiKey` stores it in plaintext.

### Escalation on blocked

Where a preset defines an escalation model, an instruction the routine model reports as
**`blocked`** is retried once on that stronger model, sharing the same live browser and message
history. The fallback is told it is *resuming*, so it re-checks page state before repeating any
action that could double-apply (submit, delete, move).

Escalation deliberately does **not** fire for:

- **`failure`** — a verified negative answer. The agent checked and the assertion did not hold;
  paying a stronger model to confirm it buys the same answer twice.
- **operator `stop`** — that also produces a blocked report, and restarting work someone just
  killed is the opposite of what they asked for.

When the first attempt bailed by **exhausting its turn cap or timeout**, the retry gets 1.5× that
budget. Running out of road is positive evidence that the instruction needs more of it, and handing
the fallback the same allowance mostly buys a second bail-out at the same wall. An agent that
*chose* to report blocked gets no such bump — that is not evidence more turns would help.

Both attempts are billed into the returned `turns` and `usage`, so escalation cannot hide its
cost, and an `escalation` object reports what the first attempt spent, why it stalled, and
whether the retry actually rescued it (`rescued: true|false`). Bail-outs also carry a
`bailReason` (`turn-cap` | `timeout` | `stalled` | `stopped` | `invalid-report`). Disable per call
with `--no-escalate`, or globally by setting the fallback model to `none`.

Any other OpenAI-compatible endpoint works by setting `baseUrl` + `model` directly. Mainland Zhipu
is `https://open.bigmodel.cn/api/paas/v4`; Z.ai Coding Plan subscriptions use
`https://api.z.ai/api/coding/paas/v4`.

## Other configuration

| Env / flag | Default | |
|---|---|---|
| `BROWSER_PILOT_CHANNEL` | `chrome` → `msedge` → bundled | browser channel |
| `BROWSER_PILOT_EXECUTABLE` | — | explicit browser binary |
| `BROWSER_PILOT_HEADED=1`, `--headed` | headless | visible window (first call of a session) |
| `BROWSER_PILOT_HOME` | `~/.browser-pilot` | sessions + config root |
| `BROWSER_PILOT_RECORD=1`, `--record` | off | record the session to webm, one file per tab, under `<session dir>/video` (first call of a session). Playwright only writes video out when the browser context closes, so the paths are printed by `stop` — nothing is readable mid-session, and killing the daemon without `stop` loses the recording. |
| `BROWSER_PILOT_SCRIPT=1`, `--script` | off | record every action as a replayable Playwright step (first call of a session); write the spec with `browser-pilot script [out.spec.ts]`. Costs one page round trip per action to resolve a durable selector. |
| `--max-turns` | 30 | agent turn cap per instruction |
| `--timeout` | 300 | wall-clock seconds per instruction |
| `--turn-timeout` | 90 | wall-clock seconds for a single LLM call; a turn that produces no tool call by then is aborted and retried with a nudge, and three such turns in a row end the instruction. Stops a model from spending the whole `--timeout` reasoning inside one request. |

## Development

```sh
npm run build             # tsc -> dist/
npm test                  # unit tests (protocol, refs, prompt, report, loop, trimming)
BP_BROWSER_TESTS=1 npx vitest run   # + browser-backed primitive tests (needs Chrome/Edge)
```

`test/fixture/page.html` is the fixture the browser tests drive (React-style controlled inputs,
async banner, confirm() dialog). For a full-pipeline smoke without spending tokens, point
`BROWSER_PILOT_BASE_URL` at a scripted mock of `/chat/completions`.
