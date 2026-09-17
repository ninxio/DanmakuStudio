import { describe, expect, it } from "vitest";
import type { AlignmentProposal } from "./types";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import { createEmptyProject } from "../project/factory";
import { createDanmakuSourceBinding } from "../project/mediaLibrary";
import { createDanmakuSourceSegment } from "../project/sourceTimeline";
import { validateProjectSchema } from "../project/schema";
import type { EditorProject, ProjectMediaReference, ProjectMediaRole } from "../project/types";
import { projectDanmakuToTargets } from "../timeline/sourceProjection";
import {
  acceptMediaMatchCandidate,
  acceptMediaMatchCandidateWithManualTakeover,
  automaticallyAcceptMediaMatchCandidate,
  createAppliedSegmentId,
  createMediaMatchCandidate,
  reconcileMediaMatchCandidates,
  rejectMediaMatchCandidate,
  revokeMediaMatchCandidateAcceptance,
  upsertMediaMatchCandidate,
  updateMediaMatchCandidateRange
} from "./mediaMatching";
import { assessManualMediaTimeMapVerificationEligibility } from "./mediaTimeMap";
import { readTimeMapManualTakeover } from "./timeMapReviewDecision";

const TIMESTAMP = "2026-07-11T00:00:00.000Z";

describe("media matching candidates", () => {
  it("从带 matchRange 的提案创建候选，并为提案与规则 ID 加候选命名空间", () => {
    const project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 0,
      targetEndMs: 65_000
    });

    const candidate = createMediaMatchCandidate(
      project,
      {
        id: "candidate-1",
        batchId: "batch-1",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal
      },
      TIMESTAMP
    );

    expect(candidate).toMatchObject({
      id: "candidate-1",
      batchId: "batch-1",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 0,
      targetEndMs: 65_000,
      confidence: 0.9,
      state: "pending",
      appliedSegmentIds: []
    });
    expect(candidate.proposal.anchors[0].id).toBe("candidate-1:anchor:0:anchor-shared");
    expect(candidate.proposal.cutCandidates[0].id).toBe("candidate-1:cut:0:cut-shared");
    expect(candidate.timingRules[0]).toMatchObject({
      id: "candidate-1:rule:0:candidate-1:cut:0:cut-shared",
      sourceAtMs: 40_000,
      gapMs: 5_000
    });
    expect(proposal.anchors[0].id).toBe("anchor-shared");
  });

  it("没有绑定 XML 时把合法候选标记为 blocked，并严格拒绝角色与区间错误", () => {
    const project = createMatchingProject();
    project.danmakuSourceBindings = [];
    const proposal = createProposal();
    const blocked = createMediaMatchCandidate(project, {
      id: "blocked",
      batchId: "batch",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });
    expect(blocked.state).toBe("blocked");

    expect(() =>
      createMediaMatchCandidate(project, {
        id: "wrong-role",
        batchId: "batch",
        sourceMediaId: "target-1",
        targetMediaId: "source-1",
        proposal
      })
    ).toThrow("来源必须是 B 站参考素材");

    const outOfRange = createProposal({ sourceEndMs: 300_000, targetEndMs: 300_000 });
    expect(() =>
      createMediaMatchCandidate(project, {
        id: "out-of-range",
        batchId: "batch",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal: outOfRange
      })
    ).toThrow("超出素材已知时长");
  });

  it("更新待复核区间并拒绝候选，不改写已确认片段", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-1",
      "source-1",
      "target-1"
    );
    const updated = updateMediaMatchCandidateRange(
      project,
      "candidate-1",
      { sourceStartMs: 5_000, targetEndMs: 75_000 },
      "2026-07-11T00:01:00.000Z"
    );
    expect(updated.mediaMatchCandidates[0]).toMatchObject({
      sourceStartMs: 5_000,
      targetEndMs: 75_000,
      state: "pending",
      updatedAt: "2026-07-11T00:01:00.000Z"
    });
    expect(updated.mediaMatchCandidates[0].proposal.matchRange).toMatchObject({
      sourceStartMs: 5_000,
      targetEndMs: 75_000
    });

    const rejected = rejectMediaMatchCandidate(
      updated,
      "candidate-1",
      "2026-07-11T00:02:00.000Z"
    );
    expect(rejected.mediaMatchCandidates[0]).toMatchObject({
      state: "rejected",
      appliedSegmentIds: []
    });
    expect(rejected.danmakuSourceSegments).toEqual([]);
    expect(() => acceptMediaMatchCandidate(rejected, "candidate-1", ["asset-1"])).toThrow(
      "已拒绝"
    );
  });

  it("空 range patch 或与当前值相同的 patch 保持项目与候选时间图 revision 不变", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-noop-range",
      "source-1",
      "target-1"
    );
    const seeded = updateMediaMatchCandidateRange(
      project,
      "candidate-noop-range",
      { sourceStartMs: 11_000, sourceEndMs: 71_000 },
      "2026-07-11T00:01:00.000Z"
    );
    expect(seeded.mediaTimeMaps[0]?.revision).toBe(1);

    const emptyPatch = updateMediaMatchCandidateRange(
      seeded,
      "candidate-noop-range",
      {},
      "2026-07-11T00:02:00.000Z"
    );
    expect(emptyPatch).toBe(seeded);
    expect(emptyPatch.mediaTimeMaps[0]?.revision).toBe(1);

    const sameValuePatch = updateMediaMatchCandidateRange(
      seeded,
      "candidate-noop-range",
      {
        sourceStartMs: 11_000,
        sourceEndMs: 71_000,
        targetStartMs: seeded.mediaMatchCandidates[0].targetStartMs,
        targetEndMs: seeded.mediaMatchCandidates[0].targetEndMs
      },
      "2026-07-11T00:03:00.000Z"
    );
    expect(sameValuePatch).toBe(seeded);
    expect(sameValuePatch.mediaTimeMaps[0]?.revision).toBe(1);
    expect(sameValuePatch.mediaMatchCandidates[0].updatedAt).toBe(
      "2026-07-11T00:01:00.000Z"
    );
  });

  it("整体平移候选范围时同步平移 proposal 锚点、差异坐标和段内规则", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-shift",
      "source-1",
      "target-1"
    );
    project.mediaMatchCandidates[0].proposal.evidenceProfile = createEvidenceProfile();

    const updated = updateMediaMatchCandidateRange(project, "candidate-shift", {
      sourceStartMs: 20_000,
      sourceEndMs: 80_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    const candidate = updated.mediaMatchCandidates[0];

    expect(candidate.proposal.matchRange).toMatchObject({
      sourceStartMs: 20_000,
      sourceEndMs: 80_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    expect(candidate.proposal.anchors[0]).toMatchObject({ sourceMs: 25_000, targetMs: 35_000 });
    expect(candidate.proposal.cutCandidates[0]).toMatchObject({
      sourceAtMs: 50_000,
      sourceRangeStartMs: 49_000,
      sourceRangeEndMs: 51_000
    });
    expect(candidate.timingRules[0].sourceAtMs).toBe(50_000);
    expect(candidate.proposal.evidenceProfile?.samples).toEqual([
      expect.objectContaining({
        axis: "source",
        startMs: 22_000,
        endMs: 24_000,
        counterpartMs: 32_000,
        offsetMs: 10_000
      }),
      expect.objectContaining({
        axis: "target",
        startMs: 32_000,
        endMs: 34_000,
        counterpartMs: 22_000,
        offsetMs: 10_000
      })
    ]);
    expect(validateProjectSchema(updated).ok).toBe(true);
  });

  it("整体平移 v12 时间图时按双轴同步平移逐段边界和备选路径", () => {
    const project = createMatchingProject();
    const timeMap = createVerifiedTimeMapProposal();
    const firstSpan = timeMap.spans[0];
    const editSpan = timeMap.spans[1];
    if (!firstSpan?.boundaries || !editSpan?.boundaries) {
      throw new Error("测试时间图缺少完整逐段边界证据。");
    }
    firstSpan.boundaries.start = {
      status: "refined",
      axis: "source",
      contextSide: "before",
      coarseMs: 10_000,
      refinedMs: 10_100,
      uncertaintyStartMs: 10_050,
      uncertaintyEndMs: 10_150,
      supportDurationMs: 5_000,
      correlation: 0.9,
      alternativeMargin: 0.4,
      reason: "参考轴边界测试证据。"
    };
    firstSpan.alternatives = [
      {
        kind: "matched",
        score: 0.8,
        sourceStartMs: 11_000,
        sourceEndMs: 39_000,
        targetStartMs: 31_000,
        targetEndMs: 62_000,
        reason: "备选路径测试证据。"
      }
    ];
    editSpan.boundaries.start = {
      status: "refined",
      axis: "target",
      contextSide: "before",
      coarseMs: 63_000,
      refinedMs: 63_100,
      uncertaintyStartMs: 63_050,
      uncertaintyEndMs: 63_150,
      supportDurationMs: 5_000,
      correlation: 0.9,
      alternativeMargin: 0.4,
      reason: "目标轴边界测试证据。"
    };
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-v12-shift",
        batchId: "batch",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal: {
          ...createProposal({ targetStartMs: 30_000, targetEndMs: 95_000 }),
          timeMap
        }
      })
    ];

    const updated = updateMediaMatchCandidateRange(project, "candidate-v12-shift", {
      sourceStartMs: 20_000,
      sourceEndMs: 80_000,
      targetStartMs: 50_000,
      targetEndMs: 115_000
    });
    const shiftedSpans = updated.mediaMatchCandidates[0].proposal.timeMap?.spans;

    expect(shiftedSpans?.[0]?.boundaries?.start).toMatchObject({
      coarseMs: 20_000,
      refinedMs: 20_100,
      uncertaintyStartMs: 20_050,
      uncertaintyEndMs: 20_150
    });
    expect(shiftedSpans?.[1]?.boundaries?.start).toMatchObject({
      coarseMs: 83_000,
      refinedMs: 83_100,
      uncertaintyStartMs: 83_050,
      uncertaintyEndMs: 83_150
    });
    expect(shiftedSpans?.[0]?.alternatives?.[0]).toMatchObject({
      sourceStartMs: 21_000,
      sourceEndMs: 49_000,
      targetStartMs: 51_000,
      targetEndMs: 82_000
    });
  });

  it("只调整范围边界时保留范围内证据，并排除被裁出的旧证据", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-trim",
      "source-1",
      "target-1"
    );
    const evidenceProfile = createEvidenceProfile();
    project.mediaMatchCandidates[0].proposal.evidenceProfile = {
      ...evidenceProfile,
      samples: [
        { ...evidenceProfile.samples[0], endMs: 18_000 },
        evidenceProfile.samples[1],
        {
          ...evidenceProfile.samples[0],
          startMs: 40_000,
          endMs: 45_000
        }
      ]
    };
    const expanded = updateMediaMatchCandidateRange(project, "candidate-trim", {
      sourceStartMs: 5_000
    });

    expect(expanded.mediaMatchCandidates[0].proposal.anchors[0].sourceMs).toBe(15_000);
    expect(expanded.mediaMatchCandidates[0].timingRules[0].sourceAtMs).toBe(40_000);
    const trimmed = updateMediaMatchCandidateRange(expanded, "candidate-trim", {
      sourceStartMs: 16_000,
      sourceEndMs: 39_000
    });
    expect(trimmed.mediaMatchCandidates[0].proposal.anchors).toHaveLength(0);
    expect(trimmed.mediaMatchCandidates[0].proposal.cutCandidates).toHaveLength(0);
    expect(trimmed.mediaMatchCandidates[0].timingRules).toHaveLength(0);
    expect(trimmed.mediaMatchCandidates[0].proposal.diagnostics).toContain(
      "人工调整范围后排除了 2 条范围外匹配证据。"
    );
    expect(trimmed.mediaMatchCandidates[0].proposal.evidenceProfile?.samples).toEqual([
      expect.objectContaining({ axis: "source", startMs: 16_000, endMs: 18_000 }),
      expect.objectContaining({ axis: "target", startMs: 2_000, endMs: 4_000 })
    ]);
    expect(validateProjectSchema(trimmed).ok).toBe(true);
  });

  it("一条参考素材可接受为多个目标原片的独立来源段（1→N）", () => {
    let project = createMatchingProject();
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-target-1",
        batchId: "batch",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal: createProposal({
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 65_000
        })
      }),
      createMediaMatchCandidate(project, {
        id: "candidate-target-2",
        batchId: "batch",
        sourceMediaId: "source-1",
        targetMediaId: "target-2",
        proposal: createProposal({
          sourceStartMs: 70_000,
          sourceEndMs: 130_000,
          targetStartMs: 0,
          targetEndMs: 65_000
        })
      })
    ];

    project = acceptMediaMatchCandidate(project, "candidate-target-1", ["asset-1"]);
    project = acceptMediaMatchCandidate(project, "candidate-target-2", ["asset-1"]);

    expect(project.danmakuSourceSegments).toHaveLength(2);
    expect(project.danmakuSourceSegments.map((segment) => segment.targetMediaId)).toEqual([
      "target-1",
      "target-2"
    ]);
    expect(project.mediaMatchCandidates.map((candidate) => candidate.state)).toEqual([
      "accepted",
      "accepted"
    ]);
  });

  it("多条参考素材可分别落到同一目标原片，并只接受各自绑定的 XML（N→1）", () => {
    let project = createMatchingProject();
    project.mediaLibrary.push(createMedia("source-2", "bilibiliReference"));
    project.assets.push(createAsset("asset-2", "source-2.xml"));
    project.danmakuSourceBindings.push(
      createDanmakuSourceBinding("binding-2", "asset-2", "source-2", TIMESTAMP)
    );
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-source-1",
        batchId: "batch",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal: createProposal({ targetStartMs: 0, targetEndMs: 65_000 })
      }),
      createMediaMatchCandidate(project, {
        id: "candidate-source-2",
        batchId: "batch",
        sourceMediaId: "source-2",
        targetMediaId: "target-1",
        proposal: createProposal({ targetStartMs: 80_000, targetEndMs: 145_000 })
      })
    ];

    project = acceptMediaMatchCandidate(project, "candidate-source-1", ["asset-1"]);
    expect(() => acceptMediaMatchCandidate(project, "candidate-source-2", ["asset-1"])).toThrow(
      "不一致"
    );
    project = acceptMediaMatchCandidate(project, "candidate-source-2", ["asset-2"]);

    expect(project.danmakuSourceSegments).toHaveLength(2);
    expect(project.danmakuSourceSegments.map((segment) => segment.sourceMediaId)).toEqual([
      "source-1",
      "source-2"
    ]);
    expect(project.danmakuSourceSegments.map((segment) => segment.targetMediaId)).toEqual([
      "target-1",
      "target-1"
    ]);
    expect(project.danmakuSourceSegments[1].targetStartMs).toBe(80_000);
  });

  it("已有同素材对重叠来源段时拒绝重复确认，避免同一 XML 重复投影", () => {
    let project = withCandidate(
      createMatchingProject(),
      "candidate-first",
      "source-1",
      "target-1"
    );
    project = acceptMediaMatchCandidate(project, "candidate-first", ["asset-1"]);
    project.mediaMatchCandidates.push(
      createMediaMatchCandidate(project, {
        id: "candidate-duplicate",
        batchId: "batch-duplicate",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal: createProposal()
      })
    );

    expect(() =>
      acceptMediaMatchCandidate(project, "candidate-duplicate", ["asset-1"])
    ).toThrow("不能重复确认");
    expect(project.danmakuSourceSegments).toHaveLength(1);
  });

  it("候选范围与同一 XML 的忽略段重叠时拒绝确认", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-ignored",
      "source-1",
      "target-1"
    );
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("ignored-range", {
        label: "已确认片头忽略范围",
        kind: "ignored",
        assetId: "asset-1",
        sourceMediaId: "source-1",
        sourceStartMs: 0,
        sourceEndMs: 20_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    ];

    expect(() => acceptMediaMatchCandidate(project, "candidate-ignored", ["asset-1"])).toThrow(
      "与当前候选范围冲突"
    );
    expect(project.danmakuSourceSegments).toHaveLength(1);
  });

  it("重复接受候选保持幂等，且不写入全局 anchors/cutMarkers", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-1",
      "source-1",
      "target-1"
    );
    project.syncAnchors = [
      { id: "existing-anchor", sourceMs: 1_000, targetMs: 2_000, origin: "manual" }
    ];
    project.cutMarkers = [
      { id: "existing-cut", name: "已有差异", sourceAtMs: 1_000, targetGapMs: 500, note: "" }
    ];

    const accepted = acceptMediaMatchCandidate(project, "candidate-1", ["asset-1"], TIMESTAMP);
    const acceptedAgain = acceptMediaMatchCandidate(
      accepted,
      "candidate-1",
      ["asset-1"],
      "2026-07-11T01:00:00.000Z"
    );

    expect(acceptedAgain.danmakuSourceSegments).toHaveLength(1);
    expect(acceptedAgain.mediaMatchCandidates[0].appliedSegmentIds).toEqual([
      createAppliedSegmentId("candidate-1", "asset-1")
    ]);
    expect(acceptedAgain.mediaTimeMaps).toHaveLength(2);
    expect(acceptedAgain.mediaTimeMaps.map((map) => map.state).sort()).toEqual([
      "candidate",
      "confirmed"
    ]);
    expect(acceptedAgain.syncAnchors).toEqual(project.syncAnchors);
    expect(acceptedAgain.cutMarkers).toEqual(project.cutMarkers);
  });

  it("同范围但 spans 异构的候选图不能绕过 proposal.timeMap 语义绑定", () => {
    let project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    proposal.timeMap = createVerifiedTimeMapProposal();
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-semantic-mismatch",
      batchId: "batch-v2",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });
    project = upsertMediaMatchCandidate(project, candidate, TIMESTAMP);
    const candidateMap = project.mediaTimeMaps.find((map) => map.id === candidate.timeMapId);
    if (!candidateMap) {
      throw new Error("测试候选图不存在。");
    }
    const corruptedSpans = structuredClone(candidateMap.spans);
    corruptedSpans[0] = { ...corruptedSpans[0], targetEndMs: 62_000 };
    corruptedSpans[1] = { ...corruptedSpans[1], targetStartMs: 62_000 };
    const corrupted = {
      ...project,
      mediaTimeMaps: project.mediaTimeMaps.map((map) =>
        map.id === candidateMap.id ? { ...map, spans: corruptedSpans } : map
      )
    };

    expect(validateProjectSchema(corrupted).ok).toBe(false);
    expect(() =>
      acceptMediaMatchCandidate(corrupted, candidate.id, ["asset-1"], TIMESTAMP)
    ).toThrow("与候选提案的映射语义不一致");
  });

  it("已确认 clone 的映射语义被篡改后，重复接受和 schema 都 fail-closed", () => {
    let project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    proposal.timeMap = createVerifiedTimeMapProposal();
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-confirmed-tamper",
      batchId: "batch-v2",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });
    project = upsertMediaMatchCandidate(project, candidate, TIMESTAMP);
    const accepted = acceptMediaMatchCandidate(project, candidate.id, ["asset-1"], TIMESTAMP);
    const confirmedMap = accepted.mediaTimeMaps.find((map) => map.state === "confirmed");
    if (!confirmedMap) {
      throw new Error("测试确认图不存在。");
    }
    const corrupted = {
      ...accepted,
      mediaTimeMaps: accepted.mediaTimeMaps.map((map) =>
        map.id === confirmedMap.id
          ? { ...map, engineVersion: `${map.engineVersion}:tampered` }
          : map
      )
    };

    expect(validateProjectSchema(corrupted).ok).toBe(false);
    expect(() =>
      acceptMediaMatchCandidate(corrupted, candidate.id, ["asset-1"], TIMESTAMP)
    ).toThrow("确认时间图与候选时间图的映射语义不一致");
  });

  it("撤销确认会删除候选生成的来源段并恢复待复核，且可重新接受", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-revoke",
      "source-1",
      "target-1"
    );
    const accepted = acceptMediaMatchCandidate(
      project,
      "candidate-revoke",
      ["asset-1"],
      TIMESTAMP
    );
    const candidateMap = accepted.mediaTimeMaps.find((map) => map.state === "candidate");
    const confirmedMap = accepted.mediaTimeMaps.find((map) => map.state === "confirmed");
    expect(candidateMap).toMatchObject({ quality: { level: "legacy-unverified" } });
    expect(confirmedMap?.id).not.toBe(candidateMap?.id);
    expect(accepted.danmakuSourceSegments[0].timeMapId).toBe(confirmedMap?.id);
    expect(accepted.mediaMatchCandidates[0].confirmedTimeMapId).toBe(confirmedMap?.id);

    const revoked = revokeMediaMatchCandidateAcceptance(
      accepted,
      "candidate-revoke",
      "2026-07-11T00:03:00.000Z"
    );
    expect(revoked.danmakuSourceSegments).toEqual([]);
    expect(revoked.mediaMatchCandidates[0]).toMatchObject({
      state: "pending",
      appliedSegmentIds: [],
      confirmedTimeMapId: null,
      updatedAt: "2026-07-11T00:03:00.000Z"
    });
    expect(revoked.mediaTimeMaps.find((map) => map.id === confirmedMap?.id)?.state).toBe(
      "superseded"
    );

    const acceptedAgain = acceptMediaMatchCandidate(revoked, "candidate-revoke", ["asset-1"]);
    expect(acceptedAgain.mediaMatchCandidates[0].state).toBe("accepted");
    expect(acceptedAgain.danmakuSourceSegments).toHaveLength(1);
    expect(acceptedAgain.mediaMatchCandidates[0].confirmedTimeMapId).toContain(
      ":time-map:confirmed:2"
    );
  });

  it("撤销按 confirmed map 清理未登记的同归属段，不留下可导出孤儿", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-revoke-all",
      "source-1",
      "target-1"
    );
    const accepted = acceptMediaMatchCandidate(
      project,
      "candidate-revoke-all",
      ["asset-1"],
      TIMESTAMP
    );
    const ownedSegment = accepted.danmakuSourceSegments[0];
    const inconsistent = {
      ...accepted,
      danmakuSourceSegments: [
        ownedSegment,
        {
          ...ownedSegment,
          id: "candidate-revoke-all:segment:recovered-after-interruption",
          label: "异常中断后未登记但仍指向确认图的段"
        }
      ]
    };
    expect(validateProjectSchema(inconsistent).ok).toBe(false);

    const revoked = revokeMediaMatchCandidateAcceptance(
      inconsistent,
      "candidate-revoke-all",
      "2026-07-11T00:03:00.000Z"
    );
    expect(revoked.danmakuSourceSegments).toEqual([]);
    expect(revoked.mediaMatchCandidates[0]).toMatchObject({
      state: "pending",
      confirmedTimeMapId: null,
      appliedSegmentIds: []
    });
    expect(validateProjectSchema(revoked).ok).toBe(true);
  });

  it("撤销遇到未知 appliedSegmentIds 时安全阻断且不删除任何来源段", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-revoke-unknown",
      "source-1",
      "target-1"
    );
    const accepted = acceptMediaMatchCandidate(
      project,
      "candidate-revoke-unknown",
      ["asset-1"],
      TIMESTAMP
    );
    const corrupted = {
      ...accepted,
      mediaMatchCandidates: accepted.mediaMatchCandidates.map((candidate) => ({
        ...candidate,
        appliedSegmentIds: [...candidate.appliedSegmentIds, "unknown-segment"]
      }))
    };

    expect(() =>
      revokeMediaMatchCandidateAcceptance(corrupted, "candidate-revoke-unknown")
    ).toThrow("已安全阻断撤销");
    expect(corrupted.danmakuSourceSegments).toEqual(accepted.danmakuSourceSegments);
  });

  it("来源段、XML 或媒体删除后清理候选的已应用引用与状态", () => {
    const project = withCandidate(
      createMatchingProject(),
      "candidate-cleanup",
      "source-1",
      "target-1"
    );
    const accepted = acceptMediaMatchCandidate(
      project,
      "candidate-cleanup",
      ["asset-1"],
      TIMESTAMP
    );
    const withoutSegment = reconcileMediaMatchCandidates({
      ...accepted,
      danmakuSourceSegments: []
    });
    expect(withoutSegment.mediaMatchCandidates[0]).toMatchObject({
      state: "pending",
      appliedSegmentIds: []
    });

    const withoutAsset = reconcileMediaMatchCandidates({
      ...accepted,
      assets: [],
      danmakuSourceBindings: []
    });
    expect(withoutAsset.mediaMatchCandidates[0]).toMatchObject({
      state: "blocked",
      appliedSegmentIds: []
    });

    const withoutTarget = reconcileMediaMatchCandidates({
      ...accepted,
      mediaLibrary: accepted.mediaLibrary.filter((media) => media.id !== "target-1")
    });
    expect(withoutTarget.mediaMatchCandidates).toEqual([]);
    expect(validateProjectSchema(withoutSegment).ok).toBe(true);
    // 清理引用不会静默删除用户来源段；失去 accepted owner 的旧段由 schema fail-closed。
    expect(validateProjectSchema(withoutAsset).ok).toBe(false);
    expect(validateProjectSchema(withoutTarget).ok).toBe(false);
  });

  it("旧候选接受后生成显式时间图，但 legacy-unverified 默认阻断导出", () => {
    let project = createMatchingProject();
    project.assets[0].items = [
      createDanmakuItem("asset-1", 0, 20_000),
      createDanmakuItem("asset-1", 1, 50_000)
    ];
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-projection",
        batchId: "batch-projection",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal: createProposal({
          sourceStartMs: 10_000,
          sourceEndMs: 70_000,
          targetStartMs: 30_000,
          targetEndMs: 95_000
        })
      })
    ];

    project = acceptMediaMatchCandidate(
      project,
      "candidate-projection",
      ["asset-1"],
      TIMESTAMP
    );
    const appliedSegment = project.danmakuSourceSegments[0];
    expect(appliedSegment).toMatchObject({
      targetStartMs: 30_000,
      timingRules: [{ sourceAtMs: 40_000, gapMs: 5_000 }]
    });
    expect(typeof appliedSegment.timeMapId).toBe("string");
    expect(project.mediaTimeMaps.find((map) => map.id === appliedSegment.timeMapId)).toMatchObject({
      state: "confirmed",
      quality: { level: "legacy-unverified" }
    });

    const projection = projectDanmakuToTargets(project);
    expect(projection.status).toBe("blocked");
    expect(projection.groups).toEqual([]);
    expect(projection.issues.some((issue) => issue.message.includes("旧版未验证"))).toBe(true);
  });

  it("Alignment V2 候选保留分段仿射图，但没有校准 record 时不能伪装 verified 导出", () => {
    let project = createMatchingProject();
    project.assets[0].items = [
      createDanmakuItem("asset-1", 0, 20_000),
      createDanmakuItem("asset-1", 1, 50_000)
    ];
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    proposal.timeMap = createVerifiedTimeMapProposal();
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-v2",
        batchId: "batch-v2",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal
      })
    ];

    project = acceptMediaMatchCandidate(project, "candidate-v2", ["asset-1"], TIMESTAMP);
    const candidateMap = project.mediaTimeMaps.find((map) => map.state === "candidate");
    const confirmedMap = project.mediaTimeMaps.find((map) => map.state === "confirmed");
    expect(candidateMap).toMatchObject({
      engineVersion: "alignment-v2-test",
      quality: { level: "review" },
      spans: [
        { kind: "matched" },
        { kind: "targetOnly" },
        { kind: "matched" }
      ]
    });
    expect(confirmedMap?.id).not.toBe(candidateMap?.id);
    expect(confirmedMap?.verification).toBeNull();

    const projection = projectDanmakuToTargets(project);
    expect(projection.status).toBe("blocked");
    expect(projection.groups).toHaveLength(0);
    expect(projection.issues.some((issue) => issue.message.includes("复核"))).toBe(true);
  });

  it("外部 V2 自报 verified 不满足中央概率门槛时降级并阻断导出", () => {
    let project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    const overclaimed = createVerifiedTimeMapProposal();
    overclaimed.quality.probability = 0.99;
    proposal.timeMap = overclaimed;
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-v2-overclaimed",
      batchId: "batch-v2",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });

    expect(candidate.proposal.timeMap?.quality).toMatchObject({ level: "review" });
    project = upsertMediaMatchCandidate(project, candidate, TIMESTAMP);
    expect(project.mediaTimeMaps[0]?.quality.level).toBe("review");
    project = acceptMediaMatchCandidate(project, candidate.id, ["asset-1"], TIMESTAMP);

    const projection = projectDanmakuToTargets(project);
    expect(projection.status).toBe("blocked");
    expect(projection.groups).toEqual([]);
    expect(projection.issues.some((issue) => issue.message.includes("仍需人工复核"))).toBe(true);
  });

  it("证据不足或有歧义的 V2 时间图在领域层也不能被确认", () => {
    const project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    const blockedTimeMap = createVerifiedTimeMapProposal();
    blockedTimeMap.quality = {
      ...blockedTimeMap.quality,
      level: "blocked",
      reasons: ["最佳路径与备选路径无法区分。"]
    };
    proposal.timeMap = blockedTimeMap;
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-blocked-v2",
      batchId: "batch-v2",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });
    project.mediaMatchCandidates = [candidate];

    expect(candidate.state).toBe("blocked");
    expect(() => acceptMediaMatchCandidate(project, candidate.id, ["asset-1"])).toThrow(
      "候选时间图已阻断"
    );
  });

  it("自动门控阻断时允许用户采用系统建议建立人工方案，并进入安装级签发预检", () => {
    let project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    const blockedTimeMap = createVerifiedTimeMapProposal();
    blockedTimeMap.quality = {
      ...blockedTimeMap.quality,
      level: "blocked",
      reasons: ["留出锚点未覆盖全部范围，自动确认已阻断。"]
    };
    proposal.timeMap = blockedTimeMap;
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-manual-takeover",
      batchId: "batch-v2",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });
    project = upsertMediaMatchCandidate(project, candidate, TIMESTAMP);

    const accepted = acceptMediaMatchCandidateWithManualTakeover(
      project,
      candidate.id,
      ["asset-1"],
      "2026-07-11T01:00:00.000Z"
    );
    const confirmedMap = accepted.mediaTimeMaps.find((map) => map.state === "confirmed");

    expect(accepted.mediaMatchCandidates[0]).toMatchObject({
      state: "accepted",
      confirmedTimeMapId: confirmedMap?.id
    });
    expect(accepted.danmakuSourceSegments).toHaveLength(1);
    expect(confirmedMap?.quality.level).toBe("review");
    expect(confirmedMap?.quality.reasons.join(" ")).toContain("自动确认已阻断");
    expect(readTimeMapManualTakeover(confirmedMap!)).toBe("2026-07-11T01:00:00.000Z");
    expect(
      assessManualMediaTimeMapVerificationEligibility(confirmedMap!, {
        calibrationArtifactId: "manual-takeover-ui",
        calibrationArtifactVersion: "1",
        verifier: "user",
        verifiedAt: "2026-07-11T01:01:00.000Z"
      })
    ).toEqual({ eligible: true, reason: null });
  });

  it("只改 V2 候选边界时不会硬拉旧映射，而是明确降级为 ambiguous", () => {
    const project = createMatchingProject();
    const proposal = createProposal({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      targetEndMs: 95_000
    });
    proposal.timeMap = createVerifiedTimeMapProposal();
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-range-v2",
        batchId: "batch-v2",
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        proposal
      })
    ];

    const updated = updateMediaMatchCandidateRange(project, "candidate-range-v2", {
      sourceStartMs: 12_000
    });
    expect(updated.mediaMatchCandidates[0]).toMatchObject({ state: "blocked" });
    expect(updated.mediaMatchCandidates[0].proposal.timeMap).toMatchObject({
      quality: { level: "blocked" },
      spans: [{ kind: "ambiguous", sourceStartMs: 12_000 }]
    });
    expect(updated.mediaTimeMaps[0]).toMatchObject({
      quality: { level: "blocked" },
      spans: [{ kind: "ambiguous" }]
    });
  });

  it("严格 V2.5 独立留出候选会自动绑定全部 XML 并形成可导出的 verified 确认图", () => {
    const project = createMatchingProject();
    const proposal = createAutomaticVerificationProposal();
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-auto-verified",
      batchId: "batch-auto",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal
    });
    const seeded = upsertMediaMatchCandidate(project, candidate, TIMESTAMP);

    const accepted = automaticallyAcceptMediaMatchCandidate(
      seeded,
      candidate.id,
      "2026-07-11T01:00:00.000Z"
    );
    const confirmed = accepted.mediaTimeMaps.find((map) => map.state === "confirmed");
    expect(accepted.mediaMatchCandidates[0]).toMatchObject({
      state: "accepted",
      confirmedTimeMapId: confirmed?.id
    });
    expect(accepted.danmakuSourceSegments).toHaveLength(1);
    expect(confirmed).toMatchObject({
      quality: { level: "verified" },
      verification: {
        method: "automatic-calibration",
        calibrationArtifactId: "alignment-v2.5-independent-holdout-policy"
      }
    });

    const unsafe = createMatchingProject();
    const unsafeProposal = createAutomaticVerificationProposal();
    unsafeProposal.timeMap!.quality.p95ResidualMs = 200;
    unsafeProposal.timeMap!.quality.p99ResidualMs = 220;
    unsafeProposal.timeMap!.quality.maxResidualMs = 250;
    const unsafeCandidate = createMediaMatchCandidate(unsafe, {
      id: "candidate-not-auto-verified",
      batchId: "batch-auto",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      proposal: unsafeProposal
    });
    const unchanged = automaticallyAcceptMediaMatchCandidate(
      upsertMediaMatchCandidate(unsafe, unsafeCandidate, TIMESTAMP),
      unsafeCandidate.id,
      "2026-07-11T01:00:00.000Z"
    );
    expect(unchanged.mediaMatchCandidates[0].state).toBe("pending");
    expect(unchanged.danmakuSourceSegments).toEqual([]);
  });
});

