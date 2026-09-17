import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Vitest 4 also times synchronous fixtures; these include large XML and signed matrices.
    // User-visible speed budgets are checked separately against the production browser build.
    testTimeout: 15_000,
    setupFiles: ["src/test/reactActEnvironment.ts", "src/test/setup.ts"],
    css: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
});
