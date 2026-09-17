import { collectExportMetadata } from "../../infrastructure/xml/xmlMediaMetadata";
import { recordPublicationDelivery } from "../../application/publicationDelivery";
import { useMemo, useState } from "react";
import { TextButton } from "../../components/TextButton";
import { buildFamilyArrangementExport } from "../../domain/project/familyArrangement";
import { requiresProjectionOnlyExport } from "../../domain/timeline/sourceProjection";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { downloadLegacyXmlFiles } from "../../infrastructure/file-system/exportFiles";
import {
  serializeBilibiliXml,
  validateExportedXml
} from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";

export function FamilyExportPanel() {
  const project = useEditorStore((state) => state.project);
  const go = useEditorStore((state) => state.setWorkspacePage);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const plan = useMemo(
    () =>
      project.familyArrangement
        ? buildFamilyArrangementExport(project, project.familyArrangement)
        : null,
    [project]
  );
  if (!plan) return null;
  const blockedByProjection = requiresProjectionOnlyExport(project);
  const errors = plan.issues.filter((issue) => issue.severity === "error");
  const selectedGroups = plan.groups.filter(
    (group) => group.exportable && !excluded.has(group.episodeKey)
  );
  const ready =
    !blockedByProjection &&
    !errors.some((error) => error.episodeKey === null) &&
    selectedGroups.length > 0;
  const exportFiles = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const files = selectedGroups.map((group) => {
        const index = plan.groups.indexOf(group);
        const content = serializeBilibiliXml(
          group.entries,
          collectExportMetadata(
            project.assets,
            project
              .familyArrangement!.rows.filter((r) => group.rowIds.includes(r.id))
              .map((r) => r.assetId),
            group.endMs
          )
        ).xml;
        const validation = validateExportedXml(content);
        if (!validation.ok) throw new Error(validation.message);
        return {
          fileName: createProjectDownloadFileName(
            `${project.name} - ${String(index + 1).padStart(2, "0")} - ${group.episodeLabel}`,
            ".xml"
          ),
          content
        };
      });
      const result = await downloadLegacyXmlFiles(files, {
        type: "application/xml;charset=utf-8",
        archiveFileName: createProjectDownloadFileName(project.name, "-分集.zip")
      });
      recordPublicationDelivery(project, "family", files);
      setMessage(
        `已导出 ${files.length} 个分集 XML。${"directoryPath" in result && result.directoryPath ? `保存位置：${result.directoryPath}` : "文件已交给下载管理器。"}`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="family-export" aria-label="分集安排导出">
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-content-primary">按你的安排导出分集</h2>
          <p className="mt-2">{plan.groups.length} 个输出 · 每个片段按已保存的窗口和起点排列</p>
        </div>
        <TextButton tone="primary" disabled={!ready || busy} onClick={() => void exportFiles()}>
          {busy ? "正在导出…" : `导出选中分集 XML（${selectedGroups.length}）`}
        </TextButton>
      </div>
      <p className="mt-3 text-xs text-content-muted">
        此输出使用分集安排、单条修正与全局偏移；时间线上的剪刀和锚点属于下方“当前弹幕时间线”输出。
      </p>
      {blockedByProjection ? (
        <p className="mt-3 text-feedback-warning">
          当前项目已经配置原片映射，请使用原片投影导出；分集安排不会替代已确认的内容映射。
        </p>
      ) : null}
      {errors.length ? (
        <div className="mt-3 text-feedback-warning">
          <p>还有 {errors.length} 处需要补充。已准备好的分集可以先导出。</p>
          <ul>
            {[...new Set(errors.map((error) => error.message))].map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="family-export-list">
        {plan.groups.map((group) => (
          <li key={group.episodeKey}>
            <label className="flex gap-3 items-center">
              <input
                type="checkbox"
                disabled={!group.exportable}
                checked={group.exportable && !excluded.has(group.episodeKey)}
                onChange={(event) =>
                  setExcluded((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.delete(group.episodeKey);
                    else next.add(group.episodeKey);
                    return next;
                  })
                }
              />
              {group.episodeLabel}
            </label>
            <span>
              {group.entries.length} 条 · {group.exportable ? "可输出" : "待补充"}
            </span>
          </li>
        ))}
      </ul>
      <TextButton onClick={() => go("materials")}>返回素材 · 修改分集安排</TextButton>
      {message ? (
        <p role="status" className="mt-3">
          {message}
        </p>
      ) : null}
    </section>
  );
}
