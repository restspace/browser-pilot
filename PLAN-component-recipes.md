# Component recipes: cross-app learning for hard widgets

Written 2026-08-25, after the swg3 sweep. Successor work to PLAN-replay-v2
(whose mechanisms it does not change) — this plan attacks the largest
remaining source of model-recovery steps: third-party UI components that
defeat the naive fill/click/read primitives.

## The evidence this plan rests on

- swg3-n2 was the first real-app replay to run a full flow (13/13 steps,
  orchestrator-free, verified 5/6). The ONE objective it failed, on both
  replays, was the Grafana Notes **text panel**: a monaco editor. swg3-n3's
  recovery reported honestly — "the Monaco editor model shows the typed text
  … but the panel preview still shows the default" — and halted. swg3-n2's
  recovery claimed success that Grafana's API disproves. Every route into
  that widget (skill replay, cheap model, strong-model recovery with 29–30
  turns) fails or fabricates.
- The matrix work already names canvas/monaco as a hard limit
  (bench/MATRIX-v0.1.md); atelyr and Odoo have their own instances of the
  class (rich-text editors, non-native dropdowns).
- These widgets are not app features. Monaco in Grafana is monaco in every
  admin panel that embeds it; the same is true of CodeMirror, ProseMirror/
  contenteditable editors, combobox-style dropdowns, date pickers. The
  app-agnostic rule (app knowledge lives in the session briefing, never in
  browser-pilot) is therefore not in tension: **component knowledge is
  cross-app by construction**, and the store that holds it is keyed by
  component identity, not by origin.

## Shape of the mechanism

A third tier of learning, alongside skills (origin-scoped macro-procedures)
and flows (session-scoped step sequences):

**recipes** — origin-INDEPENDENT micro-procedures, one per (component
family, intent), where intent is one of a small closed set: `set-value`,
`read-value`, `select-option`, `open`, `dismiss`. A recipe is a short list
of primitive actions with the payload parameterised, plus a mandatory
**verification read**: how to read the component's effective value back so
the recipe can prove it worked. Example, monaco/set-value:

1. click the component root (focus lands on `.inputarea`)
2. press Control+A
3. keyboard.insertText {{value}}
4. press Escape (commit / dismiss suggestions)
5. VERIFY: read `.view-lines` text, must contain {{value}}

Step 5 is not optional and is the honesty rule made structural: a recipe
that cannot re-observe its own effect did not succeed. This is exactly the
check that would have stopped swg3-n2's fabricated Notes-panel success.

## Component recognition

A component fingerprint is a structural signature of the target element's
ancestry — the same philosophy as fingerprint.ts, scoped to a subtree:

- an ordered list of marker predicates on the closest matching ancestor:
  stable class tokens (`monaco-editor`, `cm-editor`, `ProseMirror`), ARIA
  idioms (`role=combobox` + `aria-expanded` + no `<select>`), tag shape
  (`[contenteditable=true]`).
- matching runs in one `page.evaluate` over the resolved target: walk up
  from the element, first family whose predicate matches wins, return the
  family id and the matched root's selector.

Recognition is allowed to be a heuristic because being wrong is cheap by
construction: the recipe runs, its verification read fails, the action falls
back to the naive primitive and then to the model — one wasted attempt, no
dead flow. (Same budget rule as PLAN-replay-v2: heuristics may order and
suggest; only evidence may decide "success".)

## Where recipes are applied

1. **Tool layer (invisible to skills).** In tools.ts `dispatch`, `fill` /
   `type` / `select` on a target inside a recognized component swap the
   naive primitive for the family's validated recipe. A skill recorded
   against monaco replays unchanged — its `fill` step just stops lying.
   The swap is recorded in the step result (`filled via recipe
   monaco/set-value@2`) so transcripts and drift telemetry stay truthful.
2. **Inner agent (visible).** The `[skills]`-style block gains a
   `[components]` line when the current page contains recognized components,
   listing the family and available intents, so the model reaches for
   `fill` (now recipe-backed) instead of improvising 29-turn workarounds.

## Learning and lifecycle

Recipes obey the skills lifecycle, with the store scoped globally:

- **Compile.** When the deterministic path failed at an element and the
  model's recovery then succeeded, the recorder already holds the exact
  action run that worked. If the failed target sits inside a recognized (or
  newly fingerprint-able) component root, and the successful actions all
  landed inside that root, compile them into a recipe with the typed
  payload parameterised (discoverSlots on the instruction, as for skills).
  Guard as skills do: only action primitives, no eval/screenshot, ≤ 8 steps.
- **Status.** provisional → validated on the second clean, verified use;
  demoted after two consecutive verification failures. A use on a DIFFERENT
  origin counts double toward validation: cross-origin success is what
  proves the knowledge is component-level, not app-level in disguise.
- **Store.** One JSON file, `~/.browser-pilot/components.json` (override:
  `BROWSER_PILOT_COMPONENTS_FILE`), families keyed by id with their marker
  predicates and per-intent recipe variants; same stats block as skills
  (uses, successes, per-origin tallies, lastUsed).

## Seeding

Ship a starter library — this is component knowledge, so shipping it does
not breach the app-agnostic rule:

- monaco (`set-value`, `read-value`)
- CodeMirror 6 (`set-value`, `read-value`)
- contenteditable / ProseMirror (`set-value`, `read-value`)
- ARIA combobox without `<select>` (`select-option`)

Seeded recipes enter the store as provisional like everything else: they
must verify on first contact and can be demoted or superseded by learned
variants when a library version changes behaviour. The seed is a floor, not
an authority.

## What this does NOT cover

- True canvas surfaces (charts, drag-to-position grids): no DOM to verify
  against, out of scope; remains a declared hard limit.
- App-level flows ("how Grafana saves a dashboard") — that is skill/flow
  territory and stays origin-scoped.
- Free-form vision. Recognition stays structural; bp is text-only.

## Validation

- Unit: fingerprint matching (positive on monaco/CodeMirror fixtures,
  negative on plain textarea); recipe verify-read gating; lifecycle incl.
  cross-origin double-weight; tool-layer swap with fallback to naive fill.
- Browser (BP_BROWSER_TESTS): a fixture page embedding a real monaco build —
  naive fill fails, recipe path sets and verifies the value.
- Bench: re-run swg3-style sweep; success = obj 3 passes on replays, the
  Notes steps stop consuming recovery turns, and per-replay recovery steps
  drop toward the ≤ 1 bar. Second target: an Odoo flow touching its
  many2one dropdowns (the "Configure your product" class from swo).

## Task checklist

- [ ] 1. Component store + types (`src/skills/components.ts`): families,
      recipes, stats, load/save, seeded library.
- [ ] 2. Recognition probe (one evaluate: element → family + root selector),
      used from tools.ts dispatch.
- [ ] 3. Tool-layer swap for fill/type/select with verification read and
      naive fallback; result strings and drift telemetry updated.
- [ ] 4. `[components]` block for the inner agent's context.
- [ ] 5. Recipe compilation from recoveries (learn.ts hook) + lifecycle
      with cross-origin weighting.
- [ ] 6. Fixture + tests (unit, browser-gated monaco).
- [ ] 7. Validation sweeps (grafana swg4; odoo swo2) recorded in
      bench/MATRIX-v0.1.md follow-up.
