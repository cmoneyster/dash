import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    // Run test files one at a time so they never race on the shared
    // event_settings row or seeded test menu items in the database.
    // (Vitest 4 ignores the old `singleFork` option.)
    fileParallelism: false,
  },
});
