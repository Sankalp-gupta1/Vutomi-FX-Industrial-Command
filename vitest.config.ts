import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 10000,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
