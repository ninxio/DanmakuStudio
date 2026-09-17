import type {
  AlignmentPersonalGoldCase,
  AlignmentPersonalGoldRecordSnapshot,
  AlignmentPersonalGoldVoteSnapshot,
  AlignmentReviewRecord,
  AlignmentReviewVote,
  EditorProject
} from "../project/types";
import { sha256Hex } from "../shared/sha256";
import {
  assessAlignmentAdjudication,
  buildAlignmentMediaFamilyAssignments,
  type AlignmentAdjudicationStatus
} from "./alignmentAdjudication";
import { createAlignmentReviewRecordEvidenceDigestForProject } from "./alignmentShadowRiskOverlay";
import type { AlignmentConfidenceSampleV2 } from "./alignmentReviewRecords";

const PERSONAL_GOLD_VOTE_SET_DOMAIN = "danmaku-studio-personal-gold-vote-set-v1";
const PERSONAL_GOLD_CASE_IDENTITY_DOMAIN =
  "danmaku-studio-personal-gold-case-identity-v1";
const PERSONAL_GOLD_CASE_CONTENT_DOMAIN =
  "danmaku-studio-personal-gold-case-content-v1";
const PERSONAL_GOLD_DATASET_DOMAIN = "danmaku-studio-personal-gold-dataset-v1";

interface FreezePersonalGoldCaseInput {
  reviewRecordId: string;
  frozenAt: string;
}

type FreezePersonalGoldCaseResult =
  | {
      ok: true;
      project: EditorProject;
      caseId: string;
      created: boolean;
      message: string;
    }
  | {
      ok: false;
      project: EditorProject;
      reason: "record-missing" | "record-inactive" | "not-gold";
      message: string;
    };

interface PersonalGoldEligibleCaseView {
  reviewRecordId: string;
  prospectiveCaseId: string;
  familyId: string;
  familyScope: "content-identified" | "project-local";
  resolution: "independentAgreement" | "adjudicator";
  decision: AlignmentPersonalGoldCase["decision"];
  boundaryToleranceMs: number | null;
  voteCount: number;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  verificationContext: "present" | "absent" | "source-changed";
}

interface PersonalGoldFrozenCaseView {
  id: string;
  sourceReviewRecordId: string;
  sourceState: "active" | "superseded" | "missing";
  decision: AlignmentPersonalGoldCase["decision"];
  resolution: AlignmentPersonalGoldCase["resolution"];
  boundaryToleranceMs: number | null;
  voteCount: number;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  frozenAt: string;
  verificationContext: "present" | "absent" | "source-changed";
}

interface PersonalGoldFamilyView {
  familyId: string;
  scope: "content-identified" | "project-local";
  cases: PersonalGoldFrozenCaseView[];
}

interface PersonalGoldPortfolio {
  eligibleCases: PersonalGoldEligibleCaseView[];
  frozenFamilies: PersonalGoldFamilyView[];
  frozenCaseCount: number;
  pendingIndependentCount: number;
  conflictCount: number;
}

interface PersonalGoldDatasetCase {
  caseVersion: 1;
  id: string;
  caseContentDigest: string;
  recordEvidenceDigest: string;
  mediaGroupId: string;
  split: "development" | "calibration" | "frozen-test";
  resolution: AlignmentPersonalGoldCase["resolution"];
  decision: AlignmentPersonalGoldCase["decision"];
  boundaryToleranceMs: number | null;
  frozenAt: string;
  record: Omit<
    AlignmentPersonalGoldRecordSnapshot,
    | "reviewRecordId"
    | "recordEvidenceDigest"
    | "timeMapId"
    | "sourceMediaId"
    | "targetMediaId"
  >;
  conclusions: Array<Omit<AlignmentPersonalGoldVoteSnapshot, "voteId">>;
}

interface PersonalGoldExport {
  manifest: {
    schemaVersion: "personal-gold-export-v1";
    datasetId: string;
    createdAt: string;
    caseCount: number;
    mediaFamilyCount: number;
    splitCounts: Record<"development" | "calibration" | "frozen-test", number>;
    note: string;
  };
  cases: PersonalGoldDatasetCase[];
  samples: AlignmentConfidenceSampleV2[];
}

