import { RotateCcw, Trash2 } from "lucide-react";
import { Field } from "../../components/Field";
import { TextButton } from "../../components/TextButton";
import { formatTimecode } from "../../domain/shared/time";
import { findResolvedEvent, useEditorStore } from "../../stores/editorStore";

export function InspectorPanel() {
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const setItemAdjustment = useEditorStore((state) => state.setItemAdjustment);
  const disableSelectedDanmaku = useEditorStore((state) => state.disableSelectedDanmaku);
  const restoreSelectedDanmaku = useEditorStore((state) => state.restoreSelectedDanmaku);
  const updateClip = useEditorStore((state) => state.updateClip);
  const updateCutMarker = useEditorStore((state) => state.updateCutMarker);
  const deleteCutMarker = useEditorStore((state) => state.deleteCutMarker);

  if (selection.kind === "danmaku" && selection.ids.length === 1) {
    const event = findResolvedEvent(project, selection.ids[0]);
    if (!event) {
      return <EmptyInspector text="选中的弹幕不存在。" />;
    }
    const adjustment = project.itemTimeAdjustments[event.item.id] ?? 0;
    const disabled = project.disabledItemIds.includes(event.item.id);
    return (
      <div className="thin-scrollbar h-full overflow-auto p-3" data-testid="inspector-danmaku">
        <Header title="弹幕检查器" subtitle={event.asset.fileName} />
        <label className="mt-3 grid gap-1 text-xs text-content-muted">
          弹幕文本
          <textarea
            readOnly
            value={event.item.text}
            className="min-h-20 resize-none rounded border border-panel-line bg-surface-inset p-2 text-sm text-content-primary"
          />
        </label>
        <div className="mt-3 grid gap-3">
          <ReadOnlyRow label="最终时间" value={formatTimecode(event.finalTimeMs)} />
          <ReadOnlyRow label="原始时间" value={formatTimecode(event.item.sourceTimeMs)} />
          <ReadOnlyRow label="模式" value={String(event.item.mode ?? "未知")} />
          <ReadOnlyRow label="字号" value={String(event.item.fontSize ?? "未知")} />
          <ReadOnlyRow
            label="颜色"
            value={`#${(event.item.color ?? 16_777_215).toString(16).padStart(6, "0")}`}
          />
          <ReadOnlyRow label="来源 XML" value={event.asset.fileName} />
          <Field
            label="时间微调"
            type="number"
            value={adjustment}
            suffix="ms"
            onChange={(change) => setItemAdjustment(event.item.id, Number(change.target.value))}
          />
          <label className="flex items-center justify-between rounded border border-panel-line bg-panel-soft px-3 py-2 text-xs text-content-secondary">
            启用
            <input
              type="checkbox"
              checked={!disabled}
              onChange={(change) => {
                if (change.target.checked) {
                  restoreSelectedDanmaku();
                } else {
                  disableSelectedDanmaku();
                }
              }}
            />
          </label>
        </div>
      </div>
    );
  }

  if (selection.kind === "danmaku" && selection.ids.length > 1) {
    return (
      <div className="grid gap-3 p-3" data-testid="inspector-multi">
        <Header title="多选弹幕" subtitle={`${selection.ids.length} 条已选择`} />
        <TextButton tone="danger" onClick={disableSelectedDanmaku}>
          <Trash2 size={14} />
          禁用所选弹幕
        </TextButton>
        <TextButton onClick={restoreSelectedDanmaku}>
          <RotateCcw size={14} />
          恢复所选弹幕
        </TextButton>
      </div>
    );
  }

  if (selection.kind === "clip" && selection.ids.length === 1) {
    const clip = project.clips.find((candidate) => candidate.id === selection.ids[0]);
    const asset = clip
      ? project.assets.find((candidate) => candidate.id === clip.assetId)
      : null;
    if (!clip || !asset) {
      return <EmptyInspector text="选中的片段不存在。" />;
    }
    return (
      <div className="thin-scrollbar h-full overflow-auto p-3" data-testid="inspector-clip">
        <Header title="片段检查器" subtitle={asset.fileName} />
        <div className="mt-3 grid gap-3">
          <Field
            label="片段名称"
            value={clip.name}
            onChange={(event) => updateClip(clip.id, { name: event.target.value })}
          />
          <Field
            label="时间轴起点"
            type="number"
            value={clip.timelineStartMs}
            suffix="ms"
            onChange={(event) =>
              updateClip(clip.id, { timelineStartMs: Number(event.target.value) })
            }
          />
          <Field
            label="源入点"
            type="number"
            value={clip.sourceInMs}
            suffix="ms"
            onChange={(event) =>
              updateClip(clip.id, { sourceInMs: Number(event.target.value) })
            }
          />
          <Field
            label="源出点"
            type="number"
            value={clip.sourceOutMs}
            suffix="ms"
            onChange={(event) =>
              updateClip(clip.id, { sourceOutMs: Number(event.target.value) })
            }
          />
          <Field
            label="片段总偏移"
            type="number"
            value={clip.localOffsetMs}
            suffix="ms"
            onChange={(event) =>
              updateClip(clip.id, { localOffsetMs: Number(event.target.value) })
            }
          />
          <ReadOnlyRow label="包含弹幕数" value={asset.items.length.toLocaleString("zh-CN")} />
          <label className="flex items-center justify-between rounded border border-panel-line bg-panel-soft px-3 py-2 text-xs text-content-secondary">
            启用片段
            <input
              type="checkbox"
              checked={clip.enabled}
              onChange={(event) => updateClip(clip.id, { enabled: event.target.checked })}
            />
          </label>
        </div>
      </div>
    );
  }

  if (selection.kind === "cut" && selection.ids.length === 1) {
    const marker = project.cutMarkers.find((candidate) => candidate.id === selection.ids[0]);
    if (!marker) {
      return <EmptyInspector text="选中的版本差异不存在。" />;
    }
    const gapDirection = marker.targetGapMs < 0 ? -1 : 1;
    return (
      <div className="thin-scrollbar h-full overflow-auto p-3" data-testid="inspector-cut">
        <Header title="版本差异" subtitle={marker.name} />
        <p className="mt-3 rounded border border-panel-line bg-panel-soft p-2 text-xs leading-5 text-content-muted">
          当当前弹幕对应的视频和完整版在这里多出或少了一段内容时，用它让后续弹幕一起前移或后移。
        </p>
        <div className="mt-3 grid gap-3">
          <Field
            label="名称"
            value={marker.name}
            onChange={(event) => updateCutMarker(marker.id, { name: event.target.value })}
          />
          <Field
            label="差异发生在当前视频的哪里"
            type="number"
            value={marker.sourceAtMs}
            suffix={
              <span className="whitespace-nowrap">
                ms / {formatTimecode(marker.sourceAtMs)}
              </span>
            }
            onChange={(event) =>
              updateCutMarker(marker.id, { sourceAtMs: Number(event.target.value) })
            }
          />
          <label className="grid gap-1 text-xs text-content-muted">
            <span>完整版比当前版</span>
            <select
              aria-label="完整版比当前版"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-sm text-content-primary"
              value={marker.targetGapMs < 0 ? "less" : "more"}
              onChange={(event) => {
                const nextDirection = event.target.value === "less" ? -1 : 1;
                updateCutMarker(marker.id, {
                  targetGapMs: nextDirection * Math.abs(marker.targetGapMs)
                });
              }}
            >
              <option value="more">多了一段内容</option>
              <option value="less">少了一段内容</option>
            </select>
          </label>
          <Field
            label="相差多久"
            type="number"
            value={Math.abs(marker.targetGapMs)}
            suffix={
              <span className="whitespace-nowrap">
                ms / {formatTimecode(Math.abs(marker.targetGapMs))}
              </span>
            }
            onChange={(event) =>
              updateCutMarker(marker.id, {
                targetGapMs: gapDirection * Math.abs(Number(event.target.value))
              })
            }
          />
          <ReadOnlyRow
            label="应用结果"
            value={createVersionDifferenceEffectText(marker.targetGapMs)}
          />
          <label className="grid gap-1 text-xs text-content-muted">
            备注
            <textarea
              value={marker.note}
              onChange={(event) => updateCutMarker(marker.id, { note: event.target.value })}
              placeholder="可写下判断依据，例如：完整版这里有片头，当前版直接进入正片。"
              className="min-h-20 resize-none rounded border border-panel-line bg-surface-inset p-2 text-sm text-content-primary"
            />
          </label>
          <TextButton tone="danger" onClick={() => deleteCutMarker(marker.id)}>
            <Trash2 size={14} />
            删除版本差异
          </TextButton>
        </div>
      </div>
    );
  }

  return (
    <EmptyInspector text="选择弹幕可以微调或禁用；选择片段可以移动和裁剪；选择版本差异可以说明这里多了或少了多久。" />
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-panel-line pb-3">
      <h2 className="text-sm font-semibold text-content-primary">{title}</h2>
      <p className="mt-1 truncate text-xs text-content-muted" title={subtitle}>
        {subtitle}
      </p>
    </div>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 text-xs text-content-muted">
      <span>{label}</span>
      <div
        className="truncate rounded border border-panel-line bg-panel-soft px-2 py-2 text-sm text-content-primary"
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyInspector({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs leading-5 text-content-muted">
      {text}
    </div>
  );
}

function createVersionDifferenceEffectText(targetGapMs: number): string {
  const duration = formatTimecode(Math.abs(targetGapMs));
  if (targetGapMs > 0) {
    return `此点之后的弹幕会整体后移 ${duration}。`;
  }
  if (targetGapMs < 0) {
    return `此点之后的弹幕会整体前移 ${duration}。`;
  }
  return "目前相差 0 秒，不会改变弹幕时间。";
}
