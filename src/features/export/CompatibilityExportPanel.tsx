import { Button } from "../../components/Button";
import { ToolSheet } from "../../components/ToolSheet";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { TextButton } from "../../components/TextButton";
import { buildBatchMergePlan } from "../../domain/danmaku/batchMerge";
import { createProjectHealthSummary } from "../../domain/project/health";
import { formatMediaBindingTitle } from "../../domain/project/mediaBinding";
import { createProjectReadinessSummary } from "../../domain/project/readiness";
import { createSeasonWorkbenchSummary } from "../../domain/project/seasonWorkbench";
import { isXmlOnlyProject } from "../../domain/project/workflowMode";
import { requiresProjectionOnlyExport } from "../../domain/timeline/sourceProjection";
import { useEditorStore } from "../../stores/editorStore";
import { EmptyState, Row } from "../assets/assetPanelShared";
import { setStatus } from "../assets/assetPanelSharedLogic";
import { ExportReadinessPanel } from "./ExportReadinessPanel";
import {
  BatchMergeSummary,
  EmbyMetadataPanel,
  ManualRulePanel,
  SeasonEpisodeBindingPanel,
  SeasonWorkbenchPanel
} from "./legacyBatchExport";
import {
  createBatchMergeOptions,
  type LongSplitMode,
  type PartWindowMode
} from "./legacyBatchExportOptions";
import { exportBatchMergePlan } from "./legacyBatchExportService";
import { useEmbyMetadataController } from "./useEmbyMetadataController";

