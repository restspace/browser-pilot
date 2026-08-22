# Goal: repair ticket flow

This is a GOAL, not a list of UI steps. Work out how to achieve it yourself.

The app is a repair-desk tool at {{APP_URL}}.
Sign in with email `{{APP_EMAIL}}` and password `{{APP_PASSWORD}}`.

## Objectives

1. A ticket titled `<RUNID> RD Bench Ticket` exists in the app.
2. That ticket has a part named `<RUNID> RD Part A` with cost 100 and markup 25.
   Report the price the app computes for it.
3. That ticket has a second part named `<RUNID> RD Part B` with cost 200 and markup 25.
   Report the price the app computes for it.
4. Part A's cost is changed from 100 to 150. Report the price the app computes afterwards.
5. The ticket ends in status `Ready`. The app enforces preconditions before it will accept
   that status — discover what they are, satisfy them, and report exactly what was required.
6. Both parts are then removed, and the ticket is archived so that nothing created by this
   run is left active.

Substitute the runid you were given for `<RUNID>` everywhere above, exactly as provided.

## Notes on the environment

- After a create or delete, the list/detail view refreshes a short beat after the mutation,
  not instantly. Don't conclude a create or delete failed just because it isn't reflected
  immediately — wait on concrete page state rather than assuming the first render is final.

## What to report

When you are done, stop calling tools and give a final plain-text report with one line per
objective above: the objective number, DONE or FAILED, and the concrete value(s) you observed
from the page (prices, statuses, confirmation text). If an objective defeated you, say so
plainly — do not guess a value or claim success you did not verify.
