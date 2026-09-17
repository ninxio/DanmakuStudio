import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const fixtureDir = join(root, "fixtures", "bilibili");
mkdirSync(fixtureDir, { recursive: true });

function makeXml(count, name, spacingMs) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<i>"];
  for (let index = 0; index < count; index += 1) {
    const time = ((index * spacingMs) / 1000).toFixed(3);
    const mode = index % 11 === 0 ? 5 : index % 13 === 0 ? 4 : 1;
    const color = index % 5 === 0 ? 16711680 : index % 7 === 0 ? 65280 : 16777215;
    lines.push(
      `  <d p="${time},${mode},25,${color},1700000000,0,synthetic,row${index}">${name} ${index}</d>`
    );
  }
  lines.push("</i>", "");
  return lines.join("\n");
}

writeFileSync(join(fixtureDir, "large-10000.xml"), makeXml(10_000, "一万条合成弹幕", 120), "utf8");
writeFileSync(join(fixtureDir, "large-50000.xml"), makeXml(50_000, "五万条性能弹幕", 80), "utf8");
