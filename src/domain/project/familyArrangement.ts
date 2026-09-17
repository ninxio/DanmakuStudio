import type { EditorProject } from "./types";
import type {
  FamilyArrangement,
  FamilyArrangementRow,
  FamilyArrangementExport,
  FamilyWorkflowIntent,
  MediaFamilyAnalysis,
  MediaFamilyContext
} from "./mediaFamilyTypes";
import { resolveFamilyDurations } from "./familyPlayback";

/** Presets only create editable rows; none creates a verification or guesses content boundaries. */
export function createFamilyArrangement(
  analysis: MediaFamilyAnalysis,
  workflow: FamilyWorkflowIntent = analysis.hypotheses[0]?.kind ?? "unknown"
): FamilyArrangement {
  const groupByAsset = new Map(
    analysis.groups.flatMap((group) => group.assetIds.map((id) => [id, group] as const))
  );
  const uncertain = new Set(
    analysis.issues
      .filter((issue) =>
        ["duplicatePart", "conflictingIdentity", "parallelVersions"].includes(issue.code)
      )
      .flatMap((issue) => issue.assetIds)
  );
  return {
    version: 1,
    title: analysis.suggestedTitle ?? analysis.titleCandidates[0]?.title ?? "弹幕项目",
    workflow,
    rows: analysis.files.map((file, index) => {
      const group = groupByAsset.get(file.assetId);
      const key = uncertain.has(file.assetId)
        ? `file:${file.assetId}`
        : workflow === "movieParts"
          ? `${file.sourceGroupKey}::movie`
          : workflow === "episodes"
            ? `file:${file.assetId}`
            : group?.episodeKey
              ? group.key
              : `file:${file.assetId}`;
      return {
        id: `family:${file.assetId}:${index}`,
        assetId: file.assetId,
        episodeKey: key,
        episodeLabel:
          workflow === "movieParts"
            ? "正片"
            : workflow === "episodes"
              ? file.episodeIdentity
                ? (group?.episodeLabel ?? file.fileName)
                : file.fileName.replace(/\.xml$/i, "")
              : group?.episodeLabel === "未确定集号"
                ? file.fileName.replace(/\.xml$/i, "")
                : (group?.episodeLabel ?? file.fileName),
        sourceInMs: 0,
        sourceOutMs: file.durationMs,
        targetStartMs: null,
        enabled: true
      };
    })
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function ms(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function label(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096;
}
export function isFamilyArrangement(value: unknown): value is FamilyArrangement {
  if (
    !record(value) ||
    value.version !== 1 ||
    !label(value.title) ||
    !["movieParts", "episodes", "episodeParts", "longCollection", "unknown"].includes(
      String(value.workflow)
    ) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 20000
  )
    return false;
  const ids = new Set<string>();
  return value.rows.every((row) => {
    if (
      !record(row) ||
      !label(row.id) ||
      !row.id ||
      ids.has(row.id) ||
      !label(row.assetId) ||
      !row.assetId ||
      !(row.episodeKey === null || label(row.episodeKey)) ||
      !label(row.episodeLabel) ||
      !ms(row.sourceInMs) ||
      !(
        row.sourceOutMs === null ||
        (ms(row.sourceOutMs) && row.sourceOutMs > row.sourceInMs)
      ) ||
      !(row.targetStartMs === null || ms(row.targetStartMs)) ||
      typeof row.enabled !== "boolean"
    )
      return false;
    ids.add(row.id);
    return true;
  });
}

/** Half-open source windows. Unknown prior ends require an explicit next target position. */
export function buildFamilyArrangementExport(
  project: Pick<
    EditorProject,
    | "assets"
    | "mediaLibrary"
    | "danmakuSourceBindings"
    | "disabledItemIds"
    | "itemTimeAdjustments"
    | "globalOffsetMs"
  >,
  arrangement: FamilyArrangement,
  context: MediaFamilyContext = {}
): FamilyArrangementExport {
  const result: FamilyArrangementExport = { issues: [], groups: [] };
  if (!isFamilyArrangement(arrangement))
    return {
      groups: [],
      issues: [
        {
          code: "invalidArrangement",
          severity: "error",
          message: "安排包含无效时间、重复行或缺失字段。",
          rowId: null,
          episodeKey: null
        }
      ]
    };
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const durations = resolveFamilyDurations(project, context);
  const disabled = new Set(project.disabledItemIds);
  const grouped = new Map<string, FamilyArrangementRow[]>();
  for (const row of arrangement.rows.filter((row) => row.enabled)) {
    const key = row.episodeKey || `unassigned:${row.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const included = new Set(arrangement.rows.map((row) => row.assetId));
  const unassigned = project.assets.filter((asset) => !included.has(asset.id));
  if (unassigned.length)
    result.issues.push({
      code: "newAssets",
      severity: "error",
      message: `还有 ${unassigned.length} 个新文件没有加入安排；请追加或明确排除。`,
      rowId: null,
      episodeKey: null
    });
  for (const [episodeKey, rows] of grouped) {
    const group: FamilyArrangementExport["groups"][number] = {
      episodeKey,
      episodeLabel: rows[0].episodeLabel,
      rowIds: rows.map((row) => row.id),
      entries: [],
      exportable: true,
      endMs: 0
    };
    const issue = (
      row: FamilyArrangementRow,
      code: string,
      message: string,
      severity: "error" | "warning" = "error"
    ) => {
      result.issues.push({ code, severity, message, rowId: row.id, episodeKey });
      if (severity === "error") group.exportable = false;
    };
    let cursor: number | null = 0;
    let maxEnd = 0;
    let unknownTail = false;
    const used = new Map<string, Array<[number, number]>>();
    for (const row of rows) {
      const asset = assets.get(row.assetId);
      if (!asset) {
        issue(row, "missingAsset", "来源文件已移除，请删除该安排或重新导入。");
        continue;
      }
      if (!row.episodeKey || !row.episodeLabel.trim())
        issue(row, "missingEpisode", "请填写输出名称。");
      const out = row.sourceOutMs ?? durations.get(row.assetId)?.durationMs ?? null;
      if (out === null) unknownTail = true;
      const start: number | null = row.targetStartMs ?? cursor;
      if (out !== null && out <= row.sourceInMs) {
        issue(row, "emptyWindow", "结束时间必须晚于开始时间。");
        continue;
      }
      if (start === null) {
        issue(
          row,
          "unknownPreviousEnd",
          "前一片段没有准确结束时间；填写它的结束时间，或明确指定本段的输出起点。"
        );
        cursor = null;
        continue;
      }
      const end: number | null = out === null ? null : start + out - row.sourceInMs;
      if (end !== null && !Number.isSafeInteger(end)) {
        issue(row, "overflow", "输出时间超出支持范围。");
        continue;
      }
      const ranges = used.get(asset.id) ?? [];
      if (ranges.some(([from, to]) => row.sourceInMs < to && (out ?? Infinity) > from))
        issue(
          row,
          "repeatedWindow",
          "同一文件的窗口在本输出中重叠，请确认是否需要重复弹幕。",
          "warning"
        );
      used.set(asset.id, [...ranges, [row.sourceInMs, out ?? Infinity]]);
      for (const item of asset.items) {
        if (
          !item.enabled ||
          disabled.has(item.id) ||
          item.sourceTimeMs < row.sourceInMs ||
          (out !== null && item.sourceTimeMs >= out)
        )
          continue;
        const finalTimeMs =
          start +
          item.sourceTimeMs -
          row.sourceInMs +
          project.globalOffsetMs +
          (project.itemTimeAdjustments[item.id] ?? 0);
        if (!Number.isSafeInteger(finalTimeMs) || finalTimeMs < 0) {
          issue(row, "invalidItemTime", "偏移使部分弹幕早于零点或超出范围，请调整后导出。");
          break;
        }
        group.entries.push({ item, finalTimeMs, rowId: row.id });
      }
      cursor = end;
      if (end !== null) maxEnd = Math.max(maxEnd, end);
    }
    group.endMs = unknownTail ? null : maxEnd;
    if (group.entries.length === 0)
      result.issues.push({
        code: "emptyOutput",
        severity: "warning",
        message: `${group.episodeLabel} 没有启用的弹幕。`,
        rowId: null,
        episodeKey
      });
    result.groups.push(group);
  }
  return result;
}