export function buildPersonalGoldExport(
  project: EditorProject,
  createdAt = new Date().toISOString()
): PersonalGoldExport {
  const sortedCases = [...project.alignmentPersonalGoldCases].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  for (const item of sortedCases) assertCaseIntegrity(item);
  const datasetDigest = digest(
    PERSONAL_GOLD_DATASET_DOMAIN,
    sortedCases.map((item) => [item.id, item.caseContentDigest])
  );
  const datasetId = `personal-gold-dataset:${datasetDigest.slice("sha256:".length)}`;
  const records = uniqueRecords(sortedCases.map(caseRecordForFamily));
  const assignments = buildAlignmentMediaFamilyAssignments(project, records);
  const cases = sortedCases.map((item) => {
    const assignment =
      assignments.get(item.sourceReviewRecordId) ??
      fallbackFamily(caseRecordForFamily(item));
    return toDatasetCase(item, assignment.mediaGroupId, assignment.split);
  });
  const samples = cases.map((item, index): AlignmentConfidenceSampleV2 => {
    const source = sortedCases[index];
    const expectedKind = decisionToKind(source.decision);
    return {
      schemaVersion: "alignment-confidence-sample-v2",
      datasetId,
      sampleId: source.id,
      mediaGroupId: item.mediaGroupId,
      split: item.split,
      labelSource: "adjudicatedGold",
      trainingUse: item.split === "frozen-test" ? "frozenEvaluation" : "supervised",
      proposalCorrect:
        expectedKind === null
          ? null
          : expectedKind === source.recordSnapshot.algorithmPrediction,
      decision: source.decision,
      boundaryToleranceMs: source.boundaryToleranceMs,
      engineVersion: source.recordSnapshot.engineVersion,
      featureVersion: source.recordSnapshot.featureVersion,
      parametersHash: source.recordSnapshot.parametersHash,
      features: { ...source.recordSnapshot.features }
    };
  });
  const splitCounts = {
    development: cases.filter((item) => item.split === "development").length,
    calibration: cases.filter((item) => item.split === "calibration").length,
    "frozen-test": cases.filter((item) => item.split === "frozen-test").length
  };
  return {
    manifest: {
      schemaVersion: "personal-gold-export-v1",
      datasetId,
      createdAt,
      caseCount: cases.length,
      mediaFamilyCount: new Set(cases.map((item) => item.mediaGroupId)).size,
      splitCounts,
      note:
        "仅包含用户显式冻结的独立人工裁决与算法证据；不授予 TimeMap、自动签发或导出权限。"
    },
    cases,
    samples
  };
}

export function serializePersonalGoldExport(dataset: PersonalGoldExport): {
  manifestJson: string;
  casesJsonl: string;
  samplesJsonl: string;
} {
  return {
    manifestJson: `${JSON.stringify(dataset.manifest, null, 2)}\n`,
    casesJsonl:
      dataset.cases.length === 0
        ? ""
        : `${dataset.cases.map((item) => JSON.stringify(item)).join("\n")}\n`,
    samplesJsonl:
      dataset.samples.length === 0
        ? ""
        : `${dataset.samples.map((item) => JSON.stringify(item)).join("\n")}\n`
  };
}