function withCandidate(
  project: EditorProject,
  id: string,
  sourceMediaId: string,
  targetMediaId: string
): EditorProject {
  return {
    ...project,
    mediaMatchCandidates: [
      createMediaMatchCandidate(project, {
        id,
        batchId: "batch",
        sourceMediaId,
        targetMediaId,
        proposal: createProposal()
      })
    ]
  };
}

function createMatchingProject(): EditorProject {
  const project = createEmptyProject("媒体匹配测试");
  project.mediaLibrary = [
    createMedia("source-1", "bilibiliReference"),
    createMedia("target-1", "targetOriginal", {
      episodeKey: "S01E01",
      episodeLabel: "第 1 集"
    }),
    createMedia("target-2", "targetOriginal", { episodeKey: "S01E02", episodeLabel: "第 2 集" })
  ];
  project.assets = [createAsset("asset-1", "source-1.xml")];
  project.danmakuSourceBindings = [
    createDanmakuSourceBinding("binding-1", "asset-1", "source-1", TIMESTAMP)
  ];
  return project;
}

function createProposal(
  overrides: Partial<NonNullable<AlignmentProposal["matchRange"]>> = {}
): AlignmentProposal {
  const matchRange = {
    sourceStartMs: 10_000,
    sourceEndMs: 70_000,
    targetStartMs: 0,
    targetEndMs: 65_000,
    coverage: 0.95,
    ...overrides
  };
  const sourceAnchorMs = matchRange.sourceStartMs + 5_000;
  const targetAnchorMs = matchRange.targetStartMs + 5_000;
  const cutSourceMs = matchRange.sourceStartMs + 30_000;
  return {
    anchors: [
      {
        id: "anchor-shared",
        sourceMs: sourceAnchorMs,
        targetMs: targetAnchorMs,
        confidence: 0.92,
        origin: "automatic"
      }
    ],
    cutCandidates: [
      {
        id: "cut-shared",
        name: "删减候选",
        sourceAtMs: cutSourceMs,
        sourceRangeStartMs: cutSourceMs - 1_000,
        sourceRangeEndMs: cutSourceMs + 1_000,
        targetGapMs: 5_000,
        confidence: 0.88,
        note: "音频持续阶跃"
      }
    ],
    confidence: 0.9,
    diagnostics: ["匹配测试"],
    matchRange
  };
}

