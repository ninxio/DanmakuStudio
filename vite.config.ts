import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: false,
    watch: {
      // Playwright writes acceptance screenshots and traces inside the repository.
      // They are evidence, not application inputs; watching them can reload another
      // concurrent E2E page while it is interacting with an otherwise stable control.
      ignored: [
        "**/artifacts/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/src-tauri/target/**",
        "**/dist/**",
        "**/*.test.ts",
        "**/*.test.tsx"
      ]
    }
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Shared import/export codecs are cached independently from the app shell.
          if (id.replace(/\\/g, "/").includes("/src/infrastructure/xml/")) {
            return "xml-codec";
          }
          if (!id.includes("node_modules")) {
            return;
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/") ||
            id.includes("/zustand/")
          ) {
            return "vendor-react";
          }
          if (id.includes("/lucide-react/")) {
            return "vendor-icons";
          }
          return;
        }
      }
    }
  }
});
