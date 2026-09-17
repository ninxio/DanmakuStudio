import { Button } from "../../components/Button";
import {
  ArrowRight,
  Crosshair,
  FolderOpen,
  FileAudio,
  FileText,
  Search,
  Trash2,
  Video,
  WandSparkles
} from "lucide-react";
import { useState } from "react";
import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { ToolSheet } from "../../components/ToolSheet";
import { TextButton } from "../../components/TextButton";
import { statusLabel } from "../../domain/shared/statusVocabulary";
import { formatTimecode } from "../../domain/shared/time";
import {
  formatMediaBindingEpisode,
  formatMediaBindingSource,
  formatMediaBindingTitle,
  formatMediaSourceSummary
} from "../../domain/project/mediaBinding";
import {
  formatProjectMatchScore,
  type ProjectMatchAssessment,
  type ProjectMatchCriterionState
} from "../../domain/project/matchAssessment";
import type {
  MediaBinding,
  MediaReference,
  ProjectMediaReference,
  ProjectMediaRole
} from "../../domain/project/types";
import { EmptyState, Row } from "./assetPanelShared";
import type {
  MediaAudioPreparationViewModel,
  MediaLibraryItemViewModel
} from "./materialsPanelModels";

export function TargetMediaBindingPanel({
  binding,
  media,
  mediaLibrary,
  validating,
  onBindLocalPath,
  onValidateEmby,
  onClear
}: {
  binding: MediaBinding | null;
  media: MediaReference | null;
  mediaLibrary: ProjectMediaReference[];
  validating: boolean;
  onBindLocalPath: () => void;
  onValidateEmby: () => void;
  onClear: () => void;
}) {
  const bindingMedia =
    binding?.kind === "localFile" && binding.mediaId
      ? mediaLibrary.find((candidate) => candidate.id === binding.mediaId)
      : null;
  const localBindingConnected =
    binding?.kind === "localFile" &&
    (Boolean(binding.localPath) ||
      Boolean(bindingMedia?.objectUrl) ||
      (Boolean(media?.objectUrl) &&
        (binding.mediaId
          ? media?.id === binding.mediaId
          : media?.fileName === binding.fileName)));
  const statusText = !binding
    ? "未绑定"
    : binding.kind === "localFile"
      ? localBindingConnected
        ? "本地文件已连接"
        : "需要重新选择本地媒体"
      : "Emby 条目已保存";
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex items-center gap-2">
        <Crosshair size={16} className="text-accent-cyan" />
        <h3 className="text-sm font-medium text-content-primary">目标原片（完整版）</h3>
        <span className="ml-auto rounded border border-panel-line bg-surface-inset px-2 py-0.5 text-ui-caption text-content-muted">
          {statusText}
        </span>
      </div>
      <p className="mt-2 leading-5 text-content-muted">
        {binding
          ? "后续匹配评分、对齐和导出检查会以这里保存的完整版作为目标来源。"
          : "绑定本地完整版或 Emby 条目后，项目会记住弹幕最终要对齐到哪一部、哪一集。"}
      </p>
      {binding ? (
        <dl className="mt-3 grid gap-2">
          <Row label="名称" value={formatMediaBindingTitle(binding)} />
          <Row label="来源" value={formatMediaBindingSource(binding)} />
          <Row label="位置" value={formatMediaBindingEpisode(binding)} />
          <Row
            label="时长"
            value={binding.runtimeMs === null ? "未知" : formatTimecode(binding.runtimeMs)}
          />
          {binding.kind === "localFile" ? (
            <Row
              label="本地路径"
              value={binding.localPath ? binding.localPath : "未保存路径"}
            />
          ) : null}
          {binding.kind === "embyItem" ? (
            <>
              <Row label="条目 ID" value={binding.itemId} />
              <Row
                label="媒体源"
                value={
                  binding.mediaSources[0]
                    ? formatMediaSourceSummary(binding.mediaSources[0])
                    : "暂未读取"
                }
              />
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <TextButton onClick={onBindLocalPath}>
          <FolderOpen size={14} />
          选择本地路径
        </TextButton>
        {binding?.kind === "embyItem" ? (
          <TextButton onClick={onValidateEmby} disabled={validating}>
            <Search size={14} />
            {validating ? "验证中" : "验证 Emby"}
          </TextButton>
        ) : null}
        {binding ? (
          <TextButton tone="danger" onClick={onClear}>
            <Trash2 size={14} />
            解除绑定
          </TextButton>
        ) : null}
      </div>
    </section>
  );
}

export function MediaLibrarySection({
  title,
  description,
  role,
  mediaItems,
  onImportFromEmby,
  onDropFiles,
  onReconnect,
  onDelete,
  onAudioSelection,
  onDetailsSummaryRef
}: {
  title: string;
  description: string;
  role: ProjectMediaRole;
  mediaItems: MediaLibraryItemViewModel[];
  onImportFromEmby?: () => void;
  onDropFiles: (files: FileList) => void;
  onReconnect: (mediaId: string) => void;
  onDelete: (mediaId: string) => void;
  onAudioSelection: (mediaId: string, value: string) => void;
  onDetailsSummaryRef: (mediaId: string, element: HTMLElement | null) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const issueItems = mediaItems.filter(
    (media) => media.reconnectWarning || media.audioPreparation.tone !== "success"
  );
  const normalItems = mediaItems.filter(
    (media) => !media.reconnectWarning && media.audioPreparation.tone === "success"
  );
  return (
    <section
      className={`media-list-surface text-sm text-content-secondary transition ${
        dropActive ? "border-accent-cyan bg-accent-cyan/10" : "border-panel-line bg-panel-soft"
      }`}
      data-testid={`${role}-dropzone`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          setDropActive(true);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDropActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        onDropFiles(event.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-2">
        <Video
          size={16}
          className={role === "targetOriginal" ? "text-accent-green" : "text-accent-cyan"}
        />
        <h3 className="text-sm font-medium text-content-primary">{title}</h3>
        <span className="ml-auto rounded border border-panel-line bg-surface-inset px-2 py-0.5 text-ui-caption text-content-muted">
          {mediaItems.length} 个
        </span>
      </div>
      <p className="mt-2 leading-5 text-content-muted">{description}</p>
      {role === "targetOriginal" && onImportFromEmby ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <TextButton onClick={onImportFromEmby}>
            <FileAudio size={14} />从 Emby 获取音频
          </TextButton>
        </div>
      ) : null}
      {mediaItems.length > 0 ? (
        <div className="material-library mt-3">
          <div className="flex flex-wrap gap-2 text-ui-caption text-content-muted">
            <span>
              {statusLabel("actionRequired")} {issueItems.length}
            </span>
            <span>正常素材 {normalItems.length} 个</span>
          </div>
          {mediaItems.map((media) => (
            <MediaLibraryItemCard
              key={media.id}
              title={title}
              media={media}
              isIssue={
                Boolean(media.reconnectWarning) || media.audioPreparation.tone !== "success"
              }
              onReconnect={onReconnect}
              onDelete={onDelete}
              onAudioSelection={onAudioSelection}
              onDetailsSummaryRef={onDetailsSummaryRef}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={role === "targetOriginal" ? "尚未导入原片素材" : "尚未导入 B 站参考素材"}
          text={
            role === "targetOriginal"
              ? "可连续导入多个完整版或目标集的视频或音频。"
              : "可连续导入多个单集、合集、删减版视频或对应音频。"
          }
        />
      )}
    </section>
  );
}

function MediaLibraryItemCard({
  title,
  media,
  isIssue,
  onReconnect,
  onDelete,
  onAudioSelection,
  onDetailsSummaryRef
}: {
  title: string;
  media: MediaLibraryItemViewModel;
  isIssue: boolean;
  onReconnect: (mediaId: string) => void;
  onDelete: (mediaId: string) => void;
  onAudioSelection: (mediaId: string, value: string) => void;
  onDetailsSummaryRef: (mediaId: string, element: HTMLElement | null) => void;
}) {
  const [keepExpanded, setKeepExpanded] = useState(false);
  const detailsVisible = keepExpanded;

  return (
    <article
      role={isIssue ? "region" : undefined}
      aria-label={isIssue ? `${title}需要处理：${media.fileName}` : undefined}
      className={`rounded border bg-surface-inset ${
        isIssue ? "border-accent-yellow/30" : "border-panel-line/80"
      }`}
    >
      <div className="flex items-center gap-2 px-2.5 py-2 text-content-secondary">
        {media.audioOnly ? (
          <FileAudio size={14} className="shrink-0 text-feedback-running" aria-hidden="true" />
        ) : (
          <Video size={14} className="shrink-0 text-content-muted" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm" title={media.name}>
          {media.fileName}
        </span>
        <span className="sr-only">{media.name}</span>
        <span className="media-duration text-ui-caption text-content-muted">
          {media.durationText}
        </span>
        {media.canReconnect && media.reconnectWarning ? (
          <TextButton onClick={() => onReconnect(media.id)}>重新连接</TextButton>
        ) : null}
        <Button
          ref={(element) => onDetailsSummaryRef(media.id, element)}
          onClick={() => setKeepExpanded(true)}
          aria-label={media.fileName + " 文件详情"}
        >
          详情与音轨
        </Button>
        <span className="shrink-0 text-ui-caption text-content-muted">
          {statusLabel(isIssue ? "actionRequired" : "runnable")}
        </span>
      </div>
      <ToolSheet
        title="素材详情与音轨"
        open={detailsVisible}
        onClose={() => setKeepExpanded(false)}
      >
        <div data-testid={`media-details-${media.id}`}>
          <h3 className="mb-3 break-words text-base font-medium text-content-primary">
            {media.fileName}
          </h3>
          <div className="flex items-center justify-between gap-2 text-ui-caption text-content-muted">
            <span>{media.durationText}</span>
            <span>{media.connectionText}</span>
          </div>
          <p
            className={`mt-2 rounded border px-2 py-1.5 text-ui-caption leading-5 ${audioPreparationClass(
              media.audioPreparation.tone
            )}`}
          >
            <span className="font-medium">{media.audioPreparation.statusText}</span>
            <span className="text-current/75"> · {media.audioPreparation.detailText}</span>
          </p>
          {media.reconnectWarning ? (
            <p className="mt-2 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-ui-caption leading-5 text-accent-yellow">
              {media.reconnectWarning}
            </p>
          ) : null}
          <details className="mt-2 rounded border border-panel-line/70 bg-surface-inset">
            <summary className="cursor-pointer px-2 py-1.5 text-ui-caption text-content-muted hover:text-content-secondary">
              文件详情
            </summary>
            <dl className="grid gap-1 border-t border-panel-line/70 px-2 py-2 text-content-muted">
              <Row label="角色" value={media.details.role} />
              <Row label="内容" value={media.details.content} />
              <Row label="时长" value={media.details.duration} />
              <Row label="来源" value={media.details.source} />
              <Row label="引用" value={media.details.reference} />
            </dl>
            {media.audioPreparation.canSelect ? (
              <label className="grid gap-1 border-t border-panel-line/70 px-2 py-2">
                <span className="text-ui-caption text-content-muted">用于匹配的音轨</span>
                <select
                  aria-label={`${media.fileName} 音轨选择`}
                  className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                  value={media.audioPreparation.selectionValue}
                  onChange={(event) => onAudioSelection(media.id, event.target.value)}
                >
                  <option value="" disabled>
                    {media.audioPreparation.selectionPlaceholder}
                  </option>
                  {media.audioPreparation.selectionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </details>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {media.canReconnect ? (
              <TextButton onClick={() => onReconnect(media.id)}>
                <FolderOpen size={14} />
                重新连接
              </TextButton>
            ) : null}
            <TextButton tone="danger" onClick={() => onDelete(media.id)}>
              <Trash2 size={14} />
              删除
            </TextButton>
          </div>
        </div>
      </ToolSheet>
    </article>
  );
}

export function MaterialsSummaryPanel({
  originalCount,
  referenceCount,
  xmlCount,
  unplacedXmlCount,
  hasTimeline,
  unboundXmlCount,
  reconnectCount,
  audioIssueCount,
  audioBusy,
  audioPaused,
  audioCancelling,
  audioRestartRequired,
  audioTerminalMessage,
  pendingSuggestionCount,
  onAddOriginal,
  onAddReference,
  onAddXml,
  onAcquireBilibili,
  onAcquireOriginal,
  onAddWebDav,
  onAddEmby,
  onReviewBindings,
  onReviewAudio,
  onCancelAudio,
  onRefreshAudio,
  onContinue,
  onEditXml,
  alignmentEnabled
}: {
  originalCount: number;
  referenceCount: number;
  xmlCount: number;
  unplacedXmlCount: number;
  hasTimeline: boolean;
  unboundXmlCount: number;
  reconnectCount: number;
  audioIssueCount: number;
  audioBusy: boolean;
  audioPaused: boolean;
  audioCancelling: boolean;
  audioRestartRequired: boolean;
  audioTerminalMessage: string | null;
  pendingSuggestionCount: number;
  onAddOriginal: () => void;
  onAddReference: () => void;
  onAddXml: () => void;
  onAcquireBilibili?: () => void;
  onAcquireOriginal?: () => void;
  onAddWebDav?: () => void;
  onAddEmby?: () => void;
  onReviewBindings: () => void;
  onReviewAudio: () => void;
  onCancelAudio: () => void;
  onRefreshAudio: () => void;
  onContinue: () => void;
  onEditXml: () => void;
  alignmentEnabled: boolean;
}) {
  const restartBlocked = alignmentEnabled && audioRestartRequired;
  const nextAction = restartBlocked
    ? {
        label: "重启应用后继续",
        detail: audioTerminalMessage ?? "媒体清单进程清理状态不确定，需重启应用。",
        run: null
      }
    : xmlCount === 0
      ? {
          label: "导入后继续",
          detail: "只编辑和导出弹幕时，导入 XML 就可以开始，不需要视频。",
          run: null
        }
      : !alignmentEnabled
        ? {
            label:
              unplacedXmlCount === 0
                ? "继续编辑当前时间线"
                : hasTimeline
                  ? `加入 ${unplacedXmlCount} 个 XML 并编辑`
                  : "开始编辑弹幕",
            detail:
              unplacedXmlCount === 0
                ? "保留当前片段、偏移和禁用状态，继续调整弹幕。"
                : `将 ${unplacedXmlCount} 个未加入的 XML 接到时间线末尾，已知播放时长优先，未知部分按末条弹幕估算；保留原时间零点和已有编辑。`,
            run: onEditXml
          }
        : originalCount === 0
          ? {
              label: "添加原片后继续",
              detail: "已启用视频对齐，请选择最终时间轴对应的视频或音频。",
              run: null
            }
          : referenceCount === 0
            ? {
                label: "添加参考素材后继续",
                detail: "参考视频或音频用于确定弹幕原本的时间位置。",
                run: null
              }
            : unboundXmlCount > 0
              ? {
                  label: `确认 ${unboundXmlCount} 个弹幕来源`,
                  detail: "告诉应用每个 XML 原本对应哪个参考素材。",
                  run: onReviewBindings
                }
              : audioIssueCount > 0
                ? {
                    label: `处理 ${audioIssueCount} 个音轨`,
                    detail: "有素材需要检查音轨，完成后即可继续匹配。",
                    run: onReviewAudio
                  }
                : {
                    label: "进入智能匹配",
                    detail: "素材已经齐全，可以开始分析时间关系。",
                    run: onContinue
                  };
  const ready =
    !restartBlocked &&
    (alignmentEnabled
      ? originalCount > 0 &&
        referenceCount > 0 &&
        xmlCount > 0 &&
        unboundXmlCount === 0 &&
        reconnectCount === 0 &&
        audioIssueCount === 0
      : xmlCount > 0);

  return (
    <section className="page-heading" aria-label="素材准备摘要" data-testid="materials-summary">
      <div className="min-w-0">
        <h2>素材</h2>
        <p>
          {ready
            ? alignmentEnabled
              ? "来源已关联，素材已准备好。接下来分析时间关系。"
              : "弹幕已就绪，可以直接开始编辑。"
            : nextAction.detail}
        </p>
        {restartBlocked && (
          <p role="alert" className="text-feedback-danger">
            {audioTerminalMessage ?? "请重启应用后继续准备音轨。"}
          </p>
        )}
      </div>
      <div className="page-actions">
        <WorkspaceMenu
          label="添加素材"
          primary={xmlCount === 0}
          icon={<FolderOpen size={15} />}
          items={[
            { id: "xml", label: "导入 XML", icon: <FileText size={15} />, onSelect: onAddXml },
            {
              id: "original",
              label: "批量导入原片素材",
              icon: <Video size={15} />,
              onSelect: onAddOriginal
            },
            {
              id: "reference",
              label: "批量导入 B 站参考素材",
              icon: <Video size={15} />,
              onSelect: onAddReference
            },
            ...(onAcquireBilibili
              ? [{ id: "bilibili", label: "从 B 站获取", onSelect: onAcquireBilibili }]
              : []),
            ...(onAddEmby
              ? [{ id: "emby", label: "从 Emby 导入原片音频", onSelect: onAddEmby }]
              : []),
            ...(onAcquireOriginal ? [{id:"motrix",label:"搜索原片与 Motrix 下载",onSelect:onAcquireOriginal}] : []),
            ...(onAddWebDav ? [{id:"webdav",label:"从 WebDAV 获取原片音轨",onSelect:onAddWebDav}] : [])
          ]}
        />
        <TextButton
          tone={pendingSuggestionCount > 0 ? "neutral" : "primary"}
          disabled={nextAction.run === null}
          disabledReason={nextAction.run === null ? nextAction.detail : undefined}
          data-testid="materials-primary-action"
          onClick={nextAction.run ?? undefined}
        >
          {nextAction.label}
          <ArrowRight size={14} />
        </TextButton>
        {!restartBlocked && alignmentEnabled && audioBusy ? (
          <TextButton disabled={audioCancelling} onClick={onCancelAudio}>
            {audioCancelling ? "正在停止…" : "停止准备"}
          </TextButton>
        ) : !restartBlocked && alignmentEnabled && audioIssueCount > 0 ? (
          <TextButton onClick={onRefreshAudio}>
            {audioPaused ? "重新准备音轨" : "刷新音轨"}
          </TextButton>
        ) : null}
      </div>
    </section>
  );
}

export function MaterialCount({
  label,
  count,
  ready
}: {
  label: string;
  count: number;
  ready: boolean;
}) {
  return (
    <div className="rounded-lg border border-panel-line/70 bg-surface-inset px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-caption text-content-muted">{label}</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            ready ? "bg-accent-green" : "bg-surface-soft"
          }`}
          aria-hidden="true"
        />
      </div>
      <div className="mt-1 text-sm font-semibold text-content-secondary">{count}</div>
    </div>
  );
}

export function MediaRoleGuidePanel({
  targetCount,
  referenceCount,
  alignmentEnabled
}: {
  targetCount: number;
  referenceCount: number;
  alignmentEnabled: boolean;
}) {
  return (
    <details className="rounded-lg border border-panel-line bg-panel-soft text-xs text-content-secondary">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-content-muted hover:text-content-secondary">
        <Video size={15} className="text-accent-cyan" />
        <span className="font-medium">
          {alignmentEnabled ? "了解三类素材的关系" : "什么时候需要导入视频？"}
        </span>
        <span className="ml-auto text-ui-caption text-content-subtle">说明</span>
      </summary>
      <div className="border-t border-panel-line px-3 py-3">
        <h3 className="text-sm font-medium text-content-primary">媒体来源</h3>
        <p className="mt-2 leading-5 text-content-muted">
          {alignmentEnabled
            ? "当前项目已启用视频对齐：先完成素材绑定，再在匹配页标出来源段，最后按原片分集导出。视频和音频都不嵌入项目文件。"
            : "应用仍按四页动线工作，但纯 XML 项目会自动跳过智能匹配。如果只是修改弹幕时间、禁用个别弹幕或导出修正后的 XML，只需导入 XML。只有需要把弹幕对齐到另一份原片时，才需要添加原片和参考素材。"}
        </p>
        <dl className="mt-3 grid gap-2">
          <Row label="原片素材" value={`${targetCount} 个`} />
          <Row label="B 站参考" value={`${referenceCount} 个`} />
          <Row
            label="当前流程"
            value={
              alignmentEnabled
                ? "XML → 参考素材 → 来源段 → 原片"
                : "XML → 时间线编辑 → 导出 XML"
            }
          />
        </dl>
      </div>
    </details>
  );
}

export function ProjectMatchAssessmentPanel({
  assessment,
  onPreview
}: {
  assessment: ProjectMatchAssessment;
  onPreview: () => void;
}) {
  const canPreview = Boolean(assessment.proposal);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex items-center gap-2">
        <WandSparkles size={16} className="text-accent-cyan" />
        <h3 className="text-sm font-medium text-content-primary">匹配评分</h3>
        <span
          className={`ml-auto rounded border px-2 py-0.5 text-ui-caption ${projectMatchBadgeClass(assessment.conclusion)}`}
        >
          {assessment.conclusionLabel}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-[64px_minmax(0,1fr)] gap-3">
        <div
          className={`flex h-14 items-center justify-center rounded border text-lg font-semibold ${projectMatchScoreClass(assessment.conclusion)}`}
        >
          {formatProjectMatchScore(assessment.score)}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-5 text-content-primary">
            {assessment.headline}
          </p>
          <p className="mt-1 leading-5 text-content-muted">{assessment.detail}</p>
        </div>
      </div>
      <dl className="mt-3 grid gap-2">
        <Row label="目标" value={assessment.targetTitle} />
        <Row label="XML" value={formatMatchSourceSummary(assessment)} />
      </dl>
      <div className="mt-3 grid gap-2">
        {assessment.criteria.map((criterion) => (
          <div
            key={criterion.id}
            className="rounded border border-panel-line/70 bg-surface-inset p-2"
          >
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span
                className={`text-ui-caption ${projectMatchCriterionClass(criterion.state)}`}
              >
                {projectMatchCriterionStateText(criterion.state)}
              </span>
              <span className="min-w-0">
                <span className="text-content-primary">{criterion.label}</span>
                <span className="text-content-muted"> / {criterion.summary}</span>
              </span>
            </div>
            <p className="mt-1 leading-5 text-content-muted">{criterion.detail}</p>
            {criterion.evidence.length > 0 ? (
              <p
                className="mt-1 truncate text-ui-caption text-content-muted"
                title={criterion.evidence.join("；")}
              >
                {criterion.evidence.join("；")}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <TextButton
          onClick={onPreview}
          disabled={!canPreview}
          title={
            canPreview
              ? "把评分诊断和候选同步线索送入时间轴预览"
              : "绑定目标原片并导入 XML 后可生成提案"
          }
        >
          <Crosshair size={14} />
          预览评分提案
        </TextButton>
      </div>
    </section>
  );
}

function formatMatchSourceSummary(assessment: ProjectMatchAssessment): string {
  if (assessment.source.itemCount === 0) {
    return `${assessment.source.assetCount} 个 XML / 暂无弹幕`;
  }
  const endText =
    assessment.source.sourceEndMs === null
      ? "未知"
      : formatTimecode(assessment.source.sourceEndMs);
  return `${assessment.source.assetCount} 个 XML / ${assessment.source.itemCount.toLocaleString("zh-CN")} 条 / 到 ${endText}`;
}

function projectMatchBadgeClass(conclusion: ProjectMatchAssessment["conclusion"]): string {
  if (conclusion === "likely") {
    return "border-feedback-success/40 bg-feedback-success/10 text-feedback-success";
  }
  if (conclusion === "unlikely") {
    return "border-feedback-danger/40 bg-feedback-danger/10 text-feedback-danger";
  }
  return "border-feedback-warning/40 bg-feedback-warning/10 text-feedback-warning";
}

function projectMatchScoreClass(conclusion: ProjectMatchAssessment["conclusion"]): string {
  if (conclusion === "likely") {
    return "border-feedback-success/30 bg-feedback-success/10 text-feedback-success";
  }
  if (conclusion === "unlikely") {
    return "border-feedback-danger/30 bg-feedback-danger/10 text-feedback-danger";
  }
  return "border-feedback-warning/30 bg-feedback-warning/10 text-feedback-warning";
}

function projectMatchCriterionClass(state: ProjectMatchCriterionState): string {
  if (state === "positive") {
    return "text-feedback-success";
  }
  if (state === "negative") {
    return "text-feedback-danger";
  }
  if (state === "warning") {
    return "text-feedback-warning";
  }
  return "text-content-muted";
}

function projectMatchCriterionStateText(state: ProjectMatchCriterionState): string {
  if (state === "positive") {
    return "有利";
  }
  if (state === "negative") {
    return "冲突";
  }
  if (state === "warning") {
    return "待确认";
  }
  return "中性";
}

function audioPreparationClass(tone: MediaAudioPreparationViewModel["tone"]): string {
  if (tone === "success") {
    return "border-accent-green/30 bg-accent-green/10 text-accent-green";
  }
  if (tone === "warning") {
    return "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow";
  }
  if (tone === "error") {
    return "border-accent-red/30 bg-accent-red/10 text-accent-red";
  }
  return "border-panel-line bg-surface-inset text-content-muted";
}
