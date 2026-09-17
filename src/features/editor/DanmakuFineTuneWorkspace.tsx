import { useEditorStore } from "../../stores/editorStore";
import { CalibrationOverview } from "./CalibrationOverview";
import { InspectorPanel } from "../inspector/InspectorPanel";
import { TimelinePanel } from "../timeline/TimelinePanel";
import { useState } from "react";
import { TextButton } from "../../components/TextButton";
import { ToolSheet } from "../../components/ToolSheet";
import { PreviewPanel } from "../preview/PreviewPanel";

/**
 * XML/danmaku fine tuning is intentionally separated from media alignment.
 * It remains available in step 3 without permanently shrinking the A/B editor.
 */
export function DanmakuFineTuneWorkspace() {
  const projectId = useEditorStore((state) => state.project.id);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const [tool, setTool] = useState<"calibration" | "inspector" | null>(null);
  return (
    <section
      className="fine-tune-workspace"
      data-testid="danmaku-fine-tune-workspace"
      aria-label="弹幕精修工作台"
    >
      <div className="editor-context-bar">
        <span className="text-content-muted text-xs">
          选择片段或弹幕后调整；源 XML 保持不变。
        </span>
        <div className="editor-toolbar-actions">
          <TextButton onClick={() => setTool("calibration")}>偏移与校准</TextButton>
          <TextButton onClick={() => setTool("inspector")}>片段与单条属性</TextButton>
        </div>
      </div>
      <div className="fine-tune-preview">
        <PreviewPanel compact />
      </div>
      <div className="fine-tune-timeline">
        <TimelinePanel />
      </div>
      <CalibrationOverview
        key={`${projectId}:${projectEpoch}`}
        sheet={{ open: tool === "calibration", onClose: () => setTool(null) }}
      />
      <ToolSheet
        title="片段与单条属性"
        open={tool === "inspector"}
        onClose={() => setTool(null)}
      >
        <div className="fine-tune-inspector">
          <InspectorPanel />
        </div>
      </ToolSheet>
    </section>
  );
}
