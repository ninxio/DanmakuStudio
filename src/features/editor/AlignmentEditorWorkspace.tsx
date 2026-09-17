import { Beaker, GitCompareArrows, SlidersHorizontal } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import "../../app/styles/editor-workspace.css";
import { ToolSheet } from "../../components/ToolSheet";
import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { WorkspaceTabs } from "../../components/WorkspaceTabs";
import { TextButton } from "../../components/TextButton";
import { WorkspaceStatePanel } from "../../components/WorkspaceStatePanel";
import { getProjectWorkflowMode } from "../../domain/project/workflowMode";
import { inspectXmlTimeline } from "../../domain/timeline/xmlTimeline";
import { useEditorStore } from "../../stores/editorStore";
import { AlignmentRelationEditor } from "./AlignmentRelationEditor";
import type { TimeMapPlaybackAdapterFactory } from "./TimeMapPlaybackReview";
import { MatchCoverageWorkspace } from "./MatchCoverageWorkspace";

const ManualAlignmentWorkspace = lazy(async () => ({
  default: (await import("../matching/ManualAlignmentWorkspace")).ManualAlignmentWorkspace
}));

type AlignmentEditorMode = "coverage" | "relations" | "danmaku";

const AlignmentLearningPanel = lazy(async () => {
  const module = await import("./AlignmentLearningPanel");
  return { default: module.AlignmentLearningPanel };
});

const DanmakuFineTuneWorkspace = lazy(async () => {
  const module = await import("./DanmakuFineTuneWorkspace");
  return { default: module.DanmakuFineTuneWorkspace };
});

export function AlignmentEditorWorkspace({
  playbackAdapterFactory
}: {
  playbackAdapterFactory?: TimeMapPlaybackAdapterFactory;
} = {}) {
  const [mode, setMode] = useState<AlignmentEditorMode>("coverage");
  const [tool, setTool] = useState<"manual" | "learning" | null>(null);
  const workspaceIntent = useEditorStore((state) => state.workspaceIntentRequest);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  useEffect(() => {
    setMode("coverage");
    setTool(null);
  }, [projectEpoch]);
  useEffect(() => {
    if (
      workspaceIntent?.intent.page === "editing" &&
      workspaceIntent.intent.target.kind === "candidate"
    ) {
      setTool(null);
      setMode("relations");
    }
  }, [workspaceIntent]);
  const project = useEditorStore((state) => state.project);
  const selectedCandidate = useEditorStore((state) => state.alignmentEditorCandidateId);
  const selectCandidate = useEditorStore((state) => state.selectAlignmentEditorCandidate);
  const startXmlEditing = useEditorStore((state) => state.startXmlEditing);
  const xmlOnly = getProjectWorkflowMode(project) === "xml-only";
  const unplacedXmlCount = inspectXmlTimeline(project).unplacedAssets.length;
  return (
    <section
      className="editor-workspace-shell"
      data-testid={xmlOnly ? "xml-only-editor-shell" : "alignment-editor-shell"}
    >
      <nav className="editor-mode-bar" aria-label="编辑工作台模式">
        {xmlOnly ? (
          <h2 className="font-semibold">弹幕时间线编辑</h2>
        ) : (
          <WorkspaceTabs<AlignmentEditorMode>
            label="编辑工作台主要模式"
            value={mode}
            items={[
              { id: "coverage", label: "覆盖分析", icon: <GitCompareArrows size={15} /> },
              { id: "relations", label: "精确修正", icon: <SlidersHorizontal size={15} /> },
              { id: "danmaku", label: "弹幕精修", icon: <SlidersHorizontal size={15} /> }
            ]}
            onChange={setMode}
          />
        )}
        {!xmlOnly && mode === "relations" && (
          <div className="correction-context">
            <TextButton onClick={() => setMode("coverage")}>返回覆盖分析</TextButton>
            <label>
              <span>定位参考</span>
              <select
                aria-label="精修参考"
                value={selectedCandidate ?? project.mediaMatchCandidates[0]?.id ?? ""}
                onChange={(event) => selectCandidate(event.target.value)}
              >
                {project.mediaMatchCandidates
                  .filter((candidate) => candidate.state !== "rejected")
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {
                        project.mediaLibrary.find(
                          (media) => media.id === candidate.sourceMediaId
                        )?.name
                      }{" "}
                      →{" "}
                      {
                        project.mediaLibrary.find(
                          (media) => media.id === candidate.targetMediaId
                        )?.name
                      }
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        <div role="group" aria-label="编辑高级工具">
          <WorkspaceMenu
            label="更多工具"
            items={[
              {
                id: "manual",
                label: "来源段与手工规则",
                onSelect: () => setTool("manual"),
                icon: <SlidersHorizontal size={15} />
              },
              {
                id: "learning",
                label: "算法改进数据",
                onSelect: () => setTool("learning"),
                icon: <Beaker size={15} />
              }
            ]}
          />
        </div>
      </nav>
      {xmlOnly && unplacedXmlCount > 0 ? (
        <div className="editor-notice">
          <span>还有 {unplacedXmlCount} 个 XML 未加入当前时间线。</span>
          <TextButton onClick={startXmlEditing}>加入 XML 并继续编辑</TextButton>
        </div>
      ) : null}
      <div className="editor-main-surface">
        {!xmlOnly && mode === "coverage" ? (
          <MatchCoverageWorkspace
            onManualPosition={() => setTool("manual")}
            key={`${project.id}:${projectEpoch}`}
          />
        ) : xmlOnly || mode === "danmaku" ? (
          <Suspense
            fallback={
              <EditorLoading
                title={xmlOnly ? "正在加载弹幕编辑器" : "正在加载弹幕精修工作台"}
              />
            }
          >
            <DanmakuFineTuneWorkspace />
          </Suspense>
        ) : (
          <AlignmentRelationEditor playbackAdapterFactory={playbackAdapterFactory} />
        )}
      </div>
      <ToolSheet
        title="来源段与手工规则"
        open={tool === "manual"}
        onClose={() => setTool(null)}
        wide
      >
        <div className="editor-tool-workspace">
          <Suspense fallback={<EditorLoading title="正在加载手工工具" />}>
            <ManualAlignmentWorkspace />
          </Suspense>
        </div>
      </ToolSheet>
      <ToolSheet
        title="算法改进数据"
        open={tool === "learning"}
        onClose={() => setTool(null)}
        wide
      >
        <div className="editor-tool-workspace">
          <Suspense fallback={<EditorLoading title="正在加载算法改进数据" />}>
            <AlignmentLearningPanel />
          </Suspense>
        </div>
      </ToolSheet>
    </section>
  );
}

function EditorLoading({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <WorkspaceStatePanel
        state="loading"
        title={title}
        description="当前编辑状态保持不变。"
        className="w-full max-w-md"
      />
    </div>
  );
}
