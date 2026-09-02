# Goal: dashboard build flow (Grafana)

This is a GOAL, not a list of UI steps. Work out how to achieve it yourself.

The app is Grafana 11 at {{APP_URL}}.
Sign in with username `{{APP_EMAIL}}` and password `{{APP_PASSWORD}}`.

## Objectives

1. Report the titles of the panels on the provisioned dashboard named `Service health`,
   exactly as shown.
2. A NEW dashboard exists, titled `<RUNID> Bench Dashboard`, containing a **Stat** panel
   titled `<RUNID> Availability` whose query uses the `TestData` data source. The
   dashboard is saved.
3. That dashboard also contains a **Text** panel titled `<RUNID> Notes` whose content
   includes the runid. Saved.
4. The dashboard has the tag `bench` and its time range is set to the last 6 hours. Saved.
5. The dashboard's auto-refresh interval is set to `1m`. Saved.
6. Report the dashboard's URL (or UID) so it can be found again — read it from the browser's
   page URL rather than quoting it from memory.

Substitute the runid you were given for `<RUNID>` everywhere above, exactly as provided.

## Notes on the environment

- Time-series charts here are drawn to canvas; panel TITLES and editor controls are
  regular DOM. Nothing in this goal requires reading values off a chart.
- Grafana only persists changes when the dashboard is explicitly saved; edits in the
  panel editor are not saved by "Apply"/"Back" alone.
- The time range is persisted into the saved dashboard ONLY when the save dialog's
  "Update default time range" box is ticked; the time picker in the top bar shows the
  browser session's range whether or not it was saved, so it is not proof of persistence.

## What to report

When you are done, stop calling tools and give a final plain-text report with one line per
objective above: the objective number, DONE or FAILED, and the concrete value(s) you observed
from the page. If an objective defeated you, say so plainly — do not guess a value or claim
success you did not verify.
