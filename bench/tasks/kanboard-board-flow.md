# Goal: kanban task flow (Kanboard)

This is a GOAL, not a list of UI steps. Work out how to achieve it yourself.

The app is Kanboard at {{APP_URL}}.
Sign in with username `{{APP_EMAIL}}` and password `{{APP_PASSWORD}}`.

## Objectives

1. On the board of the project named `Bench Board`, report the names of the board's
   columns in their left-to-right order, exactly as shown.
2. A task titled `<RUNID> Bench Task` exists on the `Bench Board` project, with a
   description that includes the runid.
3. That task has been moved so it now sits in the `Work in progress` column of the board.
4. The task has a comment whose text includes the runid.
5. The task's due date is set to 2026-12-31.
6. Report the task's numeric ID exactly as the app displays it (Kanboard shows it
   as `#<number>` on the task card and task page).

Substitute the runid you were given for `<RUNID>` everywhere above, exactly as provided.

## Notes on the environment

- Kanboard is a classic server-rendered app: most actions load a new page or open a
  small modal form, and the board supports dragging cards between columns.
- Do not modify or move the seed tasks (titles starting `Seed:`); objective 1 only
  reads the board.
- A task's details (description, comments, due date) are edited from its task page
  or its card menu, not inline on the board.

## What to report

When you are done, stop calling tools and give a final plain-text report with one line per
objective above: the objective number, DONE or FAILED, and the concrete value(s) you observed
from the page. If an objective defeated you, say so plainly — do not guess a value or claim
success you did not verify.
