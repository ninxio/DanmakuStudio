import type { StateCreator } from "zustand";
import { getKnownBilibiliDuration } from "../../domain/danmaku/bilibiliAcquisition";
import type { DanmakuClip } from "../../domain/danmaku/types";
import { createId, touchProject } from "../../domain/project/factory";
import {
  cleanupProjectEditReferences as cleanupProjectEditReferencesInProject,
  cleanupProjectMissingAssetClips as cleanupProjectMissingAssetClipsInProject
} from "../../domain/project/health";
import { getAssetTimeRange } from "../../domain/timeline/mapping";
import { appendUnplacedXmlAssets, inspectXmlTimeline } from "../../domain/timeline/xmlTimeline";
import { isXmlOnlyProject } from "../../domain/project/workflowMode";
import { clampMilliseconds } from "../../domain/shared/time";
import {
  editCandidateTimeMapSpan as editProjectCandidateTimeMapSpan,
  mergeCandidateTimeMapSpanWithNext as mergeProjectCandidateTimeMapSpanWithNext,
  resolveOriginalOnlyGap as resolveProjectOriginalOnlyGap,
  resolveReferenceOnlyGap as resolveProjectReferenceOnlyGap,
  reviewCandidateTimeMapSpan as reviewProjectCandidateTimeMapSpan,
  splitCandidateTimeMapSpan as splitProjectCandidateTimeMapSpan
} from "../../domain/alignment/timeMapReviewDecision";
import { submitAlignmentReviewVote as submitProjectAlignmentReviewVote } from "../../domain/alignment/alignmentAdjudication";
import { freezePersonalGoldCase as freezeProjectPersonalGoldCase } from "../../domain/alignment/personalGoldCase";
import { recordCandidateTimeMapSpanPlaybackReview as recordProjectTimeMapSpanPlaybackReview } from "../../domain/alignment/timeMapPlaybackReviewEvidence";
import type { EditorStore } from "../editorStoreTypes";
import {
  commitProject,
  createClipFromAsset,
  createErrorStatus,
  createSelection,
  emptySelection,
  formatDurationForStatus,
  getClipVisualEndMs,
  getClipVisualStartMs,
  isTimeInsideClipBody,
  mergeAdjacentClips,
  splitClip,
  unique
} from "../editorStoreHelpers";

export type EditingSlice = Pick<
  EditorStore,
  | "reviewCandidateTimeMapSpan"
  | "editCandidateTimeMapSpan"
  | "splitCandidateTimeMapSpan"
  | "mergeCandidateTimeMapSpanWithNext"
  | "resolveOriginalOnlyGap"
  | "resolveReferenceOnlyGap"
  | "recordTimeMapSpanPlaybackReview"
  | "submitAlignmentReviewVote"
  | "freezePersonalGoldCase"
  | "addAssetToTimeline"
  | "removeAssetFromTimeline"
  | "autoArrangeClips"
  | "startXmlEditing"
  | "moveClip"
  | "moveSelectedClips"
  | "moveSelectedCutMarkers"
  | "updateClip"
  | "moveSelectedDanmaku"
  | "setItemAdjustment"
  | "disableSelectedDanmaku"
  | "restoreSelectedDanmaku"
  | "cleanupProjectEditReferences"
  | "cleanupProjectMissingAssetClips"
  | "addCutMarkerAtPlayhead"
  | "addCutMarker"
  | "updateCutMarker"
  | "deleteCutMarker"
  | "deleteSelection"
  | "splitClipAtTime"
  | "splitSelectedClipsAtPlayhead"
  | "mergeSelectedClips"
  | "addSyncAnchor"
  | "updateSyncAnchor"
  | "deleteSyncAnchor"
  | "setGlobalOffset"
  | "updatePreview"
>;

