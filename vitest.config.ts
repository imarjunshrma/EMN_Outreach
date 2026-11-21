import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: process.env.SKIP_TEST_DB === '1' ? [] : ['tests/helpers/global-setup.ts'],
    setupFiles: ['tests/helpers/env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
