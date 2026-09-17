import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import { parseProjectJson, serializeProject } from "../project/schema";
import type {
  AlignmentReviewFeatureSnapshot,
  AlignmentReviewRecord,
  AlignmentReviewVote,
  EditorProject
} from "../project/types";
import {
  buildPersonalGoldExport,
  buildPersonalGoldPortfolio,
  freezePersonalGoldCase,
  serializePersonalGoldExport
} from "./personalGoldCase";

describe("Personal Gold case", () => {
  it("只把当前 active 且已独立裁决的记录冻结为不改变 TimeMap 的 case", () => {
    const project = createGoldProject();
    const timeMapsBefore = structuredClone(project.mediaTimeMaps);

    const result = freezePersonalGoldCase(project, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });

    expect(result).toMatchObject({ ok: true, created: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.project.alignmentPersonalGoldCases).toHaveLength(1);
    expect(result.project.alignmentPersonalGoldCases[0]).toMatchObject({
      caseVersion: 1,
      sourceReviewRecordId: "review-1",
      resolution: "independentAgreement",
      decision: "target-extra",
      boundaryToleranceMs: 1_250,
      frozenAt: "2026-08-30T12:00:00.000Z",
      recordSnapshot: {
        algorithmPrediction: "targetOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 10_000,
        targetStartMs: 10_000,
        targetEndMs: 13_000
      },
      voteSnapshots: [
        {
          role: "independent",
          decision: "target-extra",
          shadowRiskSourceRunId: `sha256:${"c".repeat(64)}`,
          shadowRiskEvidenceDigest: `sha256:${"d".repeat(64)}`,
          shadowRiskAtReview: 0.72
        },
        { role: "independent", decision: "target-extra" }
      ]
    });
    expect(result.project.mediaTimeMaps).toEqual(timeMapsBefore);
    expect(project.alignmentPersonalGoldCases).toEqual([]);
  });

  it("case identity 只绑定证据与排序票集，并以 canonical 内容摘要忽略对象键序", () => {
    const firstProject = createGoldProject();
    const first = freezePersonalGoldCase(firstProject, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!first.ok) throw new Error(first.message);

    const laterReviewTime = createGoldProject();
    laterReviewTime.alignmentReviewRecords[0].reviewedAt = "2026-08-30T15:00:00.000Z";
    const second = freezePersonalGoldCase(laterReviewTime, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T16:00:00.000Z"
    });
    if (!second.ok) throw new Error(second.message);

    const reorderedFeatures = createGoldProject();
    reorderedFeatures.alignmentReviewRecords[0].features = Object.fromEntries(
      Object.entries(reorderedFeatures.alignmentReviewRecords[0].features).reverse()
    ) as AlignmentReviewFeatureSnapshot;
    reorderedFeatures.alignmentReviewVotes.reverse();
    const third = freezePersonalGoldCase(reorderedFeatures, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!third.ok) throw new Error(third.message);

    expect(second.caseId).toBe(first.caseId);
    expect(third.caseId).toBe(first.caseId);
    expect(third.project.alignmentPersonalGoldCases[0].caseContentDigest).toBe(
      first.project.alignmentPersonalGoldCases[0].caseContentDigest
    );
  });

  it("同证据票集重复冻结幂等，后来有效票更新只追加新 case", () => {
    const first = freezePersonalGoldCase(createGoldProject(), {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!first.ok) throw new Error(first.message);
    const originalCase = structuredClone(first.project.alignmentPersonalGoldCases[0]);

    const duplicate = freezePersonalGoldCase(first.project, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T13:00:00.000Z"
    });
    expect(duplicate).toMatchObject({ ok: true, created: false, caseId: originalCase.id });
    if (!duplicate.ok) throw new Error(duplicate.message);
    expect(duplicate.project).toBe(first.project);

    const voteUpdated: EditorProject = {
      ...first.project,
      alignmentReviewVotes: [
        ...first.project.alignmentReviewVotes.map((vote) =>
          vote.id === "vote-a" ? { ...vote, voteState: "superseded" as const } : vote
        ),
        {
          ...createVote(
            "vote-a-v2",
            `sha256:${"a".repeat(64)}`,
            900,
            "2026-08-30T13:30:00.000Z"
          ),
          supersedesVoteId: "vote-a"
        }
      ]
    };
    const next = freezePersonalGoldCase(voteUpdated, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T14:00:00.000Z"
    });
    if (!next.ok) throw new Error(next.message);

    expect(next.created).toBe(true);
    expect(next.caseId).not.toBe(originalCase.id);
    expect(next.project.alignmentPersonalGoldCases).toHaveLength(2);
    expect(next.project.alignmentPersonalGoldCases[0]).toEqual(originalCase);
  });

  it("inactive、独立票不足和冲突记录都不能冻结", () => {
    const inactive = createGoldProject();
    inactive.alignmentReviewRecords[0].recordState = "superseded";
    expect(
      freezePersonalGoldCase(inactive, {
        reviewRecordId: "review-1",
        frozenAt: "2026-08-30T12:00:00.000Z"
      })
    ).toMatchObject({ ok: false, reason: "record-inactive" });

    const pending = createGoldProject();
    pending.alignmentReviewVotes = pending.alignmentReviewVotes.slice(0, 1);
    expect(buildPersonalGoldPortfolio(pending)).toMatchObject({
      eligibleCases: [],
      pendingIndependentCount: 1,
      conflictCount: 0
    });
    expect(
      freezePersonalGoldCase(pending, {
        reviewRecordId: "review-1",
        frozenAt: "2026-08-30T12:00:00.000Z"
      })
    ).toMatchObject({ ok: false, reason: "not-gold" });

    const conflict = createGoldProject();
    conflict.alignmentReviewVotes[1].decision = "source-extra";
    expect(buildPersonalGoldPortfolio(conflict)).toMatchObject({
      eligibleCases: [],
      pendingIndependentCount: 0,
      conflictCount: 1
    });
    expect(
      freezePersonalGoldCase(conflict, {
        reviewRecordId: "review-1",
        frozenAt: "2026-08-30T12:00:00.000Z"
      })
    ).toMatchObject({ ok: false, reason: "not-gold" });
  });

  it("独立票冲突时只接受第三名仲裁者的 Gold 结论", () => {
    const project = createGoldProject();
    project.alignmentReviewVotes[1].decision = "source-extra";
    project.alignmentReviewVotes.push({
      ...createVote(
        "vote-adjudicator",
        `sha256:${"e".repeat(64)}`,
        400,
        "2026-08-30T11:30:00.000Z"
      ),
      role: "adjudicator",
      decision: "replacement"
    });

    const frozen = freezePersonalGoldCase(project, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });

    expect(frozen).toMatchObject({ ok: true, created: true });
    if (!frozen.ok) throw new Error(frozen.message);
    expect(frozen.project.alignmentPersonalGoldCases[0]).toMatchObject({
      resolution: "adjudicator",
      decision: "replacement",
      boundaryToleranceMs: 400
    });
    expect(frozen.project.alignmentPersonalGoldCases[0].voteSnapshots).toHaveLength(3);
  });

  it("仲裁冻结排除未形成 Gold 的 unresolved 独立票且保持稳定身份", () => {
    const withoutUnresolved = createGoldProject();
    withoutUnresolved.alignmentReviewVotes[1].decision = "source-extra";
    withoutUnresolved.alignmentReviewVotes.push({
      ...createVote(
        "vote-adjudicator",
        `sha256:${"e".repeat(64)}`,
        400,
        "2026-08-30T11:30:00.000Z"
      ),
      role: "adjudicator",
      decision: "replacement"
    });
    const withUnresolved = structuredClone(withoutUnresolved);
    withUnresolved.alignmentReviewVotes.push({
      ...createVote(
        "vote-unresolved",
        `sha256:${"f".repeat(64)}`,
        500,
        "2026-08-30T11:45:00.000Z"
      ),
      decision: "unresolved"
    });

    const baseline = freezePersonalGoldCase(withoutUnresolved, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    const frozen = freezePersonalGoldCase(withUnresolved, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });

    expect(baseline).toMatchObject({ ok: true, created: true });
    expect(frozen).toMatchObject({ ok: true, created: true });
    if (!baseline.ok) throw new Error(baseline.message);
    if (!frozen.ok) throw new Error(frozen.message);
    const baselineCase = baseline.project.alignmentPersonalGoldCases[0];
    const frozenCase = frozen.project.alignmentPersonalGoldCases[0];
    expect(
      frozenCase.voteSnapshots.map(({ voteId, role, decision }) => ({
        voteId,
        role,
        decision
      }))
    ).toEqual([
      { voteId: "vote-a", role: "independent", decision: "target-extra" },
      { voteId: "vote-adjudicator", role: "adjudicator", decision: "replacement" },
      { voteId: "vote-b", role: "independent", decision: "source-extra" }
    ]);
    expect(frozenCase.id).toBe(baselineCase.id);
    expect(frozenCase.voteSetDigest).toBe(baselineCase.voteSetDigest);

    const reopened = parseProjectJson(serializeProject(frozen.project));
    expect(reopened.alignmentPersonalGoldCases).toEqual(
      frozen.project.alignmentPersonalGoldCases
    );
  });

  it("独立一致时不把未参与结论的 active 仲裁票混入有效票集", () => {
    const project = createGoldProject();
    project.alignmentReviewVotes.push({
      ...createVote(
        "vote-unused-adjudicator",
        `sha256:${"e".repeat(64)}`,
        400,
        "2026-08-30T11:30:00.000Z"
      ),
      role: "adjudicator",
      decision: "unresolved"
    });

    const frozen = freezePersonalGoldCase(project, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });

    if (!frozen.ok) throw new Error(frozen.message);
    expect(frozen.project.alignmentPersonalGoldCases[0].voteSnapshots.map((vote) => vote.voteId)).toEqual([
      "vote-a",
      "vote-b"
    ]);
  });

  it("通过共享媒体端点把冻结 cases 归入同一完整连接家族和 split", () => {
    const project = createGoldProject();
    project.alignmentReviewRecords.push({
      ...createReviewRecord(),
      id: "review-2",
      spanId: "span-2",
      sourceMediaId: "source-2",
      reviewedAt: "2026-08-30T09:30:00.000Z"
    });
    project.alignmentReviewVotes.push(
      {
        ...createVote(
          "vote-c",
          `sha256:${"f".repeat(64)}`,
          600,
          "2026-08-30T11:15:00.000Z"
        ),
        reviewRecordId: "review-2"
      },
      {
        ...createVote(
          "vote-d",
          `sha256:${"1".repeat(64)}`,
          700,
          "2026-08-30T11:30:00.000Z"
        ),
        reviewRecordId: "review-2"
      }
    );
    const first = freezePersonalGoldCase(project, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!first.ok) throw new Error(first.message);
    const second = freezePersonalGoldCase(first.project, {
      reviewRecordId: "review-2",
      frozenAt: "2026-08-30T12:01:00.000Z"
    });
    if (!second.ok) throw new Error(second.message);

    const dataset = buildPersonalGoldExport(second.project);

    expect(dataset.manifest).toMatchObject({ caseCount: 2, mediaFamilyCount: 1 });
    expect(new Set(dataset.cases.map((item) => item.mediaGroupId)).size).toBe(1);
    expect(new Set(dataset.cases.map((item) => item.split)).size).toBe(1);
  });

  it("来源记录与票据后来 supersede 时仍从冻结快照展示原 case", () => {
    const frozen = freezePersonalGoldCase(createGoldProject(), {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!frozen.ok) throw new Error(frozen.message);
    const snapshotBefore = structuredClone(frozen.project.alignmentPersonalGoldCases[0]);
    const changedProject: EditorProject = {
      ...frozen.project,
      alignmentReviewRecords: frozen.project.alignmentReviewRecords.map((record) => ({
        ...record,
        recordState: "superseded"
      })),
      alignmentReviewVotes: frozen.project.alignmentReviewVotes.map((vote) => ({
        ...vote,
        voteState: "superseded"
      }))
    };

    const portfolio = buildPersonalGoldPortfolio(changedProject);

    expect(portfolio.eligibleCases).toEqual([]);
    expect(portfolio.frozenCaseCount).toBe(1);
    expect(portfolio.frozenFamilies[0]).toMatchObject({
      scope: "project-local",
      cases: [
        {
          id: snapshotBefore.id,
          sourceState: "superseded",
          decision: "target-extra",
          resolution: "independentAgreement",
          voteCount: 2,
          sourceStartMs: 10_000,
          targetEndMs: 13_000
        }
      ]
    });
    expect(changedProject.alignmentPersonalGoldCases[0]).toEqual(snapshotBefore);
  });

  it("冻结导出的 dataset ID 只绑定 case 内容而不绑定导出时间", () => {
    const project = createGoldProject();
    project.name = "不应出现在导出中的项目名";
    const frozen = freezePersonalGoldCase(project, {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!frozen.ok) throw new Error(frozen.message);

    const first = buildPersonalGoldExport(
      frozen.project,
      "2026-08-30T12:30:00.000Z"
    );
    const second = buildPersonalGoldExport(
      frozen.project,
      "2026-08-31T12:30:00.000Z"
    );
    const serialized = serializePersonalGoldExport(first);

    expect(first.manifest).toMatchObject({
      schemaVersion: "personal-gold-export-v1",
      caseCount: 1,
      createdAt: "2026-08-30T12:30:00.000Z"
    });
    expect(first.manifest.datasetId).toBe(second.manifest.datasetId);
    expect(first.samples[0]).toMatchObject({
      schemaVersion: "alignment-confidence-sample-v2",
      sampleId: frozen.project.alignmentPersonalGoldCases[0].id,
      labelSource: "adjudicatedGold",
      decision: "target-extra",
      proposalCorrect: true
    });
    expect(serialized.casesJsonl).toContain('"resolution":"independentAgreement"');
    expect(JSON.stringify(serialized)).not.toContain("不应出现在导出中的项目名");
    expect(JSON.stringify(serialized)).not.toContain("session-vote-a");
    expect(JSON.stringify(serialized)).not.toContain("verificationId");
  });

  it("冻结内容被篡改时 fail-closed，不导出伪造 Personal Gold", () => {
    const frozen = freezePersonalGoldCase(createGoldProject(), {
      reviewRecordId: "review-1",
      frozenAt: "2026-08-30T12:00:00.000Z"
    });
    if (!frozen.ok) throw new Error(frozen.message);
    frozen.project.alignmentPersonalGoldCases[0].recordSnapshot.targetEndMs += 1;

    expect(() => buildPersonalGoldExport(frozen.project)).toThrow(
      "Personal Gold case 内容摘要不一致"
    );
  });
});

