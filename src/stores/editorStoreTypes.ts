import type { ExportDraft } from "../application/exportProjectCommands";
import type { EditorStatus } from "../application/commandStatus";
export type { ExportDraft } from "../application/exportProjectCommands";
export type { EditorStatus } from "../application/commandStatus";
import type {
  BilibiliDownloadedPage,
  BilibiliProjectContext
} from "../infrastructure/bilibili/bilibiliClient";
import type { BilibiliImportSummary } from "../application/importBilibiliMaterials";
import type { CutMarker, DanmakuClip, SyncAnchor } from "../domain/danmaku/types";
import type { HistoryState } from "../domain/history/history";
import type { DiscoveryItem, LibraryProfile } from "../domain/project/discovery";
import type { AlignmentProposal } from "../domain/alignment/types";
import type { MediaMatchRangePatch } from "../domain/alignment/mediaMatching";
import type {
  ManualTimeMapSpanPatch,
  ManualTimeMapSplitPoint,
  ResolveOriginalOnlyGapInput,
  ResolveReferenceOnlyGapInput,
  TimeMapSpanReviewDecision
} from "../domain/alignment/timeMapReviewDecision";
import type { SubmitAlignmentReviewVoteInput } from "../domain/alignment/alignmentAdjudication";
import type { TimeMapSpanPlaybackEvidence } from "../domain/alignment/timeMapPlaybackReviewEvidence";
import type {
  ManualMediaTimeMapVerificationInput,
  ManualMediaTimeMapVerificationRevocationInput
} from "../domain/alignment/mediaTimeMap";
import type {
  DanmakuSourceSegmentDraft,
  DanmakuSourceSegmentPatch
} from "../domain/project/sourceTimeline";
import type {
  EditorProject,
  EditorSelection,
  AlignmentReviewPrecision,
  MediaBinding,
  MediaMatchCandidate,
  ProjectMediaRole
} from "../domain/project/types";
import type { Milliseconds } from "../domain/shared/time";
import type {
  EmbyAudioCacheMediaDraft,
  WebDavAudioCacheMediaDraft
} from "../domain/project/mediaLibrary";
import type { CutHintSearchSettings } from "../domain/danmaku/cutHints";
import type { MaterialIntakePlan } from "../domain/project/materialIntakePlan";
import type { FamilyArrangement } from "../domain/project/mediaFamilyTypes";
import type {
  AudioTrackIntentCommand,
  AudioTrackPreparation
} from "../domain/project/audioTrackPreparation";
import type {
  MediaInventoryGenerationKey,
  MediaInventoryPublication,
  MediaInventorySemanticCounts,
  MediaInventorySemanticRow
} from "../application/mediaInventorySupervisor";
import type {
  ProjectLibraryAppliedProjectContext,
  ProjectLibraryIntent,
  ProjectLibrarySessionState
} from "../application/projectLibrarySessionController";
import type { ProjectParseResult } from "../domain/project/schema";
import type {
  WorkspaceIntent,
  WorkspaceIntentRequest,
  WorkspacePage
} from "../application/workspaceIntent";

export type { WorkspacePage } from "../application/workspaceIntent";

export type TimelineTool = "select" | "blade";

export interface CutMarkerDraft {
  name?: string;
  note?: string;
}

export type MediaInventorySessionRow =
  | MediaInventorySemanticRow
  | { mediaId: string; status: "unobserved" }
  | {
      mediaId: string;
      status: "notEligible";
      reason: "missingLocalPath" | "needsReconnect";
    };

