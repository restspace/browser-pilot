# Goal: quotation-to-order flow (Odoo)

This is a GOAL, not a list of UI steps. Work out how to achieve it yourself.

The app is Odoo 17 at {{APP_URL}}.
Sign in with login `{{APP_EMAIL}}` and password `{{APP_PASSWORD}}`.

## Objectives

1. A customer named `<RUNID> Bench Customer` exists, with City set to `Benchville`.
2. A quotation exists for that customer with ONE order line: pick any product from the
   product catalogue, quantity 3. Report the product you chose, the unit price the app
   filled in, and the untaxed amount the app computes.
3. The same quotation gains a SECOND order line: a different product, quantity 2.
   Report the product and the new untaxed amount.
4. The first line's quantity is changed from 3 to 5. Report the untaxed amount afterwards.
5. The quotation is confirmed so it becomes a sales order. Report the order reference
   (its name, e.g. `S00042`) and the status the app now shows.
6. The sales order is then cancelled so nothing created by this run stays active.
   Report the status the app shows after cancelling.

Substitute the runid you were given for `<RUNID>` everywhere above, exactly as provided.

## Notes on the environment

- Customer and product fields are autocomplete dropdowns: a value only counts when an
  option from the dropdown has actually been chosen, not merely typed.
- Do not wait for network idle — the app long-polls and is never idle. Wait on concrete
  page state instead.

## What to report

When you are done, stop calling tools and give a final plain-text report with one line per
objective above: the objective number, DONE or FAILED, and the concrete value(s) you observed
from the page (product names, amounts, order reference, statuses). If an objective defeated
you, say so plainly — do not guess a value or claim success you did not verify.
