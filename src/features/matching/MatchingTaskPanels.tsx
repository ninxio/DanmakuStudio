import { FolderOpen, LoaderCircle } from "lucide-react";
import { Badge } from "../../components/Badge";
import { TextButton } from "../../components/TextButton";
import { findProjectMedia } from "../../domain/project/mediaLibrary";
import type { EditorProject, ProjectMediaReference } from "../../domain/project/types";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";
import {
  batchTaskStatusId,
  canAnalyzeMedia,
  unavailableMediaHint,
  type BatchTask,
  type MatchingAudioPreparationView
} from "./matchingTaskModels";

export function MediaChoiceList({
  title,
  items,
  selectedIds,
  audioPreparations,
  onToggle
}: {
  title: string;
  items: ProjectMediaReference[];
  selectedIds: string[];
  audioPreparations: Record<string, MatchingAudioPreparationView>;
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="rounded border border-panel-line bg-surface-inset p-2">
      <legend className="px-1 text-xs font-medium text-content-secondary">{title}</legend>
      {items.length === 0 ? (
        <p className="p-2 leading-5 text-content-muted">尚未导入。请回素材页批量导入。</p>
      ) : (
        <div className="grid gap-1">
          {items.map((media) => {
            const available = canAnalyzeMedia(media);
            return (
              <label
                key={media.id}
                className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-surface-soft"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-cyan-500"
                  checked={selectedIds.includes(media.id)}
                  disabled={!available}
                  onChange={() => onToggle(media.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-content-secondary">{media.name}</span>
                  <span
                    className={`block text-ui-caption ${available ? "text-content-muted" : "text-accent-yellow"}`}
                  >
                    {available ? media.localPath : unavailableMediaHint(media)}
                  </span>
                  {available && audioPreparations[media.id] ? (
                    <span
                      className={`block text-ui-caption ${
                        audioPreparations[media.id].ready
                          ? "text-content-muted"
                          : "text-accent-yellow"
                      }`}
                    >
                      {audioPreparations[media.id].label}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

export function BatchTaskList({
  tasks,
  project,
  onOpenDiagnosticLogDirectory,
  onOpenSensitiveManifestDirectory
}: {
  tasks: BatchTask[];
  project: EditorProject;
  onOpenDiagnosticLogDirectory: () => void;
  onOpenSensitiveManifestDirectory: () => void;
}) {
  const jobId = tasks.find((task) => task.jobId !== null)?.jobId ?? null;
  return (
    <div
      className="mt-3 grid gap-1 rounded border border-panel-line bg-surface-inset p-2"
      aria-label="批量匹配任务"
    >
      {jobId ? (
        <details className="mb-1 rounded border border-panel-line bg-surface-inset px-2 py-1.5 text-ui-caption text-content-muted">
          <summary className="cursor-pointer text-content-muted">批次诊断与运行编号</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span>
              运行编号：<code className="text-content-secondary">{jobId}</code>
            </span>
            <TextButton className="h-7" onClick={onOpenDiagnosticLogDirectory}>
              <FolderOpen size={13} />
              打开可分享日志
            </TextButton>
            <TextButton className="h-7" onClick={onOpenSensitiveManifestDirectory}>
              <FolderOpen size={13} />
              打开本机训练证据
            </TextButton>
          </div>
          <p className="mt-1 leading-5">
            “可分享日志”不含媒体路径、文件名、内容或摘要；“本机训练证据”会保存完整路径、
            内容身份、音轨、PTS、缓存来源和算法结果，只能留在本机。两者都按运行编号持续更新并自动轮转。
          </p>
        </details>
      ) : null}
      {tasks.map((task) => {
        const source = findProjectMedia(project, task.sourceMediaId);
        const target = findProjectMedia(project, task.targetMediaId);
        return (
          <div
            key={task.id}
            className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 rounded px-2 py-1.5"
          >
            <div className="min-w-0">
              <div className="truncate text-content-secondary">
                {target?.name ?? task.targetMediaId} ← {source?.name ?? task.sourceMediaId}
              </div>
              <div
                data-testid="batch-task-message"
                className={
                  task.state === "failed"
                    ? "text-accent-red"
                    : "text-ui-caption text-content-muted"
                }
              >
                {task.message}
              </div>
              {task.logs.length > 0 ? (
                <details className="mt-1 text-ui-caption text-content-muted">
                  <summary className="cursor-pointer">
                    运行诊断（{task.logs.length} 条，已隐藏媒体路径和内容摘要）
                  </summary>
                  <pre
                    className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-inset p-2 leading-5"
                    aria-label="脱敏运行诊断"
                  >
                    {task.logs.join("\n")}
                  </pre>
                </details>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 text-ui-caption text-content-muted">
              {task.state === "running" ? (
                <LoaderCircle size={13} className="animate-spin text-accent-cyan" />
              ) : null}
              <Badge
                tone={getStatusVocabulary(batchTaskStatusId(task.state)).tone}
                title={getStatusVocabulary(batchTaskStatusId(task.state)).description}
              >
                {getStatusVocabulary(batchTaskStatusId(task.state)).label}
              </Badge>
              <span>{Math.round(task.progress * 100)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
