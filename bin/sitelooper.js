#!/usr/bin/env node
import('../dist/cli.js').catch((err) => {
  console.error('sitelooper: failed to start (did you run `npm run build`?)');
  console.error(err?.stack || String(err));
  process.exit(2);
});
