import { defineConfig } from 'vitest/config';

// Browser-gated runs launch a real Chromium per test file; running files in
// parallel starves them on small machines (2-core CI runners) and turns
// settle-timing assertions flaky. Unit runs keep full parallelism.
export default defineConfig({
  test: {
    fileParallelism: process.env.BP_BROWSER_TESTS !== '1',
    // The repo's tests all live in test/. bench/results-published holds
    // benchmark ARTIFACTS whose filenames legitimately end in .spec.mjs
    // (published Playwright scripts from the codegen/authored arms) — the
    // default include glob would run them as test suites.
    include: ['test/**/*.test.ts'],
  },
});
