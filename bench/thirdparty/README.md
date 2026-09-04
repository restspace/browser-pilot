# Third-party benchmark targets

Real applications we did not write, self-hosted so runs are reproducible and
resettable. They exist because our own two targets (`bench/app`, atelyr) share a
weakness a sceptical reader finds immediately: a tool that learns page structure can
be flattered by pages its authors shaped.

They are self-hosted deliberately. Benchmarking against live public sites would mean
fighting anti-bot measures — out of scope for this tool, and useless as measurement,
since a run that dies on a CAPTCHA says nothing about sitelooper.

## The set

| Target | Port | Covers | Auth |
|---|---|---|---|
| Odoo 17 | 8069 | dense server-rendered CRUD; **hash routing**; many2one autocompletes | admin / admin |
| Grafana 11 | 3000 | React SPA; deep unnamed DOM; drawers and option panes | admin / admin |

Bring one up with:

    docker compose -f bench/thirdparty/<name>/docker-compose.yml up -d
    bash bench/thirdparty/<name>/seed.sh      # odoo only

Reset either with `down -v` followed by `up -d` and a re-seed.

Together with `bench/app` (ships here) and atelyr (private), these are the targets the
benchmark matrix runs against.

## Targets used for shakedown, then retired

Five more were stood up on 2026-08-24 purely to widen the range of client technology
sitelooper had been exercised against — Gitea (Go templates + Vue islands), Ghost
(Ember admin, contenteditable editor), Jenkins (pre-SPA jQuery), NocoDB (canvas grid)
and the-internet (isolated widget torture). They did their job, found the defects
below, and were removed rather than carried as matrix rows nobody intended to publish.

Their compose and seed files are in git history if any of them is ever wanted back.

The reason for choosing them that way is worth keeping: **every defect found so far
came from DOM idioms we had not seen before, not from tasks we had not tried.** If the
target set is widened again, widen it by client technology, not by adding more
applications of a shape already covered.

## Known limits these targets established

- **Canvas content is unreachable.** NocoDB draws its data grid to a `<canvas>`;
  seeded rows appeared in zero DOM nodes. No selector, snapshot or read can reach
  them — by us or by any DOM-based tool. Only a vision model can. If the matrix ever
  wants a row where a vision-based arm should beat sitelooper outright, that is the
  shape to reach for.
- **iframes replay, but do not compile.** The operator can see and act inside a frame
  (refs are `f<frame>e<element>`), but an in-frame action does not compile into a
  replayable locator: recorded candidates are page-level and page locators do not
  pierce frames. Iframes work on the live agent path, not the zero-model replay path.
- **Shadow DOM works.** Playwright's snapshot pierces it; tested, no action needed.
- **Turn budget.** Odoo and atelyr forms run 19–23 turns against the default cap of
  30. Raise `--max-turns` for those targets or runs will truncate and score as
  failures.
