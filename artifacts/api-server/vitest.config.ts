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
    // Vitest 4: pool sub-options are now top-level on `test`. Run all
    // tests in a single fork so they share one DB connection pool and
    // never race on the seeded test menu items / event_settings row.
    singleFork: true,
  },
});