function createGoldProject(): EditorProject {
  const project = createEmptyProject("Gold project");
  project.alignmentReviewRecords = [createReviewRecord()];
  project.alignmentReviewVotes = [
    {
      ...createVote(
        "vote-a",
        `sha256:${"a".repeat(64)}`,
        1_000,
        "2026-08-30T10:00:00.000Z"
      ),
      shadowRiskSourceRunId: `sha256:${"c".repeat(64)}`,
      shadowRiskEvidenceDigest: `sha256:${"d".repeat(64)}`,
      shadowRiskAtReview: 0.72
    },
    createVote("vote-b", `sha256:${"b".repeat(64)}`, 1_250, "2026-08-30T11:00:00.000Z")
  ];
  return project;
}

function createReviewRecord(): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id: "review-1",
    timeMapId: "map-1",
    timeMapRevision: 1,
    spanId: "span-1",
    spanIndex: 0,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    mediaGroupId: "legacy-family-1",
    action: "classifySpan",
    decision: "target-extra",
    precision: "playbackChecked",
    algorithmPrediction: "targetOnly",
    sourceStartMs: 10_000,
    sourceEndMs: 10_000,
    targetStartMs: 10_000,
    targetEndMs: 13_000,
    boundaryToleranceMs: 750,
    features: createFeatureSnapshot(),
    engineVersion: "engine-v1",
    featureVersion: "features-v1",
    parametersHash: "parameters-v1",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-08-30T09:00:00.000Z"
  };
}

