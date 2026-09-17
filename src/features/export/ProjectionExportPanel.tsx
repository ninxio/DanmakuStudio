import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentProps
} from "react";
import {
  exportTaskChannel,
  createExportSessionKey,
  IDLE_EXPORT_SESSION,
  type ExportSessionState
} from "../../application/backgroundTasks/exportTaskChannel";
import type { EditorProject, MediaMatchCandidate } from "../../domain/project/types";
import { formatTimeMapQualityLevel } from "../../domain/alignment/timeMap";
import { statusLabel } from "../../domain/shared/statusVocabulary";
import { formatTimecode } from "../../domain/shared/time";
import type {
  ProjectionIssue,
  SourceProjectionResult,
  TargetProjectionGroup
} from "../../domain/timeline/sourceProjection";
import {
  formatExportFileError,
  getVerifiedExportUnavailableReason,
  openExportDirectoryPath,
  type SaveTextExportResult
} from "../../infrastructure/file-system/exportFiles";
import { useExportDirectory } from "./useExportDirectory";
import { useEditorStore } from "../../stores/editorStore";
import type { WorkspaceIntentTarget } from "../../application/workspaceIntent";
import { setStatus } from "../assets/assetPanelSharedLogic";
import { ExportDeliveryCenterPresentation } from "./ExportDeliveryCenterPresentation";
import { exportProjectionGroups } from "./exportProjectionService";

type DeliveryCenterModel = ComponentProps<typeof ExportDeliveryCenterPresentation>["model"];
type DeliveryBlocker = DeliveryCenterModel["blockers"][number];
type DeliveryRow = DeliveryCenterModel["rows"][number];

