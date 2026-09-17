import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const roots = ["src", "src-tauri/src", "tests", "scripts", "README.md"];
const ignoredDirectories = new Set(["node_modules", "dist", "target", "gen", ".git", "test-results"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".rs"]);
const typeScriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

const checks = [
  {
    name: "待办标记",
    pattern: new RegExp(`\\b(?:${["TO" + "DO", "FIX" + "ME"].join("|")})\\b|${"未" + "实现"}`, "g")
  }
];

const typeScriptChecks = [
  {
    name: "裸 any",
    // 排除成员访问形式的 any（expect.any、z.any 等匹配器）：TypeScript 的 any 类型
    // 永远不会紧跟点号，因此该收窄不会放过真正未说明的裸 any。
    pattern: /(?<!\.)\bany\b/g
  }
];

const findings = [];

for (const root of roots) {
  scanPath(root);
}

auditReleaseMetadata();

if (findings.length > 0) {
  console.error("源码审计发现需要复核的内容：");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}:${finding.column} [${finding.name}] ${finding.text}`);
  }
  process.exit(1);
}

console.log("源码审计通过：源码规则、CSP、许可证元数据与发行资源一致。");

function auditReleaseMetadata() {
  const expectedLicense = "GPL-3.0-only";
  const expectedDesktopBinary = "danmaku_timeline_studio";
  const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
  const tauriConfig = JSON.parse(readFileSync(join("src-tauri", "tauri.conf.json"), "utf8"));
  const cargoManifest = readFileSync(join("src-tauri", "Cargo.toml"), "utf8");
  const csp = tauriConfig.app?.security?.csp;
  const resources = tauriConfig.bundle?.resources;

  if (packageMetadata.license !== expectedLicense) {
    addReleaseFinding("package.json", "许可证元数据", `license 必须为 ${expectedLicense}`);
  }
  if (!new RegExp(`^license\\s*=\\s*"${expectedLicense}"$`, "m").test(cargoManifest)) {
    addReleaseFinding("src-tauri/Cargo.toml", "许可证元数据", `license 必须为 ${expectedLicense}`);
  }
  if (
    !new RegExp(`^default-run\\s*=\\s*"${expectedDesktopBinary}"$`, "m").test(cargoManifest)
  ) {
    addReleaseFinding(
      "src-tauri/Cargo.toml",
      "桌面发行目标",
      `default-run 必须固定为 ${expectedDesktopBinary}，不能把无界面辅助程序打进安装包`
    );
  }
  if (typeof csp !== "string" || !csp.includes("default-src 'self'")) {
    addReleaseFinding("src-tauri/tauri.conf.json", "内容安全策略", "发行配置必须启用 self-first CSP");
  }
  if (
    !resources ||
    resources["../LICENSE"] !== "LICENSE" ||
    resources["../THIRD_PARTY_NOTICES.md"] !== "THIRD_PARTY_NOTICES.md"
  ) {
    addReleaseFinding(
      "src-tauri/tauri.conf.json",
      "发行许可资源",
      "安装包必须携带 LICENSE 与 THIRD_PARTY_NOTICES.md"
    );
  }
  for (const requiredFile of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    if (!existsSync(requiredFile)) {
      addReleaseFinding(requiredFile, "发行许可资源", "必需文件不存在");
    }
  }
}

function addReleaseFinding(file, name, text) {
  findings.push({ file, line: 1, column: 1, name, text });
}

function scanPath(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    const name = path.split(/[\\/]/).at(-1) ?? path;
    if (ignoredDirectories.has(name)) {
      return;
    }
    for (const entry of readdirSync(path)) {
      scanPath(join(path, entry));
    }
    return;
  }
  if (!stats.isFile() || !shouldScanFile(path)) {
    return;
  }
  scanFile(path);
}

function shouldScanFile(path) {
  if (path.includes(`${join("src-tauri", "gen")}${separatorFor(path)}`)) {
    return false;
  }
  const extension = extname(path);
  return textExtensions.has(extension);
}

function separatorFor(path) {
  return path.includes("\\") ? "\\" : "/";
}

function scanFile(path) {
  const text = readFileSync(path, "utf8");
  const activeChecks = typeScriptExtensions.has(extname(path)) ? [...checks, ...typeScriptChecks] : checks;
  for (const check of activeChecks) {
    for (const match of text.matchAll(check.pattern)) {
      const position = positionForOffset(text, match.index ?? 0);
      findings.push({
        file: relative(process.cwd(), path),
        line: position.line,
        column: position.column,
        name: check.name,
        text: lineAt(text, position.line).trim()
      });
    }
  }
}

function positionForOffset(text, offset) {
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1
  };
}

function lineAt(text, lineNumber) {
  return text.split(/\r?\n/)[lineNumber - 1] ?? "";
}
