# sleep-walker bug report — 2026-08-08

Reported from a real session (Claude Code, Windows 11, `sleep-walker` invoked via the
`sleep-walker` skill, model `zai-org/glm-5.2` via novita).

**Task under test:** verify that a server-rendered page at `http://127.0.0.1:8787/` hydrates —
click a button labelled "Simulate a submission" twice and read the counter beside it.

**Context that matters for judging the reports below:** the page had a genuine hydration bug at
the time (two `preact` instances in the bundle; hydration threw `Cannot read properties of
undefined (reading '__H')` and stripped the island from the DOM after SSR). So the button really
was absent from the live DOM. It was present in the server-rendered HTML.

---

## Defect 1 — `do` can consume the entire timeout in a single turn and return nothing

**Severity: high.** This is the one that cost the most wall-clock.

Command:

```sh
sleep-walker do "Reload the page, then report the browser console output verbatim - every error
and warning message, with full text. Also report the innerHTML of the div with id 'root' after
load." --json
```

Result after 300s:

```json
{
  "report": {
    "status": "blocked",
    "summary": "Instruction timed out after 300s (1 turns). Work may be partially complete — check the actions log and verify current state before resuming."
  },
  "turns": 1,
  "usage": { "promptTokens": 8397, "completionTokens": 15800, "cachedTokens": 8384 },
  "actions": [],
  "transcriptTail": [
    "assistant: I'll reload the page, then capture the console output and root innerHTML. Since console overrides don't survive a page reload, I'll set up capture and re-execute the module code to intercept any errors/warnings it produces."
  ],
  "model": "zai-org/glm-5.2"
}
```

**15,800 completion tokens across one turn, zero tool calls, 300 seconds, no output.** The agent
reasoned itself to a standstill on the first turn without ever driving the browser. `actions` is
empty, so the documented recovery advice ("check the actions log") yields nothing.

Notes:

- The instruction is arguably an anti-pattern for this tool (it asks for two separate artifacts,
  and console capture across a reload is genuinely awkward). But the failure mode should be a
  fast error, not a silent 5-minute stall.
- The task was ultimately answered in ~3 seconds with a single deterministic `eval` that armed
  an error listener and re-imported the module, which returned the exact exception string.

**Suggested remediation**

- Cap or watchdog *per turn*, not just per instruction — if a turn produces no tool call within
  N seconds, abort that turn and retry with a nudge rather than burning the whole budget.
- Emit partial output on timeout. Even the reasoning text and a final `peek` would have been
  more useful than `actions: []`.
- Consider a system-prompt rule: "make a tool call on your first turn; do not plan more than one
  step ahead before observing."

---

## Defect 2 — control commands block behind an in-flight `do`

**Severity: medium.** Prevents inspecting or killing a stuck run.

While the `do` above was in flight, both of these hung rather than returning:

- `sleep-walker session list` — exceeded 120s, completed only after the `do` released
- `sleep-walker stop --all` — exceeded 45s, same

This looks like head-of-line blocking on the daemon's request handling. The practical effect is
that when a `do` goes wrong, the operator has no way to observe it or stop it — which is exactly
when those two commands are needed. I incorrectly concluded the daemon was wedged and abandoned
the tool; it was merely unresponsive to control commands.

**Suggested remediation**

- Serve `session list`, `stop`, `config` and `screenshot` on a path that does not queue behind an
  active agent loop.
- Make `stop` preempt an in-flight instruction rather than waiting for it.

---

## Defect 3 — the agent asserted a fact about source it never fetched

**Severity: low (accuracy/trust).** The verdict was right; the supporting evidence was fabricated.

The first `do` (29 turns, 163,991 prompt tokens, 4,400 completion tokens) returned:

> The button labelled 'Simulate a submission' is not present in the DOM on the page at
> http://127.0.0.1:8787/. **The server-rendered HTML inside the `.card` div contains only the
> "Hello world" paragraph and omits the `Sn` button/counter component entirely.** The client JS
> module (`/static/hello.js`) loaded successfully (HTTP 200, 11ms) […] This indicates client-side
> hydration failed.

The **conclusion was correct** — hydration had failed and the island was absent from the live DOM.
The bolded claim was **false**: `curl` of the same URL shows the button present in the server
response. The agent inspected the post-hydration DOM and described it as "the server-rendered
HTML", conflating the two.

This matters because the false sub-claim points debugging in the wrong direction — it implies an
SSR bug (which would be in the Worker) rather than a hydration bug (which was in the Vite alias
config). I spent time chasing the wrong layer because of it.

**Suggested remediation**

- Prompt guidance distinguishing *current DOM* from *server response*, and requiring an explicit
  fetch of the document source before making any claim about server-rendered output.
- Prefer hedged phrasing in `summary` for anything not directly observed by a tool call.

---

## Secondary observation — cost on trivial tasks

The first `do` spent **163,991 prompt tokens over 29 turns** to attempt two button clicks and one
text read. Caching absorbed most of it (154,496 cached), but 29 turns for a two-click assertion
suggests the agent was re-snapshotting heavily. Worth profiling against a task this small; the
equivalent deterministic sequence is three calls and no LLM tokens.

## Environment

- `sleep-walker` invoked through the bundled skill; `agent-browser 0.16.3` also present
- Windows 11 Pro 26200, Node v24.11.1
- Target: local Cloudflare Worker (`wrangler dev`) on `127.0.0.1:8787`, plain SSR HTML + one
  hydrated island, no auth, no SPA routing
