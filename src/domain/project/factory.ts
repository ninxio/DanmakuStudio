import type { EditorProject } from "./types";
import { CURRENT_SCHEMA_VERSION } from "./types";

export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${random}`;
}

export function createEmptyProject(name = "未命名项目"): EditorProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: createId("project"),
    name,
    media: null,
    mediaLibrary: [],
    mediaBinding: null,
    seasonEpisodeBindings: [],
    danmakuSourceBindings: [],
    danmakuSourceSegments: [],
    mediaMatchCandidates: [],
    mediaTimeMaps: [],
    alignmentReviewRecords: [],
    alignmentReviewVotes: [],
    alignmentPersonalGoldCases: [],
    alignmentShadowRiskOverlay: null,
    assets: [],
    clips: [],
    globalOffsetMs: 0,
    cutMarkers: [],
    syncAnchors: [],
    alignmentProposal: null,
    itemTimeAdjustments: {},
    disabledItemIds: [],
    timeline: {
      pixelsPerSecond: 90,
      scrollMs: 0,
      playheadMs: 0
    },
    preview: {
      danmakuVisible: true,
      safeAreaVisible: false,
      opacity: 0.88
    },
    createdAt: now,
    updatedAt: now
  };
}

export function cloneProject(project: EditorProject): EditorProject {
  return structuredClone(project);
}

export function touchProject(project: EditorProject): EditorProject {
  return {
    ...project,
    updatedAt: new Date().toISOString()
  };
}