export function buildPersonalGoldPortfolio(project: EditorProject): PersonalGoldPortfolio {
  for (const item of project.alignmentPersonalGoldCases) assertCaseIntegrity(item);
  const activeRecords = project.alignmentReviewRecords.filter(
    (record) => record.recordState === "active"
  );
  const frozenRecords = project.alignmentPersonalGoldCases.map(caseRecordForFamily);
  const recordsForFamilies = uniqueRecords([...activeRecords, ...frozenRecords]);
  const assignments = buildAlignmentMediaFamilyAssignments(project, recordsForFamilies);
  const existingCaseIds = new Set(
    project.alignmentPersonalGoldCases.map((item) => item.id)
  );
  let pendingIndependentCount = 0;
  let conflictCount = 0;
  const eligibleCases: PersonalGoldEligibleCaseView[] = [];
  for (const record of activeRecords) {
    const adjudication = assessAlignmentAdjudication(project, record.id);
    if (adjudication.state === "awaiting-independent") {
      pendingIndependentCount += 1;
      continue;
    }
    if (adjudication.state === "conflict") {
      conflictCount += 1;
      continue;
    }
    const candidate = createCaseContent(project, record, adjudication);
    if (!candidate || existingCaseIds.has(candidate.id)) continue;
    const assignment = assignments.get(record.id) ?? fallbackFamily(record);
    eligibleCases.push({
      reviewRecordId: record.id,
      prospectiveCaseId: candidate.id,
      familyId: assignment.mediaGroupId,
      familyScope: familyScope(project, record.timeMapId, record.timeMapRevision),
      resolution: candidate.content.resolution,
      decision: candidate.content.decision,
      boundaryToleranceMs: candidate.content.boundaryToleranceMs,
      voteCount: candidate.content.voteSnapshots.length,
      sourceStartMs: candidate.content.recordSnapshot.sourceStartMs,
      sourceEndMs: candidate.content.recordSnapshot.sourceEndMs,
      targetStartMs: candidate.content.recordSnapshot.targetStartMs,
      targetEndMs: candidate.content.recordSnapshot.targetEndMs,
      verificationContext: verificationContext(
        project,
        record.timeMapId,
        record.timeMapRevision
      )
    });
  }
  eligibleCases.sort((left, right) =>
    left.familyId.localeCompare(right.familyId) ||
    left.reviewRecordId.localeCompare(right.reviewRecordId)
  );

  const currentRecords = new Map(
    project.alignmentReviewRecords.map((record) => [record.id, record])
  );
  const families = new Map<string, PersonalGoldFamilyView>();
  for (const item of project.alignmentPersonalGoldCases) {
    const familyRecord = caseRecordForFamily(item);
    const assignment = assignments.get(item.sourceReviewRecordId) ?? fallbackFamily(familyRecord);
    const scope = familyScope(
      project,
      item.recordSnapshot.timeMapId,
      item.recordSnapshot.timeMapRevision
    );
    const family = families.get(assignment.mediaGroupId) ?? {
      familyId: assignment.mediaGroupId,
      scope,
      cases: []
    };
    if (scope === "project-local") family.scope = "project-local";
    const current = currentRecords.get(item.sourceReviewRecordId);
    family.cases.push({
      id: item.id,
      sourceReviewRecordId: item.sourceReviewRecordId,
      sourceState: current?.recordState ?? "missing",
      decision: item.decision,
      resolution: item.resolution,
      boundaryToleranceMs: item.boundaryToleranceMs,
      voteCount: item.voteSnapshots.length,
      sourceStartMs: item.recordSnapshot.sourceStartMs,
      sourceEndMs: item.recordSnapshot.sourceEndMs,
      targetStartMs: item.recordSnapshot.targetStartMs,
      targetEndMs: item.recordSnapshot.targetEndMs,
      frozenAt: item.frozenAt,
      verificationContext: verificationContext(
        project,
        item.recordSnapshot.timeMapId,
        item.recordSnapshot.timeMapRevision
      )
    });
    families.set(assignment.mediaGroupId, family);
  }
  const frozenFamilies = [...families.values()]
    .map((family) => ({
      ...family,
      cases: family.cases.sort(
        (left, right) =>
          right.frozenAt.localeCompare(left.frozenAt) || left.id.localeCompare(right.id)
      )
    }))
    .sort((left, right) => left.familyId.localeCompare(right.familyId));
  return {
    eligibleCases,
    frozenFamilies,
    frozenCaseCount: project.alignmentPersonalGoldCases.length,
    pendingIndependentCount,
    conflictCount
  };
}

