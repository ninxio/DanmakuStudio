import { Focus, Merge, MousePointer2, Scissors } from "lucide-react";
import { TextButton } from "../../../components/TextButton";
import { WorkspaceMenu } from "../../../components/WorkspaceMenu";
import type { TimeMapSpanKind } from "../../../domain/alignment/timeMap";
import type { AlignmentReviewPrecision } from "../../../domain/project/types";
export type TimeMapEditTool = "inspect" | "sourceGap" | "targetGap";
export type TimeMapViewMode = "overview" | "focus";
interface TimeMapEditorToolbarProps {
  activeTool: TimeMapEditTool;
  viewMode: TimeMapViewMode;
  selectedKind: TimeMapSpanKind;
  canEdit: boolean;
  canMarkCommon: boolean;
  canSplit: boolean;
  canMerge: boolean;
  reviewPrecision: AlignmentReviewPrecision;
  actionHint?: string | null;
  onToolChange: (tool: TimeMapEditTool) => void;
  onViewModeChange: (mode: TimeMapViewMode) => void;
  onMarkCommon: () => void;
  onMarkReplacement: () => void;
  onMarkUnresolved: () => void;
  onSplit: () => void;
  onMerge: () => void;
  onReviewPrecisionChange: (precision: AlignmentReviewPrecision) => void;
}

export function TimeMapEditorToolbar(props: TimeMapEditorToolbarProps) {
  const {
    activeTool,
    viewMode,
    selectedKind,
    canEdit,
    canMarkCommon,
    canSplit,
    canMerge,
    reviewPrecision,
    onToolChange,
    onViewModeChange,
    onMarkCommon,
    onMarkReplacement,
    onMarkUnresolved,
    onSplit,
    onMerge,
    onReviewPrecisionChange
  } = props;
  return (
    <div className="time-map-toolbar" aria-label="时间关系编辑工具">
      <TextButton
        aria-pressed={activeTool === "inspect"}
        onClick={() => onToolChange("inspect")}
      >
        <MousePointer2 size={14} />
        选择
      </TextButton>
      <WorkspaceMenu
        label={
          activeTool === "sourceGap"
            ? "标记参考多出"
            : activeTool === "targetGap"
              ? "标记原片多出"
              : "标记多出内容"
        }
        items={[
          {
            id: "source",
            label: "标记参考多出",
            disabled: !canEdit,
            onSelect: () => onToolChange("sourceGap")
          },
          {
            id: "target",
            label: "标记原片多出",
            disabled: !canEdit,
            onSelect: () => onToolChange("targetGap")
          }
        ]}
      />
      <WorkspaceMenu
        label={
          {
            matched: "共同内容",
            sourceOnly: "参考独有",
            targetOnly: "原片独有",
            ambiguous: "需要确认"
          }[selectedKind]
        }
        items={[
          {
            id: "common",
            label: "共同内容",
            disabled: !canEdit || !canMarkCommon,
            onSelect: onMarkCommon
          },
          {
            id: "replacement",
            label: "版本不同",
            disabled: !canEdit,
            onSelect: onMarkReplacement
          },
          {
            id: "unresolved",
            label: "暂不确定",
            disabled: !canEdit,
            onSelect: onMarkUnresolved
          }
        ]}
      />
      <TextButton onClick={() => onViewModeChange(viewMode === "focus" ? "overview" : "focus")}>
        <Focus size={14} />
        {viewMode === "focus" ? "查看全片" : "聚焦当前段"}
      </TextButton>
      <WorkspaceMenu
        label="编辑选项"
        items={[
          {
            id: "split",
            label: "拆分当前段",
            disabled: !canEdit || !canSplit,
            onSelect: onSplit,
            icon: <Scissors size={14} />
          },
          {
            id: "merge",
            label: "合并相邻同类段",
            disabled: !canEdit || !canMerge,
            onSelect: onMerge,
            icon: <Merge size={14} />
          },
          {
            id: "precision",
            label:
              reviewPrecision === "playbackChecked"
                ? "已用 A/B 播放核对 ✓"
                : "标记已用 A/B 播放核对",
            disabled: !canEdit,
            onSelect: () =>
              onReviewPrecisionChange(
                reviewPrecision === "playbackChecked" ? "rough" : "playbackChecked"
              )
          }
        ]}
      />
    </div>
  );
}
