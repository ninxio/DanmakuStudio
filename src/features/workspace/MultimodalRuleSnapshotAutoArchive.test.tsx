import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import type { EditorProject, MediaTimeMap } from "../../domain/project/types";
import { ensureDesktopMultimodalRuleSnapshot } from "../../infrastructure/alignment/multimodalRuleSnapshotArchiveStore";
import { MultimodalRuleSnapshotAutoArchive } from "./MultimodalRuleSnapshotAutoArchive";

vi.mock("../../infrastructure/alignment/multimodalRuleSnapshotArchiveStore", () => ({
  ensureDesktopMultimodalRuleSnapshot: vi.fn(() => Promise.resolve({
    archive: {
      schemaVersion: "alignment-multimodal-rule-snapshot-archive-v1",
      updatedAtMs: 1,
      entries: [],
      containsSensitiveMediaDigests: true,
      permission: "local-multimodal-rule-snapshot-archive-only",
      releaseEligible: false
    },
    desktopPersisted: true,
    added: true
  }))
}));

const ensureArchiveMock = vi.mocked(ensureDesktopMultimodalRuleSnapshot);

describe("应用级视觉对照规则自动归档", () => {
  beforeEach(() => {
    ensureArchiveMock.mockClear();
  });

  it("无需进入匹配页也会归档，并对相同规则保持幂等", async () => {
    const empty = createEmptyProject("auto-archive");
    const { rerender } = render(
      <MultimodalRuleSnapshotAutoArchive project={empty} />
    );
    expect(ensureArchiveMock).not.toHaveBeenCalled();

    const eligible = createEligibleProject(0);
    rerender(<MultimodalRuleSnapshotAutoArchive project={eligible} />);
    await waitFor(() => expect(ensureArchiveMock).toHaveBeenCalledTimes(1));

    rerender(
      <MultimodalRuleSnapshotAutoArchive project={{ ...eligible }} />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ensureArchiveMock).toHaveBeenCalledTimes(1);

    rerender(
      <MultimodalRuleSnapshotAutoArchive project={createEligibleProject(1)} />
    );
    await waitFor(() => expect(ensureArchiveMock).toHaveBeenCalledTimes(2));
  });

  it("后台写入失败时记录非阻断诊断且不修改 TimeMap", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ensureArchiveMock.mockRejectedValueOnce(new Error("磁盘只读"));
    const project = createEligibleProject(0);
    const original = structuredClone(project.mediaTimeMaps);
    render(<MultimodalRuleSnapshotAutoArchive project={project} />);

    await waitFor(() => expect(warning).toHaveBeenCalledWith(
      "视觉对照规则自动归档失败；核心匹配结果不受影响。",
      expect.objectContaining({ message: "磁盘只读" })
    ));
    expect(project.mediaTimeMaps).toEqual(original);
    warning.mockRestore();
  });
});

function createEligibleProject(targetOffsetMs: number): EditorProject {
  const project = createEmptyProject("auto-archive");
  project.mediaTimeMaps = [createTimeMap(targetOffsetMs)];
  return project;
}

function createTimeMap(targetOffsetMs: number): MediaTimeMap {
  return {
    id: `map-${targetOffsetMs}`,
    revision: 1,
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: identity("a"),
    targetIdentity: identity("b"),
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: targetOffsetMs,
    targetEndMs: 10_000 + targetOffsetMs,
    spans: [{
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: targetOffsetMs,
      targetEndMs: 10_000 + targetOffsetMs
    }],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 10,
      p95ResidualMs: 20,
      maxResidualMs: 30,
      boundaryUncertaintyMs: 40,
      alternativeMargin: 0.2,
      anchorCount: 3,
      heldOutAnchorCount: 1,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 3,
      visualAnchorCount: 0,
      heldOutAnchorCount: 1,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    state: "candidate",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    confirmedAt: null
  };
}

function identity(digit: string) {
  return {
    algorithm: "sha256-full-file-v2" as const,
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: digit.repeat(64),
    lastSampleDigest: digit.repeat(64)
  };
}
