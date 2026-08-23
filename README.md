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
browser-pilot skills list|show <id>|rm <id>            # stored procedures learned with --learn
browser-pilot var runid=k7x2                          # declare a run variable (learning session)
browser-pilot run ticket-flow --var runid=k7x2        # replay a recorded session, no agent tokens in steady state

# housekeeping
browser-pilot session list
browser-pilot stop [--all] [--save-flow <name>]     # prints video paths if --record was used; --save-flow exports the session as a replayable flow
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

## Learning: replay what worked, reason only where it didn't

Start a session with `--learn` (or `BROWSER_PILOT_SKILLS=1`) and browser-pilot becomes *progressively*
less agentic on a site the more it succeeds there. Every instruction that reports `success` is compiled
into a stored **skill** — a parameterised, replayable procedure — and on later instructions the skills
that start on the current page are offered to the internal agent, which replays one deterministically
and only reasons about the steps that no longer work.

```sh
browser-pilot --session a --learn open http://app.local/
browser-pilot --session a do "sign in as ops@example.com / pw1 and create a ticket titled 'k7 Bench'"
#   … 14 turns; stored s_68e5ee
browser-pilot --session b --learn open http://app.local/
browser-pilot --session b do "log in (ops@example.com, pw1) then create a new ticket called 'm3 Bench'"
#   turn 1: run_skill s_68e5ee {v1: ops@example.com, v2: pw1, v3: m3 Bench} → 11/11 steps
#   turn 2: report — 3 turns, same outcome, values read back live
browser-pilot skills list                # what has been learned, per origin
browser-pilot skills show s_68e5ee       # every step, its locators and fallbacks, what is a parameter and what is not
```

What a skill is, and how it is made:

- **Steps** are the instruction's recorded actions (so `--learn` implies `--script` recording). Each
  target carries a **chain** of locators, best first — test id, role + name, label, placeholder, stable
  id, text, structural path — and replay walks the chain when the primary no longer resolves. Selectors
  with an id baked in (`ticket-link-t15`, a link named `RD-1017`) are pushed behind the semantic ones,
  because they name a record, not a control.
- **Parameters** are found deterministically: a value the agent typed that also occurs as a whole token
  in the instruction becomes a `{{vN}}` slot, substituted everywhere — step arguments, locator names,
  expectations, the stored report. Values the agent invented ("Bench Customer" for a required field that
  the instruction did not mention) stay literal; `skills show` flags them and the `[skills]` listing tells
  the agent a procedure types **fixed** values, so it declines one whose fixed values do not fit.
- **Expectations** come from the page diff recorded around each step. The url pattern afterwards is hard.
  Page lines that carry a parameter are hard too — a step recorded to make `heading "{{v3}}"` appear must
  make the *new* title appear, which is how a positional row locator opening the *previous* ticket (the
  list refreshes a beat after a create) is caught as a failure rather than counted as a success. Other
  lines are soft: logged, not enforced, until data says they are reliable.
- **Preconditions**: the start page's url pattern (`/#/tickets/:id`) plus a structural fingerprint of the
  page — a hashed bag of normalised DOM paths, recorded now so template recognition across *different*
  pages can be built on real `(similarity, outcome)` data later. A skill is never replayed from a page
  that does not match.

How replay drives the inner loop:

1. The instruction's first user message ends with a `[skills]` block listing the candidates (id,
   template, params, success record, what it reads back, any fixed values). The system prompt is
   unchanged, so the cached prefix is unaffected.
2. The agent calls `run_skill {id, params}` — usually as its first action. That is the matching: the model
   does it on the turn it would have spent on a snapshot. Steps run in-process like a `batch`, with a
   DOM-quiescence settle before each one standing in for the observation turns the agent is no longer
   taking.
3. It completes → the agent gets every step's outcome and every value read back from the live page, and
   reports. It stops at step *k* → the agent gets "steps 1..k-1 ran, k failed because …, the page is here"
   and continues agentically from that state (operating rule 3b: observe first, never repeat what ran).
4. After the report: a clean full replay inside a successful instruction bumps the skill (second one
   **validates** it); a repair compiles the replayed prefix plus the agent's own actions as a **variant**,
   and a variant that validates supersedes the skill it repaired; the same step failing twice in a row
   **demotes** a skill out of the listing. `skills rm` / `skills clear` for anything you do not like.
