import { CircleCheck, Clock3, Crosshair, ListPlus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TextButton } from "../../components/TextButton";
import { Badge } from "../../components/Badge";
import type { BatchMergePlan } from "../../domain/danmaku/batchMerge";
import { findDanmakuSourceBinding } from "../../domain/project/mediaLibrary";
import { createSeasonEpisodeKey } from "../../domain/project/seasonEpisodeBinding";
import {
  parseSourceTimecode,
  type DanmakuSourceSegmentDraft,
  type DanmakuSourceSegmentPatch,
  type SegmentTimingRuleDraft,
  type SourceTimelineFinding,
  type SourceTimelineSummary
} from "../../domain/project/sourceTimeline";
import type {
  DanmakuSourceSegment,
  DanmakuSourceSegmentKind,
  EditorProject,
  ProjectMediaReference
} from "../../domain/project/types";
import { formatTimecode, type Milliseconds } from "../../domain/shared/time";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";
import { useEditorStore, type EditorStatus } from "../../stores/editorStore";

interface SourceSegmentEpisodeOption {
  key: string;
  label: string;
}

interface SourceSegmentFormState {
  kind: DanmakuSourceSegmentKind;
  assetId: string;
  sourceMediaId: string;
  startText: string;
  endText: string;
  targetMediaId: string;
  targetStartText: string;
  timingRulesText: string;
  episodeKey: string;
  label: string;
  note: string;
}

