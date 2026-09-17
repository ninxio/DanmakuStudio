import { selectWorkspaceMenu } from "./workspace-ui";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { finishBilibiliFixture, installBilibiliFixture } from "./bilibili-fixture";

const screenshotDir = resolve(
  process.cwd(),
  "test-results",
  "acceptance-artifacts",
  String(process.pid),
  "screenshots"
);

interface MockDialogCall {
  title: string;
  multiple: boolean;
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-11T02:03:04.000Z"));
  await page.addInitScript(
    ({ sourcePaths, targetPaths, xmlPaths }) => {
      interface MockTauriWindow extends Window {
        isTauri: boolean;
        __C136_DIALOG_CALLS__: MockDialogCall[];
        __C137_VERIFICATION_CALLS__: string[];
        __C137_PERFORMANCE_CALLS__: string[];
        __C137_FINE_MODE__: "resolved" | "unresolved" | "resourceBlocked" | "secondAssignment";
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
          metadata: { currentWindow: { label: string } };
          transformCallback: (
            callback: (...args: unknown[]) => unknown,
            once?: boolean
          ) => number;
        };
      }

      interface MockProjectLibraryRevision {
        revision: number;
        parentRevision: number | null;
        sourceRevision: number | null;
        saveKind: "create" | "autosave" | "checkpoint" | "rollback";
        label: string | null;
        savedAtUnixMs: number;
        snapshotBytes: number;
        snapshotJson: string;
        displayName: string;
        projectSchemaVersion: number;
      }

      interface MockProjectLibraryRecord {
        libraryProjectId: string;
        displayName: string;
        projectSchemaVersion: number;
        headRevision: number;
        stableRevision: number;
        createdAtUnixMs: number;
        updatedAtUnixMs: number;
        lastOpenedAtUnixMs: number;
        sessionId: string | null;
        openedRevision: number;
        revisions: MockProjectLibraryRevision[];
      }

      const mediaIdentity = (digit: string, sizeBytes: number) => ({
        algorithm: "sha256-full-file-v2",
        sizeBytes,
        modifiedUnixMs: 1_700_000_000_000,
        firstSampleDigest: digit.repeat(64),
        middleSampleDigest: digit.repeat(64),
        lastSampleDigest: digit.repeat(64)
      });
      const createTimeMap = (currentIndex: number) => {
        const sourceStartMs = currentIndex * 60_000;
        const sourceEndMs = sourceStartMs + 60_000;
        const fourKindSpans = [
          {
            kind: "matched",
            sourceStartMs,
            sourceEndMs: sourceStartMs + 20_000,
            targetStartMs: 0,
            targetEndMs: 20_000
          },
          {
            kind: "sourceOnly",
            sourceStartMs: sourceStartMs + 20_000,
            sourceEndMs: sourceStartMs + 25_000,
            targetStartMs: 20_000,
            targetEndMs: 20_000
          },
          {
            kind: "targetOnly",
            sourceStartMs: sourceStartMs + 25_000,
            sourceEndMs: sourceStartMs + 25_000,
            targetStartMs: 20_000,
            targetEndMs: 26_000
          },
          {
            kind: "ambiguous",
            sourceStartMs: sourceStartMs + 25_000,
            sourceEndMs,
            targetStartMs: 26_000,
            targetEndMs: 61_000
          }
        ];
        const completeSpan = (span: (typeof fourKindSpans)[number], spanIndex: number) => {
          const isMatched = span.kind === "matched";
          const isSourceOnly = span.kind === "sourceOnly";
          const isTargetOnly = span.kind === "targetOnly";
          const boundaryAxis = isSourceOnly ? "source" : isTargetOnly ? "target" : "both";
          const boundaryStatus = isMatched
            ? "notApplicable"
            : span.kind === "ambiguous"
              ? "ambiguous"
              : "unsupported";
          const boundaryCoordinate = (side: "start" | "end") => {
            if (isSourceOnly) {
              return side === "start" ? span.sourceStartMs : span.sourceEndMs;
            }
            if (isTargetOnly) {
              return side === "start" ? span.targetStartMs : span.targetEndMs;
            }
            return null;
          };
          const boundary = (side: "start" | "end") => ({
            status: boundaryStatus,
            axis: boundaryAxis,
            contextSide:
              isMatched || span.kind === "ambiguous"
                ? null
                : side === "start"
                  ? "before"
                  : "after",
            coarseMs: boundaryCoordinate(side),
            refinedMs: null,
            uncertaintyStartMs: null,
            uncertaintyEndMs: null,
            supportDurationMs: 0,
            correlation: null,
            alternativeMargin: null,
            reason: isMatched
              ? "E2E 共同内容段不声明版本差异边界。"
              : "E2E 没有真实媒体边界测量，必须人工复核。"
          });
          return {
            ...span,
            id: `e2e-map-${currentIndex + 1}:span:${String(spanIndex + 1).padStart(4, "0")}`,
            reason: span.kind === "ambiguous" ? "insufficientEvidence" : "e2eMeasured",
            quality: {
              level: span.kind === "ambiguous" ? "blocked" : "review",
              metricSource: "measured",
              probability: null,
              coverage: isMatched ? 0.96 : 0.72,
              uniqueContentCoverage: 0.9,
              alternativeMargin: 0.32,
              anchorCount: isMatched ? 12 : 4,
              heldOutAnchorCount: isMatched ? 3 : 1,
              p50ResidualMs: 35,
              p95ResidualMs: 80,
              p99ResidualMs: 120,
              maxResidualMs: 140,
              boundaryUncertaintyMs: 180,
              leftSupport: isMatched ? "supported" : "unsupported",
              rightSupport: isMatched ? "supported" : "unsupported",
              signals: { audio: "used", visual: "used", danmaku: "blocked" },
              reasons: [
                span.kind === "ambiguous"
                  ? "E2E 保留无法判断段，必须人工分类。"
                  : "E2E 逐段证据仅用于验证产品门禁。"
              ]
            },
            boundaries: { start: boundary("start"), end: boundary("end") },
            alternatives:
              span.kind === "ambiguous"
                ? [
                    {
                      kind: "ambiguous",
                      score: 0.48,
                      sourceStartMs: span.sourceStartMs,
                      sourceEndMs: span.sourceEndMs,
                      targetStartMs: span.targetStartMs,
                      targetEndMs: span.targetEndMs,
                      reason: "E2E 无法区分删减与替换。"
                    }
                  ]
                : []
          };
        };
        return {
          sourceStartMs,
          sourceEndMs,
          targetStartMs: 0,
          targetEndMs: currentIndex === 0 ? 61_000 : 60_000,
          spans:
            currentIndex === 0
              ? fourKindSpans.map(completeSpan)
              : [
                  {
                    kind: "matched",
                    sourceStartMs,
                    sourceEndMs,
                    targetStartMs: 0,
                    targetEndMs: 60_000
                  }
                ].map(completeSpan),
          quality: {
            level: currentIndex === 0 ? "blocked" : "review",
            probability: null,
            metricSource: "measured",
            coverage: currentIndex === 0 ? 0.72 : 0.96,
            uniqueContentCoverage: 0.94,
            p50ResidualMs: 35,
            p95ResidualMs: 80,
            p99ResidualMs: 120,
            maxResidualMs: 140,
            boundaryUncertaintyMs: 180,
            alternativeMargin: 0.32,
            anchorCount: 36,
            anchorRegionCount: 3,
            heldOutAnchorCount: 6,
            reasons:
              currentIndex === 0
                ? ["存在无法唯一解释的歧义区间。"]
                : ["备选路径差距偏小，需要真实 A/B 试听复核。"]
          },
          evidence: {
            types: ["audio", "visual"],
            audioAnchorCount: 24,
            visualAnchorCount: 12,
            heldOutAnchorCount: 6,
            top1Top2Margin: 0.32,
            uniqueContentCoverage: 0.94,
            repeatedContentOnly: false,
            selectedTrackReason: "国语音轨覆盖完整且残差最低。",
            alternativeTrackScores: [
              {
                sourceStreamIndex: 1,
                targetStreamIndex: 2,
                score: 0.92,
                scale: 1,
                offsetMs: -sourceStartMs,
                inlierCount: 36
              },
              {
                sourceStreamIndex: 1,
                targetStreamIndex: 3,
                score: 0.6,
                scale: 1,
                offsetMs: -sourceStartMs + 5_000,
                inlierCount: 18
              }
            ],
            notes: []
          },
          sourceStream: {
            type: "audio",
            index: 1,
            codec: "aac",
            startMs: 0,
            timelineOffsetMs: 0,
            timeBase: "1/48000",
            sampleRate: 48_000,
            channels: 2,
            frameRate: null,
            language: "zh",
            title: "国语"
          },
          targetStream: {
            type: "audio",
            index: 2,
            codec: "flac",
            startMs: 0,
            timelineOffsetMs: 0,
            timeBase: "1/48000",
            sampleRate: 48_000,
            channels: 6,
            frameRate: null,
            language: "zh",
            title: "正片"
          },
          sourceIdentity: mediaIdentity("a", 8_000_000_000),
          targetIdentity: mediaIdentity(String(currentIndex + 1), 7_000_000_000 + currentIndex),
          engineVersion: "alignment-v2.4",
          featureVersion: "chroma-v2",
          parametersHash: `c137-e2e-${currentIndex + 1}`
        };
      };
      const float64BitsHex = (value: number): string => {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setFloat64(0, value, false);
        return view.getBigUint64(0, false).toString(16).padStart(16, "0");
      };
      const canonicalizeRuntimeValue = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonicalizeRuntimeValue);
        if (typeof value === "object" && value !== null) {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, nested]) => [key, canonicalizeRuntimeValue(nested)])
          );
        }
        if (typeof value === "number") {
          if (!Number.isFinite(value)) throw new Error("E2E canonical JSON 不接受非有限数字");
          return `f64:${float64BitsHex(value)}`;
        }
        return value;
      };
      const createRuntimeDigest = async (
        domain: string,
        value: unknown
      ): Promise<`sha256:${string}`> => {
        const canonical = JSON.stringify(canonicalizeRuntimeValue(value));
        const bytes = new TextEncoder().encode(`${domain}\n${canonical}`);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        return `sha256:${hex}`;
      };
      const createGlobalSelection = (currentIndex: number) => {
        const sourceStartMs = currentIndex * 60_000;
        const candidate = {
          rank: 1,
          sourceStreamIndex: 1,
          targetStreamIndex: 2,
          score: 0.94,
          globalScore: 0.9,
          scale: 1,
          offsetMs: -sourceStartMs,
          sourceStartMs,
          sourceEndMs: sourceStartMs + 60_000,
          targetStartMs: 0,
          targetEndMs: currentIndex === 0 ? 61_000 : 60_000,
          inlierCount: 36,
          temporalCoverage: currentIndex === 0 ? 0.72 : 0.96,
          uniqueSourceCoverage: 0.94,
          eligible: true,
          globalSelected: true
        };
        return {
          state: "selected",
          selected: true,
          selectedRank: 1,
          selectedScore: candidate.globalScore,
          decisionRank: 1,
          decisionScore: candidate.globalScore,
          margin: 1,
          candidateCount: 1,
          eligibleCandidateCount: 1,
          topK: [candidate],
          decisionCandidate: candidate
        };
      };
      const createRelationRanking = (currentIndex: number) => {
        const sourceStartMs = currentIndex * 60_000;
        const scoreVersion = "alignment-v2-pair-intrinsic-global-weight-v1";
        const executionIdentity = {
          schemaVersion: 1,
          engineVersion: "alignment-v2.4",
          featureVersion: "chroma-v2",
          relationScoreVersion: scoreVersion,
          nativeExecutableDigest: `sha256:${"9".repeat(64)}`,
          ffmpegBinaryDigest: `sha256:${"a".repeat(64)}`,
          ffprobeBinaryDigest: `sha256:${"b".repeat(64)}`,
          sourceSpectralBackends: [
            {
              backendId: "cuda-cufft-r2c-512-v1",
              requestedBackend: "auto",
              backendDetail: "E2E CUDA/cuFFT fixture",
              fallbackReason: null
            }
          ],
          targetSpectralBackends: [
            {
              backendId: "cuda-cufft-r2c-512-v1",
              requestedBackend: "auto",
              backendDetail: "E2E CUDA/cuFFT fixture",
              fallbackReason: null
            }
          ]
        };
        const candidate = {
          rank: 1,
          sourceStreamIndex: 1,
          targetStreamIndex: 2,
          score: 0.94,
          globalScore: 0.9,
          scale: 1,
          offsetMs: -sourceStartMs,
          sourceStartMs,
          sourceEndMs: sourceStartMs + 60_000,
          targetStartMs: 0,
          targetEndMs: currentIndex === 0 ? 61_000 : 60_000,
          inlierCount: 36,
          temporalCoverage: currentIndex === 0 ? 0.72 : 0.96,
          uniqueSourceCoverage: 0.94
        };
        return {
          scoreVersion,
          executionIdentityDigest: `sha256:${"c".repeat(64)}`,
          executionIdentity,
          state: "ranked",
          candidateCount: 1,
          eligibleCandidateCount: 1,
          score: candidate.globalScore,
          bestEligibleCandidate: candidate
        };
      };
      const createFineFrontier = async (
        pairCount: number,
        mode: MockTauriWindow["__C137_FINE_MODE__"]
      ) => {
        const allCandidateIds = Array.from({ length: pairCount }, (_value, index) => ({
          pairOrdinal: index + 1,
          candidateOrdinal: 1
        }));
        const inventoryCandidates = allCandidateIds.map((id, index) => ({
          id,
          coarseUpperBoundMicros: 900_000,
          sourceAxisReuseGroupOrdinal: null,
          targetAxisReuseGroupOrdinal: null,
          members: [
            {
              rank: 1,
              sourceStreamIndex: 1,
              targetStreamIndex: 2,
              score: 0.94,
              globalScore: 0.9,
              scale: 1,
              offsetMs: -index * 60_000,
              sourceStartMs: index * 60_000,
              sourceEndMs: (index + 1) * 60_000,
              targetStartMs: 0,
              targetEndMs: index === 0 ? 61_000 : 60_000,
              inlierCount: 36,
              temporalCoverage: index === 0 ? 0.72 : 0.96,
              uniqueSourceCoverage: 0.94
            }
          ]
        }));
        const selectedCandidateIds =
          mode === "resolved"
            ? allCandidateIds
            : mode === "secondAssignment"
              ? allCandidateIds.slice(1, 2)
              : [];
        const resolved = mode === "resolved" || mode === "secondAssignment";
        const blockedCount = mode === "resourceBlocked" ? pairCount : 0;
        const unresolvedCount = mode === "unresolved" ? pairCount : 0;
        const receipt = {
          contractVersion: "alignment-v2-adaptive-fine-frontier-v3",
          scoreVersion: "alignment-v2-coarse-upper-times-confidence-v1",
          inventoryDigest: await createRuntimeDigest(
            "audio-alignment-v5/fine-frontier-inventory/v3",
            inventoryCandidates
          ),
          inventoryCandidates,
          receiptDigest: "",
          componentOrdinal: 1,
          componentPairOrdinals: Array.from(
            { length: pairCount },
            (_value, index) => index + 1
          ),
          inventoryCandidateCount: pairCount,
          resolutionMarginMicros: 10_000,
          overlapToleranceMs: 250,
          limits: {
            maxCandidates: 128,
            maxSearchStates: 100_000,
            maxSearchExpansions: 1_000_000,
            maxIntervalComparisons: 1_000_000,
            maxIntervalsPerAxis: 256,
            maxTotalIntervals: 4_096,
            refinementBatchSize: 8
          },
          inventoryStateCounts: {
            unresolved: unresolvedCount,
            scored: resolved ? pairCount : 0,
            evaluatedIneligible: 0,
            evidenceBlocked: 0,
            resourceBlocked: blockedCount,
            infrastructureFailed: 0,
            cancelled: 0
          },
          refinementRoundCount: resolved ? 1 : 0,
          evaluatedCandidateCount: resolved ? pairCount : 0,
          finalState: resolved ? "resolved" : "unresolved",
          resolved,
          selectedCandidateIds,
          selectedTotalScoreMicros: resolved ? selectedCandidateIds.length * 900_000 : null,
          bestCompleted: {
            candidateIds: selectedCandidateIds,
            totalScoreMicros: resolved ? selectedCandidateIds.length * 900_000 : 0
          },
          runnerUpCompleted: null,
          optimisticOmitted: resolved
            ? null
            : {
                candidateIds: allCandidateIds,
                totalUpperBoundMicros: pairCount * 900_000,
                openCandidateIds: allCandidateIds,
                unresolvedCandidateIds: mode === "unresolved" ? allCandidateIds : [],
                blockedCandidateIds: mode === "resourceBlocked" ? allCandidateIds : []
              },
          nextRefinementCandidateIds: mode === "unresolved" ? allCandidateIds : [],
          deferredCandidateCount: 0,
          proof: {
            beatsRunnerUpWithMargin: resolved,
            beatsOptimisticOmittedWithMargin: resolved
          },
          search: {
            statesVisited: pairCount,
            expansionsConsidered: pairCount,
            intervalComparisons: pairCount
          }
        };
        receipt.receiptDigest = await createRuntimeDigest(
          "audio-alignment-v5/fine-frontier-receipt/v3",
          receipt
        );
        return receipt;
      };
      const createFineExecutionEvidence = async (
        currentIndex: number,
        timeMap: ReturnType<typeof createTimeMap>
      ) => {
        const createWindow = (startMs: number, endMs: number, effective: boolean) => {
          const expectedSampleCount = Math.ceil(((endMs - startMs) * 16_000) / 1_000);
          return {
            startMs,
            endMs,
            presentationOffsetMs: startMs,
            sampleRate: 16_000,
            expectedSampleCount,
            actualDecodedSampleCount: effective ? expectedSampleCount : null
          };
        };
        const coarseBackend = {
          backendId: "cuda-cufft-r2c-512-v1",
          requestedBackend: "auto",
          backendDetail: "E2E CUDA/cuFFT fixture",
          fallbackReason: null
        };
        // Keep this fixture aligned with deriveLockedFineSpectralBackendIdentity:
        // a CUDA fine pass must preserve the complete coarse execution identity.
        const fineBackend = { ...coarseBackend };
        const evidence = {
          candidateId: { pairOrdinal: currentIndex + 1, candidateOrdinal: 1 },
          selectedMemberRank: 1,
          groupMemberRanks: [1],
          sourceStreamIndex: 1,
          targetStreamIndex: 2,
          sourceCoarseBackend: coarseBackend,
          targetCoarseBackend: coarseBackend,
          sourceFineBackend: fineBackend,
          targetFineBackend: fineBackend,
          sourceRequestedWindow: createWindow(
            timeMap.sourceStartMs,
            timeMap.sourceEndMs,
            false
          ),
          targetRequestedWindow: createWindow(
            timeMap.targetStartMs,
            timeMap.targetEndMs,
            false
          ),
          sourceEffectiveWindow: createWindow(timeMap.sourceStartMs, timeMap.sourceEndMs, true),
          targetEffectiveWindow: createWindow(timeMap.targetStartMs, timeMap.targetEndMs, true),
          parametersHash: await createRuntimeDigest("audio-alignment-v5/fine-parameters/v1", {
            engineVersion: "alignment-v2.4",
            featureVersion: "chroma-v2",
            fineScoreVersion: "alignment-v2-coarse-upper-times-confidence-v1",
            legacyParametersHash: timeMap.parametersHash
          }),
          occupancyDigest: `sha256:${"7".repeat(64)}`,
          proposalTimeMapDigest: await createRuntimeDigest(
            "audio-alignment-v5/proposal-time-map/v1",
            timeMap
          ),
          scoreMicros: 900_000,
          evidenceDigest: ""
        };
        evidence.evidenceDigest = await createRuntimeDigest(
          "audio-alignment-v5/fine-execution-evidence/v2",
          evidence
        );
        return evidence;
      };

      const mockWindow = window as unknown as MockTauriWindow;
      let callbackIndex = 0;
      let eventListenerIndex = 0;
      let libraryProjectIndex = 0;
      let librarySessionIndex = 0;
      const projectLibrary = new Map<string, MockProjectLibraryRecord>();
      let mediaInventoryJobIndex = 0;
      const completedMediaInventoryJobs = new Map<string, Record<string, unknown>>();
      let batchJobIndex = 0;
      const completedBatchJobs = new Map<string, Record<string, unknown>>();
      mockWindow.isTauri = true;
      mockWindow.__C136_DIALOG_CALLS__ = [];
      mockWindow.__C137_VERIFICATION_CALLS__ = [];
      mockWindow.__C137_PERFORMANCE_CALLS__ = [];
      mockWindow.__C137_FINE_MODE__ = "resolved";

      const projectLibrarySummary = (project: MockProjectLibraryRecord) => ({
        libraryProjectId: project.libraryProjectId,
        displayName: project.displayName,
        projectSchemaVersion: project.projectSchemaVersion,
        headRevision: project.headRevision,
        stableRevision: project.stableRevision,
        createdAtUnixMs: project.createdAtUnixMs,
        updatedAtUnixMs: project.updatedAtUnixMs,
        lastOpenedAtUnixMs: project.lastOpenedAtUnixMs,
        hasRecovery: false
      });
      const storedProjectSnapshot = (
        project: MockProjectLibraryRecord,
        revision: MockProjectLibraryRevision
      ) => ({
        libraryProjectId: project.libraryProjectId,
        revision: revision.revision,
        displayName: revision.displayName,
        projectSchemaVersion: revision.projectSchemaVersion,
        savedAtUnixMs: revision.savedAtUnixMs,
        snapshotJson: revision.snapshotJson
      });
      const projectLibraryReply = (value: unknown) => ({
        contractVersion: 1,
        ok: true,
        value
      });

      const experimentQueues = new Map<string, string>();
      mockWindow.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: () => {
          callbackIndex += 1;
          return callbackIndex;
        },
        invoke: async (command, args = {}) => {
          await Promise.resolve();
          if (command === "load_alignment_experiment_queue_file")
            return experimentQueues.get(String(args.projectId)) ?? null;
          if (command === "save_alignment_experiment_queue_file") {
            experimentQueues.set(String(args.projectId), String(args.content));
            return null;
          }
          if (command === "clear_alignment_experiment_queue_file") {
            experimentQueues.delete(String(args.projectId));
            return null;
          }
          if (command === "plugin:event|listen") {
            eventListenerIndex += 1;
            return eventListenerIndex;
          }
          if (command === "plugin:event|unlisten") {
            return null;
          }
          if (command === "query_project_library") {
            const request = (args.request ?? {}) as {
              query?: {
                kind?: string;
                libraryProjectId?: string;
                revision?: number;
              };
            };
            const query = request.query;
            if (query?.kind === "recent") {
              return projectLibraryReply({
                kind: "recent",
                projects: Array.from(projectLibrary.values()).map(projectLibrarySummary),
                nextCursor: null
              });
            }
            if (query?.kind === "recoveries") {
              return projectLibraryReply({ kind: "recoveries", recoveries: [] });
            }
            const project = query?.libraryProjectId
              ? projectLibrary.get(query.libraryProjectId)
              : undefined;
            if (!project) throw new Error("E2E 项目库查询了不存在的项目。");
            if (query?.kind === "revisions") {
              return projectLibraryReply({
                kind: "revisions",
                project: projectLibrarySummary(project),
                revisions: [...project.revisions].reverse().map((revision) => ({
                  revision: revision.revision,
                  parentRevision: revision.parentRevision,
                  sourceRevision: revision.sourceRevision,
                  saveKind: revision.saveKind,
                  label: revision.label,
                  savedAtUnixMs: revision.savedAtUnixMs,
                  snapshotBytes: revision.snapshotBytes
                }))
              });
            }
            if (query?.kind === "revision") {
              const revision = project.revisions.find(
                (candidate) => candidate.revision === query.revision
              );
              if (!revision) throw new Error("E2E 项目库查询了不存在的修订。");
              return projectLibraryReply({
                kind: "revision",
                snapshot: storedProjectSnapshot(project, revision)
              });
            }
            throw new Error("E2E 项目库收到未知查询。");
          }
          if (command === "open_project_library_session") {
            const request = (args.request ?? {}) as {
              source?: {
                kind?: string;
                libraryProjectId?: string;
                displayName?: string;
                projectSchemaVersion?: number;
                snapshotJson?: string;
                expectedHeadRevision?: number;
              };
            };
            const source = request.source;
            let project: MockProjectLibraryRecord | undefined;
            if (
              source?.kind === "create" &&
              typeof source.displayName === "string" &&
              typeof source.projectSchemaVersion === "number" &&
              typeof source.snapshotJson === "string"
            ) {
              libraryProjectIndex += 1;
              const now = Date.now();
              const initialRevision: MockProjectLibraryRevision = {
                revision: 1,
                parentRevision: null,
                sourceRevision: null,
                saveKind: "create",
                label: null,
                savedAtUnixMs: now,
                snapshotBytes: new TextEncoder().encode(source.snapshotJson).byteLength,
                snapshotJson: source.snapshotJson,
                displayName: source.displayName,
                projectSchemaVersion: source.projectSchemaVersion
              };
              project = {
                libraryProjectId: `e2e-project-${libraryProjectIndex}`,
                displayName: source.displayName,
                projectSchemaVersion: source.projectSchemaVersion,
                headRevision: 1,
                stableRevision: 1,
                createdAtUnixMs: now,
                updatedAtUnixMs: now,
                lastOpenedAtUnixMs: now,
                sessionId: null,
                openedRevision: 1,
                revisions: [initialRevision]
              };
              projectLibrary.set(project.libraryProjectId, project);
            } else if (source?.kind === "head" && source.libraryProjectId) {
              project = projectLibrary.get(source.libraryProjectId);
              if (!project || project.headRevision !== source.expectedHeadRevision) {
                throw new Error("E2E 项目库打开 head 时修订不匹配。");
              }
            }
            if (!project) throw new Error("E2E 项目库收到未知打开来源。");
            librarySessionIndex += 1;
            project.sessionId = `e2e-session-${librarySessionIndex}`;
            project.openedRevision = project.headRevision;
            project.lastOpenedAtUnixMs = Date.now();
            const revision = project.revisions.find(
              (candidate) => candidate.revision === project?.headRevision
            );
            if (!revision) throw new Error("E2E 项目库缺少 head 快照。");
            return projectLibraryReply({
              project: projectLibrarySummary(project),
              session: {
                sessionId: project.sessionId,
                openedRevision: project.openedRevision,
                currentRevision: project.headRevision,
                stableRevision: project.stableRevision,
                openedAtUnixMs: project.lastOpenedAtUnixMs
              },
              snapshot: storedProjectSnapshot(project, revision)
            });
          }
          if (command === "commit_project_library_session") {
            const request = (args.request ?? {}) as {
              libraryProjectId?: string;
              sessionId?: string;
              expectedHeadRevision?: number;
              change?: {
                kind?: string;
                saveKind?: "autosave" | "checkpoint" | "rollback";
                sourceRevision?: number | null;
                label?: string | null;
                displayName?: string;
                projectSchemaVersion?: number;
                snapshotJson?: string;
              };
            };
            const project = request.libraryProjectId
              ? projectLibrary.get(request.libraryProjectId)
              : undefined;
            if (
              !project ||
              project.sessionId !== request.sessionId ||
              project.headRevision !== request.expectedHeadRevision
            ) {
              throw new Error("E2E 项目库提交的项目、会话或 head 不匹配。");
            }
            const now = Date.now();
            if (request.change?.kind === "close") {
              project.stableRevision = project.headRevision;
              project.sessionId = null;
              project.updatedAtUnixMs = now;
              return projectLibraryReply({
                disposition: "committed",
                libraryProjectId: project.libraryProjectId,
                sessionId: request.sessionId,
                headRevision: project.headRevision,
                stableRevision: project.stableRevision,
                occurredAtUnixMs: now,
                sessionClosed: true
              });
            }
            const change = request.change;
            if (
              change?.kind !== "save" ||
              !change.saveKind ||
              typeof change.displayName !== "string" ||
              typeof change.projectSchemaVersion !== "number" ||
              typeof change.snapshotJson !== "string"
            ) {
              throw new Error("E2E 项目库收到无效保存提交。");
            }
            const nextRevision = project.headRevision + 1;
            project.revisions.push({
              revision: nextRevision,
              parentRevision: project.headRevision,
              sourceRevision: change.sourceRevision ?? null,
              saveKind: change.saveKind,
              label: change.label ?? null,
              savedAtUnixMs: now,
              snapshotBytes: new TextEncoder().encode(change.snapshotJson).byteLength,
              snapshotJson: change.snapshotJson,
              displayName: change.displayName,
              projectSchemaVersion: change.projectSchemaVersion
            });
            project.headRevision = nextRevision;
            project.displayName = change.displayName;
            project.projectSchemaVersion = change.projectSchemaVersion;
            project.updatedAtUnixMs = now;
            if (change.saveKind !== "autosave") project.stableRevision = nextRevision;
            return projectLibraryReply({
              disposition: "committed",
              libraryProjectId: project.libraryProjectId,
              sessionId: request.sessionId,
              headRevision: project.headRevision,
              stableRevision: project.stableRevision,
              occurredAtUnixMs: now,
              sessionClosed: false
            });
          }
          if (command.includes("alignment_benchmark")) {
            mockWindow.__C137_PERFORMANCE_CALLS__.push(command);
          }
          if (command === "get_storage_status") {
            return { active: { exports: "C:/Studio/exports" }, error: null };
          }
          if (command === "load_app_settings_file") {
            return JSON.stringify({
              export: { defaultDirectory: "" },
              player: { mpvPath: "C:\\tools\\mpv.exe", preferredBackend: "nativeMpv" },
              emby: { serverUrl: "", pathPrefix: "/emby", username: "" },
              alignment: {
                ffmpegPath: "C:\\tools\\ffmpeg.exe",
                spectralBackend: "auto",
                windowMs: 1000,
                minGapMs: 3000,
                matchThreshold: 0.35
              }
            });
          }
          if (command === "save_app_settings_file" || command === "clear_app_settings_file") {
            return null;
          }
          if (command === "plugin:dialog|open") {
            const options = (args.options ?? {}) as { title?: string; multiple?: boolean };
            mockWindow.__C136_DIALOG_CALLS__.push({
              title: options.title ?? "",
              multiple: options.multiple === true
            });
            if (options.title === "选择原片素材") {
              return targetPaths;
            }
            if (options.title === "选择 B 站参考素材") {
              return sourcePaths;
            }
            if (options.title === "选择弹幕 XML") {
              return xmlPaths;
            }
            return null;
          }
          if (command === "import_bilibili_xml_files") {
            const request = (args.request ?? {}) as { paths?: string[] };
            if (
              request.paths?.length !== 1 ||
              request.paths[0]?.toLocaleLowerCase("en-US") !==
                xmlPaths[0]?.toLocaleLowerCase("en-US")
            ) {
              throw new Error("E2E 原生 XML 导入没有收到对话框选中的唯一文件。");
            }
            return {
              files: [
                {
                  fileName: "normal.xml",
                  receipt: {
                    domain: "danmaku-xml-content-receipt-v1",
                    version: 1,
                    receiptId: `xmlr-sha256:${"1".repeat(64)}`,
                    contentDigest: `sha256:${"2".repeat(64)}`,
                    sizeBytes: 287,
                    parserVersion: "bilibili-xml-native-v1",
                    inventoryDigest: `sha256:${"3".repeat(64)}`,
                    issuerKeyId: `install-sha256:${"4".repeat(32)}`,
                    signatureAlgorithm: "hmac-sha256-v1",
                    signature: "5".repeat(64)
                  },
                  items: [
                    {
                      originalIndex: 0,
                      sourceTimeMs: 1_500,
                      mode: 1,
                      fontSize: 25,
                      color: 16_777_215,
                      timestamp: 1_700_000_000,
                      pool: 0,
                      userHash: "userA",
                      rowId: "row1",
                      text: "第一条滚动弹幕",
                      rawPFields: [
                        "1.500",
                        "1",
                        "25",
                        "16777215",
                        "1700000000",
                        "0",
                        "userA",
                        "row1"
                      ]
                    },
                    {
                      originalIndex: 1,
                      sourceTimeMs: 3_250,
                      mode: 5,
                      fontSize: 30,
                      color: 65_280,
                      timestamp: 1_700_000_001,
                      pool: 0,
                      userHash: "userB",
                      rowId: "row2",
                      text: "顶部弹幕",
                      rawPFields: [
                        "3.250",
                        "5",
                        "30",
                        "65280",
                        "1700000001",
                        "0",
                        "userB",
                        "row2"
                      ]
                    },
                    {
                      originalIndex: 2,
                      sourceTimeMs: 5_000,
                      mode: 4,
                      fontSize: 28,
                      color: 255,
                      timestamp: 1_700_000_002,
                      pool: 0,
                      userHash: "userC",
                      rowId: "row3",
                      text: "底部弹幕",
                      rawPFields: [
                        "5.000",
                        "4",
                        "28",
                        "255",
                        "1700000002",
                        "0",
                        "userC",
                        "row3"
                      ]
                    }
                  ],
                  warnings: []
                }
              ]
            };
          }
          if (command === "start_media_inventory_job") {
            const request = (args.request ?? {}) as {
              items?: Array<{ itemId: string; path: string }>;
            };
            const items = request.items ?? [];
            mediaInventoryJobIndex += 1;
            const jobId = `media-inventory-job-${mediaInventoryJobIndex}`;
            const snapshot = {
              schemaVersion: 1,
              jobId,
              status: "completed",
              sequence: 1,
              cancelRequested: false,
              counts: {
                total: items.length,
                queued: 0,
                probing: 0,
                ready: items.length,
                failed: 0,
                cancelled: 0
              },
              items: items.map((item, ordinal) => ({
                ordinal,
                itemId: item.itemId,
                status: "ready",
                result: {
                  inventoryRevision: `inventory-v1:${(mediaInventoryJobIndex * 256 + ordinal)
                    .toString(16)
                    .padStart(16, "0")}`,
                  // The reference contains five consecutive episodes; E01 has a target-only second.
                  durationMs: item.path.includes("reference")
                    ? 300_000
                    : item.path.includes("E01")
                      ? 61_000
                      : 60_000,
                  audioTracks: [
                    {
                      index: 0,
                      codec: "aac",
                      language: "jpn",
                      title: "Main",
                      sampleRate: 48_000,
                      channels: 2,
                      channelLayout: "stereo",
                      durationMs: item.path.includes("reference")
                        ? 300_000
                        : item.path.includes("E01")
                          ? 61_000
                          : 60_000,
                      dispositions: {
                        default: true,
                        original: true,
                        dub: false,
                        commentary: false,
                        descriptions: false,
                        visualImpaired: false,
                        hearingImpaired: false,
                        cleanEffects: false,
                        karaoke: false
                      },
                      recommendationRank: 1,
                      reasonCodes: ["onlyNonSpecialTrack"]
                    }
                  ],
                  recommendation: {
                    state: "recommended",
                    streamIndex: 0,
                    reasonCodes: ["onlyNonSpecialTrack"]
                  },
                  probeCompleteness: "complete",
                  cacheState: "miss"
                },
                error: null
              })),
              terminalError: null
            };
            completedMediaInventoryJobs.set(jobId, snapshot);
            return snapshot;
          }
          if (command === "get_media_inventory_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedMediaInventoryJobs.get(jobId) ?? null;
          }
          if (command === "cancel_media_inventory_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedMediaInventoryJobs.get(jobId) ?? null;
          }
          if (command === "start_audio_alignment_batch_job") {
            const request = (args.request ?? {}) as {
              sources?: Array<{ mediaId: string }>;
              targets?: Array<{ mediaId: string }>;
              pairs?: Array<{ sourceMediaId: string; targetMediaId: string }>;
              versionReuseGroups?: Array<{
                groupId: string;
                side: "source" | "target";
                mediaIds: string[];
              }>;
            };
            const sources = request.sources ?? [];
            const targets = request.targets ?? [];
            const pairingMode = request.pairs === undefined ? "fullCartesian" : "explicit";
            const pairs =
              request.pairs ??
              sources.flatMap((source) =>
                targets.map((target) => ({
                  sourceMediaId: source.mediaId,
                  targetMediaId: target.mediaId
                }))
              );
            batchJobIndex += 1;
            const jobId = `c137-batch-job-${batchJobIndex}`;
            const fineMode = mockWindow.__C137_FINE_MODE__;
            const fineFrontier = await createFineFrontier(pairs.length, fineMode);
            const pairSnapshots = await Promise.all(
              pairs.map(async (pair, currentIndex) => {
                const timeMap = createTimeMap(currentIndex);
                const confidence =
                  fineMode === "secondAssignment"
                    ? currentIndex === 0
                      ? 0.99
                      : currentIndex === 1
                        ? 0.1
                        : 0.8
                    : 0.9;
                return {
                  pairIndex: currentIndex,
                  pairOrdinal: currentIndex + 1,
                  sourceMediaId: pair.sourceMediaId,
                  targetMediaId: pair.targetMediaId,
                  status: "completed",
                  progress: 1,
                  message: "已定位对应片段",
                  relationRanking: createRelationRanking(currentIndex),
                  globalSelection: createGlobalSelection(currentIndex),
                  fineFrontier,
                  fineExecutionEvidence: fineFrontier.selectedCandidateIds.some(
                    (candidateId) => candidateId.pairOrdinal === currentIndex + 1
                  )
                    ? await createFineExecutionEvidence(currentIndex, timeMap)
                    : null,
                  proposal: {
                    anchors: [
                      {
                        id: `anchor-${currentIndex + 1}`,
                        sourceMs: currentIndex * 60_000 + 5_000,
                        targetMs: 5_000,
                        confidence: 0.94,
                        origin: "automatic"
                      }
                    ],
                    cutCandidates: [],
                    confidence,
                    diagnostics: ["E2E 使用确定性桌面批任务结果；真实定位由 Rust 测试覆盖。"],
                    timeMap,
                    matchRange: {
                      sourceStartMs: currentIndex * 60_000,
                      sourceEndMs: (currentIndex + 1) * 60_000,
                      targetStartMs: 0,
                      targetEndMs: currentIndex === 0 ? 61_000 : 60_000,
                      coverage: currentIndex === 0 ? 0.72 : 0.96
                    }
                  },
                  error: null
                };
              })
            );
            const snapshot = {
              schemaVersion: 2,
              evidenceVersion: 5,
              jobId,
              pairingMode,
              sourceMediaIds: sources.map((media) => media.mediaId),
              targetMediaIds: targets.map((media) => media.mediaId),
              versionReuseGroups: (request.versionReuseGroups ?? []).map((group, index) => ({
                groupOrdinal: index + 1,
                ...group
              })),
              status: "completed",
              progress: 1,
              message: "批量分析完成",
              totalPairCount: pairs.length,
              processedPairCount: pairs.length,
              failedPairCount: 0,
              currentPairOrdinal: null,
              pairs: pairSnapshots,
              diagnosticEvents: [],
              error: null,
              updatedAtMs: Date.now()
            };
            completedBatchJobs.set(jobId, snapshot);
            return snapshot;
          }
          if (command === "get_audio_alignment_batch_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedBatchJobs.get(jobId) ?? null;
          }
          if (command === "cancel_audio_alignment_batch_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedBatchJobs.get(jobId) ?? null;
          }
          if (command === "detect_libmpv_runtime") {
            return {
              available: true,
              libraryPath: "C:\\C136\\libmpv-2.dll",
              clientApiVersion: "2.5",
              message: "E2E libmpv 运行库预检通过。"
            };
          }
          if (command === "create_libmpv_session") {
            throw new Error("E2E 未连接真实 libmpv 与真实媒体，播放证据不得成立。");
          }
          if (
            command === "issue_manual_time_map_verification" ||
            command === "verify_manual_time_map_verification" ||
            command === "revoke_manual_time_map_verification"
          ) {
            mockWindow.__C137_VERIFICATION_CALLS__.push(command);
            throw new Error(`E2E 不允许绕过人工复核门禁：${command}`);
          }
          throw new Error(`未处理的 Tauri E2E 命令：${command}`);
        }
      };
    },
    {
      sourcePaths: ["C:\\C136\\C136-reference.mkv"],
      targetPaths: Array.from({ length: 5 }, (_, index) => `C:\\C136\\C136-E0${index + 1}.mkv`),
      xmlPaths: ["C:\\C136\\normal.xml"]
    }
  );
});

