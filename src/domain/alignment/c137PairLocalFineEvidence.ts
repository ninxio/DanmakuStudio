import {
  createC137BlindBatchMediaBindingCommitment,
  type C137BlindBatchMediaProjection
} from "./c137BlindBatchEvidence";
import {
  computeC137FormalBlindGoldDigest,
  computeC137FormalBlindManifestDigest,
  validateC137FormalBlindProvenance,
  type C137FormalBlindProvenanceBatchEnvelopeV3,
  type C137FormalBlindProvenanceV3
} from "./c137FormalBlindProvenance";
import type {
  RealMediaBenchmarkCase,
  RealMediaBenchmarkGold,
  RealMediaBenchmarkScenario
} from "./realMediaBenchmark";
import type {
  NativeBatchFineCandidateId,
  NativeBatchFineDecodeWindow,
  RealMediaBlindBatchPairOutcome,
  RealMediaBlindBatchRunReceipt
} from "./realMediaBlindBatchContract";
import { mapSourceTime, type TimeMapSpan } from "./timeMap";
import { sha256Hex } from "../shared/sha256";

export const C137_PAIR_LOCAL_FINE_EVIDENCE_SCHEMA_VERSION = 3 as const;

const EVIDENCE_DIGEST_DOMAIN = "c137-pair-local-fine-evidence-v3";

type C137PairLocalDigest = `sha256:${string}`;
export type C137PairLocalEditKind = "sourceOnly" | "targetOnly" | "replacement";
export type C137NativeModality = "same-audio" | "visual-only" | "mixed" | "no-common-content";

export interface C137PairLocalModalityEvidence {
  modality: C137NativeModality;
  evidenceTypes: Array<"audio" | "visual">;
  audioAnchorCount: number;
  visualAnchorCount: number;
  sourceAudioStreamIndex: number | null;
  targetAudioStreamIndex: number | null;
  sourceVisualStreamIndex: number | null;
  targetVisualStreamIndex: number | null;
  fineScoreMicros: number;
}

export interface C137PairLocalBoundaryErrors {
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
}

export interface C137PairLocalEditDecisionEvidence {
  eventId: string;
  goldKind: C137PairLocalEditKind | null;
  predictedKind: C137PairLocalEditKind | null;
  durationMs: number;
  boundaryErrorMs: number | null;
  durationErrorMs: number | null;
  bilateralBoundaryErrorsMs: C137PairLocalBoundaryErrors | null;
}

export interface C137PairLocalTimeMapCaseEvidence {
  caseId: string;
  mediaKind: "real";
  split: "frozen-test";
  scenarios: RealMediaBenchmarkScenario[];
  matchedProjectionErrorsMs: number[];
  endDriftAt45MinutesMs: number | null;
  editDecisions: C137PairLocalEditDecisionEvidence[];
}

export interface C137PairLocalVersionReuseEvidence {
  groupOrdinal: number;
  groupId: string;
  groupSide: "source" | "target";
  reusedPhysicalAxis: "source" | "target";
  sharedMediaId: string;
  peerPairOrdinals: number[];
  maximumOverlapMs: number;
  overlapToleranceMs: number;
}

export interface C137DerivedTimeMapCaseEvidence {
  caseId: string;
  mediaKind: "real";
  split: "frozen-test";
  scenarios: RealMediaBenchmarkScenario[];
  matchedProjectionErrorsMs: number[];
  endDriftAt45MinutesMs: number | null;
  editDecisions: Array<Omit<C137PairLocalEditDecisionEvidence, "bilateralBoundaryErrorsMs">>;
}

export interface C137PairLocalFineCaseEvidence {
  caseId: string;
  status: "measured" | "blocked";
  batchId: string | null;
  pairOrdinal: number | null;
  frontierReceiptDigest: C137PairLocalDigest | null;
  proposalTimeMapDigest: C137PairLocalDigest | null;
  selectedCandidateId: NativeBatchFineCandidateId | null;
  selectedSourceWindow: NativeBatchFineDecodeWindow | null;
  selectedTargetWindow: NativeBatchFineDecodeWindow | null;
  pairCandidateCount: number;
  completePairCandidateInventoryEnumerated: boolean;
  samePairAlternativeObserved: boolean;
  selectedGroupMemberCount: number;
  sameSegmentManyToManyObserved: boolean;
  versionReuseEvidence: C137PairLocalVersionReuseEvidence | null;
  frontierResolutionProven: boolean;
  modality: C137PairLocalModalityEvidence | null;
  timeMap: C137PairLocalTimeMapCaseEvidence | null;
  issues: string[];
}