export function freezePersonalGoldCase(
  project: EditorProject,
  input: FreezePersonalGoldCaseInput
): FreezePersonalGoldCaseResult {
  const record = project.alignmentReviewRecords.find(
    (item) => item.id === input.reviewRecordId
  );
  if (!record) {
    return {
      ok: false,
      project,
      reason: "record-missing",
      message: "这条人工记录不存在，不能冻结 Personal Gold。"
    };
  }
  if (record.recordState !== "active") {
    return {
      ok: false,
      project,
      reason: "record-inactive",
      message: "这条人工记录已有更新，请从当前有效记录重新冻结。"
    };
  }
  const adjudication = assessAlignmentAdjudication(project, record.id);
  if (
    adjudication.state !== "gold" ||
    adjudication.resolution === null ||
    adjudication.decision === null
  ) {
    return {
      ok: false,
      project,
      reason: "not-gold",
      message: "这条记录尚未完成独立裁决，不能冻结 Personal Gold。"
    };
  }

  const candidate = createCaseContent(project, record, adjudication);
  if (!candidate) {
    return {
      ok: false,
      project,
      reason: "not-gold",
      message: "这条记录尚未完成独立裁决，不能冻结 Personal Gold。"
    };
  }
  const { content, id: caseId } = candidate;
  const existing = project.alignmentPersonalGoldCases.find((item) => item.id === caseId);
  if (existing) {
    return {
      ok: true,
      project,
      caseId,
      created: false,
      message: "这一版 Personal Gold 已经冻结。"
    };
  }
  const frozenContent: Omit<AlignmentPersonalGoldCase, "caseContentDigest"> = {
    ...content,
    id: caseId,
    frozenAt: input.frozenAt
  };
  const personalGoldCase: AlignmentPersonalGoldCase = {
    ...frozenContent,
    caseContentDigest: digest(PERSONAL_GOLD_CASE_CONTENT_DOMAIN, frozenContent)
  };
  return {
    ok: true,
    project: {
      ...project,
      alignmentPersonalGoldCases: [
        ...project.alignmentPersonalGoldCases,
        personalGoldCase
      ]
    },
    caseId,
    created: true,
    message: "已冻结为 Personal Gold；不会修改 TimeMap 或签发状态。"
  };
}

function createCaseContent(
  project: EditorProject,
  record: AlignmentReviewRecord,
  adjudication: AlignmentAdjudicationStatus
): {
  id: string;
  content: Omit<AlignmentPersonalGoldCase, "id" | "caseContentDigest" | "frozenAt">;
} | null {
  if (
    adjudication.state !== "gold" ||
    adjudication.resolution === null ||
    adjudication.decision === null
  ) {
    return null;
  }
  const recordSnapshot = createRecordSnapshot(project, record);
  const voteSnapshots = selectGoldVotes(adjudication)
    .map(createVoteSnapshot)
    .sort((left, right) => left.voteId.localeCompare(right.voteId));
  const voteSetDigest = digest(PERSONAL_GOLD_VOTE_SET_DOMAIN, voteSnapshots);
  const content = {
    caseVersion: 1 as const,
    sourceReviewRecordId: record.id,
    voteSetDigest,
    resolution: adjudication.resolution,
    decision: adjudication.decision,
    boundaryToleranceMs: adjudication.boundaryToleranceMs,
    recordSnapshot,
    voteSnapshots
  };
  const identityDigest = digest(PERSONAL_GOLD_CASE_IDENTITY_DOMAIN, {
    caseVersion: content.caseVersion,
    recordEvidenceDigest: recordSnapshot.recordEvidenceDigest,
    voteSetDigest
  });
  return {
    id: `personal-gold:${identityDigest.slice("sha256:".length)}`,
    content
  };
}

function createRecordSnapshot(
  project: EditorProject,
  record: AlignmentReviewRecord
): AlignmentPersonalGoldRecordSnapshot {
  return {
    recordVersion: record.recordVersion,
    reviewRecordId: record.id,
    recordEvidenceDigest: createAlignmentReviewRecordEvidenceDigestForProject(
      project,
      record
    ),
    timeMapId: record.timeMapId,
    timeMapRevision: record.timeMapRevision,
    spanId: record.spanId,
    spanIndex: record.spanIndex,
    sourceMediaId: record.sourceMediaId,
    targetMediaId: record.targetMediaId,
    action: record.action,
    decision: record.decision,
    precision: record.precision,
    algorithmPrediction: record.algorithmPrediction,
    sourceStartMs: record.sourceStartMs,
    sourceEndMs: record.sourceEndMs,
    targetStartMs: record.targetStartMs,
    targetEndMs: record.targetEndMs,
    boundaryToleranceMs: record.boundaryToleranceMs,
    features: { ...record.features },
    engineVersion: record.engineVersion,
    featureVersion: record.featureVersion,
    parametersHash: record.parametersHash,
    reviewedAt: record.reviewedAt
  };
}

