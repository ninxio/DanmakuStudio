import { lazy, Suspense, useMemo } from "react";
import { TextButton } from "../../components/TextButton";
import { WorkspaceStatePanel } from "../../components/WorkspaceStatePanel";
import {
  createCutHintSearchPlan,
  findSuspectedCutCandidates
} from "../../domain/danmaku/cutHints";
import { isXmlOnlyProject } from "../../domain/project/workflowMode";
import { inspectXmlTimeline } from "../../domain/timeline/xmlTimeline";
import { useEditorStore } from "../../stores/editorStore";

const MediaMatchingPanel = lazy(async () => ({
  default: (await import("./MediaMatchingPanel")).MediaMatchingPanel
}));

/** Matching generates candidates; human timeline changes live in the editor. */
export function MatchingWorkspace() {
  const project = useEditorStore((state) => state.project);
  const cutHintSettings = useEditorStore((state) => state.cutHintSettings);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const startXmlEditing = useEditorStore((state) => state.startXmlEditing);
  const candidates = useMemo(
    () =>
      findSuspectedCutCandidates(
        project.assets,
        createCutHintSearchPlan(cutHintSettings).options
      ),
    [project.assets, cutHintSettings]
  );
  if (isXmlOnlyProject(project)) {
    const unplaced = inspectXmlTimeline(project).unplacedAssets.length;
    return (
      <section
        className="thin-scrollbar h-full overflow-auto p-5"
        data-testid="xml-only-matching-skip"
      >
        <WorkspaceStatePanel
          state="empty"
          title="当前项目不需要智能匹配"
          description="只有 XML 时，直接沿用弹幕自身的时间线。导入视频后，可以在这里分析参考素材与原片的时间关系。"
        />
        <div className="mt-4 flex gap-3">
          {project.assets.length > 0 ? (
            <TextButton tone="primary" onClick={startXmlEditing}>
              {project.clips.length > 0 && unplaced > 0
                ? `加入 ${unplaced} 个 XML 并编辑`
                : "直接进入弹幕编辑"}
            </TextButton>
          ) : (
            <TextButton tone="primary" onClick={() => setWorkspacePage("materials")}>
              去导入弹幕 XML
            </TextButton>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="workspace-page" data-testid="matching-workspace">
      {project.assets.length > 0 ? (
        <Suspense
          fallback={
            <WorkspaceStatePanel
              state="loading"
              title="正在载入匹配工作区"
              description="素材与项目状态保持可用。"
            />
          }
        >
          <MediaMatchingPanel project={project} suspectedCutCandidates={candidates} />
        </Suspense>
      ) : (
        <WorkspaceStatePanel
          state="empty"
          title="先导入素材"
          description="匹配需要弹幕 XML、参考素材和原片素材。"
        />
      )}
    </section>
  );
}
