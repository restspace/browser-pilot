# sitelooper: value, monetisation, and the road to first users

Written 2026-09-04 from a strategy conversation. Grounded in bench/MATRIX-SUMMARY.md
(2026-09-03, sets 26 and 28) and the current state of the repo. This is a handoff: the
next session should be able to act on it without the conversation.

## 1. What the matrix actually establishes

- **First contact is competitive, not dominant.** sitelooper is the slowest arm on every
  target and the cheapest on three of four. The 25/25 verified record is real. The
  comparators are thin: playwright-mcp and browser-use only ran on repairdesk in v0.1, and
  every run was self-run.
- **Replay is the result nobody else has.** Converged flows re-run in ~20-50s for $0.00,
  verified against the app's own database. Static scripts verified 14/48; the agent re-run
  pays full price forever. This is the thesis.
- **The moat is not the CLI.** It is the compiled flow: measured locator chains, slot
  provenance, effect gates, and the re-pin loop that makes flows converge over runs. Anyone
  can write an agent loop over Playwright. The recording-as-evidence is the hard part, and
  it produces data that gets more valuable per customer over time.

**The honest gap.** The closest competitors to the thesis are not agent-browser or
playwright-mcp. They are the record-once / replay-deterministically / model-on-drift tools:
browser-use's **workflow-use**, Stagehand action caching, Magnitude, Skyvern cached
workflows, and commercially mabl, testRigor, Autify, QA Wolf. None is in the matrix. Until
one is, "most efficient there is" will be discounted by anyone who knows the space.

## 2. workflow-use vs sitelooper

The browser-use arm in v0.1 measured the *agent* (monolithic task, 135 schema validation
errors on the bench model; smoke run passed 4/6, so model fit not harness). workflow-use is
a separate browser-use repo, "RPA 2.0", and is the real competitor to the replay thesis.

What it is (from docs, not code, as of 2026-09-04):

- Creation by browser-extension recording of a human, or "generation mode": a browser-use
  agent runs once and a workflow is written from the run.
- Replay is a JSON workflow of typed steps (navigate, click, input, select, extract, agent)
  with no model. Elements targeted by visible text first, then a fixed list of CSS/XPath
  fallbacks tried in priority order.
- Variables are extracted from form inputs, `{brace}` interpolated. Step outputs can feed
  later steps, mechanism thin.
- "Self-healing" = if a step fails, hand it to a browser-use agent. Docs do not say whether
  the repair is written back.
- README: "very early development, not recommended for production"; fallback logic
  self-described as suboptimal. Python.

Where sitelooper differs, mapping onto the README's four structural failure modes:

1. **Success detection.** workflow-use: selector resolved and action did not throw.
   sitelooper: effect gates. Wrong-element clicks and refused saves replay green there;
   this is the failure that made the codegen arm confirm an empty sales order.
2. **Value provenance.** workflow-use variables are form-field literals; no concept of a
   minted id, so a post-save url id is baked in. sitelooper: slots, threaded step outputs,
   minted values re-read from the browser.
3. **Locator measurement.** workflow-use fallbacks generated once. sitelooper records which
   candidate resolved on each replay and retires volatile ones; positional yardstick;
   same-kind-of-control guard.
4. **Waits.** Nothing in workflow-use docs on SPA hydration or DOM quiet.
5. **Healing that persists.** sitelooper recovery is compiled and re-pinned (Atelyr delete
   step: recovery, then 15/15 zero-turn replays). workflow-use repair may be ephemeral.
6. **Verification.** sitelooper bench scores against app-side state. workflow-use publishes
   no benchmark.

**Action:** add a workflow-use row on repairdesk and odoo using generation mode, scored by
the existing verifier. Expected: acceptable on the light SPA, fails on odoo the way codegen
did (minted ids, unchecked effects). Verify in source before publishing: (a) is the repaired
step written back, (b) can step outputs really feed later steps.

Sources: github.com/browser-use/workflow-use, its README, HN item 44007065,
deepwiki.com/browser-use/workflow-use.

## 3. Value to James, in order

1. **Atelyr's test suite.** Atelyr is already the hardest target in the bench. Regression
   coverage without writing or maintaining Playwright is worth money to Atelyr today.
2. **A credible open artifact.** Bench + README is what gets a solo developer noticed by the
   vendors above. Worth more than early revenue.
3. **A wedge for Restspace / RS2.** A flow runner needs hosting, storage, scheduling; natural
   first tenant workload.

## 4. Monetisation routes, ranked by fit

