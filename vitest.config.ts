import { defineConfig } from 'vitest/config';

// Browser-gated runs launch a real Chromium per test file; running files in
// parallel starves them on small machines (2-core CI runners) and turns
// settle-timing assertions flaky. Unit runs keep full parallelism.
export default defineConfig({
  test: {
    fileParallelism: process.env.BP_BROWSER_TESTS !== '1',
  },
});