5. A validated skill whose template matches the instruction word for word (case, whitespace and quote
   style aside) is replayed by the daemon **with no model call at all**, and the report is synthesised
   from the stored one with every labelled value replaced by its live read-back. A part-way stop drops
   into step 3 with the partial result in the first message. This is the path a fixed-wording test plan
   converges to; an orchestrator that rewords every step gets the two-turn path instead.

Honesty properties that are kept on purpose: read-backs are always live, never the recorded value; a
replay refuses from the wrong page or with a missing parameter without touching anything; a skill is
only compiled from a `success` report and only validated by a second one, because one success is
evidence, not proof. Every `do` result carries a `skill` block (`invoked`, `stepsReplayed/stepsTotal`,
`repaired`, `tier`, `deterministicActions/totalActions`) and a `learned` block, and `config` rolls them
up per session, so a learning run's deterministic fraction is measurable, not anecdotal.

Where skills live: `~/.browser-pilot/skills/<origin>.json`, one file per site origin, shared by every
session (that is the point); `BROWSER_PILOT_SKILLS_DIR` relocates the store, which the bench uses to keep
a sweep's store isolated. Note that anything the agent typed that was *not* in the instruction is stored
literally — a password that came from a briefing rather than the instruction will be in the file.

The app-agnostic boundary holds: nothing app-specific is compiled into the tool. Everything app-specific
lives in a store the tool *learned* on your site, which you can read and delete.

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

Near-miss report payloads are **repaired rather than rejected**: a list of ids where the schema
wants one scalar, a stray extra key, a status differing only in case, an over-long summary. These
are presentational slips, and rejecting one is expensive out of all proportion — it costs a retry
turn, then a blocked bail-out, then (with escalation on) a paid retry of the whole instruction on a
pricier model, over a value the agent had already correctly obtained. Repairs are never silent: the
result lists what was changed. Anything needing a guess about *intent* — an unmappable status, a
missing summary — is still rejected and fed back.

### Session history

Each instruction's raw tool output is elided when the **next** instruction starts. It describes a
page that has usually moved on, and left in place it is re-sent on every turn of every later
instruction: measured across a 10-step session, context per turn grew 6.1k → 30.3k tokens,
plateauing only when the size cap forced the same elision under pressure. What survives is the
one-line `[report]` entry, which carries the reported `evidence.values` alongside the summary so
facts established in step 3 are still available in step 4. Use `note` for anything that must
outlive an instruction verbatim, and `reset` to clear the conversation while keeping the browser,
cookies, briefing, and notes.

## Flows: record a whole session, replay it deterministically

A skill makes one instruction cheap on repeat. A **flow** makes a *whole session* cheap: the orchestrator
drives browser-pilot normally the first time — deciding each step as it goes, reacting to what it sees —
and the session is exported as a replayable script. Later runs need no orchestrator at all: each step
replays its pinned skill with zero model calls, drops to the cheap model only for a step whose page has
drifted, and halts (returning per-step state) only when a step genuinely cannot complete.

Crucially the flow is **not authored up front** — writing the plan in advance would throw away the
orchestrator's ability to branch on what it finds. It is *recorded from what the orchestrator actually
did*, so its mid-run decisions are captured as ordinary steps.

```sh
# 1. record — the orchestrator works normally, one --learn session, deciding as it goes
browser-pilot --session run1 --learn open http://app.local/
browser-pilot --session run1 var runid=k7            # declare what will differ next time → becomes {{runid}}
browser-pilot --session run1 do "sign in as ops@example.com / pw1 and create a ticket titled 'k7 Bench'; report its id"
browser-pilot --session run1 do "on that ticket add a part 'k7 Part A' cost 100 markup 25; report the price"
browser-pilot --session run1 stop --save-flow ticket-flow

# 2. replay — no orchestrator, new value, fresh app
browser-pilot run ticket-flow --var runid=m3
#   [OK] 01-signin  (replay)      ← pinned skill, zero model calls
#   [OK] 02-add     (replay)
#   ticket-flow: 2/2 steps, 8s — success
browser-pilot flow list | show ticket-flow
```

What the export does automatically (no configuration):

- **Variables**: values you declared with `var` (the runid) become `{{name}}` everywhere they appear.
- **Chaining**: a value one step *read back* and a later step *used* (the ticket id from step 2 quoted
  in step 3) becomes `{{step.output}}`, so replay threads live values between steps rather than replaying
  a stale id. A step that referenced a value no earlier step produced can't resolve → the run halts there
  rather than guessing.