1. **Open core with a hosted control plane.** CLI free. Paid: hosted replay runners, flow
   storage and sharing, drift dashboards, scheduled runs, bundled model stack (no API keys).
   Pricing story comes straight from the matrix: pay for recordings, replays are free.
   Playwright-to-Checkly pattern.
2. **Self-hosted enterprise licence + support.** Regulated customers will not ship DOM to a
   cloud. Supported build, SSO, audit.
3. **RPA, not just testing.** odoo flow at $0/run is process automation. Bigger market;
   second act, not first.
4. **Acquisition / partnership with a test vendor.** Self-healing is what mabl and testRigor
   charge five figures a year for. Targets: those two, Autify, QA Wolf, BrowserStack,
   Sauce Labs, Datadog Synthetics, Checkly, Browserbase.
5. **Services.** Author flows for customers. Low leverage, immediate cash, seeds the hosted
   product with real flows.

## 5. Open source: yes, with a boundary

The CLI must be open; MIT (current) works. Reasons: developers will not put a closed binary
holding their API keys into a test toolchain; distribution is agents installing a skill,
which needs a free package; every incumbent in the matrix is open, so closed = no bench
credibility.

Keep closed: the hosted control plane and model-stack tuning. Standard open-core line.

Cautions:
- Consider Apache-2.0 over MIT for the patent grant before v1.
- A source-available licence (BSL etc.) applies only to future versions. Decide before the
  first hosted customer, not after.

## 6. Preferred path: get bought or hired, after proving users

James's stated preference: acquisition or a well-paid role at an existing vendor, which
works better with a user base. What a buyer counts: named teams replaying flows in CI, flow
files committed in public repos, a usage number with a zero-turn replay rate. Target:
~20 nameable teams and a few hundred weekly replays. Six to eight weeks if the first five
minutes work.

### Current distribution state (2026-09-04)

- Public repo: github.com/restspace/sitelooper
- npm: `sitelooper` 0.3.0; **`browser-pilot` still published at 0.4.2**, a higher version
  than the new name. Will confuse the first stranger.
- Claude Code skill: installed by `cp skills/sitelooper/SKILL.md ~/.claude/skills/...`
- No MCP server. No GitHub Action. `.github/workflows/` exists (bench only).
- Developed on Windows; `bash.exe.stackdump` sits in the repo root.
- Needs an OpenAI-compatible key and a model choice (glm-5.3 / deepseek-v4-flash stack).

### Fix the first five minutes

- `npm deprecate browser-pilot` with a message pointing at sitelooper.
- Default provider config (OpenRouter or similar): one env var gives the tuned model pairing
  without reading the env table.
- Test install and quick start on a Mac before any launch.
- A demo needing no credentials: quick start against a public target already benched (e.g.
  the Grafana play instance) so a reader sees record then $0 replay in under two minutes.

### Distribute through the agents, not to humans

Persona = James: a developer in Claude Code / Cursor who wants E2E tests without maintaining
Playwright.

1. **Claude Code plugin** so install is one slash command. Highest-leverage item.
2. **MCP server** wrapping do / record / replay, for Cursor, Windsurf, Codex.
3. **GitHub Action** replaying committed flows nightly, failing on an effect gate. CI is where
   a testing tool becomes a habit; a committed flow directory is a public adoption signal
   countable by code search.

### Launch on the benchmark, not the tool

Show HN shaped as "four browser agents against four real apps, verified against the
database", not "I built a tool". Standalone bench page with raw results linked, workflow-use
row included, codegen-confirmed-empty-sales-order in paragraph two. Then Playwright Discord,
testing subreddits, browser-use and Stagehand communities. The failure-anatomy writeups
("why your agent's generated Playwright script is lying to you") are blog posts.

### Count it

Opt-in anonymous ping on record and replay: hashed hostname, steps, tier reached, model
turns, cost. Publish the aggregate. The number a buyer wants: replays per week and the
fraction run with the model asleep.

### Ten conversations

Ten people running a Playwright suite they resent: small SaaS founders, Odoo / Grafana
shops, agencies. Record their smoke test with them on a call; cover the cents. Each one who
commits a flow directory is a reference, a "nothing app-specific" data point, and a quote.

### Order of work

| week | do |
|---|---|
| 1 | npm deprecation, default provider, Mac test, no-credential demo, telemetry |
| 2 | Claude Code plugin, MCP server, workflow-use bench row |
| 3 | GitHub Action, bench page, Show HN |
| 4-8 | ten reference teams, weekly usage number published |

**Caution:** every week on the engine now is a week not on the above. The matrix says the
engine is good enough to show. The gap is packaging and reach.
