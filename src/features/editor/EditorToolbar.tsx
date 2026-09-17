import { Button } from "../../components/Button";
import {
  ChevronRight,
  FilePlus,
  FolderOpen,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Save,
  Search,
  Settings,
  Undo2
} from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState, type Ref } from "react";
import { IconButton } from "../../components/IconButton";
import { createUsabilityViewModel } from "../../domain/project/usabilityViewModel";
import { readTextFile } from "../../infrastructure/file-system/browserFiles";
import { savePortableProject } from "../../infrastructure/persistence/projectFiles";
import { useEditorStore } from "../../stores/editorStore";
import { WorkflowStepper } from "../workspace/WorkflowStepper";
import { WindowChrome } from "../workspace/WindowChrome";
import { ProjectActionsMenu } from "../workspace/ProjectActionsMenu";
import { ThemeControl } from "../../components/ThemeControl";
import { WorkflowOverviewDialog } from "./WorkflowOverviewDialog";
import type { ProjectLibrarySessionState } from "../../application/projectLibrarySessionController";
import type { AppLayoutSettings } from "../../infrastructure/settings/appLayoutSettings";

const SettingsDialog = lazy(async () => {
  const module = await import("./SettingsDialog");
  return { default: module.SettingsDialog };
});

export function EditorToolbar({
  projectSidebarCollapsed = false,
  contextPanelCollapsed = false,
  onToggleProjectSidebar,
  onToggleContextPanel,
  onOpenCommandPalette,
  commandPaletteTriggerRef,
  layoutSettings,
  onChangeLayoutSettings
}: {
  projectSidebarCollapsed?: boolean;
  contextPanelCollapsed?: boolean;
  onToggleProjectSidebar?: () => void;
  onToggleContextPanel?: () => void;
  onOpenCommandPalette?: () => void;
  commandPaletteTriggerRef?: Ref<HTMLButtonElement>;
  layoutSettings?: AppLayoutSettings;
  onChangeLayoutSettings?: (patch: Partial<AppLayoutSettings>) => void;
} = {}) {
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const project = useEditorStore((state) => state.project);
  const workspacePage = useEditorStore((state) => state.workspacePage);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const newProject = useEditorStore((state) => state.newProject);
  const openProjectFromText = useEditorStore((state) => state.openProjectFromText);
  const projectLibrary = useEditorStore((state) => state.projectLibrary);
  const requestProjectLibrary = useEditorStore((state) => state.requestProjectLibrary);
  const canUndo = useEditorStore((state) => state.history.past.length > 0);
  const canRedo = useEditorStore((state) => state.history.future.length > 0);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const usabilityModel = useMemo(() => createUsabilityViewModel(project), [project]);

  const useDesktopLibrary =
    projectLibrary.availability === "checking" || projectLibrary.availability === "ready";
  const projectLibraryBusy = useDesktopLibrary && projectLibrary.operation !== "idle";

  const exportBackup = async () => {
    try {
      const path = await savePortableProject(project);
      if (path)
        useEditorStore.setState({
          status: { message: `已保存项目文件：${path}`, tone: "success" }
        });
    } catch (error) {
      useEditorStore.setState({
        status: { message: `项目文件保存失败：${String(error)}`, tone: "error" }
      });
    }
  };

  return (
    <header
      className="shrink-0 border-b border-panel-line bg-surface-canvas"
      aria-label="项目与工作流"
    >
      <WindowChrome />
      <div className="workspace-toolbar" data-testid="toolbar-primary-row">
        <ProjectActionsMenu name={project.name}>
          <Button
            disabled={projectLibraryBusy}
            onClick={() =>
              useDesktopLibrary
                ? requestProjectLibrary({ kind: "createProject" })
                : newProject()
            }
          >
            <FilePlus size={16} />
            新建项目
          </Button>
          <Button
            disabled={projectLibraryBusy}
            onClick={() => projectInputRef.current?.click()}
          >
            <FolderOpen size={16} />
            从备份导入
          </Button>
          <Button onClick={() => void exportBackup()}>
            <Save size={16} />
            导出项目备份
          </Button>
          {onToggleProjectSidebar ? (
            <Button onClick={onToggleProjectSidebar} aria-expanded={!projectSidebarCollapsed}>
              {projectSidebarCollapsed ? (
                <PanelLeftOpen size={16} />
              ) : (
                <PanelLeftClose size={16} />
              )}
              {projectSidebarCollapsed ? "项目与分集" : "关闭项目与分集"}
            </Button>
          ) : null}
          {onToggleContextPanel && workspacePage !== "editing" ? (
            <Button onClick={onToggleContextPanel} aria-expanded={!contextPanelCollapsed}>
              {contextPanelCollapsed ? (
                <PanelRightOpen size={16} />
              ) : (
                <PanelRightClose size={16} />
              )}
              {contextPanelCollapsed ? "当前项目状态" : "关闭当前项目状态"}
            </Button>
          ) : null}
          <Button onClick={() => setWorkflowOpen(true)}>
            <MapIcon size={16} />
            新手引导
            <ChevronRight size={14} className="ml-auto" />
          </Button>
          {layoutSettings && onChangeLayoutSettings ? (
            <div className="mt-1 grid gap-3 border-t border-boundary px-3 py-3 text-sm">
              <label className="flex items-center justify-between gap-3">
                <span>界面密度</span>
                <select
                  aria-label="界面密度"
                  value={layoutSettings.density}
                  onChange={(event) =>
                    onChangeLayoutSettings({
                      density: event.target.value === "compact" ? "compact" : "comfortable"
                    })
                  }
                  className="h-8 border px-2"
                >
                  <option value="comfortable">舒适</option>
                  <option value="compact">紧凑</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={layoutSettings.reduceMotion}
                  onChange={(event) =>
                    onChangeLayoutSettings({ reduceMotion: event.target.checked })
                  }
                />
                减少动态效果
              </label>
            </div>
          ) : null}
        </ProjectActionsMenu>
        <WorkflowStepper
          steps={usabilityModel.steps}
          activePage={workspacePage}
          onChange={setWorkspacePage}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="toolbar-save-state mr-2 max-w-24 truncate text-ui-caption text-content-muted"
            role="status"
            title={projectLibrary.message}
            data-testid="project-library-save-status"
          >
            {formatProjectLibrarySaveStatus(projectLibrary)}
          </span>
          <IconButton
            label="撤销"
            icon={<Undo2 size={16} />}
            disabled={!canUndo}
            onClick={undo}
          />
          <IconButton
            label="重做"
            icon={<Redo2 size={16} />}
            disabled={!canRedo}
            onClick={redo}
          />
          {onOpenCommandPalette ? (
            <IconButton
              ref={commandPaletteTriggerRef}
              label="打开命令与快捷键"
              title="命令与快捷键（Ctrl+K）"
              aria-keyshortcuts="Control+K Meta+K"
              icon={<Search size={16} />}
              onClick={onOpenCommandPalette}
            />
          ) : null}
          <ThemeControl />
          <IconButton
            label="设置"
            icon={<Settings size={17} />}
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </div>
      <input
        ref={projectInputRef}
        className="hidden"
        type="file"
        accept=".json,.danmaku-project.json,application/json"
        data-testid="project-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void readTextFile(file)
              .then((content) => {
                if (useDesktopLibrary) {
                  requestProjectLibrary({
                    kind: "importBackup",
                    text: content,
                    sourceFileName: file.name
                  });
                } else {
                  openProjectFromText(content, file.name);
                }
              })
              .catch((error: unknown) => {
                useEditorStore.setState({
                  status: createFileReadErrorStatus("项目文件读取失败", error)
                });
              });
          }
          event.target.value = "";
        }}
      />
      {settingsOpen ? (
        <Suspense
          fallback={
            <div
              role="status"
              aria-label="正在打开设置"
              className="fixed right-3 top-14 z-40 rounded-control border border-boundary bg-surface-raised px-3 py-2 text-ui-helper text-content-muted shadow-workspace"
            >
              正在打开设置…
            </div>
          }
        >
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      ) : null}
      {workflowOpen ? (
        <WorkflowOverviewDialog
          onClose={() => setWorkflowOpen(false)}
          onImportVideo={() => {
            setWorkspacePage("materials");
            setWorkflowOpen(false);
          }}
          onImportXml={() => {
            setWorkspacePage("materials");
            setWorkflowOpen(false);
          }}
          onGoMatching={() => setWorkspacePage("matching")}
          onGoEditing={() => setWorkspacePage("editing")}
          onSaveProject={() => void exportBackup()}
          onExportXml={() => {
            setWorkspacePage("export");
          }}
        />
      ) : null}
    </header>
  );
}

function formatProjectLibrarySaveStatus(state: ProjectLibrarySessionState): string {
  if (state.saveStatus === "saving") return "保存中";
  if (state.saveStatus === "failed") return "保存失败";
  if (state.recoveryCandidates.length > 0 || state.saveStatus === "recoverable") {
    return "可恢复";
  }
  if (state.saveStatus === "saved") return "已保存";
  return state.availability === "browser" ? "备份文件模式" : "等待保存";
}

function createFileReadErrorStatus(
  prefix: string,
  error: unknown
): { message: string; tone: "error" } {
  if (error instanceof Error && error.message.trim().length > 0) {
    return { message: `${prefix}：${error.message}`, tone: "error" };
  }
  return { message: `${prefix}。`, tone: "error" };
}
