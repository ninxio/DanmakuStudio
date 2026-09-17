import {
  ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA,
  MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION,
  MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA,
  sha256Json,
  type MultimodalFrozenBlindReviewPack,
  type MultimodalBlindReviewPack,
  type RealAlignmentBlindReviewPack
} from "../domain/alignment/multimodalBlindReview";

export function createMultimodalBlindReviewPackFixture(): MultimodalFrozenBlindReviewPack {
  const queryKey = sha256Json({ query: 1 });
  const taskBody = {
    queryKey,
    sourceTimestampMs: 10_000,
    sourcePreviewStartMs: 5_000,
    sourcePreviewEndMs: 15_000,
    targetReviewStartMs: 4_000,
    targetReviewEndMs: 20_000,
    candidateSlots: [
      { slotId: "A", timestampMs: 11_500 },
      { slotId: "B", timestampMs: 12_000 }
    ]
  };
  const task = { ...taskBody, taskId: sha256Json(taskBody) };
  const body = {
    schemaVersion: MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA as typeof MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA,
    mediaFamilyId: sha256Json({ family: 1 }),
    inputs: {
      consensusResultId: sha256Json({ consensus: 1 }),
      visualResultId: sha256Json({ visual: 1 }),
      publicPlanId: sha256Json({ plan: 1 })
    },
    source: {
      path: "F:\\media\\reference.mkv",
      contentDigest: sha256Json({ source: 1 }),
      durationMs: 60_000,
      videoStreamIndex: 0
    },
    target: {
      path: "F:\\media\\original.mkv",
      contentDigest: sha256Json({ target: 1 }),
      durationMs: 65_000,
      videoStreamIndex: 0
    },
    tasks: [task],
    containsMediaPaths: true as const,
    predictionsBlinded: true as const,
    permission: MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION as typeof MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION,
    releaseEligible: false as const
  };
  return { ...body, packId: sha256Json(body) };
}

export function createRealAlignmentBlindReviewPackFixture(): RealAlignmentBlindReviewPack {
  const base = createMultimodalBlindReviewPackFixture();
  const body: Omit<RealAlignmentBlindReviewPack, "packId"> = {
    schemaVersion: ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA,
    mediaFamilyId: sha256Json({ family: "real" }),
    provenance: {
      kind: "realAlignmentRun" as const,
      runIdDigest: sha256Json({ run: 1 }),
      manifestPayloadDigest: sha256Json({ envelope: 1 }),
      manifestCanonicalPayloadDigest: sha256Json({ payload: 1 }),
      selectorVersion: "alignment-sensitive-review-selector-v1" as const,
      selectorReceiptId: sha256Json({ selector: 1 }),
      pairOrdinal: 1,
      familyAuthority: "user-declared-label" as const
    },
    source: base.source,
    target: base.target,
    tasks: base.tasks,
    containsMediaPaths: true as const,
    predictionsBlinded: true as const,
    permission: MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION,
    releaseEligible: false as const
  };
  return { ...body, packId: sha256Json(body) };
}

export function createMultimodalBlindReviewPackFixtureWithTasks(
  familyIndex: number,
  taskCount = 20
): MultimodalBlindReviewPack {
  const base = createMultimodalBlindReviewPackFixture();
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const sourceTimestampMs = 10_000 + index * 1_000;
    const targetTimestampMs = 11_500 + index * 1_000;
    const body = {
      queryKey: sha256Json({ familyIndex, query: index }),
      sourceTimestampMs,
      sourcePreviewStartMs: sourceTimestampMs - 500,
      sourcePreviewEndMs: sourceTimestampMs + 500,
      targetReviewStartMs: targetTimestampMs - 1_000,
      targetReviewEndMs: targetTimestampMs + 1_500,
      candidateSlots: [{ slotId: "A", timestampMs: targetTimestampMs }]
    };
    return { ...body, taskId: sha256Json(body) };
  }).sort((left, right) =>
    left.queryKey < right.queryKey ? -1 : left.queryKey > right.queryKey ? 1 : 0
  );
  const withoutPackId = Object.fromEntries(
    Object.entries(base).filter(([key]) => key !== "packId")
  ) as Omit<typeof base, "packId">;
  const body = {
    ...withoutPackId,
    mediaFamilyId: sha256Json({ family: familyIndex }),
    tasks
  };
  return { ...body, packId: sha256Json(body) };
}
