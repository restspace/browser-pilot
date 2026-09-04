# Changelog

## Unreleased

### Renamed to sitelooper
- The project, package, CLI and skill are now `sitelooper` (previously
  `sleep-walker`, and `browser-pilot` before that).
- Env vars are `SITELOOPER_*`; state lives under `~/.sitelooper/`.
- Nothing breaks: `sleep-walker` and `browser-pilot` remain bin aliases, both
  legacy env prefixes are still honoured (most recent wins), and an existing
  `~/.sleep-walker` or `~/.browser-pilot` home keeps being used until a
  `~/.sitelooper` exists.
- The bench arm id is now `sitelooper`; the verifiers still read results
  published under the old `sleep-walker` arm id, and published run artefacts
  keep the names they were recorded under.

## 0.2.0 — 2026-08-26 (beta)

The first beta cut. Everything below is measured, not claimed: the v0.2
addendum in `bench/MATRIX-v0.1.md` verifies 27/27 objectives across three
real apps (repairdesk, Odoo 17, Grafana 11) at $0.05–$0.50 per run, on the
same cloud environment as the v0.1 baseline.

### Replay v2 — evidence-based page/record re-resolution
- Structural URL matching: pattern markers (`:id`, `:var`, `{{…}}`) are the
  only wildcards; shape heuristics no longer decide matches.
- Soft matching (mechanism 2): a same-shape URL with 1–2 disagreeing literal
  segments proceeds optimistically and, once the run advances past it, that
  segment is generalised to `:var` in the stored skill — volatility proven,
  not guessed. Soft precondition matches are additionally gated by the
  segment's structural fingerprint (≥0.8 cosine), so a different page
  template still refuses.
- Provenance (mechanism 1): values a run mints (a created record's id, a
  generated uid) become `{{dN}}` derived params, re-bound from the live
  replay's own URL and threaded through segment chains; flows expose
  `{{step.url.<part>}}` outputs the same way.
- Navigation by recorded destination: when a navigation click's target is
  gone (session-local UI like a recents list), replay first clicks another
  visible link matching the recorded destination, then — only for a fully
  concrete URL — navigates directly. Both logged as fallthroughs.

### Component recipes
- A third, origin-INDEPENDENT learning tier for hard widgets: seeded,
  self-verifying procedures for monaco, CodeMirror 6, ProseMirror,
  contenteditable, and ARIA comboboxes, applied transparently under
  fill/type/select with fallback to the naive primitive. Recipes follow the
  skills lifecycle (provisional → validated on verified use, cross-origin
  success weighted double; demoted on repeat failure) and new variants are
  learned from successful recoveries. The mandatory verification read is
  the honesty rule made structural: a recipe that cannot re-observe its own
  effect did not succeed.

### Secrets
- `{{env:NAME}}` markers resolve only at the tool layer: the model, the
  transcript, recordings, skills, and flows carry the marker; the browser
  alone receives the value. Page echoes are scrubbed back to the marker.
  An unset variable is a hard error, never a literal keystroke.

### Install & operations
- `sleep-walker doctor`: one-command install diagnosis (node, home,
  launchable browser with the exact fix on failure, provider/key) — no
  daemon, no API key needed.
- CI: unit suite on Linux/Windows/macOS, the browser-gated suite on
  Playwright's chromium (the bare-box fallback path), and a cold-install
  job on all three OSes (pack → global install → doctor → keyless session).
- MIT license.

### Status labels
- Supported surface: `do`, learning/skills, briefings, secrets.
- Experimental: flows (`var` / `flow` / `run` / `stop --save-flow`) —
  functional end-to-end on real apps, still converging on replay cost.

## 0.1.0

Initial internal version: agent-in-the-loop `do` instruction loop, session
daemon with persistent profiles, recording to Playwright scripts, learning
mode (skills with locator chains, parameterisation, lifecycle), flows,
four-arm benchmark harness.
