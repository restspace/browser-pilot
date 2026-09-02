# sleep-walker — an agent-in-the-loop Playwright CLI

## Context

Running `atelyr/docs/MANUAL_TEST_PLAN.md` with `agent-browser` (six E2E passes, see
`docs/E2E_PASS1..6.md` and `docs/RUN_E2E.md` in the atelyr repo) exposed a consistent pattern:
**one English intent costs the outer agent 4–6+ selector-aware, quoting-aware, wait-aware CLI
calls**. The recurring friction (from the pass reports):

1. Many low-level calls per logical step; the team's own mitigation is "batch commands per shell call".
2. Deep app-specific selector knowledge required (the ~25-row map in `AUTOMATION_GUIDE.md`).
3. Fragile manual waits (networkidle hangs on Vite HMR; poll-the-DOM patterns hand-written each time).
4. No native-dialog support in agent-browser → hand-rolled base64 `eval` overrides, re-installed after navigation.
5. React-controlled inputs need native-setter `eval` hacks (fill appends on number inputs; autocomplete needs synthetic mouse events).
6. PowerShell quoting tax (`@ref` splatting, here-string rules, base64-eval workaround).
7. Env-var boilerplate per shell.
8. Orchestration state (runid, created names, workarounds) manually relayed between subagents.

**The tool**: a standalone CLI (`sleep-walker`, this directory) that wraps **Playwright
directly** (playwright-core) like agent-browser does, but whose primary verb takes a
**high-level natural-language instruction**. An **internal LLM agent** — default model
**GLM 5.2** via Zhipu's OpenAI-compatible API — translates the instruction into a series of
Playwright tool calls against a persistent browser, then returns a **concise structured result**
to the caller. The outer agent's cost per step drops to one CLI call and a one-paragraph result.

Decisions taken with the user:
- **Direct Playwright** (not shelling to agent-browser) — enables native dialog capture, React-safe
  input helpers, no subprocess/quoting layer.
- **Standalone package** at `C:\dev\sleep-walker` with a `bin` entry (same shape as agent-browser/rs).
- **Internal model: GLM 5.2** (cheap). Accessed through an OpenAI-compatible chat-completions
  client with tool calling (`baseURL` + `GLM_API_KEY`/`ZHIPU_API_KEY` env). The LLM layer is a thin
  **provider adapter** so the model is swappable via `--model`/`--provider` (e.g. an Anthropic
  adapter later) without touching the loop.
- **MVP scope**: core instruction loop only (no test-plan-runner mode yet).

## Architecture

```
outer agent (Claude Code etc.)
   │  sleep-walker do "Create an organisation named X; confirm it appears in the list"
   ▼
CLI entry (bin/sleep-walker.js) ── connects over local IPC ──► daemon process (per session)
                                                                  ├─ Playwright browser/context/page(s)
                                                                  ├─ dialog capture + React-input helpers (init scripts)
                                                                  ├─ internal agent loop (GLM 5.2 via OpenAI-compatible API)
                                                                  │    tools = snapshot/click/fill/eval/wait/… (in-process, typed)
                                                                  └─ conversation state per session
   ▲
   └── stdout: concise JSON/text result {status, summary, details?, evidence?}
```

### Process model (mirrors agent-browser)
- **Daemon**: first CLI call spawns a detached Node daemon owning the Playwright browser; subsequent
  calls connect via a named pipe (Windows) / unix socket, keyed by `--session <name>` (default
  `default`). `sleep-walker stop [--all]` kills it. State (cookies/localStorage) optionally
  persisted per session dir (`~/.sleep-walker/sessions/<name>/`) so login survives restarts.
- **CLI**: thin client; sends `{command, args}` JSON over the socket, streams progress lines
  (optional `--verbose`) and prints the final result. Exit code 0 = instruction succeeded,
  1 = failed/blocked, 2 = infra error.