export const createEditingSlice: StateCreator<EditorStore, [], [], EditingSlice> = (
  set,
  get
) => ({

  reviewCandidateTimeMapSpan: (timeMapId, spanIndex, decision, precision = "rough") => {
    try {
      commitProject(set, get, "记录时间图差异分类", (project) =>
        reviewProjectCandidateTimeMapSpan(
          project,
          timeMapId,
          spanIndex,
          decision,
          new Date().toISOString(),
          precision
        )
      );
      set({
        status: {
          message: "已保存这一段的人工分类；整张时间图仍需完成验证后才能导出。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法保存这一段的人工分类", error) });
    }
  },

  editCandidateTimeMapSpan: (timeMapId, spanIndex, patch) => {
    try {
      commitProject(set, get, "调整时间图片段边界", (project) =>
        editProjectCandidateTimeMapSpan(
          project,
          timeMapId,
          spanIndex,
          patch,
          new Date().toISOString()
        )
      );
      set({
        status: {
          message: "已更新双轴边界和片段类型；旧验证已撤销，请重新复核或明确接管当前方案。",
          tone: "warning"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法调整时间图片段", error) });
    }
  },

  splitCandidateTimeMapSpan: (timeMapId, spanIndex, point) => {
    try {
      commitProject(set, get, "拆分时间图片段", (project) =>
        splitProjectCandidateTimeMapSpan(
          project,
          timeMapId,
          spanIndex,
          point,
          new Date().toISOString()
        )
      );
      set({
        status: {
          message: "已按参考/原片双轴位置拆分；两个新分段需要重新复核。",
          tone: "warning"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法拆分时间图片段", error) });
    }
  },

  mergeCandidateTimeMapSpanWithNext: (timeMapId, spanIndex) => {
    try {
      commitProject(set, get, "合并时间图片段", (project) =>
        mergeProjectCandidateTimeMapSpanWithNext(
          project,
          timeMapId,
          spanIndex,
          new Date().toISOString()
        )
      );
      set({
        status: {
          message: "已合并相邻同类分段；合并后的边界需要重新复核。",
          tone: "warning"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法合并时间图片段", error) });
    }
  },

  resolveOriginalOnlyGap: (timeMapId, spanIndex, input, precision = "rough") => {
    try {
      commitProject(set, get, "标记原片独有内容", (project) =>
        resolveProjectOriginalOnlyGap(
          project,
          timeMapId,
          spanIndex,
          input,
          new Date().toISOString(),
          precision
        )
      );
      set({
        status: {
          message: `已标记原片独有 ${formatDurationForStatus(input.targetEndMs - input.targetStartMs)}；旧验证已撤销，可继续试听边界。`,
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法标记原片独有内容", error) });
    }
  },

  resolveReferenceOnlyGap: (timeMapId, spanIndex, input, precision = "rough") => {
    try {
      commitProject(set, get, "标记参考独有内容", (project) =>
        resolveProjectReferenceOnlyGap(
          project,
          timeMapId,
          spanIndex,
          input,
          new Date().toISOString(),
          precision
        )
      );
      set({
        status: {
          message: `已标记参考独有 ${formatDurationForStatus(input.sourceEndMs - input.sourceStartMs)}；旧验证已撤销，可继续试听边界。`,
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法标记参考独有内容", error) });
    }
  },

  recordTimeMapSpanPlaybackReview: (timeMapId, spanIndex, evidence) => {
    try {
      commitProject(set, get, "记录真实 A/B 播放复核", (project) =>
        recordProjectTimeMapSpanPlaybackReview(
          project,
          timeMapId,
          spanIndex,
          evidence,
          new Date().toISOString()
        )
      );
      set({
        status: {
          message: "已保存本段真实 A/B 播放复核证据。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法保存 A/B 播放复核证据", error) });
    }
  },

  submitAlignmentReviewVote: (input) => {
    const result = submitProjectAlignmentReviewVote(get().project, {
      ...input,
      reviewedAt: new Date().toISOString()
    });
    if (!result.ok) {
      set({ status: { message: result.message, tone: "warning" } });
      return false;
    }
    commitProject(set, get, "保存独立对齐复核", () => result.project);
    set({ status: { message: result.message, tone: "success" } });
    return true;
  },

  freezePersonalGoldCase: (reviewRecordId) => {
    const result = freezeProjectPersonalGoldCase(get().project, {
      reviewRecordId,
      frozenAt: new Date().toISOString()
    });
    if (!result.ok) {
      set({ status: { message: result.message, tone: "warning" } });
      return false;
    }
    if (!result.created) {
      set({ status: { message: result.message, tone: "neutral" } });
      return true;
    }
    commitProject(set, get, "冻结 Personal Gold", () => result.project);
    set({ status: { message: result.message, tone: "success" } });
    return true;
  },

  addAssetToTimeline: (assetId) => {
    commitProject(
      set,
      get,
      "添加弹幕片段",
      (project) => {
        const asset = project.assets.find((candidate) => candidate.id === assetId);
        if (!asset) {
          return project;
        }
        const latestEnd = project.clips.reduce(
          (max, clip) => Math.max(max, getClipVisualEndMs(clip)),
          0
        );
        return {
          ...project,
          clips: [...project.clips, createClipFromAsset(asset, latestEnd)]
        };
      },
      { kind: "clip", ids: [] }
    );
    const lastClip = get().project.clips.at(-1);
    if (lastClip) {
      set({ selection: { kind: "clip", ids: [lastClip.id] } });
    }
  },

  removeAssetFromTimeline: (assetId) => {
    const asset = get().project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      set({ status: { message: "弹幕资源不存在。", tone: "warning" } });
      return;
    }
    const clipCount = get().project.clips.filter((clip) => clip.assetId === assetId).length;
    if (clipCount === 0) {
      set({ status: { message: "该资源尚未放入时间轴。", tone: "warning" } });
      return;
    }
    commitProject(
      set,
      get,
      "移出时间轴",
      (project) => ({
        ...project,
        clips: project.clips.filter((clip) => clip.assetId !== assetId)
      }),
      emptySelection
    );
    set({ status: { message: `已从时间轴移出：${asset.fileName}`, tone: "success" } });
  },

  startXmlEditing: () => {
    const project = get().project;
    if (!isXmlOnlyProject(project)) {
      set({ status: { message: "视频对齐项目请在编辑工作台处理时间关系。", tone: "warning" } });
      return;
    }
    if (project.assets.length === 0) {
      set({ workspacePage: "materials", status: { message: "请先导入弹幕 XML。", tone: "warning" } });
      return;
    }
    const count = inspectXmlTimeline(project).unplacedAssets.length;
    try {
      if (count > 0) {
        commitProject(set, get, "加入未放入时间线的 XML", appendUnplacedXmlAssets);
      }
      set({
        workspacePage: "editing",
        status: {
          message: count > 0
            ? `已加入 ${count} 个 XML，保留原时间零点和已有编辑。优先按已知播放时长衔接，未知部分按末条弹幕估算，可继续调整间隔。`
            : "已继续编辑当前时间线，保留全部已有编辑。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法加入 XML", error) });
    }
  },

  autoArrangeClips: () => {
    const project = get().project;
    // Older entry points also use this command to initialize an empty timeline.
    // Keep initial XML intake consistent; existing timelines still support rearrange.
    if (isXmlOnlyProject(project) && project.clips.length === 0) {
      get().startXmlEditing();
      return;
    }
    commitProject(set, get, "按顺序排列分 P", (project) => {
      let cursor = 0;
      const clips = project.assets.map((asset) => {
        const existing = project.clips.find((clip) => clip.assetId === asset.id);
        const base = existing ?? createClipFromAsset(asset, cursor);
        const range = getAssetTimeRange(asset);
        const knownDuration = getKnownBilibiliDuration(asset);
        const duration = knownDuration !== null ? Math.max(knownDuration, range.latestMs + 1) : Math.max(30_000, range.latestMs - range.earliestMs);
        const arranged: DanmakuClip = {
          ...base,
          timelineStartMs: cursor,
          sourceInMs: knownDuration !== null ? 0 : range.earliestMs,
          sourceOutMs: Math.max(knownDuration ?? 0, range.latestMs + 1, range.earliestMs + 1),
          localOffsetMs: 0,
          enabled: true
        };
        cursor += duration;
        return arranged;
      });
      return { ...project, clips };
    });
    set({ status: { message: "已按分 P 顺序排列片段。", tone: "success" } });
  },

  moveClip: (clipId, deltaMs) => {
    if (deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动片段", (project) => ({
      ...project,
      clips: project.clips.map((clip) =>
        clip.id === clipId
          ? { ...clip, timelineStartMs: clampMilliseconds(clip.timelineStartMs + deltaMs) }
          : clip
      )
    }));
  },

  moveSelectedClips: (deltaMs) => {
    const selection = get().selection;
    if (selection.kind !== "clip" || selection.ids.length === 0 || deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动片段", (project) => ({
      ...project,
      clips: project.clips.map((clip) =>
        selection.ids.includes(clip.id)
          ? { ...clip, timelineStartMs: clampMilliseconds(clip.timelineStartMs + deltaMs) }
          : clip
      )
    }));
  },

  moveSelectedCutMarkers: (deltaMs) => {
    const selection = get().selection;
    if (selection.kind !== "cut" || selection.ids.length === 0 || deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动版本差异", (project) => ({
      ...project,
      cutMarkers: project.cutMarkers.map((marker) =>
        selection.ids.includes(marker.id)
          ? { ...marker, sourceAtMs: clampMilliseconds(marker.sourceAtMs + deltaMs) }
          : marker
      )
    }));
  },

  updateClip: (clipId, patch) => {
    commitProject(set, get, "修改片段", (project) => ({
      ...project,
      clips: project.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              ...patch,
              timelineStartMs:
                patch.timelineStartMs !== undefined
                  ? clampMilliseconds(patch.timelineStartMs)
                  : clip.timelineStartMs,
              sourceInMs:
                patch.sourceInMs !== undefined
                  ? clampMilliseconds(patch.sourceInMs)
                  : clip.sourceInMs,
              sourceOutMs:
                patch.sourceOutMs !== undefined
                  ? clampMilliseconds(patch.sourceOutMs)
                  : clip.sourceOutMs
            }
          : clip
      )
    }));
  },

  moveSelectedDanmaku: (deltaMs) => {
    const selection = get().selection;
    if (selection.kind !== "danmaku" || selection.ids.length === 0 || deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动弹幕", (project) => {
      const adjustments = { ...project.itemTimeAdjustments };
      for (const itemId of selection.ids) {
        adjustments[itemId] = (adjustments[itemId] ?? 0) + deltaMs;
      }
      return { ...project, itemTimeAdjustments: adjustments };
    });
  },

  setItemAdjustment: (itemId, adjustmentMs) => {
    commitProject(set, get, "设置弹幕时间微调", (project) => ({
      ...project,
      itemTimeAdjustments: {
        ...project.itemTimeAdjustments,
        [itemId]: adjustmentMs
      }
    }));
  },

  disableSelectedDanmaku: () => {
    const selection = get().selection;
    if (selection.kind !== "danmaku" || selection.ids.length === 0) {
      return;
    }
    commitProject(set, get, "禁用弹幕", (project) => ({
      ...project,
      disabledItemIds: unique([...project.disabledItemIds, ...selection.ids])
    }));
  },

  restoreSelectedDanmaku: () => {
    const selection = get().selection;
    if (selection.kind !== "danmaku" || selection.ids.length === 0) {
      return;
    }
    commitProject(set, get, "恢复弹幕", (project) => ({
      ...project,
      disabledItemIds: project.disabledItemIds.filter((id) => !selection.ids.includes(id))
    }));
  },

  cleanupProjectEditReferences: () => {
    const cleanup = cleanupProjectEditReferencesInProject(get().project);
    if (!cleanup.changed) {
      set({ status: { message: "当前没有需要清理的失效编辑引用。", tone: "neutral" } });
      return;
    }
    commitProject(set, get, "清理失效编辑引用", () => cleanup.project);
    set({
      status: {
        message: `已清理 ${cleanup.removedDisabledItemIds + cleanup.removedItemAdjustments} 条失效编辑引用。`,
        tone: "success"
      }
    });
  },

  cleanupProjectMissingAssetClips: () => {
    const cleanup = cleanupProjectMissingAssetClipsInProject(get().project);
    if (!cleanup.changed) {
      set({ status: { message: "当前没有需要清理的缺失资源片段。", tone: "neutral" } });
      return;
    }
    const removedClipIds = new Set(cleanup.removedClipIds);
    const selection = get().selection;
    const nextSelection =
      selection.kind === "clip"
        ? createSelection(
            "clip",
            selection.ids.filter((id) => !removedClipIds.has(id))
          )
        : selection;
    commitProject(set, get, "清理缺失资源片段", () => cleanup.project, nextSelection);
    set({
      status: {
        message: `已清理 ${cleanup.removedClipCount} 个缺失资源片段。`,
        tone: "success"
      }
    });
  },

  addCutMarkerAtPlayhead: () => {
    get().addCutMarker(get().project.timeline.playheadMs, 45_000);
  },

  addCutMarker: (sourceAtMs, targetGapMs = 45_000, draft) => {
    const markerId = createId("cut");
    commitProject(
      set,
      get,
      "添加版本差异",
      (project) => ({
        ...project,
        cutMarkers: [
          ...project.cutMarkers,
          {
            id: markerId,
            name: draft?.name ?? `版本差异 ${project.cutMarkers.length + 1}`,
            sourceAtMs: clampMilliseconds(sourceAtMs),
            targetGapMs,
            note: draft?.note ?? "目标完整版在此处额外存在内容"
          }
        ]
      }),
      { kind: "cut", ids: [markerId] }
    );
    set({
      status: {
        message: draft ? "已添加待确认版本差异。" : "已添加版本差异。",
        tone: "success"
      }
    });
  },

  updateCutMarker: (id, patch) => {
    commitProject(set, get, "修改版本差异", (project) => ({
      ...project,
      cutMarkers: project.cutMarkers.map((marker) =>
        marker.id === id
          ? {
              ...marker,
              ...patch,
              sourceAtMs:
                patch.sourceAtMs !== undefined
                  ? clampMilliseconds(patch.sourceAtMs)
                  : marker.sourceAtMs
            }
          : marker
      )
    }));
  },

  deleteCutMarker: (id) => {
    commitProject(
      set,
      get,
      "删除版本差异",
      (project) => ({
        ...project,
        cutMarkers: project.cutMarkers.filter((marker) => marker.id !== id)
      }),
      emptySelection
    );
  },

  deleteSelection: () => {
    const selection = get().selection;
    if (selection.ids.length === 0 || selection.kind === "none") {
      set({ status: { message: "当前没有可删除的选择项。", tone: "warning" } });
      return;
    }
    if (selection.kind === "danmaku") {
      get().disableSelectedDanmaku();
      set({ status: { message: `已禁用 ${selection.ids.length} 条弹幕。`, tone: "success" } });
      return;
    }
    if (selection.kind === "clip") {
      commitProject(
        set,
        get,
        "删除片段",
        (project) => ({
          ...project,
          clips: project.clips.filter((clip) => !selection.ids.includes(clip.id))
        }),
        emptySelection
      );
      set({
        status: { message: `已删除 ${selection.ids.length} 个时间轴片段。`, tone: "success" }
      });
      return;
    }
    if (selection.kind === "cut") {
      commitProject(
        set,
        get,
        "删除版本差异",
        (project) => ({
          ...project,
          cutMarkers: project.cutMarkers.filter((marker) => !selection.ids.includes(marker.id))
        }),
        emptySelection
      );
      set({
        status: { message: `已删除 ${selection.ids.length} 个版本差异。`, tone: "success" }
      });
      return;
    }
    set({ status: { message: "当前选择类型暂不支持删除。", tone: "warning" } });
  },

  splitClipAtTime: (clipId, splitAtMs) => {
    const project = get().project;
    const clip = project.clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      set({ status: { message: "要剪切的片段不存在。", tone: "warning" } });
      return;
    }
    const split = splitClip(clip, splitAtMs);
    if (!split) {
      set({ status: { message: "播放头必须位于片段内部，才能剪切。", tone: "warning" } });
      return;
    }
    commitProject(
      set,
      get,
      "剪切片段",
      (currentProject) => ({
        ...currentProject,
        clips: currentProject.clips.flatMap((candidate) =>
          candidate.id === clipId ? [split.left, split.right] : [candidate]
        )
      }),
      { kind: "clip", ids: [split.left.id, split.right.id] }
    );
    set({ status: { message: "已剪切片段。", tone: "success" } });
  },

  splitSelectedClipsAtPlayhead: () => {
    const { project, selection } = get();
    const targetIds =
      selection.kind === "clip" && selection.ids.length > 0
        ? selection.ids
        : project.clips
            .filter((clip) => isTimeInsideClipBody(project.timeline.playheadMs, clip))
            .map((clip) => clip.id);
    const splits = new Map<string, { left: DanmakuClip; right: DanmakuClip }>();
    for (const clipId of targetIds) {
      const clip = project.clips.find((candidate) => candidate.id === clipId);
      const split = clip ? splitClip(clip, project.timeline.playheadMs) : null;
      if (split) {
        splits.set(clipId, split);
      }
    }
    if (splits.size === 0) {
      set({ status: { message: "播放头没有位于可剪切的片段内部。", tone: "warning" } });
      return;
    }
    const selectedIds = Array.from(splits.values()).flatMap((split) => [
      split.left.id,
      split.right.id
    ]);
    commitProject(
      set,
      get,
      "剪切片段",
      (currentProject) => ({
        ...currentProject,
        clips: currentProject.clips.flatMap((clip) => {
          const split = splits.get(clip.id);
          return split ? [split.left, split.right] : [clip];
        })
      }),
      { kind: "clip", ids: selectedIds }
    );
    set({ status: { message: `已剪切 ${splits.size} 个片段。`, tone: "success" } });
  },

  mergeSelectedClips: () => {
    const { project, selection } = get();
    if (selection.kind !== "clip" || selection.ids.length < 2) {
      set({ status: { message: "请选择至少两个相邻片段再合并。", tone: "warning" } });
      return;
    }
    const selectedClips = project.clips
      .filter((clip) => selection.ids.includes(clip.id))
      .sort((left, right) => getClipVisualStartMs(left) - getClipVisualStartMs(right));
    const mergedClip = mergeAdjacentClips(selectedClips);
    if (!mergedClip) {
      set({
        status: {
          message: "只能合并同一 XML 且原弹幕时间、时间轴连续的片段。",
          tone: "warning"
        }
      });
      return;
    }
    const selected = new Set(selection.ids);
    commitProject(
      set,
      get,
      "合并片段",
      (currentProject) => ({
        ...currentProject,
        clips: currentProject.clips.flatMap((clip) => {
          if (clip.id === mergedClip.id) {
            return [mergedClip];
          }
          return selected.has(clip.id) ? [] : [clip];
        })
      }),
      { kind: "clip", ids: [mergedClip.id] }
    );
    set({ status: { message: "已合并相邻片段。", tone: "success" } });
  },

  addSyncAnchor: (anchor) => {
    commitProject(set, get, "添加同步锚点", (project) => ({
      ...project,
      syncAnchors: [...project.syncAnchors, anchor]
    }));
  },

  updateSyncAnchor: (id, patch) => {
    commitProject(set, get, "修改同步锚点", (project) => ({
      ...project,
      syncAnchors: project.syncAnchors.map((anchor) =>
        anchor.id === id
          ? {
              ...anchor,
              ...patch,
              sourceMs:
                patch.sourceMs !== undefined
                  ? clampMilliseconds(patch.sourceMs)
                  : anchor.sourceMs,
              targetMs:
                patch.targetMs !== undefined
                  ? clampMilliseconds(patch.targetMs)
                  : anchor.targetMs
            }
          : anchor
      )
    }));
  },

  deleteSyncAnchor: (id) => {
    commitProject(
      set,
      get,
      "删除同步锚点",
      (project) => ({
        ...project,
        syncAnchors: project.syncAnchors.filter((anchor) => anchor.id !== id)
      }),
      get().selection.kind === "anchor" && get().selection.ids.includes(id)
        ? emptySelection
        : get().selection
    );
  },

  setGlobalOffset: (offsetMs) => {
    commitProject(set, get, "修改全局偏移", (project) => ({
      ...project,
      globalOffsetMs: Math.round(offsetMs)
    }));
  },

  updatePreview: (patch) => {
    set((state) => ({
      project: touchProject({
        ...state.project,
        preview: {
          ...state.project.preview,
          ...patch
        }
      }),
      projectContentRevision: state.projectContentRevision + 1
    }));
  },
});