function createVerifiedTimeMapProposal(): NonNullable<AlignmentProposal["timeMap"]> {
  return {
    sourceStartMs: 10_000,
    sourceEndMs: 70_000,
    targetStartMs: 30_000,
    targetEndMs: 95_000,
    spans: [
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 10_000,
        sourceEndMs: 40_000,
        targetStartMs: 30_000,
        targetEndMs: 63_000
      }, "verified-proposal:span:0001"),
      createTestCompleteTimeMapSpan({
        kind: "targetOnly",
        sourceStartMs: 40_000,
        sourceEndMs: 40_000,
        targetStartMs: 63_000,
        targetEndMs: 68_000
      }, "verified-proposal:span:0002"),
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 40_000,
        sourceEndMs: 70_000,
        targetStartMs: 68_000,
        targetEndMs: 95_000
      }, "verified-proposal:span:0003")
    ],
    quality: {
      level: "verified",
      probability: 0.999,
      metricSource: "measured",
      coverage: 0.96,
      uniqueContentCoverage: 0.9,
      p50ResidualMs: 25,
      p95ResidualMs: 80,
      p99ResidualMs: 120,
      maxResidualMs: 140,
      boundaryUncertaintyMs: 180,
      alternativeMargin: 0.4,
      anchorCount: 40,
      anchorRegionCount: 3,
      heldOutAnchorCount: 8,
      reasons: ["测试中的独立音画证据已验证。"]
    },
    evidence: {
      types: ["audio", "visual"],
      audioAnchorCount: 32,
      visualAnchorCount: 8,
      heldOutAnchorCount: 8,
      top1Top2Margin: 0.4,
      uniqueContentCoverage: 0.9,
      repeatedContentOnly: false,
      selectedTrackReason: "测试轨道排序。",
      alternativeTrackScores: [],
      notes: ["测试证据"]
    },
    sourceStream: createAlignmentAudioStreamIdentity(0),
    targetStream: createAlignmentAudioStreamIdentity(0),
    sourceIdentity: createTestMediaIdentity(),
    targetIdentity: createTestMediaIdentity(),
    engineVersion: "alignment-v2-test",
    featureVersion: "landmark-edit-dp-test",
    parametersHash: "test-v2-parameters"
  };
}

