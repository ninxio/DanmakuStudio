import type { SuspectedCutCandidate } from "../danmaku/cutHints";
import type { DanmakuAsset } from "../danmaku/types";
import type { AlignmentEvidenceSignalSummary, AlignmentProposal, CutCandidate } from "./types";

export interface DanmakuEvidenceInput {
  assets: DanmakuAsset[];
  suspectedCutCandidates: SuspectedCutCandidate[];
  toleranceMs?: number;
}

const DEFAULT_DANMAKU_EVIDENCE_TOLERANCE_MS = 45_000;
const DANMAKU_EVIDENCE_WEIGHT = 0.2;

export function augmentAlignmentProposalWithDanmakuEvidence(
  proposal: AlignmentProposal,
  input: DanmakuEvidenceInput
): AlignmentProposal {
  const itemCount = input.assets.reduce((total, asset) => total + asset.items.length, 0);
  const toleranceMs = Math.max(1, Math.round(input.toleranceMs ?? DEFAULT_DANMAKU_EVIDENCE_TOLERANCE_MS));
  if (itemCount === 0) {
    return replaceDanmakuSignal(proposal, {
      kind: "danmaku",
      status: "notConfigured",
      label: "弹幕文本线索",
      observations: 0,
      weight: 0,
      note: "当前项目没有可扫描的 XML 弹幕，弹幕线索未参与。"
    });
  }

  const matches = proposal.cutCandidates.flatMap((candidate) =>
    findSupportingDanmakuHints(candidate, input.suspectedCutCandidates, toleranceMs).map((hint) => ({
      candidate,
      hint
    }))
  );
  const supportedCandidateIds = new Set(matches.map((match) => match.candidate.id));
  const cutCandidates = proposal.cutCandidates.map((candidate) => {
    if (!supportedCandidateIds.has(candidate.id)) {
      return candidate;
    }
    return {
      ...candidate,
      confidence: Math.min(0.98, candidate.confidence + 0.03),
      note: appendDanmakuEvidenceNote(candidate.note)
    };
  });
  const signal: AlignmentEvidenceSignalSummary = {
    kind: "danmaku",
    status: "used",
    label: "弹幕文本线索",
    observations: input.suspectedCutCandidates.length,
    weight: DANMAKU_EVIDENCE_WEIGHT,
    note:
      matches.length > 0
        ? `已扫描 ${itemCount.toLocaleString("zh-CN")} 条弹幕，${matches.length} 个文本聚类与候选版本差异相邻。`
        : `已扫描 ${itemCount.toLocaleString("zh-CN")} 条弹幕，未发现与候选版本差异相邻的文本聚类。`
  };
  return replaceDanmakuSignal(
    {
      ...proposal,
      cutCandidates,
      diagnostics: [
        ...proposal.diagnostics,
        matches.length > 0
          ? `弹幕证据：${matches.length} 个文本聚类支持 ${supportedCandidateIds.size} 个候选版本差异。`
          : "弹幕证据：未发现与候选版本差异相邻的文本聚类。"
      ]
    },
    signal
  );
}

function findSupportingDanmakuHints(
  candidate: CutCandidate,
  suspectedCutCandidates: SuspectedCutCandidate[],
  toleranceMs: number
): SuspectedCutCandidate[] {
  return suspectedCutCandidates.filter((hint) => Math.abs(hint.sourceAtMs - candidate.sourceAtMs) <= toleranceMs);
}

function appendDanmakuEvidenceNote(note: string): string {
  const addition = "弹幕文本线索与该候选时间相邻，建议复核时优先查看这一区间。";
  return note.includes(addition) ? note : `${note.trim()} ${addition}`.trim();
}

function replaceDanmakuSignal(proposal: AlignmentProposal, signal: AlignmentEvidenceSignalSummary): AlignmentProposal {
  if (!proposal.evidence) {
    return proposal;
  }
  const signals = proposal.evidence.signals?.filter((item) => item.kind !== "danmaku") ?? [];
  return {
    ...proposal,
    evidence: {
      ...proposal.evidence,
      signals: [...signals, signal]
    }
  };
}
