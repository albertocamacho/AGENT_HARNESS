import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    reporters: ["verbose"],
    testTimeout: 120_000,
    bail: process.env.CI ? 1 : 0,

    // No parallelism — real API calls, sequential output
    maxConcurrency: 1,
  },
});
