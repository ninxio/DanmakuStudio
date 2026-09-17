import { ToolSheet } from "../../components/ToolSheet";
import { Button } from "../../components/Button";
import { ArrowRight, Clock3, Link2, Play, SplitSquareHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { Field } from "../../components/Field";
import { TextButton } from "../../components/TextButton";
import { createId } from "../../domain/project/factory";
import { parseSourceTimecode } from "../../domain/project/sourceTimeline";
import { isXmlOnlyProject } from "../../domain/project/workflowMode";
import { formatTimecode } from "../../domain/shared/time";
import { useEditorStore } from "../../stores/editorStore";

type RepairMode = "sync" | "difference" | null;

export function CalibrationOverview({
  sheet
}: { sheet?: { open: boolean; onClose: () => void } } = {}) {
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const startXmlEditing = useEditorStore((state) => state.startXmlEditing);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const updatePreview = useEditorStore((state) => state.updatePreview);
  const setGlobalOffset = useEditorStore((state) => state.setGlobalOffset);
  const addSyncAnchor = useEditorStore((state) => state.addSyncAnchor);
  const updateSyncAnchor = useEditorStore((state) => state.updateSyncAnchor);
  const deleteSyncAnchor = useEditorStore((state) => state.deleteSyncAnchor);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const addCutMarker = useEditorStore((state) => state.addCutMarker);
  const [repairMode, setRepairMode] = useState<RepairMode>(null);
  const [targetTimeText, setTargetTimeText] = useState(() =>
    formatTimecode(project.timeline.playheadMs)
  );
  const [differenceSeconds, setDifferenceSeconds] = useState("45");
  const sortedSyncAnchors = [...project.syncAnchors].sort(
    (left, right) => left.sourceMs - right.sourceMs || left.id.localeCompare(right.id)
  );

  const issueCount =
    (project.clips.length === 0 && project.assets.length > 0 ? 1 : 0) +
    project.cutMarkers.length;
  const selectedLabel =
    selection.kind === "none"
      ? "未选择对象"
      : selection.kind === "clip"
        ? `已选择 ${selection.ids.length} 个弹幕片段`
        : selection.kind === "danmaku"
          ? `已选择 ${selection.ids.length} 条弹幕`
          : selection.kind === "cut"
            ? `已选择 ${selection.ids.length} 个版本差异`
            : `已选择 ${selection.ids.length} 个同步点`;
  const primaryAction =
    project.assets.length === 0
      ? {
          label: "先添加弹幕素材",
          run: () => setWorkspacePage("materials")
        }
      : project.clips.length === 0
        ? {
            label: isXmlOnlyProject(project) ? "开始编辑弹幕" : "自动排列弹幕",
            run: isXmlOnlyProject(project) ? startXmlEditing : autoArrangeClips
          }
        : {
            label: isPlaying ? "暂停检查" : "播放检查",
            run: togglePlayback
          };

  const openRepair = (mode: Exclude<RepairMode, null>) => {
    if (mode === "sync") {
      setTargetTimeText(formatTimecode(project.timeline.playheadMs));
    }
    setRepairMode(mode);
  };

  const saveSyncPoint = () => {
    const targetMs = parseSourceTimecode(targetTimeText);
    if (targetMs === null) {
      setEditorStatus("原片时间格式无效，请使用 00:00:00.000。", "warning");
      return;
    }
    addSyncAnchor({
      id: createId("sync_anchor"),
      sourceMs: project.timeline.playheadMs,
      targetMs,
      origin: "manual"
    });
    setEditorStatus("已添加同步点；弹幕和原始素材保持不变，可随时撤销。", "success");
    setRepairMode(null);
  };

  const saveDifference = () => {
    const seconds = Number(differenceSeconds);
    if (!Number.isFinite(seconds) || seconds === 0) {
      setEditorStatus("请输入非零差异秒数；负数表示之后的弹幕提前。", "warning");
      return;
    }
    const targetGapMs = Math.round(seconds * 1000);
    addCutMarker(project.timeline.playheadMs, targetGapMs, {
      name: `版本差异 ${project.cutMarkers.length + 1}`,
      note: "由校准页常用修复添加。"
    });
    setEditorStatus("已标记版本差异；只调整后续弹幕映射，不修改视频或原始 XML。", "success");
    setRepairMode(null);
  };

  const content = (
    <section
      className="shrink-0 border-b border-panel-line bg-surface-inset px-3 py-2.5 text-xs"
      data-testid="calibration-overview"
      aria-label="校准摘要"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Clock3 size={15} className="text-accent-cyan" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-semibold text-content-primary">试听并校准时间关系</h2>
            <span className="text-ui-caption text-content-subtle">
              {issueCount > 0 ? `${issueCount} 项需要留意` : "可以从开头、中段和结尾抽查"}
            </span>
          </div>
          <p className="mt-1 truncate text-ui-caption text-content-muted">
            {selectedLabel} · 播放头 {formatTimecode(project.timeline.playheadMs)} · 整体偏移{" "}
            {formatSignedMilliseconds(project.globalOffsetMs)}
          </p>
        </div>
        <TextButton tone="primary" onClick={primaryAction.run}>
          {primaryAction.label === "播放检查" ? <Play size={13} /> : null}
          {primaryAction.label}
          <ArrowRight size={13} />
        </TextButton>
      </div>
      <details className="mt-2 rounded-md border border-panel-line/70 bg-surface-inset px-2 py-1.5">
        <summary className="cursor-pointer text-ui-caption font-medium text-content-muted">
          常用修复
          <span className="ml-2 font-normal text-content-subtle">
            整体偏移、重新同步、版本差异
          </span>
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="全局偏移"
            type="number"
            value={project.globalOffsetMs}
            suffix="ms"
            onChange={(event) => setGlobalOffset(Math.round(Number(event.target.value)))}
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={project.preview.danmakuVisible}
              onChange={(event) => updatePreview({ danmakuVisible: event.target.checked })}
            />
            弹幕叠加
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={project.preview.safeAreaVisible}
              onChange={(event) => updatePreview({ safeAreaVisible: event.target.checked })}
            />
            显示安全区
          </label>
          <label className="grid gap-1">
            预览弹幕透明度
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={project.preview.opacity}
              onChange={(event) => updatePreview({ opacity: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <TextButton
            title="让全部弹幕提前 0.5 秒"
            onClick={() => setGlobalOffset(project.globalOffsetMs - 500)}
          >
            整体提前 0.5 秒
          </TextButton>
          <TextButton
            title="让全部弹幕延后 0.5 秒"
            onClick={() => setGlobalOffset(project.globalOffsetMs + 500)}
          >
            整体延后 0.5 秒
          </TextButton>
          {project.globalOffsetMs !== 0 ? (
            <TextButton onClick={() => setGlobalOffset(0)}>清除整体偏移</TextButton>
          ) : null}
          <TextButton onClick={() => openRepair("sync")}>
            <Link2 size={13} />
            从这里重新同步
          </TextButton>
          <TextButton onClick={() => openRepair("difference")}>
            <SplitSquareHorizontal size={13} />
            这之后有版本差异
          </TextButton>
        </div>
        {repairMode ? (
          <div
            className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-panel-line bg-surface-inset p-2"
            role="group"
            aria-label={repairMode === "sync" ? "重新同步设置" : "版本差异设置"}
          >
            {repairMode === "sync" ? (
              <>
                <div className="text-ui-caption leading-4 text-content-muted">
                  参考位置
                  <span className="block font-mono text-content-secondary">
                    {formatTimecode(project.timeline.playheadMs)}
                  </span>
                </div>
                <label className="grid gap-1 text-ui-caption text-content-muted">
                  对应原片时间
                  <input
                    aria-label="对应原片时间"
                    className="h-7 w-36 rounded border border-panel-line bg-panel-base px-2 font-mono text-ui-caption text-content-primary"
                    value={targetTimeText}
                    onChange={(event) => setTargetTimeText(event.target.value)}
                  />
                </label>
                <TextButton tone="primary" onClick={saveSyncPoint}>
                  保存同步点
                </TextButton>
              </>
            ) : (
              <>
                <label className="grid gap-1 text-ui-caption text-content-muted">
                  之后弹幕移动秒数
                  <input
                    aria-label="版本差异秒数"
                    className="h-7 w-28 rounded border border-panel-line bg-panel-base px-2 text-ui-caption text-content-primary"
                    type="number"
                    step="0.1"
                    value={differenceSeconds}
                    onChange={(event) => setDifferenceSeconds(event.target.value)}
                  />
                </label>
                <span className="pb-1.5 text-ui-caption text-content-subtle">
                  正数延后，负数提前
                </span>
                <TextButton tone="primary" onClick={saveDifference}>
                  保存版本差异
                </TextButton>
              </>
            )}
            <TextButton onClick={() => setRepairMode(null)}>取消</TextButton>
          </div>
        ) : null}
      </details>
      {sortedSyncAnchors.length > 0 ? (
        <details
          className="mt-2 rounded-md border border-panel-line/70 bg-surface-inset px-2 py-1.5"
          open
        >
          <summary className="cursor-pointer text-ui-caption font-medium text-content-muted">
            同步点管理
            <span className="ml-2 font-normal text-content-subtle">
              {sortedSyncAnchors.length} 个
            </span>
          </summary>
          <div className="mt-2 grid gap-2">
            {sortedSyncAnchors.map((anchor, index) => {
              const label = `同步锚点 ${index + 1}`;
              return (
                <article
                  key={anchor.id}
                  className="rounded border border-panel-line bg-surface-inset p-2"
                >
                  <div className="flex items-center gap-2">
                    <Button
                      tone="unstyled"
                      type="button"
                      className="min-w-0 flex-1 text-left font-mono text-ui-caption text-content-secondary"
                      aria-label={`定位${label}`}
                      onClick={() => setPlayhead(anchor.sourceMs)}
                    >
                      {label} · {formatTimecode(anchor.sourceMs)} →{" "}
                      {formatTimecode(anchor.targetMs)}
                    </Button>
                    <TextButton
                      tone="danger"
                      aria-label={`删除${label}`}
                      onClick={() => deleteSyncAnchor(anchor.id)}
                    >
                      <Trash2 size={12} /> 删除
                    </TextButton>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-ui-caption text-content-muted">
                      当前视频时间 ms
                      <input
                        aria-label={`${label} 当前视频时间 ms`}
                        className="h-7 min-w-0 rounded border border-panel-line bg-panel-base px-2 text-ui-caption text-content-primary"
                        inputMode="numeric"
                        value={anchor.sourceMs}
                        onChange={(event) =>
                          updateSyncAnchor(anchor.id, { sourceMs: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-ui-caption text-content-muted">
                      完整版时间 ms
                      <input
                        aria-label={`${label} 完整版时间 ms`}
                        className="h-7 min-w-0 rounded border border-panel-line bg-panel-base px-2 text-ui-caption text-content-primary"
                        inputMode="numeric"
                        value={anchor.targetMs}
                        onChange={(event) =>
                          updateSyncAnchor(anchor.id, { targetMs: Number(event.target.value) })
                        }
                      />
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </section>
  );
  return sheet ? (
    <ToolSheet title="偏移与校准" open={sheet.open} onClose={sheet.onClose}>
      {content}
    </ToolSheet>
  ) : (
    content
  );
}

function setEditorStatus(message: string, tone: "success" | "warning"): void {
  useEditorStore.setState({ status: { message, tone } });
}

function formatSignedMilliseconds(value: number): string {
  if (value === 0) {
    return "0 秒";
  }
  return `${value > 0 ? "延后" : "提前"} ${(Math.abs(value) / 1000).toFixed(1)} 秒`;
}