export interface C137PairLocalFineEvidence {
  schemaVersion: typeof C137_PAIR_LOCAL_FINE_EVIDENCE_SCHEMA_VERSION;
  kind: "c137-pair-local-fine-evidence";
  scope: "frozen-gold-native-pair-local-window-and-time-map";
  releaseEligible: false;
  trustStatus: "derived-from-untrusted-self-consistent-provenance";
  manifestDigest: C137PairLocalDigest;
  goldDigest: C137PairLocalDigest;
  provenanceDigest: C137PairLocalDigest;
  cases: C137PairLocalFineCaseEvidence[];
  evidenceDigest: C137PairLocalDigest;
}

type C137PairLocalFineEvidenceDraft = Omit<C137PairLocalFineEvidence, "evidenceDigest">;

interface LocatedPair {
  batchId: string;
  batch: C137FormalBlindProvenanceBatchEnvelopeV3;
  outcome: RealMediaBlindBatchPairOutcome;
}

interface IndexedEditEvent {
  kind: C137PairLocalEditKind;
  index: number;
  span: TimeMapSpan;
}

interface EventAssignment {
  gold: IndexedEditEvent;
  predicted: IndexedEditEvent;
  errors: C137PairLocalBoundaryErrors;
  maximumErrorMs: number;
  totalErrorMs: number;
}

export function deriveC137PairLocalFineEvidence(
  provenance: C137FormalBlindProvenanceV3
): C137PairLocalFineEvidence {
  const validation = validateC137FormalBlindProvenance(provenance);
  if (!validation.valid) {
    throw new Error(
      `pair-local fine evidence 拒绝无效 provenance：${validation.issues.join("；")}`
    );
  }
  const draft: C137PairLocalFineEvidenceDraft = {
    schemaVersion: C137_PAIR_LOCAL_FINE_EVIDENCE_SCHEMA_VERSION,
    kind: "c137-pair-local-fine-evidence",
    scope: "frozen-gold-native-pair-local-window-and-time-map",
    releaseEligible: false,
    trustStatus: "derived-from-untrusted-self-consistent-provenance",
    manifestDigest: computeC137FormalBlindManifestDigest(provenance.manifest),
    goldDigest: computeC137FormalBlindGoldDigest(provenance.manifest),
    provenanceDigest: provenance.provenanceDigest,
    cases: provenance.manifest.cases.map((benchmarkCase) =>
      deriveCaseEvidence(provenance, benchmarkCase)
    )
  };
  return {
    ...draft,
    evidenceDigest: digest(EVIDENCE_DIGEST_DOMAIN, draft)
  };
}

export function deriveC137TimeMapCasesFromPairLocalFineEvidence(
  evidence: C137PairLocalFineEvidence
): C137DerivedTimeMapCaseEvidence[] {
  return evidence.cases
    .map((item) => item.timeMap)
    .filter((item): item is C137PairLocalTimeMapCaseEvidence => item !== null)
    .map((item) => ({
      caseId: item.caseId,
      mediaKind: item.mediaKind,
      split: item.split,
      scenarios: [...item.scenarios],
      matchedProjectionErrorsMs: [...item.matchedProjectionErrorsMs],
      endDriftAt45MinutesMs: item.endDriftAt45MinutesMs,
      editDecisions: item.editDecisions.map(({ bilateralBoundaryErrorsMs, ...decision }) => {
        void bilateralBoundaryErrorsMs;
        return structuredClone(decision);
      })
    }));
}

export function c137TimeMapCasesEqualPairLocalEvidence(
  actual: readonly unknown[],
  evidence: C137PairLocalFineEvidence
): boolean {
  return (
    canonicalJson(actual) ===
    canonicalJson(deriveC137TimeMapCasesFromPairLocalFineEvidence(evidence))
  );
}

