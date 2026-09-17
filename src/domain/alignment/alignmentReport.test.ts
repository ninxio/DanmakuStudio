import { describe, expect, it } from "vitest";
import {
  createAlignmentApplyBlockers,
  createAlignmentReviewFocus,
  createAlignmentReviewItemStatuses,
  createAlignmentReviewQueue,
  createAlignmentReviewStatusSummary,
  createAlignmentReviewReport
} from "./alignmentReport";
import type { AlignmentProposal } from "./types";

describe("alignment review report", () => {
  it("生成包含锚点、版本差异区间和诊断信息的复核报告", () => {
    const proposal: AlignmentProposal = {
      anchors: [{ id: "anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断差异 1",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.72,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.82,
      diagnostics: ["音频特征匹配 4 / 4 帧。"],
      evidence: {
        algorithm: "time-map-audio",
        completeFingerprintCount: 10,
        sourceFingerprintCount: 8,
        fingerprintMatchCount: 8,
        monotonicMatchCount: 8,
        strongAnchorCount: 6,
        weakAnchorCount: 2,
        offsetClusterCount: 2,
        refinedCandidateCount: 1,
        lowConfidenceRegionCount: 0,
        quality: "medium",
        timeMappingSegmentCount: 2,
        confirmedChangeCount: 1,
        signals: [
          {
            kind: "audio",
            status: "used",
            label: "音频时间映射",
            observations: 8,
            weight: 1,
            note: "音频支持"
          },
          {
            kind: "visual",
            status: "used",
            label: "鲁棒视觉指纹",
            observations: 6,
            weight: 0.25,
            note: "视觉支持"
          }
        ]
      }
    };

    const report = createAlignmentReviewReport(proposal, new Date("2026-07-10T01:02:03.000Z"));

    expect(report).toContain("# 对齐提案复核报告");
    expect(report).toContain("生成时间：2026-07-10T01:02:03.000Z");
    expect(report).toContain("整体置信度：82.0%");
    expect(report).toContain("暂无应用阻断。");
    expect(report).toContain("## 复核队列");
    expect(report).toContain("优先复核 / 版本差异 / [audio-gap-1] 音频推断差异 1");
    expect(report).toContain("候选版本差异置信度 72.0%，建议核对边界和相差时长。");
    expect(report).toContain("待确认 / 锚点 / [anchor-1] anchor-1");
    expect(report).toContain("[anchor-1] 自动");
    expect(report).toContain("落点状态：待应用");
    expect(report).toContain("偏移：+00:00:20.000 (20000 ms)");
    expect(report).toContain("[audio-gap-1] 音频推断差异 1");
    expect(report).toContain("不确定区间：00:00:18.000 (18000 ms) - 00:00:22.000 (22000 ms)");
    expect(report).toContain("1 个候选版本差异置信度低于 75%");
    expect(report).toContain("音频特征匹配 4 / 4 帧。");
    expect(report).toContain("算法：音频时间映射");
    expect(report).toContain("鲁棒视觉指纹：已参与，观测 6，权重 25%");
    expect(createAlignmentReviewFocus(proposal)).toEqual([
      "1 个候选版本差异置信度低于 75%，建议人工确认边界和相差时长。",
      "1 个候选版本差异包含不确定区间，优先核对区间内的真实差异边界。"
    ]);
    expect(createAlignmentReviewQueue(proposal)).toMatchObject([
      {
        kind: "cutCandidate",
        id: "audio-gap-1",
        severity: "attention",
        reasons: [
          "候选版本差异置信度 72.0%，建议核对边界和相差时长。",
          "区间 00:00:18.000-00:00:22.000 内存在不确定边界，优先核对真实差异位置。"
        ]
      },
      {
        kind: "anchor",
        id: "anchor-1",
        severity: "pending",
        reasons: ["应用前抽查当前视频时间、完整版时间和偏移方向。"]
      }
    ]);
  });

  it("对空提案给出可复核的风险提示", () => {
    const report = createAlignmentReviewReport(
      {
        anchors: [],
        cutCandidates: [],
        confidence: 0,
        diagnostics: []
      },
      new Date("2026-07-10T01:02:03.000Z")
    );

    expect(report).toContain("提案没有同步锚点或候选版本差异");
    expect(report).toContain("没有诊断信息");
    expect(report).toContain("暂无同步锚点。");
    expect(report).toContain("暂无候选版本差异。");
  });

  it("识别会阻断应用的结构异常", () => {
    const proposal: AlignmentProposal = {
      anchors: [
        { id: "", sourceMs: 1000, targetMs: 1000, origin: "automatic" },
        { id: "anchor-dup", sourceMs: 2000, targetMs: 3000, origin: "automatic" },
        { id: "anchor-dup", sourceMs: 4000, targetMs: 5000, origin: "automatic" }
      ],
      cutCandidates: [
        {
          id: "range-reversed",
          name: "区间反向",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 22_000,
          sourceRangeEndMs: 18_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        },
        {
          id: "source-outside",
          name: "发生时间越界",
          sourceAtMs: 30_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        },
        {
          id: "source-outside",
          name: "重复 ID",
          sourceAtMs: 40_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: ["测试"]
    };

    expect(createAlignmentApplyBlockers(proposal)).toEqual([
      "1 个同步锚点缺少 ID，无法安全写入项目。",
      "1 个同步锚点 ID 在提案内重复（ID：anchor-dup），应用会丢失锚点。",
      "1 个候选版本差异 ID 在提案内重复（ID：source-outside），应用会丢失版本差异。",
      "1 个候选版本差异的不确定区间起止顺序异常，请修正后再应用。",
      "1 个候选版本差异的发生时间不在不确定区间内，请修正后再应用。"
    ]);
    const report = createAlignmentReviewReport(proposal, new Date("2026-07-10T01:02:03.000Z"));
    expect(report).toContain("先修阻断 / 锚点 / [未命名] 未命名锚点");
    expect(createAlignmentReviewQueue(proposal).every((item) => item.severity === "blocked")).toBe(true);
    expect(report).toContain("落点状态：阻断（缺少 ID）");
    expect(report).toContain("落点状态：阻断（提案内 ID 重复）");
    expect(report).toContain("落点状态：阻断（不确定区间起止异常）");
    expect(report).toContain("落点状态：阻断（提案内 ID 重复；发生时间不在不确定区间内）");
  });

  it("识别和当前项目已有 ID 冲突的提案", () => {
    const proposal: AlignmentProposal = {
      anchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "已有版本差异",
          sourceAtMs: 3000,
          targetGapMs: 1200,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: []
    };

    const context = {
      existingAnchorIds: ["anchor-existing"],
      existingCutMarkerIds: ["cut-existing"]
    };

    expect(createAlignmentApplyBlockers(proposal, context)).toEqual([
      "1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。",
      "1 个候选版本差异 ID 已存在于当前项目（ID：cut-existing），应用会丢失新的版本差异。"
    ]);
    const report = createAlignmentReviewReport(proposal, new Date("2026-07-10T01:02:03.000Z"), context);
    expect(report).toContain("## 应用阻断");
    expect(report).toContain("1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing）");
    expect(report).toContain("1 个候选版本差异 ID 已存在于当前项目（ID：cut-existing）");
  });

  it("阻断噪声过多的自动提案直接全量应用", () => {
    const proposal: AlignmentProposal = {
      anchors: Array.from({ length: 60 }, (_, index) => ({
        id: `anchor-${index}`,
        sourceMs: index * 1000,
        targetMs: index * 1000,
        origin: "automatic" as const,
        confidence: 0.8
      })),
      cutCandidates: Array.from({ length: 31 }, (_, index) => ({
        id: `cut-${index}`,
        name: `候选 ${index}`,
        sourceAtMs: index * 3000,
        targetGapMs: 3000,
        confidence: 0.8,
        note: ""
      })),
      confidence: 0.8,
      diagnostics: ["音频自动提案"]
    };

    expect(createAlignmentReviewFocus(proposal)[0]).toBe("本次提案包含 31 个候选版本差异，疑似音频噪声过多。");
    expect(createAlignmentApplyBlockers(proposal)).toEqual([
      "本次提案包含 31 个候选版本差异，疑似音频噪声过多。 请先逐条接受可信候选，或提高窗口/匹配阈值后重新运行。"
    ]);
  });

  it("已有 ID 的等价落点不会阻断应用，时间不同才阻断", () => {
    const equivalentProposal: AlignmentProposal = {
      anchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "已有版本差异",
          sourceAtMs: 3000,
          targetGapMs: 1200,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: []
    };
    const conflictProposal: AlignmentProposal = {
      anchors: [{ id: "anchor-existing", sourceMs: 1200, targetMs: 2400, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "同 ID 不同版本差异",
          sourceAtMs: 3000,
          targetGapMs: 2400,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: []
    };
    const context = {
      existingAnchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "manual" as const }],
      existingCutMarkers: [{ id: "cut-existing", name: "已有版本差异", sourceAtMs: 3000, targetGapMs: 1200, note: "" }]
    };

    expect(createAlignmentApplyBlockers(equivalentProposal, context)).toEqual([]);
    expect(createAlignmentApplyBlockers(conflictProposal, context)).toEqual([
      "1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。",
      "1 个候选版本差异 ID 已存在于当前项目（ID：cut-existing），应用会丢失新的版本差异。"
    ]);
    const equivalentReport = createAlignmentReviewReport(
      equivalentProposal,
      new Date("2026-07-10T01:02:03.000Z"),
      context
    );
    const conflictReport = createAlignmentReviewReport(
      conflictProposal,
      new Date("2026-07-10T01:02:03.000Z"),
      context
    );
    expect(equivalentReport).toContain("落点状态：已落点（当前项目已有等价锚点）");
    expect(equivalentReport).toContain("落点状态：已落点（当前项目已有等价版本差异）");
    expect(conflictReport).toContain("落点状态：阻断（当前项目已有同 ID 锚点）");
    expect(conflictReport).toContain("落点状态：阻断（当前项目已有同 ID 版本差异）");
    expect(createAlignmentReviewItemStatuses(equivalentProposal, context)).toMatchObject([
      {
        kind: "anchor",
        id: "anchor-existing",
        state: "applied",
        statusText: "已落点（当前项目已有等价锚点）",
        blockReasons: []
      },
      {
        kind: "cutCandidate",
        id: "cut-existing",
        state: "applied",
        statusText: "已落点（当前项目已有等价版本差异）",
        blockReasons: []
      }
    ]);
    expect(createAlignmentReviewItemStatuses(conflictProposal, context)).toMatchObject([
      {
        kind: "anchor",
        id: "anchor-existing",
        state: "blocked",
        statusText: "阻断（当前项目已有同 ID 锚点）",
        blockReasons: ["当前项目已有同 ID 锚点"]
      },
      {
        kind: "cutCandidate",
        id: "cut-existing",
        state: "blocked",
        statusText: "阻断（当前项目已有同 ID 版本差异）",
        blockReasons: ["当前项目已有同 ID 版本差异"]
      }
    ]);
    expect(createAlignmentReviewStatusSummary(createAlignmentReviewItemStatuses(conflictProposal, context))).toEqual({
      totalCount: 2,
      pendingCount: 0,
      appliedCount: 0,
      blockedCount: 2
    });
  });
});