function createAutomaticVerificationProposal(): AlignmentProposal {
  const proposal = createProposal({
    sourceStartMs: 10_000,
    sourceEndMs: 70_000,
    targetStartMs: 30_000,
    targetEndMs: 90_000
  });
  const timeMap = createVerifiedTimeMapProposal();
  timeMap.targetEndMs = 90_000;
  timeMap.engineVersion = "alignment-v2.5-rust";
  timeMap.featureVersion =
    "pcm-s16le-16k-pts-tiled-fine-content-window-sequence-reuse-frontier-v25";
  timeMap.spans = [
    createTestCompleteTimeMapSpan(
      {
        kind: "matched",
        sourceStartMs: 10_000,
        sourceEndMs: 70_000,
        targetStartMs: 30_000,
        targetEndMs: 90_000
      },
      "automatic-proposal:span:0001"
    )
  ];
  timeMap.spans[0].quality = {
    ...timeMap.spans[0].quality,
    level: "review",
    metricSource: "measured",
    probability: null,
    coverage: 0.95,
    uniqueContentCoverage: 0.9,
    alternativeMargin: 0.5,
    anchorCount: 16,
    heldOutAnchorCount: 8,
    p50ResidualMs: 20,
    p95ResidualMs: 80,
    p99ResidualMs: 120,
    maxResidualMs: 180,
    boundaryUncertaintyMs: 100,
    leftSupport: "supported",
    rightSupport: "supported",
    signals: { audio: "used", visual: "blocked", danmaku: "blocked" },
    reasons: ["自动策略测试逐段证据完整。"]
  };
  timeMap.quality = {
    ...timeMap.quality,
    level: "review",
    probability: null,
    coverage: 0.95,
    uniqueContentCoverage: 0.9,
    p50ResidualMs: 20,
    p95ResidualMs: 80,
    p99ResidualMs: 120,
    maxResidualMs: 180,
    boundaryUncertaintyMs: 100,
    alternativeMargin: 0.5,
    anchorCount: 16,
    anchorRegionCount: 3,
    heldOutAnchorCount: 8
  };
  timeMap.evidence = {
    ...timeMap.evidence,
    types: ["audio"],
    audioAnchorCount: 16,
    visualAnchorCount: 0,
    heldOutAnchorCount: 8,
    uniqueContentCoverage: 0.9,
    repeatedContentOnly: false
  };
  proposal.timeMap = timeMap;
  return proposal;
}

