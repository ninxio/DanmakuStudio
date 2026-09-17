import { defineConfig } from "@playwright/test";
import developmentConfig from "./playwright.config";

export default defineConfig({
  ...developmentConfig,
  workers: 1,
  webServer: {
    command:
      "corepack pnpm exec vite preview --host 127.0.0.1 --port 49999 --strictPort",
    url: "http://127.0.0.1:49999",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
