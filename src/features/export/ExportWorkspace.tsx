import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { WorkspaceTabs } from "../../components/WorkspaceTabs";
import { ExportSummary } from "./ExportSummary";
import { FamilyExportPanel } from "./FamilyExportPanel";
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  readPublicationDelivery,
  subscribePublicationDelivery,
  restorePublicationDelivery,
  readPublicationPersistence
} from "../../application/publicationDelivery";
import { LogVarLibraryDialog } from "./LogVarLibraryDialog";
import { TextButton } from "../../components/TextButton";
import { WorkspaceStatePanel } from "../../components/WorkspaceStatePanel";
import { createProjectHealthSummary } from "../../domain/project/health";
import { createProjectReadinessSummary } from "../../domain/project/readiness";
import { isXmlOnlyProject } from "../../domain/project/workflowMode";
import { projectDanmakuToTargets } from "../../domain/timeline/sourceProjection";
import { inspectXmlTimeline } from "../../domain/timeline/xmlTimeline";
import { useEditorStore } from "../../stores/editorStore";
import { ExportReadinessPanel } from "./ExportReadinessPanel";
import { ProjectionExportPanel } from "./ProjectionExportPanel";

const CompatibilityExportPanel = lazy(async () => {
  const module = await import("./CompatibilityExportPanel");
  return { default: module.CompatibilityExportPanel };
});

export function ExportWorkspace() {
  const project = useEditorStore((state) => state.project);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  return <ExportWorkspaceSession key={`${project.id}:${projectEpoch}`} />;
}

function ExportWorkspaceSession() {
  const project = useEditorStore((state) => state.project);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const [compatibilityLoaded, setCompatibilityLoaded] = useState(false);
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const persistence = useSyncExternalStore(
    subscribePublicationDelivery,
    readPublicationPersistence
  );
  useEffect(() => {
    void restorePublicationDelivery(project.id);
  }, [project.id]);
  const delivery = useSyncExternalStore(
    subscribePublicationDelivery,
    readPublicationDelivery,
    readPublicationDelivery
  );
  const currentDelivery = delivery?.projectId === project.id ? delivery : null;
  const [view, setView] = useState<"timeline" | "family">(
    project.familyArrangement ? "family" : "timeline"
  );
  const sourceProjection = useMemo(() => projectDanmakuToTargets(project), [project]);
  return (
    <div className="workspace-page text-xs text-content-muted">
      {project.familyArrangement ? (
        <div className="workspace-bar">
          <WorkspaceTabs
            label="导出内容"
            value={view}
            onChange={setView}
            items={[
              { id: "family", label: "分集安排" },
              { id: "timeline", label: isXmlOnlyProject(project) ? "当前时间线" : "原片投影" }
            ]}
          />
        </div>
      ) : null}
      {view === "family" && project.familyArrangement ? (
        <div className="page-scroll thin-scrollbar">
          <FamilyExportPanel />
        </div>
      ) : isXmlOnlyProject(project) ? (
        <XmlTimelineExportPanel />
      ) : (
        <div className="min-h-0 flex-1">
          <ProjectionExportPanel
            projection={sourceProjection}
            project={project}
            onGoMatching={() => setWorkspacePage("matching")}
          />
        </div>
      )}
      <div className="matching-tools-bar">
        <TextButton
          disabled={!currentDelivery}
          onClick={() => setPublishOpen(true)}
          title={currentDelivery ? "发布上次导出的成品快照" : "先导出 XML，再发布成品"}
        >
          发布到私人弹幕库
        </TextButton>
        <TextButton onClick={() => setLibraryOpen(true)}>管理私人弹幕库</TextButton>
        {persistence && (
          <span role="status" className="text-xs text-content-muted">
            {persistence}
          </span>
        )}
        <WorkspaceMenu
          label="导出工具"
          items={[
            {
              id: "compatibility",
              label: "单文件导出与高级检查",
              onSelect: () => {
                setCompatibilityLoaded(true);
                setCompatibilityOpen(true);
              }
            }
          ]}
        />
      </div>
      {publishOpen && currentDelivery ? (
        <LogVarLibraryDialog delivery={currentDelivery} onClose={() => setPublishOpen(false)} />
      ) : null}
      {libraryOpen && <LogVarLibraryDialog onClose={() => setLibraryOpen(false)} />}
      {compatibilityLoaded ? (
        <Suspense
          fallback={
            <WorkspaceStatePanel
              state="loading"
              title="正在加载兼容导出工具"
              description="当前导出工作区保持可用。"
            />
          }
        >
          <CompatibilityExportPanel
            open={compatibilityOpen}
            onClose={() => setCompatibilityOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function XmlTimelineExportPanel() {
  const project = useEditorStore((state) => state.project);
  const startXmlEditing = useEditorStore((state) => state.startXmlEditing);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const cleanupEditReferences = useEditorStore((state) => state.cleanupProjectEditReferences);
  const cleanupMissingClips = useEditorStore((state) => state.cleanupProjectMissingAssetClips);
  const health = useMemo(() => createProjectHealthSummary(project), [project]);
  const readiness = useMemo(() => createProjectReadinessSummary(project), [project]);
  const coverage = useMemo(() => inspectXmlTimeline(project), [project]);
  return (
    <div className="page-scroll thin-scrollbar">
      <div className="grid gap-3">
        <section className="text-sm text-content-secondary" data-testid="xml-only-export-panel">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold text-content-primary">
                导出当前弹幕时间线
              </h2>
              <p className="mt-2 max-w-2xl leading-6 text-content-muted">
                保存你的编辑结果。导出前会重新核验 XML，原始文件保持不变。
              </p>
              <p className="mt-2 text-ui-caption text-content-muted">
                已加入时间线 {coverage.placedAssetCount} / {coverage.assetCount} 个 XML ·{" "}
                {project.clips.length} 个片段
                {coverage.disabledAssetCount > 0
                  ? ` · ${coverage.disabledAssetCount} 个 XML 的片段全部禁用`
                  : ""}
              </p>
            </div>
            {project.clips.length === 0 && project.assets.length > 0 ? (
              <TextButton tone="primary" onClick={startXmlEditing}>
                建立时间线并开始编辑
              </TextButton>
            ) : project.assets.length === 0 ? (
              <TextButton tone="primary" onClick={() => setWorkspacePage("materials")}>
                去导入弹幕 XML
              </TextButton>
            ) : null}
          </div>
          {coverage.unplacedAssets.length > 0 && project.clips.length > 0 ? (
            <div
              className="mt-3 rounded border border-feedback-warning/30 bg-feedback-warning/10 p-3"
              role="status"
            >
              <p>
                还有 {coverage.unplacedAssets.length} 个 XML
                未加入时间线，本次导出不会包含它们。
              </p>
              <p className="mt-1 break-words text-content-muted">
                {coverage.unplacedAssets.map((asset) => asset.fileName).join("、")}
              </p>
              <TextButton className="mt-2" onClick={startXmlEditing}>
                加入剩余 XML 并编辑
              </TextButton>
            </div>
          ) : null}
        </section>
        {project.clips.length > 0 ? <ExportSummary inline /> : null}
        <details className="export-check-details">
          <summary>项目检查与修复</summary>
          <ExportReadinessPanel
            projectName={project.name}
            reportSummary={health}
            readiness={readiness}
            onCleanupEditReferences={cleanupEditReferences}
            onCleanupMissingAssetClips={cleanupMissingClips}
          />
        </details>
      </div>
    </div>
  );
}
