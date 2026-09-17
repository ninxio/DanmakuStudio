import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "**/target",
      "**/target-*",
      "node_modules",
      ".release-export/**",
      "integrations/motrix/**",
      "src-tauri/src/source_browser_bridge.js",
      "artifacts",
      "ml/data",
      "ml/output",
      "test-results",
      "playwright-report",
      "*.config.js",
      "scripts/*.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.app.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    files: ["public/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { project: false }, globals: { localStorage: "readonly", matchMedia: "readonly", document: "readonly" } }
  },
  prettier
);