### Command surface (MVP)
| Command | Purpose |
|---|---|
| `do "<instruction>" [--json] [--max-turns N] [--timeout S]` | The core verb: run the internal agent until it reports done/blocked. |
| `open <url>` | Deterministic navigation without burning agent tokens. |
| `brief <file.md> [--append]` | Load an app briefing (e.g. `AUTOMATION_GUIDE.md`) into the session's system context. |
| `note "<text>"` | Append a run note (e.g. "runid is k7x2") to session memory — replaces the hand-relayed "state notes". |
| `peek [--selector <sel>]` | Return the current a11y snapshot / URL / title directly (no agent) for outer-agent spot checks. |
| `screenshot [path]` | Direct screenshot. |
| `session list` / `stop` | Housekeeping. |
| `config` | Show resolved model/provider/paths. |

Deterministic verbs (`open`, `peek`, `screenshot`) exist so the outer agent never pays agent tokens
for trivial actions — `do` is for anything requiring judgment.

### Internal agent loop (the core)
- **LLM layer**: a small provider adapter interface —
  `complete(messages, tools) -> {text?, toolCalls[], usage}` — with the first implementation being
  **OpenAI-compatible chat completions** pointed at Zhipu's endpoint, default model `glm-5.2`
  (config: `SLEEP_WALKER_MODEL`, `SLEEP_WALKER_BASE_URL`, `GLM_API_KEY`; overridable per session
  via `config`/flags). Manual agentic loop in our code: send → execute tool calls → append results
  → repeat, with `--max-turns` cap and per-instruction wall-clock timeout.
- **Tools** (typed, in-process — no shell, no quoting), exposed as OpenAI-style function tools:
  - `snapshot` — a11y tree with `@ref` handles (compact/interactive/scoped variants); refs resolved
    via an in-daemon ref→locator map, invalidated per navigation.
  - `click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`, `hover`, `scroll_into_view` —
    accept CSS selector or `@ref`. `fill` uses **React-safe semantics by default** (native value
    setter + input/change events, clear-then-set on number inputs) — friction #5 solved in the tool
    implementation, invisible to the agent.
  - `modifier_click` — click with shift/ctrl (the global-filter gesture); `right_click` (real
    Playwright `button: 'right'`).
  - `drag` — Playwright drag plus a synthetic-HTML5-DnD fallback (dispatch dragstart/over/drop with
    a constructed DataTransfer) for custom-payload drags.
  - `wait_for` — selector visible/hidden/text-equals/count, with sane timeout; **no networkidle
    offered at all** (friction #3 designed out).
  - `read` — get text/value/attr/count for a selector (cheaper than full snapshot).
  - `eval` — escape hatch, JS string executed via `page.evaluate` (no shell in between, so no
    base64 dance).
  - `upload`, `download` (expect-download wrapper), `set_viewport`, `set_offline`, `goto`, `back`.
  - `dialog_expect` — arm the **native dialog policy** for the next action: accept/dismiss,
    prompt text, and capture; captured dialog messages are returned in the tool result. Implemented
    with Playwright's `page.on('dialog')` — friction #4 solved natively.
  - `report` — terminal tool; the agent MUST finish by calling it:
    `{status: "success"|"failure"|"blocked", summary: string, details?: string,
    evidence?: {url?, capturedDialogs?, values?}}`. Because strict-schema guarantees vary by
    provider, the daemon **validates the report against the JSON schema** (ajv) and, on invalid
    output, feeds the validation error back for one retry turn before declaring `blocked`.
    Loop ends on a valid `report` (or `--max-turns` → `blocked` with transcript tail).
- **System prompt** (frozen per session): the tool's operating rules (snapshot→act loop, wait
  discipline, when to give up, concise-report contract) + the session **briefing** (selector map /
  app conventions from `brief`) + accumulated `note`s — stable content first, in a fixed order.
  There is no Anthropic-style explicit `cache_control` on GLM; keeping the prefix byte-stable and
  the history append-only still maximises any provider-side/implicit context caching and keeps the
  design portable to providers that do cache.
