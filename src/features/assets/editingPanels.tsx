import { Button } from "../../components/Button";
import { Layers, ListPlus, Trash2 } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import type { CutMarker, SyncAnchor } from "../../domain/danmaku/types";
import { formatTimecode } from "../../domain/shared/time";
import { formatSignedDuration } from "./assetPanelSharedLogic";

export function CompensationMarkersPanel({
  markers,
  selectedIds,
  onFocus,
  onUpdate,
  onDelete
}: {
  markers: CutMarker[];
  selectedIds: string[];
  onFocus: (marker: CutMarker) => void;
  onUpdate: (id: string, patch: Partial<Omit<CutMarker, "id">>) => void;
  onDelete: (id: string) => void;
}) {
  const totalGapMs = markers.reduce((total, marker) => total + marker.targetGapMs, 0);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <ListPlus size={15} className="text-accent-cyan" />
        <span>版本差异列表</span>
        <span className="ml-auto text-ui-caption text-content-muted">{markers.length} 个</span>
      </div>
      <div className="mt-3 grid gap-2">
        {markers.length > 0 ? (
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-content-muted">
            <span className="text-content-muted">累计调整</span>
            <span>{formatSignedDuration(totalGapMs)}</span>
          </div>
        ) : (
          <div className="text-content-muted">
            暂无版本差异。可在时间轴标记，或从删减扫描、对齐线索生成。
          </div>
        )}
        {markers.map((marker) => {
          const selected = selectedIds.includes(marker.id);
          return (
            <article
              key={marker.id}
              className={`grid gap-2 rounded border p-2 ${
                selected
                  ? "border-accent-cyan bg-accent-cyan/10"
                  : "border-panel-line bg-surface-inset"
              }`}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <Button
                  tone="unstyled"
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => onFocus(marker)}
                  aria-label={`定位版本差异 ${marker.name}`}
                >
                  <span className="block truncate text-content-primary" title={marker.name}>
                    {marker.name}
                  </span>
                  <span className="mt-1 block font-mono text-ui-caption text-content-muted">
                    {formatTimecode(marker.sourceAtMs)} /{" "}
                    {formatSignedDuration(marker.targetGapMs)}
                  </span>
                </Button>
                <TextButton
                  aria-label={`删除版本差异 ${marker.name}`}
                  tone="danger"
                  onClick={() => onDelete(marker.id)}
                >
                  <Trash2 size={14} />
                  删除
                </TextButton>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-content-muted">发生时间 ms</span>
                  <input
                    aria-label={`${marker.name} 发生时间 ms`}
                    className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                    inputMode="numeric"
                    value={marker.sourceAtMs}
                    onChange={(event) =>
                      onUpdate(marker.id, { sourceAtMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-content-muted">相差 ms</span>
                  <input
                    aria-label={`${marker.name} 相差 ms`}
                    className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                    inputMode="numeric"
                    value={marker.targetGapMs}
                    onChange={(event) =>
                      onUpdate(marker.id, { targetGapMs: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function SyncAnchorsPanel({
  anchors,
  onFocus,
  onUpdate,
  onDelete
}: {
  anchors: SyncAnchor[];
  onFocus: (anchor: SyncAnchor) => void;
  onUpdate: (id: string, patch: Partial<Omit<SyncAnchor, "id">>) => void;
  onDelete: (id: string) => void;
}) {
  const sortedAnchors = [...anchors].sort(
    (left, right) => left.sourceMs - right.sourceMs || left.id.localeCompare(right.id)
  );
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <Layers size={15} className="text-accent-cyan" />
        <span>同步锚点管理</span>
        <span className="ml-auto text-ui-caption text-content-muted">
          {sortedAnchors.length} 个
        </span>
      </div>
      <div className="mt-3 grid gap-2">
        {sortedAnchors.length === 0 ? (
          <div className="text-content-muted">
            暂无同步锚点，可从锚点校准或本地对齐提案生成。
          </div>
        ) : null}
        {sortedAnchors.map((anchor, index) => {
          const label = `同步锚点 ${index + 1}`;
          return (
            <article
              key={anchor.id}
              className="grid gap-2 rounded border border-panel-line bg-surface-inset p-2"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <Button
                  tone="unstyled"
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => onFocus(anchor)}
                  aria-label={`定位${label}`}
                >
                  <span className="block truncate text-content-primary">
                    {label} / {anchorOriginText(anchor.origin)}
                  </span>
                  <span className="mt-1 block font-mono text-ui-caption text-content-muted">
                    {formatTimecode(anchor.sourceMs)} -&gt; {formatTimecode(anchor.targetMs)} /{" "}
                    {formatSignedDuration(anchor.targetMs - anchor.sourceMs)}
                  </span>
                </Button>
                <TextButton
                  aria-label={`删除${label}`}
                  tone="danger"
                  onClick={() => onDelete(anchor.id)}
                >
                  <Trash2 size={14} />
                  删除
                </TextButton>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-content-muted">当前视频时间 ms</span>
                  <input
                    aria-label={`${label} 当前视频时间 ms`}
                    className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                    inputMode="numeric"
                    value={anchor.sourceMs}
                    onChange={(event) =>
                      onUpdate(anchor.id, { sourceMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-content-muted">完整版时间 ms</span>
                  <input
                    aria-label={`${label} 完整版时间 ms`}
                    className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                    inputMode="numeric"
                    value={anchor.targetMs}
                    onChange={(event) =>
                      onUpdate(anchor.id, { targetMs: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function anchorOriginText(origin: SyncAnchor["origin"]): string {
  return origin === "manual" ? "手动" : "自动";
}
