import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/integration/global-setup.ts"],
          // Tests share one database; each test creates its own user so they don't interfere.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
