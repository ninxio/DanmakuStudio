import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const portable = (path) => path.replaceAll("\\", "/");
const isProduction = (path) =>
  /\.[cm]?tsx?$/.test(path) &&
  !/(?:\.test\.|\.spec\.|\.d\.ts$|\/test\/|\/testHelpers\.|\/testSetup\.)/.test(path);

/** Uses the installed compiler and project resolution rules, including type-only edges. */
export function auditArchitecture(root = process.cwd()) {
  const configPath = resolve(root, "tsconfig.app.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
  const paths = parsed.fileNames.filter(
    (path) => portable(relative(root, path)).startsWith("src/") && isProduction(portable(path))
  );
  const known = new Set(paths.map((path) => portable(resolve(path))));
  const nodes = [];
  const violations = [];
  const edges = [];
  const resolutionCache = ts.createModuleResolutionCache(root, (path) => path, parsed.options);

  for (const path of paths) {
    const name = portable(relative(root, path));
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    nodes.push({ file: name, lines: source.text.split("\n").length });
    const visit = (node) => {
      let specifier;
      let typeOnly = false;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
        const clause = ts.isImportDeclaration(node) ? node.importClause : node;
        const bindings = ts.isImportDeclaration(node)
          ? clause?.namedBindings
          : node.exportClause;
        typeOnly = Boolean(
          clause?.isTypeOnly ||
          (!(ts.isImportDeclaration(node) && clause?.name) &&
            bindings &&
            (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((item) => item.isTypeOnly))
        );
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal;
        typeOnly = true;
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const imported = specifier.text;
        const resolution = ts.resolveModuleName(
          imported,
          path,
          parsed.options,
          ts.sys,
          resolutionCache
        ).resolvedModule;
        const resolved = resolution ? portable(resolve(resolution.resolvedFileName)) : null;
        const relativeTarget = resolved ? portable(relative(root, resolved)) : null;
        const target = relativeTarget?.startsWith("src/") ? relativeTarget : imported;
        const fromLayer = name.split("/")[1];
        const targetLayer = target.startsWith("src/") ? target.split("/")[1] : null;
        const prohibited = {
          domain: ["infrastructure", "application", "stores", "features", "components", "app"],
          infrastructure: ["application", "stores", "features", "components", "app"],
          application: ["stores", "features", "components", "app"],
          stores: ["features", "components", "app"]
        };
        const frameworkInCore =
          ["domain", "application"].includes(fromLayer) &&
          /^(?:react(?:-dom)?(?:\/|$)|zustand(?:\/|$))/.test(imported);
        const line = source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1;
        if (
          prohibited[fromLayer]?.includes(targetLayer) ||
          frameworkInCore ||
          (fromLayer === "domain" && imported.startsWith("@tauri-apps/")) ||
          (targetLayer && !isProduction(target))
        ) {
          violations.push({ file: name, line, target, typeOnly });
        }
        if (resolved && known.has(resolved)) edges.push({ from: name, to: target, typeOnly });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const graph = new Map(nodes.map(({ file }) => [file, new Set()]));
  for (const edge of edges) if (!edge.typeOnly) graph.get(edge.from).add(edge.to);
  const cycles = findCycles(graph);
  return {
    files: nodes.length,
    lines: nodes.reduce((sum, node) => sum + node.lines, 0),
    edges: edges.length,
    violations,
    cycles,
    largest: [...nodes].sort((a, b) => b.lines - a.lines).slice(0, 10),
    mostDependencies: [...graph]
      .map(([file, dependencies]) => ({ file, count: dependencies.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  };
}

function findCycles(graph) {
  let sequence = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  const cycles = [];
  const visit = (node) => {
    indices.set(node, sequence);
    low.set(node, sequence++);
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (active.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
    }
    if (low.get(node) !== indices.get(node)) return;
    const group = [];
    let current;
    do {
      current = stack.pop();
      active.delete(current);
      group.push(current);
    } while (current !== node);
    if (group.length > 1 || graph.get(node)?.has(node)) cycles.push(group.sort());
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditArchitecture();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `架构检查：${report.files} 个生产模块，${report.edges} 条依赖，${report.violations.length} 个反向依赖，${report.cycles.length} 组运行时循环。`
    );
    for (const finding of report.violations)
      console.error(`${finding.file}:${finding.line} -> ${finding.target}`);
    for (const cycle of report.cycles) console.error(`循环：${cycle.join(" <-> ")}`);
  }
  process.exitCode = report.violations.length > 0 || report.cycles.length > 0 ? 1 : 0;
}
