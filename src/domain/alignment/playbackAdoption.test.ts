import { describe, expect, it } from "vitest";
import { createPlaybackCoverageProject } from "../../test/playbackCoverage";
import {
  adoptProjectMatches,
  currentCandidateMap,
  isPlaybackAdopted
} from "./playbackAdoption";
import { acceptMediaMatchCandidateWithManualTakeover } from "./mediaMatching";
import { projectDanmakuToTargets } from "../timeline/sourceProjection";
import { parseProjectJson, serializeProject } from "../project/schema";
import { analyzeMatchCoverage } from "./matchCoverage";
import { reviewCandidateTimeMapSpan } from "./timeMapReviewDecision";

describe("use matches before detailed review", () => {
  it("retains uncertain two-sided comments that the old blanket replacement discarded", () => {
    const project = createPlaybackCoverageProject([1]);
    const original = serializeProject(project);
    const old = acceptMediaMatchCandidateWithManualTakeover(project, "candidate-1", [
      "asset-1"
    ]);
    expect(projectDanmakuToTargets(old).projectedItemCount).toBe(1);
    const result = adoptProjectMatches(project);
    expect(result.issues).toEqual([]);
    expect(projectDanmakuToTargets(result.project)).toMatchObject({
      status: "readyWithWarnings",
      projectedItemCount: 2,
      unexpectedUnmappedItemCount: 1
    });
    const map = currentCandidateMap(result.project, result.project.mediaMatchCandidates[0])!;
    expect(isPlaybackAdopted(map)).toBe(true);
    expect(map.quality.level).not.toBe("verified");
    expect(result.project.alignmentReviewRecords).toEqual([]);
    expect(
      result.project.mediaTimeMaps.find((map) => map.id.endsWith(":before-playback"))?.spans[1]
        .kind
    ).toBe("ambiguous");
    expect(serializeProject(project)).toBe(original);
  });
  it("adopts a batch in one result, round-trips and remains idempotent", () => {
    const result = adoptProjectMatches(createPlaybackCoverageProject());
    expect(result.adoptedCount).toBe(4);
    const restored = parseProjectJson(serializeProject(result.project));
    expect(adoptProjectMatches(restored).project).toBe(restored);
    expect(projectDanmakuToTargets(restored).projectedItemCount).toBe(8);
  });
  it("keeps a real manual replacement decision", () => {
    const project = createPlaybackCoverageProject([1]);
    const reviewed = reviewCandidateTimeMapSpan(
      project,
      project.mediaMatchCandidates[0].timeMapId,
      1,
      "replacement",
      "2026-09-14T00:00:00.000Z"
    );
    expect(
      projectDanmakuToTargets(adoptProjectMatches(reviewed).project).projectedItemCount
    ).toBe(1);
  });
  it("does not turn a user's unresolved label into a decision to discard comments", () => {
    const project = createPlaybackCoverageProject([1]);
    const undecided = reviewCandidateTimeMapSpan(
      project,
      project.mediaMatchCandidates[0].timeMapId,
      1,
      "unresolved",
      "2026-09-14T00:00:00.000Z"
    );
    expect(
      projectDanmakuToTargets(adoptProjectMatches(undecided).project).projectedItemCount
    ).toBe(2);
  });
  it("refuses missing identities and invalid structure without losing the candidate", () => {
    const project = createPlaybackCoverageProject([1]);
    project.mediaTimeMaps[0].sourceIdentity = null;
    const result = adoptProjectMatches(project);
    expect(result.issues).toHaveLength(1);
    expect(result.project).toBe(project);
    project.mediaTimeMaps[0].spans[0].sourceEndMs = -1;
    expect(adoptProjectMatches(project).project).toBe(project);
  });
  it("measures union coverage, keeps missing references and never counts a gap as coverage", () => {
    const project = createPlaybackCoverageProject([2]);
    project.mediaMatchCandidates = project.mediaMatchCandidates.slice(0, 1);
    const report = analyzeMatchCoverage(project);
    expect(report.episodes[0].coveredMs).toBe(60000);
    expect(report.episodes[0].gaps).toEqual([
      { startMs: 0, endMs: 10000 },
      { startMs: 70000, endMs: 120000 }
    ]);
    expect(report.unlocated).toHaveLength(1);
    expect(report.retainedCount).toBe(4);
    expect(analyzeMatchCoverage(createPlaybackCoverageProject([2])).episodes[0].coveredMs).toBe(
      60000
    );
  });
});