export function SourceTimelineSegmentsPanel({
  segments,
  assets,
  sourceBindings,
  sourceMediaOptions,
  targetMediaOptions,
  plan,
  summary,
  onAdd,
  onUpdate,
  onDelete,
  onFocus
}: {
  segments: DanmakuSourceSegment[];
  assets: EditorProject["assets"];
  sourceBindings: EditorProject["danmakuSourceBindings"];
  sourceMediaOptions: ProjectMediaReference[];
  targetMediaOptions: ProjectMediaReference[];
  plan: BatchMergePlan;
  summary: SourceTimelineSummary;
  onAdd: (draft: DanmakuSourceSegmentDraft) => void;
  onUpdate: (id: string, patch: DanmakuSourceSegmentPatch) => void;
  onDelete: (id: string) => void;
  onFocus: (timeMs: Milliseconds) => void;
}) {
  const episodeOptions = useMemo(() => createSourceSegmentEpisodeOptions(plan), [plan]);
  const sourceSegmentGroups = useMemo(
    () => createSourceSegmentGroups(segments, sourceMediaOptions),
    [segments, sourceMediaOptions]
  );
  const [form, setForm] = useState<SourceSegmentFormState>({
    kind: "content",
    assetId: "",
    sourceMediaId: "",
    startText: "00:00:00.000",
    endText: "00:24:00.000",
    targetMediaId: "",
    targetStartText: "00:00:00.000",
    timingRulesText: "",
    episodeKey: "",
    label: "",
    note: ""
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      assetId:
        current.assetId.length === 0 && assets.length > 0 ? assets[0].id : current.assetId,
      sourceMediaId:
        findDanmakuSourceBinding(
          sourceBindings,
          current.assetId.length === 0 && assets.length > 0 ? assets[0].id : current.assetId
        )?.sourceMediaId ?? "",
      targetMediaId:
        current.targetMediaId.length === 0 && targetMediaOptions.length > 0
          ? targetMediaOptions[0].id
          : current.targetMediaId,
      episodeKey:
        current.episodeKey.length === 0 && episodeOptions.length > 0
          ? episodeOptions[0].key
          : current.episodeKey
    }));
  }, [assets, episodeOptions, sourceBindings, targetMediaOptions]);

  useEffect(() => {
    if (form.kind === "ignored" && form.targetMediaId.length > 0) {
      setForm((current) => ({ ...current, targetMediaId: "" }));
    }
  }, [form.kind, form.targetMediaId]);

  const submit = () => {
    const draft = createSourceSegmentDraftFromForm(form, episodeOptions);
    if (!draft.ok) {
      setStatus({ message: draft.message, tone: "warning" });
      return;
    }
    onAdd(draft.value);
    setForm((current) => ({
      ...current,
      startText: current.endText,
      endText: formatTimecode((parseSourceTimecode(current.endText) ?? 0) + 24 * 60 * 1000),
      label: "",
      note: ""
    }));
  };

  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary"
      aria-label="弹幕来源内容段"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <Clock3 size={15} className="text-accent-cyan" />
        <span>弹幕来源内容段</span>
        <Badge
          tone={getStatusVocabulary(summary.statusId).tone}
          title={getStatusVocabulary(summary.statusId).description}
          className="ml-auto"
        >
          {summary.statusLabel}
        </Badge>
      </div>
      <p className="mt-2 text-ui-caption leading-5 text-content-muted">
        {summary.headline}。这里只标注 B 站/XML 时间轴上的虚拟范围，不剪切、不修改视频文件。
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {summary.metrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded border border-panel-line bg-surface-inset p-2"
          >
            <div className="text-ui-caption text-content-muted">{metric.label}</div>
            <div className="mt-1 text-sm font-medium text-content-primary">{metric.value}</div>
          </div>
        ))}
      </div>
      <SourceTimelineLanes groups={sourceSegmentGroups} />
      <div className="mt-3 grid gap-1">
        {summary.findings.map((finding) => (
          <div
            key={finding.id}
            className={`rounded border p-2 ${sourceTimelineFindingClass(finding.severity)}`}
          >
            <div className="font-medium">{finding.title}</div>
            <div className="mt-1 leading-5">{finding.detail}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 rounded border border-panel-line bg-surface-inset p-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-content-muted">所属 XML</span>
            <select
              aria-label="来源段所属 XML"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              value={form.assetId}
              onChange={(event) => {
                const assetId = event.target.value;
                setForm((current) => ({
                  ...current,
                  assetId,
                  sourceMediaId:
                    findDanmakuSourceBinding(sourceBindings, assetId)?.sourceMediaId ?? ""
                }));
              }}
            >
              <option value="">请选择 XML</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.fileName}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-content-muted">B 站参考素材（由 XML 绑定决定）</span>
            <select
              aria-label="来源段 B 站参考素材"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-70"
              value={form.sourceMediaId}
              disabled
            >
              <option value="">请先到素材页绑定 XML</option>
              {sourceMediaOptions.map((media) => (
                <option key={media.id} value={media.id}>
                  {media.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="rounded border border-panel-line/70 bg-surface-inset p-2">
          <summary className="cursor-pointer text-ui-caption text-content-muted">
            目标起点与段内删减修正
          </summary>
          <div className="mt-2 grid gap-2">
            <label className="grid gap-1">
              <span className="text-content-muted">目标原片起点</span>
              <input
                aria-label="来源段目标原片起点"
                className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-50"
                value={form.targetStartText}
                disabled={form.kind === "ignored"}
                onChange={(event) =>
                  setForm((current) => ({ ...current, targetStartText: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="text-content-muted">
                删减修正（每行：参考时间 -&gt; 毫秒差值）
              </span>
              <textarea
                aria-label="来源段删减修正"
                className="min-h-20 rounded border border-panel-line bg-surface-inset p-2 text-xs text-content-primary disabled:opacity-50"
                value={form.timingRulesText}
                disabled={form.kind === "ignored"}
                placeholder="00:12:30.000 -> +45000"
                onChange={(event) =>
                  setForm((current) => ({ ...current, timingRulesText: event.target.value }))
                }
              />
            </label>
            <p className="text-ui-caption leading-5 text-content-muted">
              目标起点影响这一段投影到原片的落点；删减修正只影响该来源段内后续弹幕，不修改原始
              XML。
            </p>
          </div>
        </details>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-content-muted">开始</span>
            <input
              aria-label="来源段开始"
              className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              value={form.startText}
              onChange={(event) =>
                setForm((current) => ({ ...current, startText: event.target.value }))
              }
            />
          </label>
          <label className="grid gap-1">
            <span className="text-content-muted">结束</span>
            <input
              aria-label="来源段结束"
              className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              value={form.endText}
              onChange={(event) =>
                setForm((current) => ({ ...current, endText: event.target.value }))
              }
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-content-muted">用途</span>
            <select
              aria-label="来源段用途"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              value={form.kind}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  kind: event.target.value as DanmakuSourceSegmentKind
                }))
              }
            >
              <option value="content">正片内容</option>
              <option value="ignored">忽略范围</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-content-muted">目标原片</span>
            <select
              aria-label="来源段目标原片"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-50"
              value={form.targetMediaId}
              disabled={form.kind === "ignored"}
              onChange={(event) =>
                setForm((current) => ({ ...current, targetMediaId: event.target.value }))
              }
            >
              <option value="">暂不关联</option>
              {targetMediaOptions.map((media) => (
                <option key={media.id} value={media.id}>
                  {media.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid gap-1">
          <span className="text-content-muted">对应输出</span>
          <select
            aria-label="来源段对应输出"
            className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-50"
            value={form.episodeKey}
            disabled={form.kind === "ignored"}
            onChange={(event) =>
              setForm((current) => ({ ...current, episodeKey: event.target.value }))
            }
          >
            <option value="">暂不关联</option>
            {episodeOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-content-muted">名称</span>
          <input
            aria-label="来源段名称"
            className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
            value={form.label}
            placeholder="留空时自动命名"
            onChange={(event) =>
              setForm((current) => ({ ...current, label: event.target.value }))
            }
          />
        </label>
        <label className="grid gap-1">
          <span className="text-content-muted">备注</span>
          <input
            aria-label="来源段备注"
            className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
            value={form.note}
            placeholder="例如：前两小时为无意义片段"
            onChange={(event) =>
              setForm((current) => ({ ...current, note: event.target.value }))
            }
          />
        </label>
        <div className="flex justify-end">
          <TextButton tone="primary" onClick={submit}>
            <ListPlus size={14} />
            新增来源段
          </TextButton>
        </div>
      </div>
      {segments.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {sourceSegmentGroups.map((group) => (
            <section
              key={group.sourceMediaId}
              className="grid gap-2 rounded border border-panel-line/70 bg-surface-inset p-2"
              aria-label={`${group.label} 来源段`}
              data-testid="source-segment-lane"
            >
              <div className="text-ui-caption font-medium text-content-muted">
                {group.label}
              </div>
              {group.segments.map((segment) => (
                <SourceTimelineSegmentRow
                  key={segment.id}
                  segment={segment}
                  assets={assets}
                  sourceBindings={sourceBindings}
                  sourceMediaOptions={sourceMediaOptions}
                  targetMediaOptions={targetMediaOptions}
                  episodeOptions={episodeOptions}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                  onFocus={onFocus}
                />
              ))}
            </section>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-ui-caption leading-5 text-content-muted">
        下一步：{summary.nextActionLabel}
      </p>
    </section>
  );
}

function SourceTimelineSegmentRow({
  segment,
  assets,
  sourceBindings,
  sourceMediaOptions,
  targetMediaOptions,
  episodeOptions,
  onUpdate,
  onDelete,
  onFocus
}: {
  segment: DanmakuSourceSegment;
  assets: EditorProject["assets"];
  sourceBindings: EditorProject["danmakuSourceBindings"];
  sourceMediaOptions: ProjectMediaReference[];
  targetMediaOptions: ProjectMediaReference[];
  episodeOptions: SourceSegmentEpisodeOption[];
  onUpdate: (id: string, patch: DanmakuSourceSegmentPatch) => void;
  onDelete: (id: string) => void;
  onFocus: (timeMs: Milliseconds) => void;
}) {
  const timeMapOwned = Boolean(segment.timeMapId);
  const [form, setForm] = useState<SourceSegmentFormState>(() =>
    createFormFromSegment(segment)
  );

  useEffect(() => {
    setForm(createFormFromSegment(segment));
  }, [segment]);

  useEffect(() => {
    if (form.kind === "ignored" && form.targetMediaId.length > 0) {
      setForm((current) => ({ ...current, targetMediaId: "" }));
    }
  }, [form.kind, form.targetMediaId]);

  useEffect(() => {
    const boundSourceMediaId =
      findDanmakuSourceBinding(sourceBindings, form.assetId)?.sourceMediaId ?? "";
    if (boundSourceMediaId !== form.sourceMediaId) {
      setForm((current) => ({ ...current, sourceMediaId: boundSourceMediaId }));
    }
  }, [form.assetId, form.sourceMediaId, sourceBindings]);

  const save = () => {
    if (timeMapOwned) {
      const episode = episodeOptions.find((option) => option.key === form.episodeKey);
      onUpdate(segment.id, {
        episodeKey: form.episodeKey || null,
        episodeLabel: episode?.label ?? null,
        label: form.label,
        note: form.note
      });
      return;
    }
    const draft = createSourceSegmentDraftFromForm(form, episodeOptions);
    if (!draft.ok) {
      setStatus({ message: draft.message, tone: "warning" });
      return;
    }
    onUpdate(segment.id, draft.value);
  };

  return (
    <article className="grid gap-2 rounded border border-panel-line bg-surface-inset p-2">
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-sm ${segment.kind === "content" ? "bg-accent-cyan" : "bg-surface-soft"}`}
        />
        <span className="min-w-0 flex-1 truncate text-content-primary" title={segment.label}>
          {segment.label}
        </span>
        <span className="text-ui-caption text-content-muted">
          {formatTimecode(segment.sourceStartMs)} - {formatTimecode(segment.sourceEndMs)}
        </span>
      </div>
      <div className="grid gap-1 rounded border border-panel-line/70 bg-surface-inset p-2 text-ui-caption text-content-muted">
        <div className="truncate">
          XML：{assets.find((asset) => asset.id === segment.assetId)?.fileName ?? "未选择"}
        </div>
        <div className="truncate">
          B 站参考：
          {sourceMediaOptions.find((media) => media.id === segment.sourceMediaId)?.name ??
            "未选择"}
        </div>
        <div className="truncate">
          目标原片：
          {segment.kind === "ignored"
            ? "忽略范围无需目标"
            : (targetMediaOptions.find((media) => media.id === segment.targetMediaId)?.name ??
              "未选择")}
        </div>
      </div>
      {timeMapOwned ? (
        <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-ui-caption leading-5 text-accent-yellow">
          这条来源段由已确认时间图管理。素材、用途、双方范围和删减修正已锁定；这里只能修改输出标签与备注。若映射有误，请回到上方候选卡撤销确认后重新分析。
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={`${segment.label} 所属 XML`}
          className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
          value={form.assetId}
          disabled={timeMapOwned}
          onChange={(event) => {
            const assetId = event.target.value;
            setForm((current) => ({
              ...current,
              assetId,
              sourceMediaId:
                findDanmakuSourceBinding(sourceBindings, assetId)?.sourceMediaId ?? ""
            }));
          }}
        >
          <option value="">请选择 XML</option>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.fileName}
            </option>
          ))}
        </select>
        <select
          aria-label={`${segment.label} B 站参考素材`}
          className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-70"
          value={form.sourceMediaId}
          disabled
        >
          <option value="">请先到素材页绑定 XML</option>
          {sourceMediaOptions.map((media) => (
            <option key={media.id} value={media.id}>
              {media.name}
            </option>
          ))}
        </select>
      </div>
      <details className="rounded border border-panel-line/70 bg-surface-inset p-2">
        <summary className="cursor-pointer text-ui-caption text-content-muted">
          目标起点与段内删减修正
        </summary>
        <div className="mt-2 grid gap-2">
          <input
            aria-label={`${segment.label} 目标原片起点`}
            className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-50"
            value={form.targetStartText}
            disabled={timeMapOwned || form.kind === "ignored"}
            onChange={(event) =>
              setForm((current) => ({ ...current, targetStartText: event.target.value }))
            }
          />
          <textarea
            aria-label={`${segment.label} 删减修正`}
            className="min-h-20 rounded border border-panel-line bg-surface-inset p-2 text-xs text-content-primary disabled:opacity-50"
            value={form.timingRulesText}
            disabled={timeMapOwned || form.kind === "ignored"}
            placeholder="00:12:30.000 -> +45000"
            onChange={(event) =>
              setForm((current) => ({ ...current, timingRulesText: event.target.value }))
            }
          />
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2">
        <input
          aria-label={`${segment.label} 开始`}
          className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
          value={form.startText}
          disabled={timeMapOwned}
          onChange={(event) =>
            setForm((current) => ({ ...current, startText: event.target.value }))
          }
        />
        <input
          aria-label={`${segment.label} 结束`}
          className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
          value={form.endText}
          disabled={timeMapOwned}
          onChange={(event) =>
            setForm((current) => ({ ...current, endText: event.target.value }))
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={`${segment.label} 用途`}
          className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
          value={form.kind}
          disabled={timeMapOwned}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              kind: event.target.value as DanmakuSourceSegmentKind
            }))
          }
        >
          <option value="content">正片内容</option>
          <option value="ignored">忽略范围</option>
        </select>
        <select
          aria-label={`${segment.label} 目标原片`}
          className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-50"
          value={form.targetMediaId}
          disabled={timeMapOwned || form.kind === "ignored"}
          onChange={(event) =>
            setForm((current) => ({ ...current, targetMediaId: event.target.value }))
          }
        >
          <option value="">暂不关联</option>
          {targetMediaOptions.map((media) => (
            <option key={media.id} value={media.id}>
              {media.name}
            </option>
          ))}
        </select>
      </div>
      <select
        aria-label={`${segment.label} 对应输出`}
        className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary disabled:opacity-50"
        value={form.episodeKey}
        disabled={form.kind === "ignored"}
        onChange={(event) =>
          setForm((current) => ({ ...current, episodeKey: event.target.value }))
        }
      >
        <option value="">暂不关联</option>
        {episodeOptions.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        aria-label={`${segment.label} 名称`}
        className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
        value={form.label}
        onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
      />
      <input
        aria-label={`${segment.label} 备注`}
        className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
        value={form.note}
        placeholder="备注"
        onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <TextButton onClick={() => onFocus(segment.sourceStartMs)}>
          <Crosshair size={14} />
          定位
        </TextButton>
        <TextButton onClick={save}>
          <CircleCheck size={14} />
          更新
        </TextButton>
        <TextButton
          tone="danger"
          disabled={timeMapOwned}
          title={timeMapOwned ? "请在匹配候选卡中撤销已确认关系。" : undefined}
          onClick={() => onDelete(segment.id)}
        >
          <Trash2 size={14} />
          删除
        </TextButton>
      </div>
    </article>
  );
}

interface SourceSegmentGroup {
  sourceMediaId: string;
  label: string;
  segments: DanmakuSourceSegment[];
}

function SourceTimelineLanes({ groups }: { groups: SourceSegmentGroup[] }) {
  if (groups.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 grid gap-2" data-testid="source-timeline-lanes">
      {groups.map((group) => (
        <section
          key={group.sourceMediaId}
          className="rounded border border-panel-line bg-surface-inset p-2"
          aria-label={`${group.label} 独立时间带`}
        >
          <div className="text-ui-caption font-medium text-content-muted">{group.label}</div>
          <SourceTimelineStrip
            segments={group.segments}
            ariaLabel={`${group.label} 弹幕来源时间带`}
          />
        </section>
      ))}
    </div>
  );
}

function SourceTimelineStrip({
  segments,
  ariaLabel
}: {
  segments: DanmakuSourceSegment[];
  ariaLabel: string;
}) {
  if (segments.length === 0) {
    return null;
  }
  const sorted = [...segments].sort(
    (left, right) =>
      left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
  );
  const startMs = sorted[0].sourceStartMs;
  const endMs = Math.max(...sorted.map((segment) => segment.sourceEndMs));
  const durationMs = Math.max(1, endMs - startMs);
  return (
    <div
      className="mt-2 rounded border border-panel-line bg-surface-inset p-2"
      aria-label={ariaLabel}
    >
      <div className="relative h-7 overflow-hidden rounded bg-surface-canvas">
        {sorted.map((segment) => {
          const left = ((segment.sourceStartMs - startMs) / durationMs) * 100;
          const width = Math.max(
            1,
            ((segment.sourceEndMs - segment.sourceStartMs) / durationMs) * 100
          );
          return (
            <div
              key={segment.id}
              className={`absolute top-0 h-full border-r border-black/40 ${
                segment.kind === "content" ? "bg-accent-cyan/60" : "bg-surface-soft/60"
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${segment.label}：${formatTimecode(segment.sourceStartMs)} - ${formatTimecode(segment.sourceEndMs)}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-ui-caption text-content-muted">
        <span>{formatTimecode(startMs)}</span>
        <span>{formatTimecode(endMs)}</span>
      </div>
    </div>
  );
}

function createSourceSegmentGroups(
  segments: DanmakuSourceSegment[],
  sourceMediaOptions: ProjectMediaReference[]
): SourceSegmentGroup[] {
  const unboundSourceId = "__unbound_source__";
  const labels = new Map(sourceMediaOptions.map((media) => [media.id, media.name]));
  const order = new Map(sourceMediaOptions.map((media, index) => [media.id, index]));
  const groups = new Map<string, DanmakuSourceSegment[]>();
  segments.forEach((segment) => {
    const sourceMediaId = segment.sourceMediaId ?? unboundSourceId;
    groups.set(sourceMediaId, [...(groups.get(sourceMediaId) ?? []), segment]);
  });
  return [...groups.entries()]
    .map(([sourceMediaId, groupedSegments]) => ({
      sourceMediaId,
      label:
        sourceMediaId === unboundSourceId
          ? "未绑定参考素材"
          : (labels.get(sourceMediaId) ?? sourceMediaId),
      segments: [...groupedSegments].sort(
        (left, right) =>
          left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
      )
    }))
    .sort(
      (left, right) =>
        (order.get(left.sourceMediaId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.sourceMediaId) ?? Number.MAX_SAFE_INTEGER) ||
        left.label.localeCompare(right.label, "zh-CN")
    );
}

function createSourceSegmentEpisodeOptions(plan: BatchMergePlan): SourceSegmentEpisodeOption[] {
  return plan.episodes.map((episode) => ({
    key: createSeasonEpisodeKey(episode),
    label: episode.label
  }));
}

function createSourceSegmentDraftFromForm(
  form: SourceSegmentFormState,
  episodeOptions: readonly SourceSegmentEpisodeOption[]
): { ok: true; value: DanmakuSourceSegmentDraft } | { ok: false; message: string } {
  const sourceStartMs = parseSourceTimecode(form.startText);
  const sourceEndMs = parseSourceTimecode(form.endText);
  if (sourceStartMs === null || sourceEndMs === null) {
    return { ok: false, message: "来源段时间格式无效，请使用 00:00:00.000。" };
  }
  if (sourceEndMs <= sourceStartMs) {
    return { ok: false, message: "来源段结束时间必须晚于开始时间。" };
  }
  if (form.assetId.length === 0) {
    return { ok: false, message: "来源段必须选择所属 XML。" };
  }
  if (form.sourceMediaId.length === 0) {
    return { ok: false, message: "来源段必须选择 B 站参考素材。" };
  }
  const targetStartMs = parseSourceTimecode(form.targetStartText);
  if (form.kind === "content" && targetStartMs === null) {
    return { ok: false, message: "目标原片起点格式无效，请使用 00:00:00.000。" };
  }
  const timingRules = parseSegmentTimingRulesText(form.timingRulesText);
  if (!timingRules.ok) {
    return timingRules;
  }
  const episode = episodeOptions.find((option) => option.key === form.episodeKey);
  return {
    ok: true,
    value: {
      kind: form.kind,
      assetId: form.assetId || null,
      sourceMediaId: form.sourceMediaId || null,
      sourceStartMs,
      sourceEndMs,
      targetMediaId: form.kind === "content" ? form.targetMediaId || null : null,
      targetStartMs: form.kind === "content" ? targetStartMs : null,
      timingRules: form.kind === "content" ? timingRules.value : [],
      episodeKey: form.kind === "content" ? form.episodeKey || null : null,
      episodeLabel: form.kind === "content" ? (episode?.label ?? null) : null,
      label: form.label,
      note: form.note
    }
  };
}

function createFormFromSegment(segment: DanmakuSourceSegment): SourceSegmentFormState {
  return {
    kind: segment.kind,
    assetId: segment.assetId ?? "",
    sourceMediaId: segment.sourceMediaId ?? "",
    startText: formatTimecode(segment.sourceStartMs),
    endText: formatTimecode(segment.sourceEndMs),
    targetMediaId: segment.targetMediaId ?? "",
    targetStartText: formatTimecode(segment.targetStartMs ?? 0),
    timingRulesText: segment.timingRules
      .map(
        (rule) =>
          `${formatTimecode(rule.sourceAtMs)} -> ${rule.gapMs >= 0 ? "+" : ""}${rule.gapMs}${rule.note ? ` ${rule.note}` : ""}`
      )
      .join("\n"),
    episodeKey: segment.episodeKey ?? "",
    label: segment.label,
    note: segment.note
  };
}

function parseSegmentTimingRulesText(
  text: string
): { ok: true; value: SegmentTimingRuleDraft[] } | { ok: false; message: string } {
  const rules: SegmentTimingRuleDraft[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(.*?)\s*(?:->|=>)\s*([+-]?\d+)(?:\s+(.*))?$/);
    if (!match) {
      return {
        ok: false,
        message: `第 ${index + 1} 行删减修正格式无效，请使用“00:12:30.000 -> +45000”。`
      };
    }
    const sourceAtMs = parseSourceTimecode(match[1].trim());
    const gapMs = Number(match[2]);
    if (sourceAtMs === null || !Number.isSafeInteger(gapMs) || gapMs === 0) {
      return { ok: false, message: `第 ${index + 1} 行删减修正的时间或差值无效。` };
    }
    rules.push({ sourceAtMs, gapMs, note: match[3]?.trim() ?? "手动段内删减修正" });
  }
  return { ok: true, value: rules };
}

function sourceTimelineFindingClass(severity: SourceTimelineFinding["severity"]): string {
  if (severity === "error") {
    return "border-accent-red/30 bg-accent-red/10 text-accent-red";
  }
  if (severity === "warning") {
    return "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow";
  }
  return "border-panel-line bg-surface-inset text-content-muted";
}

function setStatus(status: EditorStatus) {
  useEditorStore.setState({ status });
}
