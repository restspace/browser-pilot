Playwright MCP - browser automation tools served over the Model Context Protocol.

Your tool set IS this arm's interface: every tool you can call (browser_navigate,
browser_snapshot, browser_click, browser_type, browser_fill_form, and the rest)
is served directly by the @playwright/mcp server, with the schemas its authors
ship. There is no command line and no extra wrapper.

Conventions that matter:

- browser_snapshot returns an accessibility snapshot of the page with element
  refs. Actions that target an element take the `ref` from the most recent
  snapshot plus a human-readable `element` description. After navigation or a
  large DOM change, take a fresh snapshot before using refs.
- Most action tools return a fresh page snapshot in their result, so a separate
  snapshot call after every action is usually redundant.
- browser_evaluate runs JavaScript in the page when no dedicated tool fits.
- Screenshots are image content; this benchmark is text-only, so image payloads
  are omitted from results — rely on snapshots instead.

The browser starts fresh for this run (isolated profile, headless Chromium),
signed out of everything.
