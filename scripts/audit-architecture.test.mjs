import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { auditArchitecture } from "./audit-architecture.mjs";

function fixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), "danmaku-architecture-"));
  try {
    const config = {
      compilerOptions: {
        moduleResolution: "Bundler",
        module: "ESNext",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] }
      },
      include: ["src"]
    };
    for (const [file, text] of Object.entries({
      "tsconfig.app.json": JSON.stringify(config),
      ...files
    })) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    run(auditArchitecture(root));
  } finally {
    // root is the exact newly created temporary directory, never caller input.
    rmSync(root, { recursive: true });
  }
}

test("rejects reverse type imports, alias re-exports and dynamic dependencies, ignoring comments and test files", () => {
  fixture(
    {
      "src/stores/store.ts": "export interface State {}\nexport const state = 1;",
      "src/domain/model.ts":
        'import type { State } from "../stores/store";\nexport { state } from "@/stores/store";\nconst load = () => import("../stores/store");\n// import { thing } from "react"\nconst description = "import fake";',
      "src/domain/model.test.ts": 'import { state } from "../stores/store";'
    },
    (report) => {
      assert.equal(report.files, 2);
      assert.equal(report.violations.length, 3);
      assert.deepEqual(
        report.violations.map((item) => item.typeOnly),
        [true, false, false]
      );
    }
  );
});

test("detects runtime cycles without rejecting type-only recursion", () => {
  fixture(
    {
      "src/domain/a.ts":
        'import { value } from "./b"; export interface Shape {} export const a = value;',
      "src/domain/b.ts": 'import type { Shape } from "./a"; export const value = 1;'
    },
    (report) => assert.deepEqual(report.cycles, [])
  );
  fixture(
    {
      "src/domain/a.ts": 'export { value } from "./b";',
      "src/domain/b.ts": 'export { value } from "./a";'
    },
    (report) => assert.deepEqual(report.cycles, [["src/domain/a.ts", "src/domain/b.ts"]])
  );
});

test("a default import remains a runtime edge beside named type imports", () => {
  fixture(
    {
      "src/domain/a.ts": 'import value, { type Shape } from "./b"; export default value;',
      "src/domain/b.ts":
        'import value from "./a"; export interface Shape {} export default value;'
    },
    (report) => assert.equal(report.cycles.length, 1)
  );
});

test("production cannot hide an upward dependency inside an excluded test file", () => {
  fixture(
    {
      "src/domain/model.ts": 'import { state } from "../stores/store.test";',
      "src/stores/store.test.ts": "export const state = 1;"
    },
    (report) => assert.equal(report.violations.length, 1)
  );
});