export function ProjectionExportPanel({
  projection,
  project,
  onGoMatching,
  exportGroups = exportProjectionGroups,
  openDirectory = openExportDirectoryPath
}: {
  projection: SourceProjectionResult;
  project: EditorProject;
  onGoMatching: () => void;
  exportGroups?: (
    projection: SourceProjectionResult,
    project: EditorProject
  ) => Promise<SaveTextExportResult | null>;
  openDirectory?: (directoryPath: string) => Promise<void>;
}) {
  const requestWorkspaceIntent = useEditorStore((state) => state.requestWorkspaceIntent);
  const workspaceIntentRequest = useEditorStore((state) => state.workspaceIntentRequest);
  const acknowledgeWorkspaceIntent = useEditorStore(
    (state) => state.acknowledgeWorkspaceIntent
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const sessionKey = createExportSessionKey(project);
  const subscribeToSession = useCallback(
    (listener: () => void) => exportTaskChannel.subscribe(sessionKey, () => listener()),
    [sessionKey]
  );
  const getSessionSnapshot = useCallback(
    () => exportTaskChannel.read(sessionKey) ?? IDLE_EXPORT_SESSION,
    [sessionKey]
  );
  const session = useSyncExternalStore(
    subscribeToSession,
    getSessionSnapshot,
    getSessionSnapshot
  );
  const { directory, error: directoryError } = useExportDirectory();
  const verifiedExportUnavailableReason =
    directoryError || getVerifiedExportUnavailableReason(directory);
  const locationByIssueId = new Map(
    projection.issues.map((issue) => [
      issue.id,
      resolveIssueLocation(issue, project, projection)
    ])
  );
  const model = createDeliveryCenterModel(
    projection,
    project,
    session,
    verifiedExportUnavailableReason,
    locationByIssueId
  );

  useEffect(() => {
    const request = workspaceIntentRequest;
    if (request?.intent.page !== "export" || request.intent.target.kind !== "exportEntry") {
      return;
    }
    const targetMediaId = request.intent.target.targetMediaId;
    const rowIndex = model.rows.findIndex((row) => row.id === targetMediaId);
    const rows = panelRef.current?.querySelectorAll<HTMLElement>(
      '[data-testid="delivery-episode-row"]'
    );
    const row = rowIndex >= 0 ? rows?.item(rowIndex) : null;
    if (row instanceof HTMLDetailsElement) row.open = true;
    const focusTarget = row?.querySelector<HTMLElement>("summary") ?? row;
    focusTarget?.focus({ preventScroll: true });
    focusTarget?.scrollIntoView?.({ block: "nearest" });
    acknowledgeWorkspaceIntent(request.sequence);
  }, [acknowledgeWorkspaceIntent, model.rows, workspaceIntentRequest]);

  const locateIssue = (issueId: string) => {
    const location = locationByIssueId.get(issueId);
    if (!location || location.page === "matching") {
      onGoMatching();
      return;
    }
    if (location.page === "editing" && location.candidateId) {
      requestWorkspaceIntent({
        page: "editing",
        target: { kind: "candidate", candidateId: location.candidateId }
      });
      return;
    }
    if (location.page === "materials" && location.target) {
      requestWorkspaceIntent({ page: "materials", target: location.target });
      return;
    }
    onGoMatching();
  };

  const handleOpenDirectory = () => {
    if (session.result?.mode !== "directory") return;
    void openDirectory(session.result.directoryPath).catch((error) =>
      setStatus({
        message: `打开目录失败：${formatExportFileError(error)}`,
        tone: "error"
      })
    );
  };

  const handleExport = () => {
    if (exportTaskChannel.read(sessionKey)?.phase === "running") return;
    const startedAtMs = Date.now();
    const targetMediaId = project.mediaLibrary.find(
      (media) => media.role === "targetOriginal"
    )?.id;
    const locate = targetMediaId
      ? () =>
          requestWorkspaceIntent({
            page: "export",
            target: { kind: "exportEntry", targetMediaId }
          })
      : undefined;
    exportTaskChannel.publish(sessionKey, {
      phase: "running",
      result: null,
      failureMessage: null,
      startedAtMs,
      updatedAtMs: startedAtMs,
      retry: handleExport,
      locate,
      targetMediaId
    });
    void exportGroups(projection, project)
      .then((result) => {
        if (result) {
          exportTaskChannel.publish(sessionKey, {
            phase: "completed",
            result,
            failureMessage: null,
            startedAtMs,
            updatedAtMs: Date.now(),
            open:
              result.mode === "directory"
                ? () => {
                    void openDirectory(result.directoryPath).catch((error) =>
                      setStatus({
                        message: `打开目录失败：${formatExportFileError(error)}`,
                        tone: "error"
                      })
                    );
                  }
                : undefined,
            locate,
            targetMediaId
          });
          return;
        }
        const status = useEditorStore.getState().status;
        exportTaskChannel.publish(sessionKey, {
          phase: "failed",
          result: null,
          failureMessage:
            status.tone === "error" || status.tone === "warning"
              ? status.message
              : "导出未完成。请查看底部状态，处理后重新导出。",
          startedAtMs,
          updatedAtMs: Date.now(),
          retry: handleExport,
          locate,
          targetMediaId
        });
      })
      .catch((error) => {
        const message = `分集 XML 导出失败：${formatExportFileError(error)}`;
        setStatus({ message, tone: "error" });
        exportTaskChannel.publish(sessionKey, {
          phase: "failed",
          result: null,
          failureMessage: message,
          startedAtMs,
          updatedAtMs: Date.now(),
          retry: handleExport,
          locate,
          targetMediaId
        });
      });
  };

  return (
    <div ref={panelRef} className="contents">
      <ExportDeliveryCenterPresentation
        model={model}
        onIntent={(intent) => {
          if (intent.type === "export-all") {
            handleExport();
          } else if (intent.type === "open-directory") {
            handleOpenDirectory();
          } else {
            locateIssue(intent.issueId);
          }
        }}
      />
    </div>
  );
}

function createDeliveryCenterModel(
  projection: SourceProjectionResult,
  project: EditorProject,
  session: ExportSessionState,
  verifiedExportUnavailableReason: string | null,
  locationByIssueId: ReadonlyMap<string, IssueLocation>
): DeliveryCenterModel {
  const exportableGroups = projection.groups.filter((group) => group.entries.length > 0);
  const reportedActionableIssues = projection.issues.filter(
    (issue) => issue.severity === "error" || projection.status === "empty"
  );
  const actionableIssues: ProjectionIssue[] =
    projection.status === "empty" && reportedActionableIssues.length === 0
      ? [
          {
            id: "delivery-empty-projection",
            severity: "warning",
            segmentId: null,
            message: "还没有可投影的正片来源段。请先在匹配页建立参考素材与原片的关系。"
          }
        ]
      : reportedActionableIssues;
  const blockers = actionableIssues.map((issue): DeliveryBlocker => {
    const location = locationByIssueId.get(issue.id) ?? {
      page: "matching",
      label: "匹配 · 关系队列"
    };
    return {
      id: issue.id,
      message: issue.message,
      targetLabel: findIssueTargetLabel(issue, project, projection),
      locationLabel: location.label
    };
  });
  const environmentBlocked = verifiedExportUnavailableReason !== null;
  const rows = createDeliveryRows(projection, project, session, blockers);
  const firstBlocker = blockers[0] ?? null;
  const primaryAction: DeliveryCenterModel["primaryAction"] = firstBlocker
    ? { type: "locate-blocker", issueId: firstBlocker.id, label: "处理首个问题" }
    : exportableGroups.length === 0
      ? null
      : {
          type: "export-all",
          label:
            session.phase === "completed"
              ? "再次导出全部可用 XML"
              : session.phase === "failed"
                ? "重试导出全部可用 XML"
                : "导出全部可用 XML",
          disabledReason: verifiedExportUnavailableReason
        };
  const summaryState: DeliveryCenterModel["summary"]["state"] = firstBlocker
    ? "blocked"
    : environmentBlocked || exportableGroups.length === 0
      ? "unavailable"
      : "ready";
  const failureMessage = session.failureMessage;
  return {
    summary: {
      state: summaryState,
      badgeLabel: statusLabel(
        projection.status === "empty"
          ? "preparing"
          : summaryState === "blocked"
            ? "blocked"
            : environmentBlocked
              ? "actionRequired"
              : projection.status === "readyWithWarnings"
                ? "reviewRequired"
                : summaryState === "ready"
                  ? "runnable"
                  : "preparing"
      ),
      headline:
        projection.status === "empty"
          ? "先完成来源段与原片关系"
          : summaryState === "blocked"
            ? `先处理 ${blockers.length} 项交付阻断`
            : summaryState === "ready"
              ? `${exportableGroups.length} 集已通过交付检查`
              : environmentBlocked
                ? "当前环境还不能开始正式导出"
                : "先完成来源段与原片关系",
      detail:
        summaryState === "ready"
          ? "导出前仍会重新核验媒体身份并重新解析 XML。"
          : environmentBlocked
            ? "投影内容已就绪；请按下方说明完成导出环境设置后继续。"
            : "从首个异常直接回到负责对象，处理后返回这里继续。",
      exportableCount: exportableGroups.length,
      totalCount: rows.length,
      blockerCount: blockers.length,
      projectedItemCount: projection.projectedItemCount
    },
    availability: environmentBlocked
      ? {
          title: "正式导出暂不可用",
          message: verifiedExportUnavailableReason ?? "当前环境不能完成正式分集导出。"
        }
      : null,
    primaryAction,
    phase: session.phase,
    completion: toCompletion(session.result),
    failureMessage,
    blockers,
    notices: projection.issues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => ({ id: issue.id, message: issue.message })),
    omitted: {
      ignoredItemCount: projection.ignoredItemCount,
      sourceOnlyItemCount: projection.sourceOnlyItemCount,
      unexpectedUnmappedItemCount: projection.unexpectedUnmappedItemCount
    },
    rows
  };
}

