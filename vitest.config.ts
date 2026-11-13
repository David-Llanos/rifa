import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Run tests against shared sources so no prior build is required.
      "@raffle/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