export function c137RelationshipModalitiesEqualPairLocalEvidence(
  actual: readonly { caseId: string; modality: C137NativeModality }[],
  evidence: C137PairLocalFineEvidence
): boolean {
  if (
    actual.length !== evidence.cases.length ||
    evidence.cases.some((item) => item.status !== "measured" || item.modality === null)
  ) {
    return false;
  }
  const expectedByCaseId = new Map(
    evidence.cases.map((item) => [item.caseId, item.modality?.modality] as const)
  );
  if (expectedByCaseId.size !== evidence.cases.length) return false;
  const seen = new Set<string>();
  for (const item of actual) {
    if (seen.has(item.caseId) || expectedByCaseId.get(item.caseId) !== item.modality) {
      return false;
    }
    seen.add(item.caseId);
  }
  return seen.size === expectedByCaseId.size;
}

function deriveCaseEvidence(
  provenance: C137FormalBlindProvenanceV3,
  benchmarkCase: RealMediaBenchmarkCase
): C137PairLocalFineCaseEvidence {
  const issues: string[] = [];
  const located = locateGoldPair(provenance, benchmarkCase);
  if (located.length !== 1) {
    issues.push(`冻结 case 必须唯一定位到一个 native gold pair，实际 ${located.length} 个。`);
    return blockedCase(benchmarkCase.id, issues);
  }
  const pair = located[0];
  const outcome = pair.outcome;
  const frontier = outcome.fineFrontier;
  const execution = outcome.fineExecutionEvidence;
  const proposal = outcome.proposalTimeMap;
  if (outcome.nativeStatus !== "completed") issues.push("native pair 未完成。 ");
  if (frontier === null) issues.push("native pair 缺少 fine frontier receipt。");
  if (execution === null) issues.push("native pair 缺少 selected fine execution evidence。");
  if (proposal === null) issues.push("native pair 缺少 proposal TimeMap。");
  if (frontier === null || execution === null || proposal === null) {
    return {
      ...blockedCase(benchmarkCase.id, issues),
      batchId: pair.batchId,
      pairOrdinal: outcome.pairOrdinal
    };
  }

  const candidateIds = observedPairCandidateIds(frontier, outcome.pairOrdinal);
  const pairCandidateCount = candidateIds.length;
  const selectedByFrontier = frontier.selectedCandidateIds.some((candidate) =>
    sameCandidate(candidate, execution.candidateId)
  );
  const frontierResolutionProven =
    frontier.resolved &&
    frontier.finalState === "resolved" &&
    selectedByFrontier &&
    frontier.proof.beatsRunnerUpWithMargin &&
    frontier.proof.beatsOptimisticOmittedWithMargin;
  if (!frontierResolutionProven) {
    issues.push("fine frontier 没有以双重 margin proof 绑定 selected candidate。");
  }
  if (execution.candidateId.pairOrdinal !== outcome.pairOrdinal) {
    issues.push("fine execution candidate 未绑定当前 pairOrdinal。");
  }
  const modality = deriveNativeModality(proposal, execution, issues);
  const versionReuseEvidence = deriveC137PairLocalVersionReuseEvidence(
    pair.batch.nativeReceipt,
    outcome
  );

  const timeMap = deriveTimeMapCase(benchmarkCase, proposal.spans);
  if (timeMap.matchedProjectionErrorsMs.length !== benchmarkCase.gold.matchedAnchors.length) {
    issues.push("proposal TimeMap 未映射全部 frozen matched anchors。");
  }
  if (
    benchmarkCase.scenarios.includes("time-stretch") &&
    timeMap.endDriftAt45MinutesMs === null
  ) {
    issues.push("time-stretch case 无法在 45 分钟位置从 frozen Gold 推导漂移。");
  }

  return {
    caseId: benchmarkCase.id,
    status: issues.length === 0 ? "measured" : "blocked",
    batchId: pair.batchId,
    pairOrdinal: outcome.pairOrdinal,
    frontierReceiptDigest: frontier.receiptDigest,
    proposalTimeMapDigest: execution.proposalTimeMapDigest,
    selectedCandidateId: structuredClone(execution.candidateId),
    selectedSourceWindow: structuredClone(execution.sourceEffectiveWindow),
    selectedTargetWindow: structuredClone(execution.targetEffectiveWindow),
    pairCandidateCount,
    completePairCandidateInventoryEnumerated: true,
    samePairAlternativeObserved: pairCandidateCount >= 2,
    selectedGroupMemberCount: execution.groupMemberRanks.length,
    sameSegmentManyToManyObserved: versionReuseEvidence !== null,
    versionReuseEvidence,
    frontierResolutionProven,
    modality,
    timeMap,
    issues
  };
}

