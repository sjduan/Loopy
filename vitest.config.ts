import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["apps/server/src/**/*.test.ts", "apps/web/src/**/*.test.ts", "packages/shared/src/**/*.test.ts"]
  }
});
