export interface SourceMaterialName {
  stem: string;
  partKey: string | null;
  workKey: string;
}

/** Source-file association only. A Part number is never an episode or a TimeMap. */
export function parseSourceMaterialName(fileName: string): SourceMaterialName {
  const stem = fileName
    .normalize("NFKC")
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
  const parts = [...stem.matchAll(/(?<![a-z0-9])(?:part|pt|p)\s*(\d{1,4})(?![a-z0-9])/g)];
  const part = parts.length === 1 && Number(parts[0][1]) > 0 ? parts[0] : null;
  const partKey = part
    ? normalizeWords(
        stem.slice(0, part.index) +
          ` part${Number(part[1])} ` +
          stem.slice(part.index + part[0].length)
      )
    : null;
  const workKey = normalizeWords(
    stem
      .replace(/^\s*\d{1,4}\s*[-_.)、]\s*/, "")
      .replace(/\bs\d{1,3}\s*e\d{1,4}(?:\s*[-~—]\s*(?:s\d{1,3}\s*)?e?\d{1,4})?\b/gi, " ")
      .replace(/\be(?:p)?\s*\d{1,4}(?:\s*[-~—]\s*e?\d{1,4})?\b/gi, " ")
      .replace(/第?[零〇一二三四五六七八九十百两\d]+季/g, " ")
      .replace(
        /第?[零〇一二三四五六七八九十百两\d]+(?:[-~—至到][零〇一二三四五六七八九十百两\d]+)?[集话話]/g,
        " "
      )
      .replace(/(?<![a-z0-9])(?:part|pt|p)\s*\d{1,4}(?![a-z0-9])/g, " ")
      .replace(/^\d+(?:[._-]\d+)?$/, "")
  );
  return { stem, partKey, workKey };
}

export function matchSourceMaterialNames(
  left: SourceMaterialName,
  right: SourceMaterialName
): "exactStem" | "sourcePart" | null {
  if (left.stem && left.stem === right.stem) return "exactStem";
  if (left.partKey && left.partKey === right.partKey) return "sourcePart";
  return null;
}

export function sourceMaterialWorksConflict(
  left: SourceMaterialName,
  right: SourceMaterialName
): boolean {
  return Boolean(left.workKey && right.workKey && left.workKey !== right.workKey);
}

function normalizeWords(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