export function CompatibilityExportPanel({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [legacyExportOpen, setLegacyExportOpen] = useState(false);
  const [partWindowMode, setPartWindowMode] = useState<PartWindowMode>("full");
  const [partWindowMinutes, setPartWindowMinutes] = useState("9");
  const [partRangeStartMinutes, setPartRangeStartMinutes] = useState("0");
  const [partRangeEndMinutes, setPartRangeEndMinutes] = useState("9");
  const [longSplitMode, setLongSplitMode] = useState<LongSplitMode>("auto");
  const [episodeDurationsText, setEpisodeDurationsText] = useState("");
  const [cutPointsText, setCutPointsText] = useState("");
  const emby = useEmbyMetadataController((lines) => {
    setEpisodeDurationsText(lines);
    setLongSplitMode("durations");
    setStatus({
      message: "已把 Emby 剧集时长导入批量整理规则。",
      tone: "success"
    });
  });
  const project = useEditorStore((state) => state.project);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const bindCurrentTargetToSeasonEpisode = useEditorStore(
    (state) => state.bindCurrentTargetToSeasonEpisode
  );
  const clearSeasonEpisodeBinding = useEditorStore((state) => state.clearSeasonEpisodeBinding);
  const cleanupProjectEditReferences = useEditorStore(
    (state) => state.cleanupProjectEditReferences
  );
  const cleanupProjectMissingAssetClips = useEditorStore(
    (state) => state.cleanupProjectMissingAssetClips
  );
  const prepareExport = useEditorStore((state) => state.prepareExport);
  const manualRules = useMemo(
    () =>
      createBatchMergeOptions({
        partWindowMode,
        partWindowMinutes,
        partRangeStartMinutes,
        partRangeEndMinutes,
        longSplitMode,
        episodeDurationsText,
        cutPointsText
      }),
    [
      partWindowMode,
      partWindowMinutes,
      partRangeStartMinutes,
      partRangeEndMinutes,
      longSplitMode,
      episodeDurationsText,
      cutPointsText
    ]
  );
  const batchMergeOptions = useMemo(
    () => ({
      ...manualRules.options,
      cutMarkers: project.cutMarkers
    }),
    [manualRules.options, project.cutMarkers]
  );
  const batchMergePlan = useMemo(
    () => buildBatchMergePlan(project.assets, batchMergeOptions),
    [batchMergeOptions, project.assets]
  );
  const seasonWorkbench = useMemo(
    () => createSeasonWorkbenchSummary(project, batchMergePlan, manualRules.warnings),
    [batchMergePlan, manualRules.warnings, project]
  );
  const projectHealth = useMemo(() => createProjectHealthSummary(project), [project]);
  const projectReadiness = useMemo(() => createProjectReadinessSummary(project), [project]);
  const projectionOnlyExport = requiresProjectionOnlyExport(project);
  const xmlOnlyWorkflow = isXmlOnlyProject(project);

  return (
    <ToolSheet title="单文件导出与高级检查" open={open} onClose={onClose} wide>
      <div className="grid gap-3">
        <div className="mt-2">
          {!xmlOnlyWorkflow ? (
            <ExportReadinessPanel
              projectName={project.name}
              reportSummary={projectHealth}
              readiness={projectReadiness}
              onCleanupEditReferences={cleanupProjectEditReferences}
              onCleanupMissingAssetClips={cleanupProjectMissingAssetClips}
            />
          ) : null}
          <p className="leading-5 text-content-muted">
            {xmlOnlyWorkflow
              ? "需要按文件名整理多份分 P XML 时，可在这里使用传统批量规则。普通单文件导出直接使用上方主按钮。"
              : "以下为单文件或传统分 P 合并导出，不依赖来源段投影。多集场景请优先使用上方「按原片分集导出」。"}
          </p>
          {projectionOnlyExport ? (
            <p className="mt-2 rounded border border-accent-red/30 bg-accent-red/10 p-2 leading-5 text-accent-red">
              当前项目已包含目标原片或时间映射。为避免导出错位
              XML，只可使用上方「按原片分集导出」。
            </p>
          ) : null}
        </div>
        {!xmlOnlyWorkflow ? (
          <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
            <h3 className="text-sm font-medium text-content-primary">
              导出当前编辑时间轴（单文件）
            </h3>
            <p className="mt-2 leading-5 text-content-muted">
              把编辑页时间轴上的全部弹幕（含全局偏移、版本差异、单条调整）合并导出为一个
              XML。适合单集修正场景。
            </p>
            <div className="mt-3">
              <TextButton
                tone="primary"
                onClick={prepareExport}
                disabled={projectionOnlyExport || project.clips.length === 0}
                title={
                  projectionOnlyExport
                    ? "当前项目必须通过已确认时间图按原片分集导出。"
                    : project.clips.length === 0
                      ? "编辑页时间轴上还没有弹幕片段。"
                      : "预览并导出单个 XML"
                }
              >
                <Download size={14} />
                预览并导出单个 XML
              </TextButton>
            </div>
          </section>
        ) : null}
        <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
          <Button
            tone="unstyled"
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left"
            aria-expanded={legacyExportOpen}
            disabled={projectionOnlyExport}
            onClick={() => {
              if (!projectionOnlyExport) {
                setLegacyExportOpen((open) => !open);
              }
            }}
          >
            <span>
              <span className="block text-sm font-medium text-content-primary">
                按文件名分 P 合并导出（传统方式）
              </span>
              <span className="mt-1 block leading-5 text-content-muted">
                不依赖来源段，按 XML 文件名识别集数并切分合并。适合命名规范的分 P 弹幕。
              </span>
            </span>
            <span className="shrink-0 rounded border border-panel-line px-2 py-1 text-ui-caption text-content-secondary">
              {legacyExportOpen ? "收起" : "展开"}
            </span>
          </Button>
          {legacyExportOpen && !projectionOnlyExport ? (
            <div className="mt-3 grid gap-3">
              {project.assets.length > 0 ? (
                <>
                  <EmbyMetadataPanel controller={emby} />
                  <ManualRulePanel
                    partWindowMode={partWindowMode}
                    partWindowMinutes={partWindowMinutes}
                    partRangeStartMinutes={partRangeStartMinutes}
                    partRangeEndMinutes={partRangeEndMinutes}
                    longSplitMode={longSplitMode}
                    episodeDurationsText={episodeDurationsText}
                    cutPointsText={cutPointsText}
                    warnings={manualRules.warnings}
                    onPartWindowModeChange={setPartWindowMode}
                    onPartWindowMinutesChange={setPartWindowMinutes}
                    onPartRangeStartMinutesChange={setPartRangeStartMinutes}
                    onPartRangeEndMinutesChange={setPartRangeEndMinutes}
                    onLongSplitModeChange={setLongSplitMode}
                    onEpisodeDurationsTextChange={setEpisodeDurationsText}
                    onCutPointsTextChange={setCutPointsText}
                  />
                  <SeasonWorkbenchPanel summary={seasonWorkbench} />
                  <SeasonEpisodeBindingPanel
                    plan={batchMergePlan}
                    bindings={project.seasonEpisodeBindings}
                    currentBinding={project.mediaBinding}
                    onBindCurrent={(episodeKey, episodeLabel) =>
                      bindCurrentTargetToSeasonEpisode(episodeKey, episodeLabel)
                    }
                    onClear={clearSeasonEpisodeBinding}
                    onOpenMediaTab={() => setWorkspacePage("materials")}
                  />
                  <BatchMergeSummary plan={batchMergePlan} warnings={manualRules.warnings} />
                  <div className="flex justify-end">
                    <TextButton
                      tone="primary"
                      onClick={() => void exportBatchMergePlan(batchMergePlan, project)}
                      disabled={batchMergePlan.episodes.length === 0}
                      title="按当前批量规则导出多个分集 XML"
                    >
                      <Download size={14} />
                      导出分集 XML
                    </TextButton>
                  </div>
                </>
              ) : (
                <EmptyState title="先导入 XML" text="分 P 合并导出基于已导入的弹幕素材。" />
              )}
            </div>
          ) : null}
        </section>
        <div className="rounded border border-panel-line bg-panel-soft p-3">
          <h3 className="mb-2 text-sm font-medium text-content-primary">{project.name}</h3>
          <Row label="资源数" value={project.assets.length.toString()} />
          <Row label="片段数" value={project.clips.length.toString()} />
          <Row label="版本差异" value={project.cutMarkers.length.toString()} />
          <Row label="同步线索" value={project.syncAnchors.length.toString()} />
          <Row label="禁用弹幕" value={project.disabledItemIds.length.toString()} />
          <Row label="目标原片" value={formatMediaBindingTitle(project.mediaBinding)} />
          <Row label="全局偏移" value={`${project.globalOffsetMs} ms`} />
          <Row label="创建时间" value={new Date(project.createdAt).toLocaleString("zh-CN")} />
          <Row label="更新时间" value={new Date(project.updatedAt).toLocaleString("zh-CN")} />
        </div>
      </div>
    </ToolSheet>
  );
}