function createDeliveryRows(
  projection: SourceProjectionResult,
  project: EditorProject,
  session: ExportSessionState,
  blockers: DeliveryBlocker[]
): DeliveryRow[] {
  const groupByTarget = new Map(projection.groups.map((group) => [group.targetMediaId, group]));
  const issueById = new Map(projection.issues.map((issue) => [issue.id, issue]));
  const mediaTargets = project.mediaLibrary.filter((media) => media.role === "targetOriginal");
  const targets =
    mediaTargets.length > 0
      ? mediaTargets
      : projection.groups.map((group) => ({
          id: group.targetMediaId,
          name: group.targetName,
          fileName: group.targetFileName,
          episodeLabel: group.episodeLabel
        }));
  return targets
    .map((target): DeliveryRow => {
      const group = groupByTarget.get(target.id);
      const projectSegments = project.danmakuSourceSegments.filter(
        (segment) => segment.kind === "content" && segment.targetMediaId === target.id
      );
      const segments = group?.segments.length ? group.segments : projectSegments;
      const rowBlockers = blockers.filter((blocker) => {
        const issue = issueById.get(blocker.id);
        return issue
          ? issueTargetsMedia(issue, target.id, project, projection)
          : projection.status === "empty";
      });
      const exportable = Boolean(group && group.entries.length > 0) && rowBlockers.length === 0;
      const state: DeliveryRow["state"] =
        rowBlockers.length > 0
          ? "blocked"
          : exportable && session.phase === "running"
            ? "running"
            : exportable && session.phase === "completed"
              ? "completed"
              : exportable && session.phase === "failed"
                ? "failed"
                : exportable
                  ? "ready"
                  : "waiting";
      return {
        id: target.id,
        targetLabel: target.episodeLabel
          ? `${target.episodeLabel} · ${target.name}`
          : target.name,
        fileName: group?.exportFileName ?? "等待生成分集 XML",
        sourceSummary: formatSourceRange(segments),
        segmentSummary: `${segments.length} 个来源段`,
        correctionSummary: formatCorrectionSummary(group, project),
        danmakuSummary: `${(group?.entries.length ?? 0).toLocaleString("zh-CN")} 条弹幕`,
        verificationLabel: formatVerificationLabel(segments, project),
        outputLabel: outputLabelForState(state),
        state,
        blockers: rowBlockers
      };
    })
    .sort((left, right) => deliveryRowPriority(left.state) - deliveryRowPriority(right.state));
}

