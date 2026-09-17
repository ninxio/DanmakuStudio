import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import nativeFixture from "../../test/fixtures/visual-aap-proposal.json";
import { createEmptyProject } from "../../domain/project/factory";
import {
  createDanmakuSourceBinding,
  createLocalPathMediaReference
} from "../../domain/project/mediaLibrary";
import {
  acceptMediaMatchCandidateWithManualTakeover,
  createMediaMatchCandidate,
  upsertMediaMatchCandidate
} from "../../domain/alignment/mediaMatching";
import { assessManualMediaTimeMapVerificationEligibility } from "../../domain/alignment/mediaTimeMap";
import { parseProjectJson, serializeProject } from "../../domain/project/schema";
import { isAlignmentProposal } from "../../domain/alignment/manualProvider";
import { compileTimeMap } from "../../domain/alignment/timeMap";
import { parseBilibiliXml, serializeBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import {
  startTauriAudioAlignmentJob,
  type AudioAlignmentJobSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { useEditorStore } from "../../stores/editorStore";
import { VisualAapMatchingPanel } from "./VisualAapMatchingPanel";
import type * as AudioAlignmentModule from "../../infrastructure/alignment/tauriAudioAlignment";

vi.mock("../../infrastructure/alignment/tauriAudioAlignment", async (importOriginal) => ({
  ...(await importOriginal<typeof AudioAlignmentModule>()),
  startTauriAudioAlignmentJob: vi.fn(),
  cancelTauriAudioAlignmentJob: vi.fn(),
  getTauriAudioAlignmentJob: vi.fn()
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

function fixture() {
  const value: unknown = structuredClone(nativeFixture);
  if (!isAlignmentProposal(value))
    throw new Error("The actual native AAP fixture violates the frontend proposal contract");
  return value;
}

it("projects only matched comments and reparses the exported XML using the actual native result", () => {
  const proposal = fixture();
  const map = compileTimeMap(proposal.timeMap!.spans);
  const asset = parseBilibiliXml(
    '<i><d p="5,1,25,16777215,0,0,test,1">before</d><d p="12,1,25,16777215,0,0,test,2">filler</d><d p="16,1,25,16777215,0,0,test,3">after insert</d><d p="22,1,25,16777215,0,0,test,4">after cut</d></i>',
    { fileName: "synthetic.xml" }
  );
  const entries = asset.items.flatMap((item) => {
    const point = map.mapSourceTime(item.sourceTimeMs);
    return point.status === "mapped" ? [{ item, finalTimeMs: point.targetTimeMs }] : [];
  });
  const exported = parseBilibiliXml(serializeBilibiliXml(entries).xml, {
    fileName: "export.xml"
  });
  expect(exported.items.map((item) => [item.text, item.sourceTimeMs])).toEqual([
    ["before", 5000],
    ["after insert", 12000],
    ["after cut", 20000]
  ]);
  expect(map.mapSourceTime(12000).status).toBe("ambiguous");
});

it("runs silent-video matching without audio preparation and saves a reloadable candidate", async () => {
  const project = createEmptyProject("Synthetic AAP");
  project.mediaLibrary = [
    createLocalPathMediaReference(
      "source",
      "bilibiliReference",
      "C:/synthetic/reference.mp4",
      26000
    ),
    createLocalPathMediaReference(
      "target",
      "targetOriginal",
      "C:/synthetic/original.mkv",
      24000
    )
  ];
  useEditorStore.setState({ project, mediaInventoryRows: {}, mediaInventoryPhase: "idle" });
  const snapshot: AudioAlignmentJobSnapshot = {
    jobId: "visual-test",
    status: "completed",
    progress: 1,
    message: "complete",
    stageKey: "completed",
    stageLabel: "已完成",
    stageIndex: 9,
    stageCount: 9,
    stageProgress: 1,
    logs: [],
    proposal: fixture(),
    error: null,
    updatedAtMs: 1
  };
  vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue(snapshot);
  render(<VisualAapMatchingPanel project={project} onBusyChange={() => undefined} />);
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "开始画面匹配" }));
  await waitFor(() =>
    expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(1)
  );
  expect(startTauriAudioAlignmentJob).toHaveBeenCalledWith(
    expect.objectContaining({ algorithm: "visual-aap", spectralBackend: "cpu" })
  );
  const restored = parseProjectJson(serializeProject(useEditorStore.getState().project));
  expect(restored.mediaMatchCandidates[0]?.proposal.timeMap?.engineVersion).toBe(
    "visual-aap-v1"
  );
  expect(restored.mediaMatchCandidates[0]?.state).not.toBe("accepted");
});

it("allows explicit review of an actual AAP result through the existing native verification preflight", () => {
  let project = createEmptyProject("AAP manual review");
  project.mediaLibrary = [
    createLocalPathMediaReference(
      "source",
      "bilibiliReference",
      "C:/synthetic/reference.mp4",
      26000
    ),
    createLocalPathMediaReference(
      "target",
      "targetOriginal",
      "C:/synthetic/original.mkv",
      24000
    )
  ];
  const asset = parseBilibiliXml('<i><d p="5,1,25,16777215,0,0,test,1">comment</d></i>', {
    fileName: "synthetic.xml"
  });
  project.assets = [asset];
  project.danmakuSourceBindings = [createDanmakuSourceBinding("binding", asset.id, "source")];
  const candidate = createMediaMatchCandidate(project, {
    id: "aap",
    batchId: "batch",
    sourceMediaId: "source",
    targetMediaId: "target",
    proposal: fixture()
  });
  project = upsertMediaMatchCandidate(project, candidate);
  project = acceptMediaMatchCandidateWithManualTakeover(project, candidate.id, [asset.id]);
  const confirmedMap = project.mediaTimeMaps.find((map) => map.state === "confirmed");
  expect(confirmedMap).toBeDefined();
  expect(
    assessManualMediaTimeMapVerificationEligibility(confirmedMap!, {
      calibrationArtifactId: "manual-takeover-ui",
      calibrationArtifactVersion: "1",
      verifier: "user",
      verifiedAt: "2026-09-18T00:00:00.000Z"
    })
  ).toEqual({ eligible: true, reason: null });
});
