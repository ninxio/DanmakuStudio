/** Read-only, bounded metadata replay. Usage: vite-node scripts/check-media-family.ts <folder> [expected group count] */
import { readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createEmptyProject } from "../src/domain/project/factory";
import { parseBilibiliXml } from "../src/infrastructure/xml/bilibiliXml";
import { analyzeMediaFamily } from "../src/domain/project/mediaFamily";
import { createFamilyArrangement } from "../src/domain/project/familyArrangement";

const root = process.argv[2];
if (!root) throw new Error("请提供需要只读检查的 XML 文件夹。");
// This developer harness needs only DOMParser from the existing untyped jsdom dependency.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new () => { window: { DOMParser: typeof DOMParser } };
};
Object.defineProperty(globalThis, "DOMParser", { value: new JSDOM().window.DOMParser });
const project = createEmptyProject();
async function visit(directory: string, depth = 0): Promise<void> {
  if (depth > 12) throw new Error("目录层级超过检查上限。");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path, depth + 1);
    if (!entry.isFile() || !/\.xml$/i.test(entry.name)) continue;
    if (project.assets.length >= 5000) throw new Error("超过单次检查的 5000 个文件上限。");
    const file = await open(path, "r");
    let header: string;
    try {
      const buffer = Buffer.alloc(16384);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
    // Metadata only. No comment bodies or source edits enter this replay.
    const metadata = header.match(/<dbx:meta\b[^>]*(?:\/>|>[\s\S]*?<\/dbx:meta>)/)?.[0] ?? "";
    const asset = parseBilibiliXml(`<i>${metadata}</i>`, {
      fileName: entry.name,
      assetId: `a${project.assets.length}`
    });
    project.assets.push({ ...asset, sourcePath: path });
  }
}
await visit(root);
const started = performance.now();
const analysis = analyzeMediaFamily(project);
const elapsedMs = performance.now() - started;
const arrangement = createFamilyArrangement(analysis, "episodeParts");
const outputCount = new Set(arrangement.rows.map((row) => row.episodeKey)).size;
console.log(
  JSON.stringify(
    {
      files: analysis.files.length,
      sources: new Set(analysis.files.map((file) => file.sourceGroupKey)).size,
      recognized: analysis.files.filter((file) => file.episodeIdentity).length,
      outputCount,
      exactDurations: analysis.files.filter((file) => file.durationMs !== null).length,
      groups: analysis.groups.map((group) => ({
        label: group.episodeLabel,
        files: group.assetIds.length
      })),
      issues: Object.fromEntries(
        [...new Set(analysis.issues.map((issue) => issue.code))].map((code) => [
          code,
          analysis.issues.filter((issue) => issue.code === code).length
        ])
      ),
      elapsedMs: Math.round(elapsedMs * 100) / 100
    },
    null,
    2
  )
);
if (process.argv[3] && outputCount !== Number(process.argv[3]))
  throw new Error(`期望 ${process.argv[3]} 个输出，实际 ${outputCount}。`);
