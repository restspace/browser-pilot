# Third-party benchmark targets

Real applications we did not write, self-hosted so runs are reproducible and
resettable. They exist because our own two targets (`bench/app`, atelyr) share a
weakness a sceptical reader finds immediately: a tool that learns page structure can
be flattered by pages its authors shaped.

They are self-hosted deliberately. Benchmarking against live public sites would mean
fighting anti-bot measures — out of scope for this tool, and useless as measurement,
since a run that dies on a CAPTCHA says nothing about browser-pilot.

## The set, and what each is here to cover

| Target | Port | Covers | Auth |
|---|---|---|---|
| Odoo 17 | 8069 | dense server-rendered CRUD; **hash routing**; many2one autocompletes | admin / admin |
| Grafana 11 | 3000 | React SPA; deep unnamed DOM; drawers and option panes | admin / admin |
| Gitea 1.22 | 3001 | Go server-rendered templates + Vue islands; dev-tool navigation | bench / bench-pass-1234 |
| Ghost 5 | 2368 | **Ember.js** admin; Koenig contenteditable editor | bench@example.com / bench-pass-1234 |
| Jenkins LTS | 8085 | legacy jQuery UI, framesets, pre-SPA idioms | anonymous (wizard disabled) |
| NocoDB | 8090 | **canvas-rendered grid** — the honest limit case | bench@example.com / bench-pass-1234 |
| the-internet | 7080 | isolated widget torture: iframes, shadow DOM, alerts, dynamic loading | none |

Each directory holds a `docker-compose.yml` and, where an account is needed, a
`seed.sh`. Bring one up with:

    docker compose -f bench/thirdparty/<name>/docker-compose.yml up -d
    bash bench/thirdparty/<name>/seed.sh      # where present

Reset any of them with `down -v` followed by `up -d` and a re-seed.

## Why this spread

Every defect found so far came from DOM idioms we had not seen before, not from
tasks we had not tried — so the set is chosen for **client-technology diversity**
rather than for more applications of the same shape. Between them they cover
server-rendered, React, Vue, Ember, and pre-SPA jQuery, plus the affordances that
break automation in isolation.

`the-internet` earns its place by isolating single affordances. The other targets
exercise iframes and shadow DOM incidentally and in combination; when a flow fails
there, this target tells us *which* affordance did it.

NocoDB earns its place by being unwinnable. It draws its grid to a `<canvas>`, so
seeded rows appear in zero DOM nodes and no selector can reach them. It is kept
because it is the one target where a vision-based tool should beat browser-pilot
outright, and a benchmark that quietly dropped it would be picking its own ground.

## Known limits these targets exposed

- **iframes replay, but do not compile.** The operator can see and act inside a
  frame, but an in-frame action does not compile into a replayable locator: recorded
  candidates are page-level and page locators do not pierce frames. Iframes work on
  the live agent path, not the zero-model replay path.
- **Canvas content is unreachable**, by us or by any DOM-based tool.
- **Turn budget.** Odoo and atelyr forms run 19–23 turns against the default cap of
  30. Raise `--max-turns` for those targets or runs will truncate and score as
  failures.
