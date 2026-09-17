import { describe, expect, it } from "vitest";
import {
  evaluateRealMediaBenchmark,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkPrediction
} from "../../domain/alignment/realMediaBenchmark";
import { createSyntheticManifestDigest } from "../../domain/alignment/syntheticAlignmentLabQueue";
import type { SyntheticAlignmentRunReport } from "./syntheticAlignmentRunner";
import {
  SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_ENTRIES,
  addSyntheticAlignmentRunReport,
  createEmptySyntheticAlignmentReportArchive,
  parseSyntheticAlignmentReportArchiveJson,
  serializeSyntheticAlignmentReportArchive
} from "./syntheticAlignmentReportArchive";

describe("程序化详细报告档案", () => {
  it("以内容摘要保存、重复运行去重并稳定恢复", () => {
    const report = createReport("archive-a");
    let archive = addSyntheticAlignmentRunReport(null, report, 10);
    const reportId = archive.entries[0].reportId;
    archive = addSyntheticAlignmentRunReport(archive, report, 20);

    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0]).toMatchObject({ reportId, savedAtMs: 20 });
    expect(parseSyntheticAlignmentReportArchiveJson(
      serializeSyntheticAlignmentReportArchive(archive)
    )).toEqual(archive);
  });

  it("保留最近 16 份不同报告并淘汰最旧内容", () => {
    let archive = createEmptySyntheticAlignmentReportArchive(0);
    for (let index = 0; index < SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_ENTRIES + 2; index += 1) {
      archive = addSyntheticAlignmentRunReport(archive, createReport(`archive-${index}`), index + 1);
    }

    expect(archive.entries).toHaveLength(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_ENTRIES);
    expect(archive.entries[0].report.manifestId).toBe("archive-17");
    expect(archive.entries.at(-1)?.report.manifestId).toBe("archive-2");
  });

  it("拒绝内容摘要篡改、未知字段和伪造发布资格", () => {
    const archive = addSyntheticAlignmentRunReport(null, createReport("archive-tamper"), 10);
    const tampered = structuredClone(archive) as unknown as Record<string, unknown>;
    const entries = tampered.entries as Array<Record<string, unknown>>;
    const report = entries[0].report as SyntheticAlignmentRunReport;
    report.configuration.matchThreshold = 0.2;
    expect(() => parseSyntheticAlignmentReportArchiveJson(JSON.stringify(tampered))).toThrow(
      "reportId 摘要不匹配"
    );
    expect(() =>
      parseSyntheticAlignmentReportArchiveJson(JSON.stringify({ ...archive, extra: true }))
    ).toThrow("未知字段");
    expect(() =>
      parseSyntheticAlignmentReportArchiveJson(
        JSON.stringify({ ...archive, releaseEligible: true })
      )
    ).toThrow("开发证据边界");
  });
});

function createReport(id: string): SyntheticAlignmentRunReport {
  const manifest = createManifest(id);
  const predictions: RealMediaBenchmarkPrediction[] = [{
    caseId: `${id}-case`,
    spans: [{
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 0,
      targetEndMs: 10_000
    }]
  }];
  return {
    schemaVersion: "alignment-synthetic-run-report-v2",
    manifestId: id,
    datasetVersion: `${id}-v1`,
    manifestDigest: createSyntheticManifestDigest(manifest),
    status: "completed",
    startedAtMs: 1,
    completedAtMs: 2,
    configuration: {
      spectralBackend: "cpu",
      windowMs: 8_000,
      minGapMs: 1_000,
      matchThreshold: 0.7,
      enableVisualEvidence: false,
      localizationMode: true
    },
    caseReceipts: [{
      caseId: `${id}-case`,
      state: "completed",
      nativeJobId: "job-1",
      proposalAvailable: true,
      qualityLevel: "review",
      engineVersion: "alignment-v2-test",
      featureVersion: "spectral-test",
      parametersHash: "sha256:test",
      failureCode: null
    }],
    predictions,
    result: evaluateRealMediaBenchmark(manifest, predictions),
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold"
  };
}

function createManifest(id: string): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    datasetVersion: `${id}-v1`,
    description: "development",
    isExample: false,
    licenseNotes: ["Authorized."],
    cases: [{
      id: `${id}-case`,
      title: id,
      mediaKind: "synthetic",
      split: "development",
      scenarios: ["codec-variant"],
      source: media(`C:/private/${id}-source.flac`),
      target: media(`C:/private/${id}-target.flac`),
      boundaryToleranceMs: 300,
      versionNotes: ["Known transform."],
      licenseNotes: ["Authorized."],
      independentAnnotations: [],
      adjudication: null,
      gold: {
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000,
        matchedAnchors: [{ id: "anchor", sourceMs: 5_000, targetMs: 5_000 }],
        sourceOnlySpans: [],
        targetOnlySpans: [],
        ambiguousSpans: []
      }
    }]
  };
}

function media(path: string) {
  return {
    path,
    audioStreamIndex: 0,
    videoStreamIndex: null,
    contentIdentity: null,
    versionNote: "16 kHz mono",
    licenseNote: "Authorized."
  };
}
