import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["../core/test/integration/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
