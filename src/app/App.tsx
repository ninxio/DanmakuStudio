import { ToolSheet } from "../components/ToolSheet";
import { Panel } from "../components/Panel";
import { TextButton } from "../components/TextButton";
import { Dialog } from "../components/Dialog";
import { applicationTaskRegistry } from "../application/backgroundTasks/applicationTaskRegistry";
import { createShellTaskRegistrations } from "../application/backgroundTasks/shellTaskModel";
import { createUsabilityViewModel } from "../domain/project/usabilityViewModel";
import { isSupportedMediaPath } from "../domain/project/mediaFormat";
import { isXmlOnlyProject } from "../domain/project/workflowMode";
import { EditorToolbar } from "../features/editor/EditorToolbar";
import { KeyboardShortcuts } from "../features/editor/KeyboardShortcuts";
import { BackgroundTaskBar } from "../features/workspace/BackgroundTaskBar";
import { CommandPalette } from "../features/workspace/CommandPalette";
import { MediaInventoryLifecycle } from "../features/workspace/MediaInventoryLifecycle";
import { ProjectLibraryLifecycle } from "../features/workspace/ProjectLibraryLifecycle";
import { ContextRail } from "../features/workspace/ContextRail";
import { ProjectSidebar } from "../features/workspace/ProjectSidebar";
import {
  createWorkspaceCommands,
  type WorkspaceCommandIntent
} from "../features/workspace/workspaceCommands";
import {
  formatExportFileError,
  openExportDirectoryPath
} from "../infrastructure/file-system/exportFiles";
import {
  formatDesktopSettingsError,
  hydrateDesktopAppSettings
} from "../infrastructure/settings/desktopAppSettings";
import {
  loadAppLayoutSettings,
  saveAppLayoutSettings,
  type AppLayoutSettings
} from "../infrastructure/settings/appLayoutSettings";
import { useEditorStore } from "../stores/editorStore";
import type { DragEvent as ReactDragEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

const ExportDialog = lazy(async () => {
  const module = await import("../features/export/ExportDialog");
  return { default: module.ExportDialog };
});

const MaterialsWorkspace = lazy(async () => {
  const module = await import("../features/assets/MaterialsWorkspace");
  return { default: module.MaterialsWorkspace };
});

const MatchingWorkspace = lazy(async () => {
  const module = await import("../features/matching/MatchingWorkspace");
  return { default: module.MatchingWorkspace };
});

const AlignmentEditorWorkspace = lazy(async () => {
  const module = await import("../features/editor/AlignmentEditorWorkspace");
  return { default: module.AlignmentEditorWorkspace };
});

const ExportWorkspace = lazy(async () => {
  const module = await import("../features/export/ExportWorkspace");
  return { default: module.ExportWorkspace };
});

const MultimodalRuleSnapshotAutoArchive = lazy(async () => {
  const module = await import("../features/workspace/MultimodalRuleSnapshotAutoArchive");
  return { default: module.MultimodalRuleSnapshotAutoArchive };
});

export function App() {
  const status = useEditorStore((state) => state.status);
  const project = useEditorStore((state) => state.project);
  const importProgress = useEditorStore((state) => state.importProgress);
  const exportDraft = useEditorStore((state) => state.exportDraft);
  const workspacePage = useEditorStore((state) => state.workspacePage);
  const canUndo = useEditorStore((state) => state.history.past.length > 0);
  const canRedo = useEditorStore((state) => state.history.future.length > 0);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const importXmlFiles = useEditorStore((state) => state.importXmlFiles);
  const importMediaFiles = useEditorStore((state) => state.importMediaFiles);
  const projectLibrary = useEditorStore((state) => state.projectLibrary);
  const requestProjectLibrary = useEditorStore((state) => state.requestProjectLibrary);
  const mediaInventoryPhase = useEditorStore((state) => state.mediaInventoryPhase);
  const mediaInventoryCounts = useEditorStore((state) => state.mediaInventoryCounts);
  const mediaInventoryRows = useEditorStore((state) => state.mediaInventoryRows);
  const mediaInventoryCancelling = useEditorStore((state) => state.mediaInventoryCancelling);
  const mediaInventoryRestartRequired = useEditorStore(
    (state) => state.mediaInventoryRestartRequired
  );
  const mediaInventoryTerminalMessage = useEditorStore(
    (state) => state.mediaInventoryTerminalMessage
  );
  const workspaceRef = useRef<HTMLElement | null>(null);
  const projectHeadingRef = useRef<HTMLDivElement>(null);
  const commandPaletteTriggerRef = useRef<HTMLButtonElement>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [pendingDroppedMedia, setPendingDroppedMedia] = useState<File[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [layoutSettings, setLayoutSettings] = useState<AppLayoutSettings>(() => ({
    ...loadAppLayoutSettings(),
    projectSidebarCollapsed: true,
    contextPanelCollapsed: true
  }));
  const recoverySessionKey = projectLibrary.recoveryCandidates
    .map((candidate) => candidate.recoverySessionId)
    .sort()
    .join("|");
  const libraryFocusSequence = projectLibrary.focusRequestSequence;
  useEffect(() => {
    if (recoverySessionKey)
      setLayoutSettings((current) => ({
        ...current,
        projectSidebarCollapsed: false,
        contextPanelCollapsed: true
      }));
  }, [recoverySessionKey]);
  useEffect(() => {
    if (libraryFocusSequence > 0)
      setLayoutSettings((current) => ({
        ...current,
        projectSidebarCollapsed: false,
        contextPanelCollapsed: true
      }));
  }, [libraryFocusSequence]);
  const usabilityModel = useMemo(() => createUsabilityViewModel(project), [project]);
  const xmlOnlyWorkflow = isXmlOnlyProject(project);
  const workspaceCommands = useMemo(
    () =>
      createWorkspaceCommands({
        currentPage: workspacePage,
        canUndo,
        canRedo,
        projectSidebarCollapsed: layoutSettings.projectSidebarCollapsed,
        contextPanelCollapsed: layoutSettings.contextPanelCollapsed
      }),
    [
      canRedo,
      canUndo,
      layoutSettings.contextPanelCollapsed,
      layoutSettings.projectSidebarCollapsed,
      workspacePage
    ]
  );

  useEffect(() => {
    let mounted = true;
    void hydrateDesktopAppSettings().catch((error) => {
      if (!mounted) {
        return;
      }
      useEditorStore.setState({
        status: {
          message: `读取桌面应用设置失败，已使用浏览器本地设置：${formatDesktopSettingsError(error)}`,
          tone: "warning"
        }
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(layoutSettings.reduceMotion);
  }, [layoutSettings.reduceMotion]);

  const runStatusAction = useCallback(() => {
    if (status.action?.type !== "openDirectory") {
      return;
    }
    void openExportDirectoryPath(status.action.directoryPath).catch((error) => {
      useEditorStore.setState({
        status: {
          message: `打开导出文件夹失败：${formatExportFileError(error)}`,
          tone: "error"
        }
      });
    });
  }, [status.action]);

  useEffect(() => {
    const firstIssueMediaId =
      Object.values(mediaInventoryRows).find(
        (row) => row.status === "failed" || row.status === "notEligible"
      )?.mediaId ?? null;
    applicationTaskRegistry.replaceSource(
      "shell",
      createShellTaskRegistrations({
        status,
        importProgress,
        inventory: {
          phase: mediaInventoryPhase,
          counts: mediaInventoryCounts,
          cancelling: mediaInventoryCancelling,
          restartRequired: mediaInventoryRestartRequired,
          terminalMessage: mediaInventoryTerminalMessage,
          firstIssueMediaId
        },
        projectLibrary,
        actions: {
          cancelInventory: () => useEditorStore.getState().cancelMediaInventory(),
          retryInventory: () => useEditorStore.getState().refreshMediaInventory(),
          retrySave: () =>
            useEditorStore.getState().requestProjectLibrary({ kind: "retrySave" }),
          locateInventoryIssue: () => {
            if (!firstIssueMediaId) return;
            useEditorStore.getState().requestWorkspaceIntent({
              page: "materials",
              target: { kind: "audioIssue", mediaId: firstIssueMediaId }
            });
          },
          runStatusAction
        }
      })
    );
  }, [
    importProgress,
    mediaInventoryCancelling,
    mediaInventoryCounts,
    mediaInventoryPhase,
    mediaInventoryRestartRequired,
    mediaInventoryRows,
    mediaInventoryTerminalMessage,
    projectLibrary,
    runStatusAction,
    status
  ]);

  useEffect(() => () => applicationTaskRegistry.clearSource("shell"), []);

  const updateLayoutSettings = (patch: Partial<AppLayoutSettings>) => {
    setLayoutSettings((current) => saveAppLayoutSettings({ ...current, ...patch }));
  };

  const runWorkspaceCommand = (intent: WorkspaceCommandIntent): void => {
    switch (intent.type) {
      case "navigate":
        setWorkspacePage(intent.page);
        break;
      case "undo":
        useEditorStore.getState().undo();
        break;
      case "redo":
        useEditorStore.getState().redo();
        break;
      case "toggle-project-sidebar":
        updateLayoutSettings({
          projectSidebarCollapsed: !layoutSettings.projectSidebarCollapsed
        });
        break;
      case "toggle-context-panel":
        updateLayoutSettings({
          contextPanelCollapsed: !layoutSettings.contextPanelCollapsed
        });
        break;
    }
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (projectLibrary.switchingProject) return;
    const files = Array.from(event.dataTransfer.files);
    const xmlFiles = files.filter(isXmlFile);
    const mediaFiles = files.filter(isSupportedReferenceMediaFile);
    if (mediaFiles.length > 0) {
      setPendingDroppedMedia(mediaFiles);
      useEditorStore.setState({
        status: {
          message: `已收到 ${mediaFiles.length} 个媒体文件，请确认它们是原片素材还是参考素材。`,
          tone: "neutral"
        }
      });
    }
    if (xmlFiles.length > 0) {
      void importXmlFiles(xmlFiles);
    }
    if (mediaFiles.length === 0 && xmlFiles.length === 0) {
      useEditorStore.setState({
        status: {
          message: "拖放文件未导入：请拖入 Bilibili XML 或受支持的视频、音频文件。",
          tone: "warning"
        }
      });
      return;
    }
    setWorkspacePage("materials");
  };

  return (
    <div
      className={`app-shell relative flex h-screen min-h-0 flex-col bg-surface-canvas text-content-primary ${
        layoutSettings.reduceMotion ? "reduce-motion" : ""
      }`}
      data-testid="app-root"
      data-density={layoutSettings.density}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <KeyboardShortcuts onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
      <ProjectLibraryLifecycle />
      <MediaInventoryLifecycle />
      <Suspense fallback={null}>
        <MultimodalRuleSnapshotAutoArchive project={project} />
      </Suspense>
      <EditorToolbar
        layoutSettings={layoutSettings}
        onChangeLayoutSettings={updateLayoutSettings}
        projectSidebarCollapsed={layoutSettings.projectSidebarCollapsed}
        contextPanelCollapsed={layoutSettings.contextPanelCollapsed}
        onToggleProjectSidebar={() =>
          updateLayoutSettings({
            projectSidebarCollapsed: !layoutSettings.projectSidebarCollapsed
          })
        }
        onToggleContextPanel={() =>
          updateLayoutSettings({
            contextPanelCollapsed: !layoutSettings.contextPanelCollapsed
          })
        }
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        commandPaletteTriggerRef={commandPaletteTriggerRef}
      />
      {commandPaletteOpen ? (
        <CommandPalette
          commands={workspaceCommands}
          onClose={() => setCommandPaletteOpen(false)}
          onExecute={runWorkspaceCommand}
          returnFocusRef={commandPaletteTriggerRef}
        />
      ) : null}
      {dragActive ? (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded border-2 border-dashed border-accent-cyan bg-surface-canvas/70 text-center text-sm text-content-secondary shadow-2xl">
          <div className="grid gap-2">
            <div className="text-base font-medium text-content-primary">拖放导入</div>
            <div className="text-xs text-content-muted">
              支持 Bilibili XML、视频和音频；媒体放下后需要确认素材角色。
            </div>
          </div>
        </div>
      ) : null}
      {pendingDroppedMedia.length > 0 ? (
        <Dialog
          ariaLabelledBy="drop-role-title"
          onClose={() => setPendingDroppedMedia([])}
          overlayClassName="bg-surface-canvas/75 p-6"
          className="w-full max-w-md rounded border-panel-line bg-surface-raised p-4"
        >
          <h2 id="drop-role-title" className="text-base font-semibold text-content-primary">
            确认媒体角色
          </h2>
          <p className="mt-2 text-sm leading-6 text-content-muted">
            共 {pendingDroppedMedia.length}{" "}
            个媒体文件。原片素材代表最终观看的标准时间轴；参考素材只用于确定弹幕原始时间和删减关系。
          </p>
          <p className="mt-2 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-xs leading-5 text-accent-yellow">
            拖放文件会作为本次会话的临时引用。若要保存本地路径并运行自动匹配，请改用素材页的批量导入按钮。纯音频可正常匹配和试听，但没有画面复核。
          </p>
          <div className="mt-3 max-h-32 overflow-auto rounded border border-panel-line bg-surface-inset p-2 text-xs text-content-muted">
            {pendingDroppedMedia.map((file) => (
              <div key={`${file.name}-${file.size}`}>{file.name}</div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <TextButton onClick={() => setPendingDroppedMedia([])}>取消</TextButton>
            <TextButton
              onClick={() => {
                importMediaFiles(pendingDroppedMedia, "bilibiliReference");
                setPendingDroppedMedia([]);
              }}
            >
              作为 B 站参考导入
            </TextButton>
            <TextButton
              tone="primary"
              onClick={() => {
                importMediaFiles(pendingDroppedMedia, "targetOriginal");
                setPendingDroppedMedia([]);
              }}
            >
              作为原片导入
            </TextButton>
          </div>
        </Dialog>
      ) : null}
      {workspacePage === "editing" && xmlOnlyWorkflow ? (
        <main
          className="app-workspace-frame flex min-h-0 flex-1 overflow-hidden"
          aria-label="编辑工作台"
          data-testid="workspace-editing"
        >
          <div className="app-workspace-gutter min-w-0 flex-1 overflow-hidden bg-surface-canvas">
            <div className="workspace-content mx-auto w-full max-w-none">
              <Panel className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-xs text-content-muted">
                      正在打开弹幕编辑器…
                    </div>
                  }
                >
                  <AlignmentEditorWorkspace />
                </Suspense>
              </Panel>
            </div>
          </div>
        </main>
      ) : workspacePage === "editing" ? (
        <main
          ref={workspaceRef}
          className="app-workspace-frame app-workspace-gutter flex min-h-0 flex-1 overflow-hidden"
          aria-label="编辑工作台"
          data-testid="workspace-editing"
        >
          <Panel className="min-h-0 min-w-0 flex-1">
            <Suspense fallback={<WorkspaceRouteFallback label="正在打开覆盖分析…" />}>
              <AlignmentEditorWorkspace />
            </Suspense>
          </Panel>
        </main>
      ) : (
        <main
          className="app-workspace-frame flex min-h-0 flex-1 overflow-hidden"
          aria-label={
            workspacePage === "materials"
              ? "素材工作台"
              : workspacePage === "matching"
                ? "匹配工作台"
                : "导出工作台"
          }
          data-testid={`workspace-${workspacePage}`}
        >
          <div className="app-workspace-gutter min-w-0 flex-1 overflow-hidden bg-surface-canvas">
            <div className="workspace-content mx-auto w-full max-w-none">
              <Panel className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <WorkspaceRouteFallback
                      label={
                        workspacePage === "materials"
                          ? "正在打开素材工作台…"
                          : workspacePage === "matching"
                            ? "正在打开匹配工作台…"
                            : "正在打开导出工作台…"
                      }
                    />
                  }
                >
                  {workspacePage === "materials" ? (
                    <MaterialsWorkspace />
                  ) : workspacePage === "matching" ? (
                    <MatchingWorkspace />
                  ) : (
                    <ExportWorkspace />
                  )}
                </Suspense>
              </Panel>
            </div>
          </div>
        </main>
      )}
      <ToolSheet
        initialFocusRef={projectHeadingRef}
        title="项目与分集"
        open={!layoutSettings.projectSidebarCollapsed}
        onClose={() => updateLayoutSettings({ projectSidebarCollapsed: true })}
      >
        <ProjectSidebar
          headingFocusRef={projectHeadingRef}
          project={project}
          model={usabilityModel}
          library={projectLibrary}
          onLibraryIntent={requestProjectLibrary}
        />
      </ToolSheet>
      <ToolSheet
        title="当前项目状态"
        open={!layoutSettings.contextPanelCollapsed}
        onClose={() => updateLayoutSettings({ contextPanelCollapsed: true })}
      >
        <ContextRail model={usabilityModel} pageId={workspacePage} />
      </ToolSheet>
      <BackgroundTaskBar />
      {exportDraft && !(xmlOnlyWorkflow && workspacePage === "export") ? (
        <Suspense fallback={null}>
          <ExportDialog />
        </Suspense>
      ) : null}
      {projectLibrary.switchingProject ? (
        <Dialog
          ariaLabel="正在切换项目"
          onClose={() => undefined}
          closeOnEscape={false}
          className="max-w-sm p-6"
        >
          <p role="status">正在保存并切换项目，请稍候…</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function WorkspaceRouteFallback({ label }: { label: string }) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center bg-panel-base text-xs text-content-muted"
      role="status"
      data-testid="workspace-route-loading"
    >
      {label}
    </div>
  );
}

function hasFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isXmlFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".xml") || file.type === "text/xml" || file.type === "application/xml";
}

function isSupportedReferenceMediaFile(file: File): boolean {
  return (
    isSupportedMediaPath(file.name) ||
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/")
  );
}