function createVoteSnapshot(vote: AlignmentReviewVote): AlignmentPersonalGoldVoteSnapshot {
  return {
    voteId: vote.id,
    reviewerIdDigest: vote.reviewerIdDigest,
    role: vote.role,
    decision: vote.decision,
    boundaryToleranceMs: vote.boundaryToleranceMs,
    reviewedAt: vote.reviewedAt,
    shadowRiskSourceRunId: vote.shadowRiskSourceRunId ?? null,
    shadowRiskEvidenceDigest: vote.shadowRiskEvidenceDigest ?? null,
    shadowRiskAtReview: vote.shadowRiskAtReview ?? null
  };
}

function selectGoldVotes(adjudication: AlignmentAdjudicationStatus): AlignmentReviewVote[] {
  if (
    adjudication.state !== "gold" ||
    adjudication.resolution === null ||
    adjudication.decision === null
  ) {
    return [];
  }
  const independentByReviewer = new Map<string, AlignmentReviewVote>();
  for (const vote of adjudication.activeVotes) {
    if (vote.role === "independent") {
      independentByReviewer.set(vote.reviewerIdDigest, vote);
    }
  }
  const independent = [...independentByReviewer.values()].filter(
    (vote) => vote.decision !== "unresolved"
  );
  if (adjudication.resolution === "independentAgreement") return independent;

  const independentReviewers = new Set(independentByReviewer.keys());
  const adjudicator = [...adjudication.activeVotes]
    .reverse()
    .find(
      (vote) =>
        vote.role === "adjudicator" &&
        vote.decision === adjudication.decision &&
        !independentReviewers.has(vote.reviewerIdDigest)
    );
  return adjudicator ? [...independent, adjudicator] : independent;
}

function digest(domain: string, value: unknown): string {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
}

function assertCaseIntegrity(item: AlignmentPersonalGoldCase): void {
  const sortedVotes = [...item.voteSnapshots].sort((left, right) =>
    left.voteId.localeCompare(right.voteId)
  );
  const expectedVoteSetDigest = digest(PERSONAL_GOLD_VOTE_SET_DOMAIN, sortedVotes);
  const expectedContentDigest = digest(
    PERSONAL_GOLD_CASE_CONTENT_DOMAIN,
    caseContent(item)
  );
  const expectedIdentityDigest = digest(PERSONAL_GOLD_CASE_IDENTITY_DOMAIN, {
    caseVersion: item.caseVersion,
    recordEvidenceDigest: item.recordSnapshot.recordEvidenceDigest,
    voteSetDigest: item.voteSetDigest
  });
  const expectedId = `personal-gold:${expectedIdentityDigest.slice("sha256:".length)}`;
  if (
    item.voteSetDigest !== expectedVoteSetDigest ||
    item.caseContentDigest !== expectedContentDigest ||
    item.id !== expectedId
  ) {
    throw new Error("Personal Gold case 内容摘要不一致，请从可信项目修订恢复。");
  }
}

function caseContent(
  item: AlignmentPersonalGoldCase
): Omit<AlignmentPersonalGoldCase, "caseContentDigest"> {
  return {
    id: item.id,
    caseVersion: item.caseVersion,
    sourceReviewRecordId: item.sourceReviewRecordId,
    voteSetDigest: item.voteSetDigest,
    resolution: item.resolution,
    decision: item.decision,
    boundaryToleranceMs: item.boundaryToleranceMs,
    recordSnapshot: item.recordSnapshot,
    voteSnapshots: item.voteSnapshots,
    frozenAt: item.frozenAt
  };
}