interface IssueLocation {
  page: "materials" | "matching" | "editing";
  candidateId?: string;
  target?: WorkspaceIntentTarget;
  label: string;
}

function resolveIssueLocation(
  issue: ProjectionIssue,
  project: EditorProject,
  projection: SourceProjectionResult
): IssueLocation {
  const segment = issue.segmentId
    ? project.danmakuSourceSegments.find((item) => item.id === issue.segmentId)
    : findTargetIssueSegment(issue, project, projection);
  if (segment && needsMaterialsRoute(segment, project)) {
    const sourceExists = Boolean(
      segment.sourceMediaId &&
      project.mediaLibrary.some((media) => media.id === segment.sourceMediaId)
    );
    const assetExists = Boolean(
      segment.assetId && project.assets.some((asset) => asset.id === segment.assetId)
    );
    const target: WorkspaceIntentTarget = sourceExists
      ? { kind: "media", mediaId: segment.sourceMediaId as string }
      : assetExists
        ? { kind: "xml", assetId: segment.assetId as string }
        : { kind: "media", mediaId: segment.targetMediaId ?? "" };
    return { page: "materials", target, label: `素材 · ${segment.label}` };
  }
  const candidate = segment ? findCandidateForSegment(segment, project) : null;
  if (candidate) {
    const target = project.mediaLibrary.find((media) => media.id === candidate.targetMediaId);
    return {
      page: "editing",
      candidateId: candidate.id,
      label: `编辑 · ${target?.episodeLabel ?? target?.name ?? segment?.label ?? "时间关系"}`
    };
  }
  return { page: "matching", label: "匹配 · 关系队列" };
}

function findCandidateForSegment(
  segment: EditorProject["danmakuSourceSegments"][number],
  project: EditorProject
): MediaMatchCandidate | null {
  const candidates = project.mediaMatchCandidates.filter(
    (candidate) => candidate.state !== "rejected"
  );
  return (
    candidates.find((candidate) => candidate.appliedSegmentIds.includes(segment.id)) ??
    candidates.find(
      (candidate) => segment.timeMapId && candidate.confirmedTimeMapId === segment.timeMapId
    ) ??
    candidates.find(
      (candidate) =>
        candidate.sourceMediaId === segment.sourceMediaId &&
        candidate.targetMediaId === segment.targetMediaId
    ) ??
    null
  );
}

function needsMaterialsRoute(
  segment: EditorProject["danmakuSourceSegments"][number],
  project: EditorProject
): boolean {
  if (!segment.assetId || !project.assets.some((asset) => asset.id === segment.assetId))
    return true;
  if (
    !segment.sourceMediaId ||
    !project.mediaLibrary.some((media) => media.id === segment.sourceMediaId)
  )
    return true;
  return !project.danmakuSourceBindings.some(
    (binding) =>
      binding.assetId === segment.assetId && binding.sourceMediaId === segment.sourceMediaId
  );
}