function createAlignmentAudioStreamIdentity(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "aac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 2,
    frameRate: null,
    language: "zh",
    title: null
  };
}

function createEvidenceProfile(): NonNullable<AlignmentProposal["evidenceProfile"]> {
  return {
    version: "alignment-evidence-profile-v1",
    windowMs: 2_000,
    samples: [
      {
        axis: "source",
        startMs: 12_000,
        endMs: 14_000,
        counterpartMs: 2_000,
        strength: 0.9,
        anchorCount: 3,
        heldOutAnchorCount: 1,
        medianAbsResidualMs: 20,
        offsetMs: -10_000,
        state: "supported"
      },
      {
        axis: "target",
        startMs: 2_000,
        endMs: 4_000,
        counterpartMs: 12_000,
        strength: 0.9,
        anchorCount: 3,
        heldOutAnchorCount: 1,
        medianAbsResidualMs: 20,
        offsetMs: -10_000,
        state: "supported"
      }
    ]
  };
}

function createMedia(
  id: string,
  role: ProjectMediaRole,
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: `${id}.mkv`,
    objectUrl: null,
    durationMs: 200_000,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件",
    localPath: `D:\\media\\${id}.mkv`,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" },
    contentIdentity: overrides.contentIdentity ?? createTestMediaIdentity()
  };
}

function createTestMediaIdentity() {
  return {
    algorithm: "fnv1a64-first-middle-last-64k-v1",
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: "a".repeat(16),
    middleSampleDigest: "b".repeat(16),
    lastSampleDigest: "c".repeat(16)
  };
}

function createAsset(id: string, fileName: string) {
  return {
    id,
    name: id,
    fileName,
    color: "#ffffff",
    items: [],
    warnings: [],
    importedAt: TIMESTAMP,
    sourceReceipt: null
  };
}

function createDanmakuItem(assetId: string, index: number, sourceTimeMs: number) {
  return {
    id: `${assetId}-item-${index}`,
    assetId,
    originalIndex: index,
    sourceTimeMs,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "hash",
    rowId: String(index),
    text: `弹幕 ${index}`,
    rawPFields: [
      String(sourceTimeMs / 1_000),
      "1",
      "25",
      "16777215",
      "0",
      "0",
      "hash",
      String(index)
    ],
    enabled: true
  };
}