test("多素材工作流覆盖四类判定、真实 A/B 失败与人工接管导出", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");

  await selectWorkspaceMenu(page, "添加素材", "批量导入原片素材");
  await expect(page.getByTestId("status-bar")).toContainText("已导入 5 个原片素材");
  await selectWorkspaceMenu(page, "添加素材", "批量导入 B 站参考素材");
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个B 站参考素材");
  await page.getByRole("tab", { name: /^原片 / }).click();
  await expect(page.getByText("C136-E01.mkv", { exact: true })).toBeVisible();
  await expect(page.getByText("C136-E05.mkv", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^参考 / }).click();
  await expect(page.getByText("C136-reference.mkv", { exact: true })).toBeVisible();

  await selectWorkspaceMenu(page, "添加素材", "导入 XML");
  await expect(page.getByTestId("status-bar")).toContainText(
    "已受验证导入 1 个 XML，共 3 条弹幕"
  );
  await page.getByTestId("asset-card").locator("summary").click();
  await expect(page.getByText("已受验证", { exact: true })).toBeVisible();

  const dialogCalls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __C136_DIALOG_CALLS__: MockDialogCall[];
        }
      ).__C136_DIALOG_CALLS__
  );
  expect(dialogCalls).toEqual([
    { title: "选择原片素材", multiple: true },
    { title: "选择 B 站参考素材", multiple: true },
    { title: "选择弹幕 XML", multiple: true }
  ]);

  await page.getByLabel("normal.xml 弹幕来源素材").selectOption({ label: "C136-reference" });
  await expect(page.getByTestId("status-bar")).toContainText("已绑定 XML 来源");
  await page.getByRole("tab", { name: /^原片 / }).click();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-materials-batch.png"),
    fullPage: true
  });

  await page.getByTestId("workspace-nav-matching").click();
  const matchingPanel = page.getByTestId("media-matching-panel");
  await expect(page.getByTestId("real-media-benchmark-panel")).toHaveCount(0);
  await expect(matchingPanel).toContainText("将分析 1 个参考 × 5 个原片，共 5 组");
  await matchingPanel.getByRole("button", { name: "开始批量匹配" }).click();
  await selectWorkspaceMenu(page, "匹配工具", "全部结果与已保存关系");
  await expect(page.getByTestId("media-match-candidate")).toHaveCount(5);
  await expect(page.getByTestId("status-bar")).toContainText("5 组可逐项确认");
  const firstCandidate = page.getByTestId("media-match-candidate").nth(0);
  await expect(firstCandidate).toContainText("C136-E01 ← C136-reference");
  await firstCandidate.getByRole("button", { name: "进入编辑工作台" }).click();
  const editor = page.getByTestId("alignment-editor-workspace");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("region", { name: "双轨差异编辑器" })).toBeVisible();
  await selectWorkspaceMenu(page, "关系工具", "关系详情与导出检查");
  await expect(page.getByRole("dialog", { name: "关系详情与导出检查" })).toContainText(
    "共同 1 · 参考独有 1 · 原片独有 1 · 待确认 1"
  );
  await page.getByRole("button", { name: "关闭关系详情与导出检查" }).click();

  await expect(editor).toContainText("第 4 / 4 段");
  await expect(editor.getByRole("button", { name: "需要确认", exact: true })).toBeVisible();
  await selectWorkspaceMenu(page, "需要确认", "版本不同");
  await expect(editor).toContainText("需要人工处理");
  await editor.getByRole("button", { name: "上一段" }).click();
  await expect(editor).toContainText("第 3 / 4 段");
  await expect(editor.getByRole("button", { name: "原片独有", exact: true })).toBeVisible();
  await selectWorkspaceMenu(page, /^标记(?:多出内容|参考多出|原片多出)$/, "标记原片多出");
  await editor.getByRole("button", { name: "上一段" }).click();
  await expect(editor).toContainText("第 2 / 4 段");
  await expect(editor.getByRole("button", { name: "参考独有", exact: true })).toBeVisible();
  await selectWorkspaceMenu(page, /^标记(?:多出内容|参考多出|原片多出)$/, "标记参考多出");
  await page.screenshot({
    path: resolve(screenshotDir, "c137-four-kind-review.png"),
    fullPage: true
  });

  await editor.getByRole("button", { name: "上一段" }).click();
  await expect(editor).toContainText("第 1 / 4 段");
  await expect(editor.getByRole("button", { name: "共同内容", exact: true })).toBeVisible();
  const playbackReview = editor.getByTestId("time-map-playback-review");
  await expect(
    playbackReview.getByRole("button", { name: "正在听原片 B", exact: true })
  ).toBeVisible();
  await expect(playbackReview.getByTestId("dual-video-viewers").locator("article")).toHaveCount(
    2
  );
  await expect(playbackReview.getByRole("button", { name: "播放当前段" })).toBeEnabled();
  await playbackReview.getByRole("button", { name: "播放当前段" }).click();
  await expect(playbackReview.getByRole("alert")).toContainText(
    "E2E 未连接真实 libmpv 与真实媒体，播放证据不得成立"
  );
  await playbackReview.getByRole("button", { name: "试听记录" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "试听记录" })
      .getByRole("button", { name: "记录本段已复核" })
  ).toBeDisabled();
  await page.getByRole("button", { name: "关闭试听记录" }).click();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-ab-review-fail-closed.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "采用当前结果并允许导出", exact: true }).click();
  await selectWorkspaceMenu(page, "关系工具", "关系详情与导出检查");
  await expect(page.getByRole("dialog", { name: "关系详情与导出检查" })).toContainText(
    "已采用用于播放"
  );
  await expect(page.getByRole("dialog", { name: "关系详情与导出检查" })).toContainText(
    "已允许导出"
  );
  await page.getByRole("button", { name: "关闭关系详情与导出检查" }).click();

  await page.getByRole("button", { name: "返回覆盖分析" }).click();
  await expect(page.getByRole("button", { name: "采用全部并导出" })).toBeEnabled();
  await page.getByRole("button", { name: "采用全部并导出" }).click();
  // This browser bridge deliberately has no real media authority; adoption remains saved.
  await expect(page.getByRole("button", { name: "采用全部并导出" })).toBeEnabled();
  await page.getByRole("tab", { name: "精确修正" }).click();
  await selectWorkspaceMenu(page, "关系工具", "关系详情与导出检查");
  const verification = page.getByTestId("manual-time-map-verification");
  await expect(verification).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-manual-signing-fail-closed.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "关闭关系详情与导出检查" }).click();
  await page.getByTestId("workspace-nav-matching").click();
  await selectWorkspaceMenu(page, "匹配工具", "全部结果与已保存关系");
  await expect(matchingPanel).toContainText("5 / 5 个原片已有可用关系");
  await expect(matchingPanel).toContainText("已保存 5 个");
  const confirmedRelations = page.getByTestId("confirmed-media-relations");
  await expect(confirmedRelations).toContainText("C136-E02");
  await expect(confirmedRelations).toContainText("C136-E05");

  const verificationCalls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __C137_VERIFICATION_CALLS__: string[];
        }
      ).__C137_VERIFICATION_CALLS__
  );
  expect(verificationCalls).toEqual([]);

  await page.getByRole("button", { name: "关闭全部结果与已保存关系" }).click();
  await page.getByTestId("workspace-nav-export").click();
  const projectionExport = page.getByRole("region", { name: "按原片分集导出" });
  await expect(
    projectionExport.getByRole("heading", { name: "导出", exact: true })
  ).toBeVisible();
  await expect(projectionExport).toContainText("可导出分集");
  await expect(projectionExport).toContainText("1 个");
  await expect(projectionExport).toContainText("C136-E05.xml");
  await projectionExport.getByRole("button", { name: /^检查详情/ }).click();
  await expect(
    page.getByRole("dialog", { name: "导出检查详情" }).getByText("查看未导出弹幕统计")
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭导出检查详情" }).click();
  const exportAllButton = projectionExport.getByRole("button", { name: "导出全部分集 XML" });
  // The native default is sufficient; an empty preference no longer blocks delivery.
  await expect(exportAllButton).toBeEnabled();
  await projectionExport.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-export-default-ready.png"),
    fullPage: true
  });
});

