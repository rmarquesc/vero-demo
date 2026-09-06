import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The contract's WASM runtime is not safe to share across worker threads,
    // and these tests are fast enough that isolation costs nothing.
    pool: 'forks',
    server: {
      // Load the generated contract through Node rather than Vite. It is
      // already plain JS, and its source map points at compiler-internal paths
      // that do not ship — which Vite reports as a warning on every run.
      deps: { external: [/contracts\/managed\//] },
    },
    testTimeout: 30_000,
  },
});