function blockedCase(caseId: string, issues: string[]): C137PairLocalFineCaseEvidence {
  return {
    caseId,
    status: "blocked",
    batchId: null,
    pairOrdinal: null,
    frontierReceiptDigest: null,
    proposalTimeMapDigest: null,
    selectedCandidateId: null,
    selectedSourceWindow: null,
    selectedTargetWindow: null,
    pairCandidateCount: 0,
    completePairCandidateInventoryEnumerated: false,
    samePairAlternativeObserved: false,
    selectedGroupMemberCount: 0,
    sameSegmentManyToManyObserved: false,
    versionReuseEvidence: null,
    frontierResolutionProven: false,
    modality: null,
    timeMap: null,
    issues: [...issues]
  };
}

export function deriveC137PairLocalVersionReuseEvidence(
  receipt: Pick<RealMediaBlindBatchRunReceipt, "versionReuseGroups" | "pairOutcomes">,
  current: RealMediaBlindBatchPairOutcome
): C137PairLocalVersionReuseEvidence | null {
  const currentFrontier = current.fineFrontier;
  const currentExecution = current.fineExecutionEvidence;
  const currentProposal = current.proposalTimeMap;
  if (currentFrontier === null || currentExecution === null || currentProposal === null) {
    return null;
  }
  const currentInventory = currentFrontier.inventoryCandidates.find((candidate) =>
    sameCandidate(candidate.id, currentExecution.candidateId)
  );
  if (currentInventory === undefined) return null;

  for (const group of receipt.versionReuseGroups) {
    const currentMediaId =
      group.side === "target" ? current.targetMediaId : current.sourceMediaId;
    if (!group.mediaIds.includes(currentMediaId)) continue;
    const reusedPhysicalAxis = group.side === "target" ? "source" : "target";
    const currentGroupOrdinal =
      reusedPhysicalAxis === "source"
        ? currentInventory.sourceAxisReuseGroupOrdinal
        : currentInventory.targetAxisReuseGroupOrdinal;
    if (currentGroupOrdinal !== group.groupOrdinal) continue;

    const sharedMediaId =
      group.side === "target" ? current.sourceMediaId : current.targetMediaId;
    const observedPeers: Array<{ pairOrdinal: number; overlapMs: number }> = [];
    for (const peer of receipt.pairOutcomes) {
      if (peer.pairOrdinal === current.pairOrdinal || peer.nativeStatus !== "completed")
        continue;
      const peerGroupedMediaId =
        group.side === "target" ? peer.targetMediaId : peer.sourceMediaId;
      const peerSharedMediaId =
        group.side === "target" ? peer.sourceMediaId : peer.targetMediaId;
      if (peerSharedMediaId !== sharedMediaId || !group.mediaIds.includes(peerGroupedMediaId)) {
        continue;
      }
      const peerFrontier = peer.fineFrontier;
      const peerExecution = peer.fineExecutionEvidence;
      const peerProposal = peer.proposalTimeMap;
      if (peerFrontier === null || peerExecution === null || peerProposal === null) continue;
      if (
        peerFrontier.componentOrdinal !== currentFrontier.componentOrdinal ||
        !currentFrontier.componentPairOrdinals.includes(peer.pairOrdinal) ||
        !peerFrontier.componentPairOrdinals.includes(current.pairOrdinal) ||
        !currentFrontier.selectedCandidateIds.some((candidate) =>
          sameCandidate(candidate, currentExecution.candidateId)
        ) ||
        !peerFrontier.selectedCandidateIds.some((candidate) =>
          sameCandidate(candidate, peerExecution.candidateId)
        )
      ) {
        continue;
      }
      const peerInventory = peerFrontier.inventoryCandidates.find((candidate) =>
        sameCandidate(candidate.id, peerExecution.candidateId)
      );
      if (peerInventory === undefined) continue;
      const peerGroupOrdinal =
        reusedPhysicalAxis === "source"
          ? peerInventory.sourceAxisReuseGroupOrdinal
          : peerInventory.targetAxisReuseGroupOrdinal;
      if (peerGroupOrdinal !== group.groupOrdinal) continue;
      const overlapMs = maximumProposalAxisOverlapMs(
        currentProposal.spans,
        peerProposal.spans,
        reusedPhysicalAxis
      );
      const overlapToleranceMs = Math.max(
        currentFrontier.overlapToleranceMs,
        peerFrontier.overlapToleranceMs
      );
      if (overlapMs > overlapToleranceMs) {
        observedPeers.push({ pairOrdinal: peer.pairOrdinal, overlapMs });
      }
    }
    if (observedPeers.length > 0) {
      observedPeers.sort((left, right) => left.pairOrdinal - right.pairOrdinal);
      return {
        groupOrdinal: group.groupOrdinal,
        groupId: group.groupId,
        groupSide: group.side,
        reusedPhysicalAxis,
        sharedMediaId,
        peerPairOrdinals: observedPeers.map((peer) => peer.pairOrdinal),
        maximumOverlapMs: Math.max(...observedPeers.map((peer) => peer.overlapMs)),
        overlapToleranceMs: currentFrontier.overlapToleranceMs
      };
    }
  }
  return null;
}