test("Evidence v5 未决、资源阻断与后端第二选择均失败关闭", async ({ page }) => {
  await page.goto("/");
  await selectWorkspaceMenu(page, "添加素材", "批量导入原片素材");
  await selectWorkspaceMenu(page, "添加素材", "批量导入 B 站参考素材");
  await selectWorkspaceMenu(page, "添加素材", "导入 XML");
  await page.getByLabel("normal.xml 弹幕来源素材").selectOption({ label: "C136-reference" });
  await page.getByTestId("workspace-nav-matching").click();
  const matchingPanel = page.getByTestId("media-matching-panel");

  await page.evaluate(() => {
    (
      window as unknown as {
        __C137_FINE_MODE__: "resolved" | "unresolved" | "resourceBlocked" | "secondAssignment";
      }
    ).__C137_FINE_MODE__ = "unresolved";
  });
  await matchingPanel.getByRole("button", { name: "开始批量匹配" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("0 组可逐项确认，5 组暂不可确认");
  await expect(page.getByTestId("media-match-candidate")).toHaveCount(0);
  await expect(
    matchingPanel
      .getByTestId("matching-task-queue")
      .getByText("发现 5 个接近位置，原生精匹配暂时不能唯一确定；本组不能确认。")
  ).toHaveCount(5);
  await page.getByRole("button", { name: "结果详情与运行记录", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "结果详情与运行记录" })).toContainText(
    "原生精匹配暂时不能唯一确定"
  );
  await page.getByRole("button", { name: "关闭结果详情与运行记录" }).click();
  await expect(matchingPanel.getByText("没有找到可信对应片段")).toHaveCount(0);

  await page.evaluate(() => {
    (
      window as unknown as {
        __C137_FINE_MODE__: "resolved" | "unresolved" | "resourceBlocked" | "secondAssignment";
      }
    ).__C137_FINE_MODE__ = "resourceBlocked";
  });
  await matchingPanel.getByRole("button", { name: "开始批量匹配" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("0 组可逐项确认，5 组未完成分析");
  await expect(page.getByTestId("media-match-candidate")).toHaveCount(0);
  await expect(
    matchingPanel.getByTestId("matching-task-queue").getByText(/这组没有完成分析：可用资源不足/)
  ).toHaveCount(5);
  await page.getByRole("button", { name: "结果详情与运行记录", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "结果详情与运行记录" })).toContainText(
    "可用资源不足"
  );
  await page.getByRole("button", { name: "关闭结果详情与运行记录" }).click();
  await expect(matchingPanel.getByText("没有找到可信对应片段")).toHaveCount(0);

  await page.evaluate(() => {
    (
      window as unknown as {
        __C137_FINE_MODE__: "resolved" | "unresolved" | "resourceBlocked" | "secondAssignment";
      }
    ).__C137_FINE_MODE__ = "secondAssignment";
  });
  await matchingPanel.getByRole("button", { name: "开始批量匹配" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("1 组可逐项确认，4 组暂不可确认");
  await selectWorkspaceMenu(page, "匹配工具", "全部结果与已保存关系");
  await expect(page.getByTestId("media-match-candidate")).toHaveCount(1);
  const selectedCard = page.getByTestId("media-match-candidate");
  await expect(selectedCard).toContainText("C136-E02 ← C136-reference");
  await selectedCard.getByText("匹配证据与诊断").click();
  await expect(selectedCard).toContainText("定位线索分数 10% · 不是校准概率");
});

test("B 站仅弹幕获取在后台完成并保留 P 时长导出", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await installBilibiliFixture(page);
  await selectWorkspaceMenu(page, "添加素材", "从 B 站获取");
  const dialog = page.getByRole("dialog", { name: "从 B 站获取素材" });
  await dialog.getByLabel("B 站视频链接或 BV / av 号").fill("BV1xx411c7mD");
  await dialog.getByRole("button", { name: "解析视频" }).click();
  await dialog.getByRole("checkbox", { name: /P2 第 2 段/ }).uncheck();
  await dialog.getByRole("radio", { name: /仅弹幕 XML/ }).check();
  await dialog.getByRole("button", { name: "选择文件夹" }).click();
  await dialog.getByRole("button", { name: "获取并加入素材（2 P）" }).click();
  await expect(dialog.getByLabel("B 站获取进度")).toContainText("正在获取 P1");
  await dialog.getByRole("button", { name: "关闭 B 站获取" }).click();
  await page.getByTestId("workspace-nav-export").click();
  await finishBilibiliFixture(page);
  await expect(page.getByTestId("status-bar")).toContainText("新增 2 个 XML");
  await page.getByTestId("workspace-nav-materials").click();
  await page.getByRole("button", { name: "开始编辑弹幕", exact: true }).click();
  await page.getByTestId("workspace-nav-export").click();
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __BILI_EXPORTS__: unknown[] }).__BILI_EXPORTS__.length
      )
    )
    .toBe(1);
  const exported = await page.evaluate(
    () =>
      (
        window as unknown as {
          __BILI_EXPORTS__: Array<{ directoryPath: string; contentBase64: string }>;
        }
      ).__BILI_EXPORTS__[0]
  );
  expect(exported.directoryPath).toBe("C:/Studio/exports");
  const xml = Buffer.from(exported.contentBase64, "base64").toString("utf8");
  const values = await page.evaluate((text) => {
    const document = new DOMParser().parseFromString(text, "text/xml");
    return Array.from(document.querySelectorAll("d"), (item) => ({
      text: item.textContent,
      seconds: Number(item.getAttribute("p")?.split(",")[0])
    }));
  }, xml);
  expect(values).toEqual([
    { text: "第1段弹幕", seconds: 10 },
    { text: "第3段弹幕", seconds: 65 }
  ]);
  await page.getByTestId("workspace-nav-materials").click();
  await selectWorkspaceMenu(page, "添加素材", "从 B 站获取");
  await expect(dialog).toContainText("已新增 2 个 XML");
  await dialog.getByRole("button", { name: "将已保存结果导入当前项目" }).click();
  await expect(dialog).toContainText("复用 2 个");
  await page.screenshot({
    path: testInfo.outputPath("bilibili-completed.png"),
    fullPage: true
  });
  const documentBounds = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewport: { width: innerWidth, height: innerHeight },
    overflow: Array.from(document.querySelectorAll("body *")).flatMap((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > innerHeight && getComputedStyle(node).position !== "fixed"
        ? [{ tag: node.tagName, className: node.className, bottom: rect.bottom }]
        : [];
    })
  }));
  expect(
    { width: documentBounds.width, height: documentBounds.height },
    JSON.stringify(documentBounds)
  ).toEqual(documentBounds.viewport);
});

