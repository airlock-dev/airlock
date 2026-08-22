import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep native better-sqlite3 teardown below the GitHub runner's process-pressure cliff.
    // Unbounded fork concurrency intermittently aborts a worker in Database::~Database(),
    // which Vitest surfaces only as ERR_IPC_CHANNEL_CLOSED after otherwise-passing tests.
    maxWorkers: 2,
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'openclaw/**'],
  },
});