- **Pinning**: each step records the skill it produced, so `run` replays that skill directly (true
  zero-model, Tier A) instead of re-matching. A repair during a `run` is compiled and, once it validates,
  **re-pinned into the flow file**, so the flow heals itself over successive runs.
- Only steps that ended in `success` are exported — a step the orchestrator tried, hit a wall on, and
  worked around is not part of the resolved path.

The execution ladder per step, halting as soon as a rung succeeds: **replay the pinned skill** (0 tokens,
binding its parameters from the flow's own stored bindings rather than re-parsing the wording) → **recover
on the strong model** — a step that failed to replay is by definition no longer the straightforward case
the cheap model handled at record time, so recovery goes *straight* to the strongest model available (the
configured fallback model, even when per-step escalation is otherwise off, or an explicit
`--recovery-model`), with the partial replay in hand → **halt** and return the step's state, so a caller
can be brought back to continue from exactly there. That last rung is the orchestrator returning to the
*top* of the ladder for one step, not rejoining the whole run.

Navigation to a record is parameterised, not hard-coded: when a skill step clicks the row or link for a
record whose identifier appears in the instruction (ticket `RD-1015`), that identifier becomes a slot, so
replay navigates to *this* run's record. When the identifier is one an earlier step produced, it threads
through as `{{step.output}}` — provided that step read it back live. If it did not (the identifier was in
the recorded report only, so the honesty rule dropped it), the reference cannot be threaded; rather than
halt, the step **soft-resolves to what is known** (the record's title, say) and recovers on the strong
model, which finds the record by that instead — and re-pins the cleaner skill it produces. So a flow
degrades to a model call on the coupled step rather than failing, and heals over runs.

Honesty carries over intact: a replayed step reports only values it read back live or that came from your
own `--var` parameters; a value the recording captured as a literal (the ticket id from the run that made
the flow) is **dropped, never reported from memory**, and struck from the summary — the same rule that
makes skill replay trustworthy. A corollary worth knowing: a flow reliably reproduces *actions* and echoes
*your parameters*, but it surfaces an *app-computed* value (a price the server calculated) on replay only
when the original recording read it back explicitly; otherwise that output is omitted rather than faked.

Flows live in `~/.browser-pilot/flows/<name>.json` (`BROWSER_PILOT_FLOWS_DIR` relocates), one file per
flow, human-readable and hand-editable.

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

The failed attempt's **raw tool results are compacted away** before the fallback sees them. The
handoff message already carries what mattered — the blocked report, the ordered actions log, where
the browser was left — so leaving the transcript in place would re-send the same information on
every turn at the escalation tier's much higher cache rate. (Measured on a real 10-step run: the
fallback's cached history re-reads alone were 45% of the whole run's cost.) Message *structure* is
preserved, never pruned — an assistant `tool_calls` message must keep its matching answer — and
earlier instructions are untouched.

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
| `BROWSER_PILOT_SKILLS=1`, `--learn` | off | learning mode (see [Learning](#learning-replay-what-worked-reason-only-where-it-didnt)): compile successful instructions into stored skills and replay them later; implies `--script`. `BROWSER_PILOT_SKILLS_DIR` relocates the store (default `~/.browser-pilot/skills`). |
| `--max-turns` | 30 | agent turn cap per instruction |
| `--timeout` | 300 | wall-clock seconds per instruction |
| `--turn-timeout` | 90 | wall-clock seconds for a single LLM call; a turn that produces no tool call by then is aborted and retried with a nudge, and three such turns in a row end the instruction. Stops a model from spending the whole `--timeout` reasoning inside one request. |

## Development

```sh
npm run build             # tsc -> dist/
npm test                  # unit tests (protocol, refs, prompt, report, loop, trimming, skills)
BP_BROWSER_TESTS=1 npx vitest run   # + browser-backed primitive, replay and perturbation tests (needs Chrome/Edge)
```

`test/fixture/page.html` is the fixture the browser tests drive (React-style controlled inputs,
async banner, confirm() dialog). For a full-pipeline smoke without spending tokens, point
`BROWSER_PILOT_BASE_URL` at a scripted mock of `/chat/completions`.