test("B 站弹幕和参考音轨按非连续 P 自动配对", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await installBilibiliFixture(page);
  await selectWorkspaceMenu(page, "添加素材", "从 B 站获取");
  const dialog = page.getByRole("dialog", { name: "从 B 站获取素材" });
  await dialog
    .getByLabel("B 站视频链接或 BV / av 号")
    .fill("https://www.bilibili.com/video/BV1xx411c7mD?p=3");
  await dialog.getByRole("button", { name: "解析视频" }).click();
  await expect(dialog).toContainText("已选 1 / 3 P");
  await dialog.getByRole("checkbox", { name: /P1 第 1 段/ }).check();
  await dialog.getByRole("button", { name: "选择文件夹" }).click();
  await page.screenshot({
    path: testInfo.outputPath("bilibili-selection.png"),
    fullPage: true
  });
  await dialog.getByRole("button", { name: "获取并加入素材（2 P）" }).click();
  await expect(dialog.getByLabel("B 站获取进度")).toContainText("正在获取 P1");
  await finishBilibiliFixture(page);
  await expect(dialog).toContainText("2 个参考音轨，建立 2 个来源绑定");
  await dialog.getByRole("button", { name: "关闭 B 站获取" }).click();
  await expect(page.getByLabel("P1.xml 弹幕来源素材")).toHaveValue(
    "bilibili-reference-170001-101"
  );
  await expect(page.getByLabel("P3.xml 弹幕来源素材")).toHaveValue(
    "bilibili-reference-170001-103"
  );
  await page.getByLabel("撤销", { exact: true }).click();
  await expect(page.getByLabel("P1.xml 弹幕来源素材")).toHaveCount(0);
  await page.getByLabel("重做", { exact: true }).click();
  await expect(page.getByLabel("P1.xml 弹幕来源素材")).toHaveValue(
    "bilibili-reference-170001-101"
  );
});