function createVote(
  id: string,
  reviewerIdDigest: string,
  boundaryToleranceMs: number,
  reviewedAt: string
): AlignmentReviewVote {
  return {
    voteVersion: 1,
    id,
    reviewRecordId: "review-1",
    reviewerIdDigest,
    reviewSessionId: `session-${id}`,
    role: "independent",
    decision: "target-extra",
    boundaryToleranceMs,
    supersedesVoteId: null,
    voteState: "active",
    reviewedAt,
    reviewStartedAt: null,
    reviewDurationMs: null,
    reviewDurationBasis: null,
    shadowRiskSourceRunId: null,
    shadowRiskEvidenceDigest: null,
    shadowRiskAtReview: null
  };
}

function createFeatureSnapshot(): AlignmentReviewFeatureSnapshot {
  return {
    sourceCoverage: 0.8,
    uniqueContentCoverage: 0.75,
    anchorCount: 12,
    heldOutAnchorCount: 3,
    anchorRegionCount: 2,
    p95ResidualMs: 120,
    p99ResidualMs: 180,
    maxResidualMs: 220,
    boundaryUncertaintyMs: 300,
    alternativeMargin: 0.2,
    ambiguousRatio: 0.05,
    bidirectionalAgreement: 0.9,
    differenceRiskP50: null,
    differenceRiskP90: null,
    differenceRiskP99: null,
    informativenessP50: null,
    visualRecoveredRatio: null,
    visualAmbiguousRatio: null,
    visualMarginP50: null
  };
}
