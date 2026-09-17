import { useNativeVideoObstruction } from "../../components/useNativeVideoObstruction";
import { ProjectIdentityPanel } from "./ProjectIdentityPanel";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { Clapperboard, FileText, Film, FolderKanban } from "lucide-react";
import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import type { UsabilityViewModel } from "../../domain/project/usabilityViewModel";
import type { EditorProject } from "../../domain/project/types";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";
import type {
  ProjectLibraryIntent,
  ProjectLibrarySessionState
} from "../../application/projectLibrarySessionController";

export function ProjectSidebar({
  project,
  model,
  library,
  onLibraryIntent,
  headingFocusRef
}: {
  project: EditorProject;
  model: UsabilityViewModel;
  library: ProjectLibrarySessionState;
  onLibraryIntent: (intent: ProjectLibraryIntent) => void;
  headingFocusRef?: RefObject<HTMLDivElement>;
}) {
  const obstructionRef = useRef<HTMLElement>(null);
  useNativeVideoObstruction(obstructionRef);
  const ownHeadingRef = useRef<HTMLDivElement | null>(null);
  const headingRef = headingFocusRef ?? ownHeadingRef;
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const matchedTargetIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.kind === "content" && segment.targetMediaId ? [segment.targetMediaId] : []
    )
  );
  const pendingTargetIds = new Set(
    project.mediaMatchCandidates.flatMap((candidate) =>
      candidate.targetMediaId &&
      (candidate.state === "pending" || candidate.state === "blocked")
        ? [candidate.targetMediaId]
        : []
    )
  );
  const episodes = project.mediaLibrary.filter((media) => media.role === "targetOriginal");

  useEffect(() => {
    if (library.recoveryCandidates.length > 0) setLibraryOpen(true);
  }, [library.recoveryCandidates.length]);

  useEffect(() => {
    if (library.focusRequestSequence > 0) headingRef.current?.focus();
  }, [library.focusRequestSequence, headingRef]);

  useEffect(() => {
    if (
      selectedRevision !== null &&
      !library.revisions.some((revision) => revision.revision === selectedRevision)
    ) {
      setSelectedRevision(null);
    }
  }, [library.revisions, selectedRevision]);

  return (
    <aside
      ref={obstructionRef}
      className="flex min-h-0 w-[216px] shrink-0 flex-col border-r border-panel-line bg-surface-canvas"
      aria-label="项目与任务"
      data-testid="project-sidebar"
    >
      <div className="border-b border-panel-line px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-ui-caption font-semibold uppercase tracking-[0.14em] text-content-muted">
            项目与任务
          </span>
          <span
            className={`text-ui-caption ${
              model.issues.length > 0 ? "text-accent-yellow" : "text-accent-green"
            }`}
          >
            {model.issues.length} 项待处理
          </span>
        </div>
        <div
          ref={headingRef}
          tabIndex={-1}
          data-testid="project-sidebar-heading"
          className="flex items-center gap-2 rounded text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
        >
          <FolderKanban size={15} className="text-accent-cyan" />
          <span className="min-w-0 truncate text-xs font-semibold">{model.projectName}</span>
        </div>
        <p className="mt-1 text-ui-caption leading-4 text-content-muted">
          {model.summary.materialSummary}
        </p>
      </div>
      <ProjectIdentityPanel key={project.id} />
      <div className="grid grid-cols-3 gap-1 border-b border-panel-line p-2">
        <SummaryMetric
          icon={<Film size={12} />}
          label="原片"
          value={model.summary.originalCount}
        />
        <SummaryMetric
          icon={<Clapperboard size={12} />}
          label="参考"
          value={model.summary.referenceCount}
        />
        <SummaryMetric
          icon={<FileText size={12} />}
          label="XML"
          value={model.summary.xmlCount}
        />
      </div>
      {library.availability === "browser" ? null : (
        <details
          className="shrink-0 border-b border-panel-line bg-surface-inset"
          open={libraryOpen}
          onToggle={(event) => setLibraryOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer px-3 py-2 text-ui-caption font-semibold text-content-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan">
            本机项目库
            {library.recoveryCandidates.length > 0 ? (
              <span className="ml-2 text-accent-yellow">
                {library.recoveryCandidates.length} 个可恢复
              </span>
            ) : null}
          </summary>
          <div className="grid gap-2 px-2 pb-2">
            <input
              aria-label="搜索本机项目"
              placeholder="搜索项目名称…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="rounded-lg border border-boundary bg-surface-inset px-3 py-2"
            />
            {library.recoveryCandidates.map((candidate) => (
              <div
                key={candidate.recoverySessionId}
                className="rounded border border-accent-yellow/30 bg-accent-yellow/5 p-2"
              >
                <div
                  className="truncate text-ui-caption text-content-secondary"
                  title={candidate.displayName}
                >
                  {candidate.displayName}
                </div>
                <div className="mt-1 text-ui-caption leading-4 text-accent-yellow">
                  {candidate.hasNewerAutosave ? "发现未关闭的自动保存" : "旧版本未关闭会话"}
                  {" · 修订 "}
                  {candidate.recoveryRevision}
                </div>
                <div className="mt-2 flex gap-1">
                  <LibraryButton
                    label={`恢复：${candidate.displayName}`}
                    disabled={library.operation !== "idle"}
                    onClick={() =>
                      onLibraryIntent({
                        kind: "recoverProject",
                        libraryProjectId: candidate.libraryProjectId,
                        recoverySessionId: candidate.recoverySessionId
                      })
                    }
                  >
                    {candidate.hasNewerAutosave ? "恢复" : "恢复打开"}
                  </LibraryButton>
                  {candidate.hasNewerAutosave ? (
                    <LibraryButton
                      label={`放弃恢复：${candidate.displayName}`}
                      disabled={library.operation !== "idle"}
                      onClick={() =>
                        onLibraryIntent({
                          kind: "discardRecovery",
                          libraryProjectId: candidate.libraryProjectId,
                          recoverySessionId: candidate.recoverySessionId
                        })
                      }
                    >
                      放弃
                    </LibraryButton>
                  ) : null}
                </div>
              </div>
            ))}
            {library.recentProjects.length > 0 ? (
              <div>
                <div className="mb-1 text-ui-caption text-content-subtle">最近项目</div>
                <ul className="grid gap-1">
                  {library.recentProjects
                    .filter((recent) =>
                      recent.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase())
                    )
                    .map((recent) => (
                      <li key={recent.libraryProjectId}>
                        <Button
                          tone="unstyled"
                          type="button"
                          aria-label={`打开最近项目：${recent.displayName}`}
                          disabled={library.operation !== "idle"}
                          className="flex w-full items-center justify-between gap-2 rounded border border-panel-line bg-surface-raised px-2 py-1.5 text-left text-ui-caption text-content-secondary hover:border-accent-cyan/40 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                          onClick={() =>
                            onLibraryIntent({
                              kind: "openRecent",
                              libraryProjectId: recent.libraryProjectId
                            })
                          }
                        >
                          <span className="min-w-0 text-sm">
                            <span className="block truncate">{recent.displayName}</span>
                            <span className="mt-1 block text-xs text-content-subtle">
                              {new Date(recent.lastOpenedAtUnixMs).toLocaleString("zh-CN")}
                            </span>
                          </span>
                          <span
                            className={
                              recent.hasRecovery ? "text-accent-yellow" : "text-content-subtle"
                            }
                          >
                            {recent.hasRecovery ? "待恢复" : `r${recent.headRevision}`}
                          </span>
                        </Button>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            {library.activeProject ? (
              <div className="rounded border border-panel-line p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-ui-caption text-content-muted">
                    当前 r{library.activeProject.headRevision}
                  </span>
                  <LibraryButton
                    label="查看项目版本"
                    disabled={library.operation !== "idle"}
                    onClick={() => onLibraryIntent({ kind: "loadRevisions" })}
                  >
                    版本
                  </LibraryButton>
                </div>
                {library.revisionProjectId === library.activeProject.libraryProjectId &&
                library.revisions.length > 0 ? (
                  <fieldset className="mt-2 grid gap-1">
                    <legend className="text-ui-caption text-content-subtle">
                      选择要回退的修订
                    </legend>
                    {library.revisions.map((revision) => (
                      <label
                        key={revision.revision}
                        className="flex items-center gap-2 rounded px-1 py-1 text-ui-caption text-content-muted"
                      >
                        <input
                          type="radio"
                          name="project-library-revision"
                          aria-label={`选择修订 ${revision.revision}`}
                          checked={selectedRevision === revision.revision}
                          onChange={() => setSelectedRevision(revision.revision)}
                        />
                        <span>r{revision.revision}</span>
                        <span className="truncate">
                          {formatRevisionKind(revision.saveKind)}
                        </span>
                      </label>
                    ))}
                    <LibraryButton
                      label={
                        selectedRevision === null
                          ? "请先选择回退修订"
                          : `回退到修订 ${selectedRevision} 并追加新版本`
                      }
                      disabled={selectedRevision === null || library.operation !== "idle"}
                      onClick={() => {
                        if (selectedRevision !== null) {
                          onLibraryIntent({
                            kind: "rollbackToRevision",
                            revision: selectedRevision
                          });
                        }
                      }}
                    >
                      回退并追加
                    </LibraryButton>
                  </fieldset>
                ) : null}
              </div>
            ) : null}
            <p className="text-ui-caption leading-4 text-content-subtle" role="status">
              {library.message}
            </p>
          </div>
        </details>
      )}
      <section className="px-3 py-4">
        <h2 className="mb-3 text-xs font-semibold text-content-muted">
          {model.workflowMode === "xml-only" ? "弹幕文件" : "原片分集"}
        </h2>
        <ul
          className="grid gap-2"
          aria-label={model.workflowMode === "xml-only" ? "弹幕文件" : "原片分集"}
        >
          {model.workflowMode === "xml-only"
            ? project.assets.map((asset) => (
                <li key={asset.id} className="flex items-center gap-2 text-xs">
                  <FileText size={14} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate" title={asset.fileName}>
                    {asset.fileName}
                  </span>
                  <span>{asset.items.length} 条</span>
                </li>
              ))
            : episodes.map((episode) => (
                <li key={episode.id} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate" title={episode.name}>
                    {episode.episodeLabel ? `${episode.episodeLabel} · ` : ""}
                    {episode.name}
                  </span>
                  <EpisodeState
                    status={
                      matchedTargetIds.has(episode.id)
                        ? "matched"
                        : pendingTargetIds.has(episode.id)
                          ? "review"
                          : "waiting"
                    }
                  />
                </li>
              ))}
        </ul>
      </section>
      <div className="border-t border-panel-line px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-ui-caption text-content-muted">项目状态</span>
          <span
            className={`truncate text-ui-caption ${
              model.summary.reviewIssueCount > 0 ? "text-accent-yellow" : "text-accent-green"
            }`}
          >
            {model.summary.resultSummary}
          </span>
        </div>
      </div>
    </aside>
  );
}

function LibraryButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      tone="unstyled"
      type="button"
      aria-label={label}
      disabled={disabled}
      className="rounded border border-panel-line px-1.5 py-1 text-ui-caption text-content-secondary hover:border-accent-cyan/40 hover:text-content-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function formatRevisionKind(
  kind: ProjectLibrarySessionState["revisions"][number]["saveKind"]
): string {
  if (kind === "autosave") return "自动保存";
  if (kind === "rollback") return "版本回退";
  if (kind === "recovered") return "恢复";
  if (kind === "recoveryDiscarded") return "放弃恢复";
  if (kind === "checkpoint") return "手动版本";
  return "创建";
}

function SummaryMetric({
  icon,
  label,
  value
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md bg-surface-inset px-2 py-1.5 text-center">
      <div className="flex items-center justify-center gap-1 text-content-subtle">
        {icon}
        <span className="text-ui-caption">{label}</span>
      </div>
      <div className="mt-0.5 text-xs font-medium text-content-secondary">{value}</div>
    </div>
  );
}

function EpisodeState({ status }: { status: "matched" | "review" | "waiting" }) {
  const vocabulary = getStatusVocabulary(
    status === "matched" ? "confirmed" : status === "review" ? "reviewRequired" : "preparing"
  );
  return (
    <Badge tone={vocabulary.tone} title={vocabulary.description} className="shrink-0">
      {vocabulary.label}
    </Badge>
  );
}