- **Conversation persistence**: the daemon keeps one running message history per session, so
  instruction N+1 has the context of instructions 1..N (created names, workarounds discovered).
  History is trimmed when it grows (old tool_results elided, keeping the agent's own summaries);
  `note`s survive trimming. GLM 5.2's low per-token cost is what makes carrying this history
  affordable.
- **Result contract**: `do` prints the `report` JSON (or a human one-liner without `--json`).
  Nothing else lands in the outer agent's context unless `--verbose`.

### Repo layout (`C:\dev\sleep-walker`)
```
package.json            # bin: {"sleep-walker": "bin/sleep-walker.js"}, deps: playwright-core, openai (or plain fetch), ajv
tsconfig.json
src/
  cli.ts                # arg parsing, daemon connect/spawn, output formatting
  daemon/
    server.ts           # socket server, command dispatch, lifecycle
    browser.ts          # Playwright bootstrap, context/session persistence, init scripts
    dialogs.ts          # dialog policy + capture
    refs.ts             # snapshot builder + @ref map (a11y tree serialisation)
    inputs.ts           # React-safe fill/select/autocomplete helpers
  agent/
    llm.ts              # provider adapter interface + OpenAI-compatible (GLM) implementation
    loop.ts             # agentic loop, turn caps, timeouts, usage accounting
    tools.ts            # tool schemas + dispatch to daemon primitives
    prompt.ts           # system prompt assembly (rules + briefing + notes)
    report.ts           # report JSON schema + ajv validation + retry-on-invalid
  shared/protocol.ts    # CLI↔daemon message types
test/                   # vitest unit tests (refs, prompt assembly, report validation) + a smoke e2e
README.md
```

### Key reuse / references
- Snapshot/`@ref` concept and command vocabulary: modelled on agent-browser 0.16.3 (documented in
  `C:\Users\james\.claude\skills\browser-testing\SKILL.md`); implementation is ours on
  playwright-core's ARIA snapshot APIs.
- App briefing content: `C:\dev\atelyr\docs\AUTOMATION_GUIDE.md` becomes the canonical `brief`
  input for atelyr runs (no atelyr knowledge baked into the tool).
- GLM 5.2 access: Zhipu OpenAI-compatible endpoint; confirm the current model id / base URL /
  tool-calling support level from Zhipu's docs at implementation time and put them in `llm.ts`
  defaults (all overridable by env/flags so a doc drift is a config change, not a code change).

## Implementation order

1. **Scaffold** package + tsconfig + CLI/daemon skeleton with socket protocol; `open`, `peek`,
   `screenshot`, `stop` working end-to-end (no agent yet).
2. **Browser primitives**: snapshot/refs, React-safe inputs, dialog capture, waits, drag fallback —
   each unit-tested against a tiny local fixture page (vitest + playwright).
3. **Agent loop**: LLM adapter (GLM), tools, system prompt, report validation, loop with turn
   caps; the `do` verb.
4. **Session memory**: persistent history, `brief`/`note`, history trimming.
5. **Polish**: `--json`/`--verbose`, exit codes, usage accounting per instruction, README with the
   outer-agent usage contract.

## Verification

1. Unit tests (`npm test`): ref map stability, report schema validation (incl. the invalid→retry
   path), prompt assembly ordering (frozen prefix bytes identical across instructions), dialog
   capture.
2. **Smoke E2E against a fixture page**: `do "fill the form with name X and submit; confirm the
   success banner"` — exercises snapshot→fill→click→wait→report on GLM 5.2 for real.
3. **Real-world slice against atelyr** (`npm run dev` in `C:\dev\atelyr`, production backend — use a
   run-scoped `MTP` name and clean up per the manual plan's §12):
   - `brief docs/AUTOMATION_GUIDE.md`, `do "log in with <creds>"`,
   - `do "create a supplier organisation named '<runid> MTP Supplies Ltd' and confirm it appears in the Organisations list with the count incremented"`,
   - `do "delete it"` — covers login, cross-tab assertion, dialog accept.
   Compare token cost + call count against the equivalent agent-browser sequence from `RUN_E2E.md`,
   and sanity-check GLM 5.2's tool-calling reliability (malformed-call rate) over the slice — if it
   proves unreliable, the provider adapter is the swap point.
4. Log per-instruction usage (`--verbose`) to confirm the cost profile that motivated the GLM
   choice.
