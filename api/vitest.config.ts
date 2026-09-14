import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The first test in each file to import explorerService.ts pays for compiling
    // it, which alone exceeds the 5s default and fails tests that then assert on a
    // pure function. The budget is for the import, not for the assertions.
    testTimeout: 20_000,
  },
});