function findTargetIssueSegment(
  issue: ProjectionIssue,
  project: EditorProject,
  projection: SourceProjectionResult
) {
  const group = projection.groups.find((candidate) =>
    ["target-empty", "target-negative", "target-overflow"].some(
      (kind) => issue.id === `${kind}-${candidate.targetMediaId}`
    )
  );
  if (!group) return undefined;
  return project.danmakuSourceSegments.find(
    (segment) => segment.kind === "content" && segment.targetMediaId === group.targetMediaId
  );
}

function issueTargetsMedia(
  issue: ProjectionIssue,
  targetMediaId: string,
  project: EditorProject,
  projection: SourceProjectionResult
): boolean {
  if (issue.segmentId) {
    return (
      project.danmakuSourceSegments.find((segment) => segment.id === issue.segmentId)
        ?.targetMediaId === targetMediaId
    );
  }
  return projection.groups.some(
    (group) =>
      group.targetMediaId === targetMediaId &&
      ["target-empty", "target-negative", "target-overflow"].some(
        (kind) => issue.id === `${kind}-${group.targetMediaId}`
      )
  );
}

function findIssueTargetLabel(
  issue: ProjectionIssue,
  project: EditorProject,
  projection: SourceProjectionResult
): string {
  const segment = issue.segmentId
    ? project.danmakuSourceSegments.find((item) => item.id === issue.segmentId)
    : findTargetIssueSegment(issue, project, projection);
  const target = segment?.targetMediaId
    ? project.mediaLibrary.find((media) => media.id === segment.targetMediaId)
    : null;
  return target?.episodeLabel
    ? `${target.episodeLabel} · ${target.name}`
    : (target?.name ?? segment?.label ?? "整个交付批次");
}

function formatSourceRange(segments: EditorProject["danmakuSourceSegments"]): string {
  if (segments.length === 0) return "等待建立来源范围";
  const startMs = Math.min(...segments.map((segment) => segment.sourceStartMs));
  const endMs = Math.max(...segments.map((segment) => segment.sourceEndMs));
  return `${formatTimecode(startMs)} – ${formatTimecode(endMs)}`;
}

function formatCorrectionSummary(
  group: TargetProjectionGroup | undefined,
  project: EditorProject
): string {
  const ruleCount = group?.appliedRules.length ?? 0;
  const adjustedItemCount = new Set(
    (group?.entries ?? [])
      .filter((entry) => (project.itemTimeAdjustments[entry.item.id] ?? 0) !== 0)
      .map((entry) => entry.item.id)
  ).size;
  if (ruleCount === 0 && adjustedItemCount === 0) return "没有额外修正";
  return `${ruleCount} 处版本修正 · ${adjustedItemCount} 条精调`;
}

function formatVerificationLabel(
  segments: EditorProject["danmakuSourceSegments"],
  project: EditorProject
): string {
  const maps = segments.flatMap((segment) => {
    if (!segment.timeMapId) return [];
    const timeMap = project.mediaTimeMaps.find((item) => item.id === segment.timeMapId);
    return timeMap ? [timeMap] : [];
  });
  if (segments.length === 0 || maps.length !== segments.length) return "缺少确认时间图";
  const levels = [...new Set(maps.map((timeMap) => timeMap.quality.level))];
  return levels.map((level) => formatTimeMapQualityLevel(level)).join(" / ");
}

function outputLabelForState(state: DeliveryRow["state"]): string {
  if (state === "blocked" || state === "failed") return statusLabel("blocked");
  if (state === "running") return statusLabel("running");
  if (state === "completed") return statusLabel("exported");
  return state === "waiting" ? "待建立关系" : "可导出";
}

function deliveryRowPriority(state: DeliveryRow["state"]): number {
  if (state === "failed" || state === "blocked") return 0;
  if (state === "running") return 1;
  if (state === "ready") return 2;
  return 3;
}

function toCompletion(result: SaveTextExportResult | null): DeliveryCenterModel["completion"] {
  if (!result) return null;
  return {
    fileCount: result.fileCount,
    directoryPath: result.mode === "directory" ? result.directoryPath : null,
    filePath: result.mode === "directory" ? result.filePath : result.downloadedFileName,
    wasRenamed: result.mode === "directory" ? result.wasRenamed : false
  };
}