export interface EditorStore {
  project: EditorProject;
  saveDiscovery: (items: DiscoveryItem[], profile?: LibraryProfile) => boolean;
  selection: EditorSelection;
  history: HistoryState<EditorProject>;
  isPlaying: boolean;
  status: EditorStatus;
  importProgress: number | null;
  exportDraft: ExportDraft | null;
  alignmentProposal: AlignmentProposal | null;
  cutHintSettings: CutHintSearchSettings;
  timelineTool: TimelineTool;
  workspacePage: WorkspacePage;
  workspaceIntentSequence: number;
  workspaceIntentRequest: WorkspaceIntentRequest | null;
  /** 当前在第 3 步编辑工作台中打开的媒体匹配关系；仅属于界面会话，不写入项目。 */
  alignmentEditorCandidateId: string | null;
  projectEpoch: number;
  /** 仅领域提交递增；播放头、选择、悬停等临时界面状态不得触发自动保存。 */
  projectContentRevision: number;
  projectLibrary: ProjectLibrarySessionState;
  projectLibraryIntentSequence: number;
  projectLibraryIntent: { sequence: number; intent: ProjectLibraryIntent } | null;
  mediaInventoryGeneration: number;
  mediaInventoryGenerationKey: MediaInventoryGenerationKey | null;
  mediaInventoryPhase: "idle" | MediaInventoryPublication["phase"];
  mediaInventoryCounts: MediaInventorySemanticCounts | null;
  mediaInventoryRows: Record<string, MediaInventorySessionRow>;
  mediaInventoryPaused: boolean;
  mediaInventoryCancelling: boolean;
  mediaInventoryRestartRequired: boolean;
  mediaInventoryTerminalMessage: string | null;
  synchronizeMediaInventory: () => MediaInventoryGenerationKey;
  refreshMediaInventory: () => void;
  cancelMediaInventory: () => void;
  applyMediaInventoryPublication: (publication: MediaInventoryPublication) => void;
  setMediaAudioTrackIntent: (mediaId: string, command: AudioTrackIntentCommand) => boolean;
  getMediaAudioTrackPreparation: (mediaId: string) => AudioTrackPreparation | null;
  setWorkspacePage: (page: WorkspacePage) => void;
  requestWorkspaceIntent: (intent: WorkspaceIntent) => void;
  acknowledgeWorkspaceIntent: (sequence: number) => void;
  selectAlignmentEditorCandidate: (candidateId: string) => void;
  applyProjectLibraryState: (state: ProjectLibrarySessionState) => void;
  requestProjectLibrary: (intent: ProjectLibraryIntent) => void;
  acknowledgeProjectLibraryIntent: (sequence: number) => void;
  newProject: () => void;
  renameProject: (name: string) => void;
  saveFamilyArrangement: (arrangement: FamilyArrangement) => boolean;
  setReferenceEpisodeHint: (mediaId: string, text: string) => boolean;
  adoptMatchesForPlayback: (candidateIds?: string[]) => boolean;
  importXmlFiles: (files: FileList | File[]) => Promise<void>;
  importXmlPaths: (paths: string[]) => Promise<void>;
  importBilibiliMaterials: (
    results: readonly BilibiliDownloadedPage[],
    context: BilibiliProjectContext
  ) => Promise<BilibiliImportSummary | null>;
  importMediaFiles: (files: FileList | File[], role: ProjectMediaRole) => void;
  importMediaPaths: (paths: string[], role: ProjectMediaRole) => void;
  importEmbyAudioCache: (draft: EmbyAudioCacheMediaDraft) => void;
  importWebDavAudioCache: (draft: WebDavAudioCacheMediaDraft) => void;
  addMediaMatchCandidate: (candidate: MediaMatchCandidate) => void;
  updateMediaMatchCandidateRange: (candidateId: string, patch: MediaMatchRangePatch) => void;
  reviewCandidateTimeMapSpan: (
    timeMapId: string,
    spanIndex: number,
    decision: TimeMapSpanReviewDecision,
    precision?: AlignmentReviewPrecision
  ) => void;
  editCandidateTimeMapSpan: (
    timeMapId: string,
    spanIndex: number,
    patch: ManualTimeMapSpanPatch
  ) => void;
  splitCandidateTimeMapSpan: (
    timeMapId: string,
    spanIndex: number,
    point: ManualTimeMapSplitPoint
  ) => void;
  mergeCandidateTimeMapSpanWithNext: (timeMapId: string, spanIndex: number) => void;
  resolveOriginalOnlyGap: (
    timeMapId: string,
    spanIndex: number,
    input: ResolveOriginalOnlyGapInput,
    precision?: AlignmentReviewPrecision
  ) => void;
  resolveReferenceOnlyGap: (
    timeMapId: string,
    spanIndex: number,
    input: ResolveReferenceOnlyGapInput,
    precision?: AlignmentReviewPrecision
  ) => void;
  recordTimeMapSpanPlaybackReview: (
    timeMapId: string,
    spanIndex: number,
    evidence: TimeMapSpanPlaybackEvidence
  ) => void;
  submitAlignmentReviewVote: (
    input: Omit<SubmitAlignmentReviewVoteInput, "reviewedAt">
  ) => boolean;
  freezePersonalGoldCase: (reviewRecordId: string) => boolean;
  importAlignmentShadowRiskOverlayJson: (json: string) => boolean;
  clearAlignmentShadowRiskOverlay: () => void;
  acceptMediaMatchCandidate: (candidateId: string, assetIds: string[]) => void;
  acceptMediaMatchCandidateWithManualTakeover: (
    candidateId: string,
    assetIds: string[]
  ) => void;
  issueManualMediaTimeMapVerification: (
    timeMapId: string,
    input: ManualMediaTimeMapVerificationInput
  ) => Promise<void>;
  revokeManualMediaTimeMapVerification: (
    timeMapId: string,
    input: ManualMediaTimeMapVerificationRevocationInput
  ) => Promise<void>;
  revokeMediaMatchCandidateAcceptance: (candidateId: string) => Promise<void>;
  rejectMediaMatchCandidate: (candidateId: string) => void;
  importVideoFile: (file: File) => void;
  removeMedia: () => void;
  removeMediaReference: (mediaId: string) => void;
  reconnectMediaReference: (mediaId: string, file: File) => void;
  bindCurrentMediaAsTarget: () => void;
  setMediaBinding: (binding: MediaBinding) => void;
  clearMediaBinding: () => void;
  bindXmlToSourceMedia: (assetId: string, sourceMediaId: string) => void;
  clearXmlSourceBinding: (assetId: string) => void;
  applyMaterialIntakeSuggestions: (
    plan: MaterialIntakePlan,
    suggestionIds: readonly string[]
  ) => void;
  bindCurrentTargetToSeasonEpisode: (episodeKey: string, episodeLabel: string) => void;
  clearSeasonEpisodeBinding: (episodeKey: string) => void;
  addDanmakuSourceSegment: (draft: DanmakuSourceSegmentDraft) => void;
  updateDanmakuSourceSegment: (id: string, patch: DanmakuSourceSegmentPatch) => void;
  deleteDanmakuSourceSegment: (id: string) => void;
  updateMediaDuration: (durationMs: Milliseconds, mediaId?: string | null) => void;
  openProjectFromText: (text: string, sourceFileName?: string) => void;
  openProjectFromLibrary: (
    result: ProjectParseResult,
    context: ProjectLibraryAppliedProjectContext
  ) => void;
  addAssetToTimeline: (assetId: string) => void;
  removeAsset: (assetId: string) => void;
  removeAssetFromTimeline: (assetId: string) => void;
  autoArrangeClips: () => void;
  startXmlEditing: () => void;
  select: (selection: EditorSelection) => void;
  clearSelection: () => void;
  selectAllClips: () => void;
  toggleDanmakuSelection: (itemId: string, additive: boolean) => void;
  toggleClipSelection: (clipId: string, additive: boolean) => void;
  toggleCutSelection: (cutId: string, additive: boolean) => void;
  selectDanmakuRange: (startMs: Milliseconds, endMs: Milliseconds, additive: boolean) => void;
  setPlayhead: (timeMs: Milliseconds) => void;
  setPlaying: (playing: boolean) => void;
  togglePlayback: () => void;
  setTimelineScroll: (scrollMs: Milliseconds) => void;
  setTimelineZoom: (
    pixelsPerSecond: number,
    anchorTimeMs?: Milliseconds,
    anchorRatio?: number
  ) => void;
  fitTimelineToContent: (viewportWidthPx?: number) => void;
  moveClip: (clipId: string, deltaMs: Milliseconds) => void;
  moveSelectedClips: (deltaMs: Milliseconds) => void;
  moveSelectedCutMarkers: (deltaMs: Milliseconds) => void;
  updateClip: (clipId: string, patch: Partial<Omit<DanmakuClip, "id" | "assetId">>) => void;
  moveSelectedDanmaku: (deltaMs: Milliseconds) => void;
  setItemAdjustment: (itemId: string, adjustmentMs: Milliseconds) => void;
  disableSelectedDanmaku: () => void;
  restoreSelectedDanmaku: () => void;
  cleanupProjectEditReferences: () => void;
  cleanupProjectMissingAssetClips: () => void;
  addCutMarkerAtPlayhead: () => void;
  addCutMarker: (
    sourceAtMs: Milliseconds,
    targetGapMs?: Milliseconds,
    draft?: CutMarkerDraft
  ) => void;
  updateCutMarker: (id: string, patch: Partial<Omit<CutMarker, "id">>) => void;
  deleteCutMarker: (id: string) => void;
  deleteSelection: () => void;
  splitClipAtTime: (clipId: string, splitAtMs: Milliseconds) => void;
  splitSelectedClipsAtPlayhead: () => void;
  mergeSelectedClips: () => void;
  setTimelineTool: (tool: TimelineTool) => void;
  addSyncAnchor: (anchor: SyncAnchor) => void;
  updateSyncAnchor: (id: string, patch: Partial<Omit<SyncAnchor, "id">>) => void;
  deleteSyncAnchor: (id: string) => void;
  setGlobalOffset: (offsetMs: Milliseconds) => void;
  updatePreview: (patch: Partial<EditorProject["preview"]>) => void;
  prepareExport: () => void;
  clearExport: () => void;
  importAlignmentProposalText: (text: string, sourceFileName?: string) => void;
  previewAlignmentProposalData: (proposal: AlignmentProposal) => void;
  exportAlignmentProposal: () => string;
  clearAlignmentProposal: () => void;
  applyAlignmentProposalData: (proposal: AlignmentProposal) => void;
  applyAlignmentProposal: () => void;
  setCutHintSettings: (settings: Partial<CutHintSearchSettings>) => void;
  undo: () => void;
  redo: () => void;
}