interface PhysicalInterval {
  startMs: number;
  endMs: number;
}

function maximumProposalAxisOverlapMs(
  left: readonly TimeMapSpan[],
  right: readonly TimeMapSpan[],
  axis: "source" | "target"
): number {
  const leftIntervals = canonicalPhysicalIntervals(left, axis);
  const rightIntervals = canonicalPhysicalIntervals(right, axis);
  let maximum = 0;
  for (const leftInterval of leftIntervals) {
    for (const rightInterval of rightIntervals) {
      maximum = Math.max(
        maximum,
        Math.min(leftInterval.endMs, rightInterval.endMs) -
          Math.max(leftInterval.startMs, rightInterval.startMs)
      );
    }
  }
  return Math.max(0, maximum);
}

function canonicalPhysicalIntervals(
  spans: readonly TimeMapSpan[],
  axis: "source" | "target"
): PhysicalInterval[] {
  const intervals = spans
    .map((span) => ({
      startMs: axis === "source" ? span.sourceStartMs : span.targetStartMs,
      endMs: axis === "source" ? span.sourceEndMs : span.targetEndMs
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const canonical: PhysicalInterval[] = [];
  for (const interval of intervals) {
    const previous = canonical.at(-1);
    if (previous !== undefined && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      canonical.push({ ...interval });
    }
  }
  return canonical;
}

function deriveNativeModality(
  proposal: NonNullable<RealMediaBlindBatchPairOutcome["proposalTimeMap"]>,
  execution: NonNullable<RealMediaBlindBatchPairOutcome["fineExecutionEvidence"]>,
  issues: string[]
): C137PairLocalModalityEvidence | null {
  const evidenceTypes = proposal.evidence.types.filter(
    (type): type is "audio" | "visual" => type === "audio" || type === "visual"
  );
  const uniqueTypes = [...new Set(evidenceTypes)];
  const audioUsed = proposal.evidence.audioAnchorCount > 0;
  const visualUsed = proposal.evidence.visualAnchorCount > 0;
  if (audioUsed !== uniqueTypes.includes("audio")) {
    issues.push("native TimeMap 的 audio evidence type 与 audioAnchorCount 不一致。");
  }
  if (visualUsed !== uniqueTypes.includes("visual")) {
    issues.push("native TimeMap 的 visual evidence type 与 visualAnchorCount 不一致。");
  }
  if (
    audioUsed &&
    (proposal.sourceStream?.type !== "audio" ||
      proposal.targetStream?.type !== "audio" ||
      proposal.sourceStream.index !== execution.sourceStreamIndex ||
      proposal.targetStream.index !== execution.targetStreamIndex)
  ) {
    issues.push("native audio modality 未绑定 fine execution 实际使用的双端音轨。");
  }
  if (
    visualUsed &&
    (proposal.sourceVisualStream?.type !== "video" ||
      proposal.targetVisualStream?.type !== "video")
  ) {
    issues.push("native visual modality 缺少双端实际视频流身份。");
  }
  if (proposal.quality.level === "blocked") {
    issues.push("native TimeMap 已因证据冲突或不足被 blocked，不能发布 modality。");
  }
  if (!audioUsed && !visualUsed) {
    issues.push(
      "native TimeMap 没有可用的 audio/visual 锚点；不能把成功候选事后标为 no-common-content。"
    );
    return null;
  }
  return {
    modality: audioUsed ? (visualUsed ? "mixed" : "same-audio") : "visual-only",
    evidenceTypes: uniqueTypes,
    audioAnchorCount: proposal.evidence.audioAnchorCount,
    visualAnchorCount: proposal.evidence.visualAnchorCount,
    sourceAudioStreamIndex: audioUsed ? (proposal.sourceStream?.index ?? null) : null,
    targetAudioStreamIndex: audioUsed ? (proposal.targetStream?.index ?? null) : null,
    sourceVisualStreamIndex: visualUsed ? (proposal.sourceVisualStream?.index ?? null) : null,
    targetVisualStreamIndex: visualUsed ? (proposal.targetVisualStream?.index ?? null) : null,
    fineScoreMicros: execution.scoreMicros
  };
}

function locateGoldPair(
  provenance: C137FormalBlindProvenanceV3,
  benchmarkCase: RealMediaBenchmarkCase
): LocatedPair[] {
  const sourceCommitment = createC137BlindBatchMediaBindingCommitment(
    provenance.manifest.id,
    provenance.manifest.datasetVersion,
    "source",
    provenance.plan.visualEvidenceEnabled,
    benchmarkCase.source
  );
  const targetCommitment = createC137BlindBatchMediaBindingCommitment(
    provenance.manifest.id,
    provenance.manifest.datasetVersion,
    "target",
    provenance.plan.visualEvidenceEnabled,
    benchmarkCase.target
  );
  const located: LocatedPair[] = [];
  for (const batch of provenance.batches) {
    const source = findProjectionMedia(batch.projection.sources, sourceCommitment);
    const target = findProjectionMedia(batch.projection.targets, targetCommitment);
    if (source === null || target === null) continue;
    const outcome = batch.nativeReceipt.pairOutcomes.find(
      (item) => item.sourceMediaId === source.mediaId && item.targetMediaId === target.mediaId
    );
    if (outcome !== undefined) located.push({ batchId: batch.batchId, batch, outcome });
  }
  return located;
}

function findProjectionMedia(
  media: readonly C137BlindBatchMediaProjection[],
  bindingCommitment: C137PairLocalDigest
): C137BlindBatchMediaProjection | null {
  return media.find((item) => item.bindingCommitment === bindingCommitment) ?? null;
}

function observedPairCandidateIds(
  frontier: NonNullable<RealMediaBlindBatchPairOutcome["fineFrontier"]>,
  pairOrdinal: number
): NativeBatchFineCandidateId[] {
  return frontier.inventoryCandidates
    .filter((candidate) => candidate.id.pairOrdinal === pairOrdinal)
    .map((candidate) => structuredClone(candidate.id));
}

function deriveTimeMapCase(
  benchmarkCase: RealMediaBenchmarkCase,
  predictedSpans: readonly TimeMapSpan[]
): C137PairLocalTimeMapCaseEvidence {
  const matchedProjectionErrorsMs: number[] = [];
  for (const anchor of benchmarkCase.gold.matchedAnchors) {
    const mapped = mapSourceTime(predictedSpans, anchor.sourceMs);
    if (mapped.status === "mapped") {
      matchedProjectionErrorsMs.push(Math.abs(mapped.targetTimeMs - anchor.targetMs));
    }
  }
  return {
    caseId: benchmarkCase.id,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: [...benchmarkCase.scenarios],
    matchedProjectionErrorsMs,
    endDriftAt45MinutesMs: benchmarkCase.scenarios.includes("time-stretch")
      ? deriveDriftAt45Minutes(benchmarkCase.gold, predictedSpans)
      : null,
    editDecisions: deriveEditDecisions(benchmarkCase, predictedSpans)
  };
}

function deriveDriftAt45Minutes(
  gold: RealMediaBenchmarkGold,
  predictedSpans: readonly TimeMapSpan[]
): number | null {
  const sourceMs = gold.sourceStartMs + 45 * 60 * 1_000;
  if (sourceMs >= gold.sourceEndMs) return null;
  const goldTargetMs = interpolateGoldTarget(gold, sourceMs);
  const predicted = mapSourceTime(predictedSpans, sourceMs);
  if (goldTargetMs === null || predicted.status !== "mapped") return null;
  return Math.abs(predicted.targetTimeMs - goldTargetMs);
}

function interpolateGoldTarget(gold: RealMediaBenchmarkGold, sourceMs: number): number | null {
  const anchors = [...gold.matchedAnchors].sort(
    (left, right) => left.sourceMs - right.sourceMs
  );
  const exact = anchors.find((anchor) => anchor.sourceMs === sourceMs);
  if (exact !== undefined) return exact.targetMs;
  const left = [...anchors].reverse().find((anchor) => anchor.sourceMs < sourceMs);
  const right = anchors.find((anchor) => anchor.sourceMs > sourceMs);
  if (left === undefined || right === undefined || right.sourceMs === left.sourceMs)
    return null;
  const ratio = (sourceMs - left.sourceMs) / (right.sourceMs - left.sourceMs);
  return Math.round(left.targetMs + ratio * (right.targetMs - left.targetMs));
}

function deriveEditDecisions(
  benchmarkCase: RealMediaBenchmarkCase,
  predictedSpans: readonly TimeMapSpan[]
): C137PairLocalEditDecisionEvidence[] {
  const goldEvents = collectGoldEvents(benchmarkCase.gold);
  const predictedEvents = predictedSpans
    .map((span, index): IndexedEditEvent | null =>
      span.kind === "matched" ? null : { kind: normalizeEditKind(span.kind), index, span }
    )
    .filter((event): event is IndexedEditEvent => event !== null);
  const assignments = assignEvents(
    goldEvents,
    predictedEvents,
    benchmarkCase.boundaryToleranceMs
  );
  const assignedGold = new Set(assignments.map((item) => item.gold.index));
  const assignedPredicted = new Set(assignments.map((item) => item.predicted.index));
  const paired = assignments.map((assignment, index) =>
    createPairedDecision(benchmarkCase.id, index, assignment)
  );
  const missed = goldEvents
    .filter((event) => !assignedGold.has(event.index))
    .map((event, index) =>
      createUnpairedDecision(benchmarkCase.id, paired.length + index, event, "gold")
    );
  const falsePositives = predictedEvents
    .filter((event) => !assignedPredicted.has(event.index))
    .map((event, index) =>
      createUnpairedDecision(
        benchmarkCase.id,
        paired.length + missed.length + index,
        event,
        "predicted"
      )
    );
  return [...paired, ...missed, ...falsePositives];
}

function collectGoldEvents(gold: RealMediaBenchmarkGold): IndexedEditEvent[] {
  return [
    ...gold.sourceOnlySpans.map((span, index) => ({
      kind: "sourceOnly" as const,
      index,
      span
    })),
    ...gold.targetOnlySpans.map((span, index) => ({
      kind: "targetOnly" as const,
      index: gold.sourceOnlySpans.length + index,
      span
    })),
    ...gold.ambiguousSpans.map((span, index) => ({
      kind: "replacement" as const,
      index: gold.sourceOnlySpans.length + gold.targetOnlySpans.length + index,
      span
    }))
  ].sort(compareEvents);
}

function assignEvents(
  gold: readonly IndexedEditEvent[],
  predicted: readonly IndexedEditEvent[],
  toleranceMs: number
): EventAssignment[] {
  const candidates = gold.flatMap((goldEvent) =>
    predicted.map((predictedEvent) => {
      const errors = boundaryErrors(goldEvent.span, predictedEvent.span);
      const values = [
        errors.sourceStartMs,
        errors.sourceEndMs,
        errors.targetStartMs,
        errors.targetEndMs
      ];
      return {
        gold: goldEvent,
        predicted: predictedEvent,
        errors,
        maximumErrorMs: Math.max(...values),
        totalErrorMs: values.reduce((sum, value) => sum + value, 0)
      };
    })
  );
  candidates.sort(
    (left, right) =>
      Number(left.maximumErrorMs > toleranceMs) - Number(right.maximumErrorMs > toleranceMs) ||
      left.maximumErrorMs - right.maximumErrorMs ||
      left.totalErrorMs - right.totalErrorMs ||
      Number(left.gold.kind !== left.predicted.kind) -
        Number(right.gold.kind !== right.predicted.kind) ||
      compareEvents(left.gold, right.gold) ||
      compareEvents(left.predicted, right.predicted)
  );
  const usedGold = new Set<number>();
  const usedPredicted = new Set<number>();
  const result: EventAssignment[] = [];
  for (const candidate of candidates) {
    if (candidate.maximumErrorMs > toleranceMs) continue;
    if (usedGold.has(candidate.gold.index) || usedPredicted.has(candidate.predicted.index)) {
      continue;
    }
    usedGold.add(candidate.gold.index);
    usedPredicted.add(candidate.predicted.index);
    result.push(candidate);
  }
  return result.sort((left, right) => compareEvents(left.gold, right.gold));
}

function createPairedDecision(
  caseId: string,
  index: number,
  assignment: EventAssignment
): C137PairLocalEditDecisionEvidence {
  return {
    eventId: `${caseId}:pair-local:${String(index + 1).padStart(4, "0")}`,
    goldKind: assignment.gold.kind,
    predictedKind: assignment.predicted.kind,
    durationMs: Math.max(
      eventDuration(assignment.gold.span),
      eventDuration(assignment.predicted.span)
    ),
    boundaryErrorMs: assignment.maximumErrorMs,
    durationErrorMs: Math.max(
      Math.abs(
        sourceDuration(assignment.gold.span) - sourceDuration(assignment.predicted.span)
      ),
      Math.abs(targetDuration(assignment.gold.span) - targetDuration(assignment.predicted.span))
    ),
    bilateralBoundaryErrorsMs: assignment.errors
  };
}

function createUnpairedDecision(
  caseId: string,
  index: number,
  event: IndexedEditEvent,
  side: "gold" | "predicted"
): C137PairLocalEditDecisionEvidence {
  return {
    eventId: `${caseId}:pair-local:${String(index + 1).padStart(4, "0")}`,
    goldKind: side === "gold" ? event.kind : null,
    predictedKind: side === "predicted" ? event.kind : null,
    durationMs: eventDuration(event.span),
    boundaryErrorMs: null,
    durationErrorMs: null,
    bilateralBoundaryErrorsMs: null
  };
}

function boundaryErrors(left: TimeMapSpan, right: TimeMapSpan): C137PairLocalBoundaryErrors {
  return {
    sourceStartMs: Math.abs(left.sourceStartMs - right.sourceStartMs),
    sourceEndMs: Math.abs(left.sourceEndMs - right.sourceEndMs),
    targetStartMs: Math.abs(left.targetStartMs - right.targetStartMs),
    targetEndMs: Math.abs(left.targetEndMs - right.targetEndMs)
  };
}

function normalizeEditKind(kind: TimeMapSpan["kind"]): C137PairLocalEditKind {
  return kind === "ambiguous" ? "replacement" : (kind as C137PairLocalEditKind);
}

function eventDuration(span: TimeMapSpan): number {
  return Math.max(sourceDuration(span), targetDuration(span));
}

function sourceDuration(span: TimeMapSpan): number {
  return span.sourceEndMs - span.sourceStartMs;
}

function targetDuration(span: TimeMapSpan): number {
  return span.targetEndMs - span.targetStartMs;
}

function compareEvents(left: IndexedEditEvent, right: IndexedEditEvent): number {
  return (
    left.span.sourceStartMs - right.span.sourceStartMs ||
    left.span.targetStartMs - right.span.targetStartMs ||
    left.index - right.index
  );
}

function sameCandidate(
  left: NativeBatchFineCandidateId,
  right: NativeBatchFineCandidateId
): boolean {
  return (
    left.pairOrdinal === right.pairOrdinal && left.candidateOrdinal === right.candidateOrdinal
  );
}

function digest(domain: string, value: unknown): C137PairLocalDigest {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareAscii)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
