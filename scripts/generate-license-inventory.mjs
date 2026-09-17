import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const checkOnly = process.argv.includes("--check");
const outputPath = resolve("THIRD_PARTY_NOTICES.md");
const npmPackages = collectNpmProductionPackages();
const cargoPackages = collectCargoRegistryPackages();
const markdown = renderInventory(npmPackages, cargoPackages);

if (checkOnly) {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== markdown) {
    console.error("第三方许可证清单不是最新结果；请运行 corepack pnpm licenses:generate。");
    process.exit(1);
  }
  console.log(`许可证清单通过：npm ${npmPackages.length} 项，Cargo ${cargoPackages.length} 项。`);
} else {
  writeFileSync(outputPath, markdown, "utf8");
  console.log(`已生成 THIRD_PARTY_NOTICES.md：npm ${npmPackages.length} 项，Cargo ${cargoPackages.length} 项。`);
}

function collectNpmProductionPackages() {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const pending = Object.keys(root.dependencies ?? {}).map((name) => ({ name, from: resolve("package.json") }));
  const visited = new Map();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const packageJsonPath = resolveNodePackageJson(current.name, dirname(current.from));
    const packageRoot = dirname(packageJsonPath);
    const realRoot = realpathSync(packageRoot);
    if (visited.has(realRoot)) continue;
    const realPackageJsonPath = join(realRoot, "package.json");
    const metadata = JSON.parse(readFileSync(realPackageJsonPath, "utf8"));
    const license = normalizeLicense(metadata.license, `npm ${metadata.name}@${metadata.version}`);
    visited.set(realRoot, {
      name: String(metadata.name),
      version: String(metadata.version),
      license,
      homepage: normalizeRepository(metadata.repository, metadata.homepage)
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      pending.push({ name: dependency, from: realPackageJsonPath });
    }
  }
  return [...visited.values()].sort(comparePackages);
}

function resolveNodePackageJson(name, startDirectory) {
  let current = startDirectory;
  while (true) {
    const candidate = join(current, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rootCandidate = resolve("node_modules", name, "package.json");
  if (existsSync(rootCandidate)) return rootCandidate;
  throw new Error(`无法解析生产 npm 依赖：${name}`);
}

function collectCargoRegistryPackages() {
  const lock = readFileSync(join("src-tauri", "Cargo.lock"), "utf8");
  const packages = parseCargoLock(lock).filter((item) => item.source?.startsWith("registry+"));
  const registryRoot = join(homedir(), ".cargo", "registry", "src");
  const registries = existsSync(registryRoot)
    ? readdirSync(registryRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(registryRoot, entry.name))
    : [];
  const result = packages.flatMap((item) => {
    const directoryName = `${item.name}-${item.version}`;
    const sourceRoot = registries
      .map((registry) => join(registry, directoryName))
      .find((candidate) => existsSync(join(candidate, "Cargo.toml")));
    if (!sourceRoot) {
      throw new Error(`${directoryName} 的许可源文件尚未获取；请先运行 cargo fetch --manifest-path src-tauri/Cargo.toml --locked。`);
    }
    const manifest = readFileSync(join(sourceRoot, "Cargo.toml"), "utf8");
    const packageSection = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
    const license = packageSection.match(/^license\s*=\s*"([^"]+)"/m)?.[1];
    const licenseFile = packageSection.match(/^license-file\s*=\s*"([^"]+)"/m)?.[1];
    const homepage =
      packageSection.match(/^repository\s*=\s*"([^"]+)"/m)?.[1] ??
      packageSection.match(/^homepage\s*=\s*"([^"]+)"/m)?.[1] ??
      "";
    return {
      name: item.name,
      version: item.version,
      license: normalizeLicense(license ?? (licenseFile ? `LicenseRef-file:${licenseFile}` : null), directoryName),
      homepage
    };
  });
  return uniquePackages(result).sort(comparePackages);
}

function parseCargoLock(text) {
  return text
    .split("[[package]]")
    .slice(1)
    .map((block) => ({
      name: block.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "",
      version: block.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "",
      source: block.match(/^source\s*=\s*"([^"]+)"/m)?.[1] ?? null
    }))
    .filter((item) => item.name && item.version);
}

function normalizeLicense(value, label) {
  const license =
    typeof value === "string"
      ? value.trim()
      : value && typeof value === "object" && typeof value.type === "string"
        ? value.type.trim()
        : "";
  if (!license || /^(UNLICENSED|SEE LICENSE IN)$/i.test(license)) {
    throw new Error(`${label} 缺少可审计许可证表达式。`);
  }
  return license;
}

function normalizeRepository(repository, homepage) {
  if (typeof repository === "string") return normalizeProjectUrl(repository);
  if (repository && typeof repository.url === "string") {
    return normalizeProjectUrl(repository.url);
  }
  return typeof homepage === "string" ? normalizeProjectUrl(homepage) : "";
}

function normalizeProjectUrl(value) {
  const cleaned = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(cleaned)) return `https://github.com/${cleaned}`;
  return cleaned;
}

function uniquePackages(packages) {
  return [
    ...new Map(packages.map((item) => [`${item.name}\u0000${item.version}\u0000${item.license}`, item])).values()
  ];
}

function comparePackages(left, right) {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}

function renderInventory(npm, cargo) {
  const lines = [
    "# Third-Party Notices",
    "",
    "This file is generated from the production npm dependency graph and the locally resolved Cargo registry sources referenced by `src-tauri/Cargo.lock` for the verified Windows build environment.",
    "It is an inventory, not a replacement for the license texts shipped by each dependency.",
    "Danmaku Studio itself is licensed under `GPL-3.0-only`; see `LICENSE`.",
    "",
    "## Adapted source: DanmakuBox",
    "",
    "Bilibili acquisition is adapted from DanmakuBox_Re (`src-tauri/src/bilibili.rs`). Its MIT license follows in full; the original source directory remains unchanged.",
    "",
    readFileSync("docs/licenses/DanmakuBox-MIT.txt", "utf8").trim(),
    "",
    "A bundled FFmpeg, FFprobe, libmpv, model weight, plugin, or other optional runtime must add its exact build identity and complete license materials before release. None is implied by this inventory.",
    "",
    "## Production npm packages",
    "",
    "| Package | Version | License | Project |",
    "| --- | --- | --- | --- |",
    ...npm.map(tableRow),
    "",
    "## Cargo registry packages",
    "",
    "| Crate | Version | License | Project |",
    "| --- | --- | --- | --- |",
    ...cargo.map(tableRow)
  ];
  return `${lines.join("\n")}\n`;
}

function tableRow(item) {
  const project = item.homepage ? `[link](${escapeCell(item.homepage)})` : "—";
  return `| ${escapeCell(item.name)} | ${escapeCell(item.version)} | ${escapeCell(item.license)} | ${project} |`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}
