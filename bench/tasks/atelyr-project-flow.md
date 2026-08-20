# Goal: project pricing flow

This is a GOAL, not a list of UI steps. Work out how to achieve it yourself.

The app is a project-management tool at {{APP_URL}}.
Sign in with email `{{APP_EMAIL}}` and password `{{APP_PASSWORD}}`.

## Objectives

1. A project named `<RUNID> MTP Bench Project` exists in the app.
2. That project has a line item named `<RUNID> MTP Item A` with cost 100 and markup 25.
   Report the price the app computes for it.
3. That project has a second line item named `<RUNID> MTP Item B` with cost 200 and markup 25.
   Report the price the app computes for it.
4. Item A's cost is changed from 100 to 150. Report the price the app computes afterwards.
5. Item A's status ends as `Specified` rather than its initial status. The app enforces
   preconditions before it will accept that status — discover what they are, satisfy them,
   and report exactly what was required.
6. Both line items are then removed, and the project is closed/archived so that nothing
   created by this run is left active.

Substitute the runid you were given for `<RUNID>` everywhere above, exactly as provided.

## Notes on the environment

- This is a development server. Do not wait for network idle — its websocket never goes idle.
  Wait on concrete page state instead.
- List views refresh asynchronously after a create or delete.

## What to report

When you are done, stop calling tools and give a final plain-text report with one line per
objective above: the objective number, DONE or FAILED, and the concrete value(s) you observed
from the page (prices, statuses, confirmation text). If an objective defeated you, say so
plainly — do not guess a value or claim success you did not verify.