function toDatasetCase(
  item: AlignmentPersonalGoldCase,
  mediaGroupId: string,
  split: "development" | "calibration" | "frozen-test"
): PersonalGoldDatasetCase {
  const snapshot = item.recordSnapshot;
  return {
    caseVersion: item.caseVersion,
    id: item.id,
    caseContentDigest: item.caseContentDigest,
    recordEvidenceDigest: snapshot.recordEvidenceDigest,
    mediaGroupId,
    split,
    resolution: item.resolution,
    decision: item.decision,
    boundaryToleranceMs: item.boundaryToleranceMs,
    frozenAt: item.frozenAt,
    record: {
      recordVersion: snapshot.recordVersion,
      timeMapRevision: snapshot.timeMapRevision,
      spanId: snapshot.spanId,
      spanIndex: snapshot.spanIndex,
      action: snapshot.action,
      decision: snapshot.decision,
      precision: snapshot.precision,
      algorithmPrediction: snapshot.algorithmPrediction,
      sourceStartMs: snapshot.sourceStartMs,
      sourceEndMs: snapshot.sourceEndMs,
      targetStartMs: snapshot.targetStartMs,
      targetEndMs: snapshot.targetEndMs,
      boundaryToleranceMs: snapshot.boundaryToleranceMs,
      features: { ...snapshot.features },
      engineVersion: snapshot.engineVersion,
      featureVersion: snapshot.featureVersion,
      parametersHash: snapshot.parametersHash,
      reviewedAt: snapshot.reviewedAt
    },
    conclusions: item.voteSnapshots.map((vote) => ({
      reviewerIdDigest: vote.reviewerIdDigest,
      role: vote.role,
      decision: vote.decision,
      boundaryToleranceMs: vote.boundaryToleranceMs,
      reviewedAt: vote.reviewedAt,
      shadowRiskSourceRunId: vote.shadowRiskSourceRunId,
      shadowRiskEvidenceDigest: vote.shadowRiskEvidenceDigest,
      shadowRiskAtReview: vote.shadowRiskAtReview
    }))
  };
}

function decisionToKind(
  decision: AlignmentPersonalGoldCase["decision"]
): AlignmentPersonalGoldRecordSnapshot["algorithmPrediction"] | null {
  if (decision === "source-extra") return "sourceOnly";
  if (decision === "target-extra") return "targetOnly";
  if (decision === "replacement") return "ambiguous";
  return null;
}

function caseRecordForFamily(item: AlignmentPersonalGoldCase): AlignmentReviewRecord {
  const snapshot = item.recordSnapshot;
  return {
    recordVersion: snapshot.recordVersion,
    id: snapshot.reviewRecordId,
    timeMapId: snapshot.timeMapId,
    timeMapRevision: snapshot.timeMapRevision,
    spanId: snapshot.spanId,
    spanIndex: snapshot.spanIndex,
    sourceMediaId: snapshot.sourceMediaId,
    targetMediaId: snapshot.targetMediaId,
    mediaGroupId: "personal-gold-frozen",
    action: snapshot.action,
    decision: snapshot.decision,
    precision: snapshot.precision,
    algorithmPrediction: snapshot.algorithmPrediction,
    sourceStartMs: snapshot.sourceStartMs,
    sourceEndMs: snapshot.sourceEndMs,
    targetStartMs: snapshot.targetStartMs,
    targetEndMs: snapshot.targetEndMs,
    boundaryToleranceMs: snapshot.boundaryToleranceMs,
    features: snapshot.features,
    engineVersion: snapshot.engineVersion,
    featureVersion: snapshot.featureVersion,
    parametersHash: snapshot.parametersHash,
    supersedesRecordId: null,
    recordState: "superseded",
    reviewedAt: snapshot.reviewedAt
  };
}

function uniqueRecords(records: AlignmentReviewRecord[]): AlignmentReviewRecord[] {
  const unique = new Map<string, AlignmentReviewRecord>();
  for (const record of records) unique.set(record.id, record);
  return [...unique.values()];
}

function familyScope(
  project: EditorProject,
  timeMapId: string,
  timeMapRevision: number
): "content-identified" | "project-local" {
  const timeMap = project.mediaTimeMaps.find(
    (item) => item.id === timeMapId && item.revision === timeMapRevision
  );
  return timeMap?.sourceIdentity && timeMap.targetIdentity
    ? "content-identified"
    : "project-local";
}

function verificationContext(
  project: EditorProject,
  timeMapId: string,
  timeMapRevision: number
): "present" | "absent" | "source-changed" {
  const timeMap = project.mediaTimeMaps.find((item) => item.id === timeMapId);
  if (!timeMap || timeMap.revision !== timeMapRevision) return "source-changed";
  return timeMap.verification ? "present" : "absent";
}

function fallbackFamily(record: AlignmentReviewRecord): {
  mediaGroupId: string;
  split: "development";
} {
  return {
    mediaGroupId: `media-family:${sha256Hex(
      JSON.stringify([record.sourceMediaId, record.targetMediaId])
    )}`,
    split: "development"
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数字。");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
