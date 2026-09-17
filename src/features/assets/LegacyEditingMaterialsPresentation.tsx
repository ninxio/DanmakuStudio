import { Layers, ListPlus, ListX, Shuffle } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import type { CutMarker, SyncAnchor } from "../../domain/danmaku/types";
import { formatTimecode } from "../../domain/shared/time";
import { EmptyState, Row } from "./assetPanelShared";
import { CompensationMarkersPanel, SyncAnchorsPanel } from "./editingPanels";

type LegacyEditingGuidance = "needsImport" | "needsTimeline" | "ready";

interface LegacyEditingAssetRow {
  assetId: string;
  color: string;
  fileName: string;
  itemCount: number;
  earliestMs: number;
  latestMs: number;
  inTimeline: boolean;
}

interface LegacyEditingMaterialsViewModel {
  guidance: LegacyEditingGuidance;
  assetRows: LegacyEditingAssetRow[];
  cutMarkerGroup: {
    markers: CutMarker[];
    selectedIds: string[];
  };
  syncAnchorGroup: {
    anchors: SyncAnchor[];
  };
}

type LegacyEditingMaterialsIntent =
  | { type: "goToMaterials" }
  | { type: "arrangeAssets" }
  | { type: "placeAsset"; assetId: string }
  | { type: "selectAssetClip"; assetId: string }
  | { type: "unplaceAsset"; assetId: string }
  | { type: "focusVersionDifference"; marker: CutMarker }
  | {
      type: "changeVersionDifference";
      id: string;
      patch: Partial<Omit<CutMarker, "id">>;
    }
  | { type: "removeVersionDifference"; id: string }
  | { type: "focusSyncAnchor"; anchor: SyncAnchor }
  | {
      type: "changeSyncAnchor";
      id: string;
      patch: Partial<Omit<SyncAnchor, "id">>;
    }
  | { type: "removeSyncAnchor"; id: string };

interface LegacyEditingMaterialsPresentationProps {
  viewModel: LegacyEditingMaterialsViewModel;
  onIntent: (intent: LegacyEditingMaterialsIntent) => void;
}

export function LegacyEditingMaterialsPresentation({
  viewModel,
  onIntent
}: LegacyEditingMaterialsPresentationProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto p-3">
        <div className="grid gap-3">
          <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
            <h3 className="text-sm font-medium text-content-primary">下一步</h3>
            <p className="mt-2 leading-5 text-content-muted">
              {viewModel.guidance === "needsImport"
                ? "还没有弹幕 XML。请先到素材页导入。"
                : viewModel.guidance === "needsTimeline"
                  ? "把弹幕素材放到时间轴。多分 P 文件可以直接按顺序排列。"
                  : "现在可以在时间轴预览和微调弹幕；遇到视频版本删减时，用“标记版本差异”。"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {viewModel.guidance === "needsImport" ? (
                <TextButton tone="primary" onClick={() => onIntent({ type: "goToMaterials" })}>
                  <ListPlus size={14} />
                  去素材页导入
                </TextButton>
              ) : (
                <TextButton onClick={() => onIntent({ type: "arrangeAssets" })}>
                  <Shuffle size={14} />
                  按顺序放入时间轴
                </TextButton>
              )}
            </div>
          </section>
          {viewModel.assetRows.length === 0 ? (
            <EmptyState
              title="尚未导入 XML"
              text="到素材页导入 Bilibili XML 后，这里会显示可编辑的弹幕素材。"
            />
          ) : (
            viewModel.assetRows.map((asset) => (
              <article
                key={asset.assetId}
                className="performance-list-item rounded border border-panel-line bg-panel-soft p-3"
                data-testid="asset-card"
              >
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-sm" style={{ background: asset.color }} />
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-content-primary">
                    {asset.fileName}
                  </h3>
                </div>
                <dl className="mt-3 grid gap-1 text-xs text-content-muted">
                  <Row label="弹幕数量" value={asset.itemCount.toLocaleString("zh-CN")} />
                  <Row label="最早时间" value={formatTimecode(asset.earliestMs)} />
                  <Row label="最晚时间" value={formatTimecode(asset.latestMs)} />
                  <Row
                    label="状态"
                    value={asset.inTimeline ? "已放入时间轴" : "未放入时间轴"}
                  />
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <TextButton
                    onClick={() => onIntent({ type: "placeAsset", assetId: asset.assetId })}
                    disabled={asset.inTimeline}
                    tone={asset.inTimeline ? "neutral" : "primary"}
                  >
                    <ListPlus size={14} />
                    放入时间轴
                  </TextButton>
                  {asset.inTimeline ? (
                    <TextButton
                      onClick={() =>
                        onIntent({ type: "selectAssetClip", assetId: asset.assetId })
                      }
                    >
                      <Layers size={14} />
                      选择片段
                    </TextButton>
                  ) : null}
                  {asset.inTimeline ? (
                    <TextButton
                      title="从时间轴移出，保留资源"
                      onClick={() =>
                        onIntent({
                          type: "unplaceAsset",
                          assetId: asset.assetId
                        })
                      }
                    >
                      <ListX size={14} />
                      移出
                    </TextButton>
                  ) : null}
                </div>
              </article>
            ))
          )}
          {viewModel.assetRows.length > 0 ? (
            <>
              <CompensationMarkersPanel
                markers={viewModel.cutMarkerGroup.markers}
                selectedIds={viewModel.cutMarkerGroup.selectedIds}
                onFocus={(marker) => onIntent({ type: "focusVersionDifference", marker })}
                onUpdate={(id, patch) =>
                  onIntent({ type: "changeVersionDifference", id, patch })
                }
                onDelete={(id) => onIntent({ type: "removeVersionDifference", id })}
              />
              <SyncAnchorsPanel
                anchors={viewModel.syncAnchorGroup.anchors}
                onFocus={(anchor) => onIntent({ type: "focusSyncAnchor", anchor })}
                onUpdate={(id, patch) => onIntent({ type: "changeSyncAnchor", id, patch })}
                onDelete={(id) => onIntent({ type: "removeSyncAnchor", id })}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
