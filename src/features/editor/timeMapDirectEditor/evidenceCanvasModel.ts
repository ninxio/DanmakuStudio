import { designTokenColor } from "../../../components/designTokens";
import type { AlignmentEvidenceProfile } from "../../../domain/alignment/types";

type EvidenceSample = AlignmentEvidenceProfile["samples"][number];

export function drawTimeMapEvidenceCanvas(
  canvas: HTMLCanvasElement,
  samples: AlignmentEvidenceProfile["samples"],
  rangeStartMs: number,
  rangeEndMs: number
) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width || 800));
  const height = Math.max(1, Math.round(bounds.height || 28));
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = designTokenColor("surface-canvas");
  context.fillRect(0, 0, width, height);
  const durationMs = Math.max(1, rangeEndMs - rangeStartMs);
  const offsetLaneHeight = Math.min(14, Math.max(9, height * 0.24));
  const riskBaseline = height - offsetLaneHeight - 1;
  context.fillStyle = designTokenColor("surface-inset");
  context.fillRect(0, riskBaseline, width, offsetLaneHeight + 1);
  context.strokeStyle = designTokenColor("content-subtle", 0.32);
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, riskBaseline + 0.5);
  context.lineTo(width, riskBaseline + 0.5);
  context.stroke();
  samples.forEach((sample) => {
    const x = ((sample.startMs - rangeStartMs) / durationMs) * width;
    const sampleWidth = Math.max(1, ((sample.endMs - sample.startMs) / durationMs) * width);
    const risk = sample.differenceRisk ?? evidenceDifferenceRisk(sample.state, sample.strength);
    const information = sample.informativeness ?? (sample.state === "noEvidence" ? 0 : 0.55);
    const mountainHeight = Math.max(2, risk * Math.max(2, riskBaseline - 3));
    const y = riskBaseline - mountainHeight;
    context.fillStyle = heatmapColor(sample, information);
    context.fillRect(x, y, sampleWidth + 0.75, mountainHeight);
    if (information < 0.16) {
      context.strokeStyle = designTokenColor("content-muted", 0.22);
      context.lineWidth = 1;
      for (let hatchX = x - height; hatchX < x + sampleWidth + height; hatchX += 6) {
        context.beginPath();
        context.moveTo(hatchX, riskBaseline);
        context.lineTo(hatchX + mountainHeight, y);
        context.stroke();
      }
    }
  });
  const denseSamples = samples.filter((sample) => sample.matchProbability !== undefined);
  if (denseSamples.length >= 2) {
    context.strokeStyle = designTokenColor("evidence-supported", 0.9);
    context.lineWidth = 1.25;
    context.beginPath();
    denseSamples.forEach((sample, index) => {
      const centerMs = (sample.startMs + sample.endMs) / 2;
      const x = ((centerMs - rangeStartMs) / durationMs) * width;
      const y = riskBaseline - (sample.matchProbability ?? 0) * Math.max(2, riskBaseline - 4);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  const offsetSamples = samples.filter((sample) => effectiveOffsetMs(sample) !== null);
  if (offsetSamples.length < 2) return;
  const offsets = offsetSamples.map((sample) => effectiveOffsetMs(sample) ?? 0);
  const minOffset = Math.min(...offsets);
  const maxOffset = Math.max(...offsets);
  const offsetRange = Math.max(1, maxOffset - minOffset);
  context.strokeStyle = designTokenColor("content-secondary", 0.9);
  context.lineWidth = 1.5;
  context.beginPath();
  offsetSamples.forEach((sample, index) => {
    const centerMs = (sample.startMs + sample.endMs) / 2;
    const x = ((centerMs - rangeStartMs) / durationMs) * width;
    const y =
      height -
      2 -
      (((effectiveOffsetMs(sample) ?? 0) - minOffset) / offsetRange) * (offsetLaneHeight - 4);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      const previous = offsetSamples[index - 1];
      const previousCenterMs = (previous.startMs + previous.endMs) / 2;
      const previousX = ((previousCenterMs - rangeStartMs) / durationMs) * width;
      const previousY =
        height -
        2 -
        (((effectiveOffsetMs(previous) ?? 0) - minOffset) / offsetRange) *
          (offsetLaneHeight - 4);
      const stepX = (previousX + x) / 2;
      context.lineTo(stepX, previousY);
      context.lineTo(stepX, y);
      context.lineTo(x, y);
    }
  });
  context.stroke();
  offsetSamples.forEach((sample) => {
    if (sample.visualRecoveryState !== "recovered") return;
    const centerMs = (sample.startMs + sample.endMs) / 2;
    const x = ((centerMs - rangeStartMs) / durationMs) * width;
    context.fillStyle = designTokenColor("evidence-recovered", 0.98);
    context.beginPath();
    context.moveTo(x, riskBaseline + 1);
    context.lineTo(x + 3.5, riskBaseline + 4.5);
    context.lineTo(x, riskBaseline + 8);
    context.lineTo(x - 3.5, riskBaseline + 4.5);
    context.closePath();
    context.fill();
  });
}

export function evidenceSampleSummary(sample: EvidenceSample) {
  const match = Math.round((sample.matchProbability ?? sample.strength) * 100);
  const risk = Math.round(
    (sample.differenceRisk ?? evidenceDifferenceRisk(sample.state, sample.strength)) * 100
  );
  if ((sample.informativeness ?? 1) < 0.16 || sample.dominantState === "uncertain") {
    return "这一段证据较少，建议试听确认";
  }
  if (sample.dominantState === "sourceOnly" || sample.state === "sourceOnly") {
    return "参考可能多出内容 · 风险 " + risk + "%";
  }
  if (sample.dominantState === "targetOnly" || sample.state === "targetOnly") {
    return "原片可能多出内容 · 风险 " + risk + "%";
  }
  if (sample.dominantState === "replacement" || sample.state === "conflicting") {
    return "两侧内容可能冲突或被替换 · 风险 " + risk + "%";
  }
  return "共同内容趋势 " + match + "%";
}

export function effectiveOffsetMs(sample: EvidenceSample) {
  return sample.visualRecoveryState === "recovered" && sample.visualOffsetMs !== undefined
    ? sample.visualOffsetMs
    : sample.offsetMs;
}

function heatmapColor(sample: EvidenceSample, information: number) {
  const alpha = (0.28 + Math.max(0, Math.min(1, information)) * 0.66).toFixed(3);
  const dominant = sample.dominantState;
  if (dominant === "matched" || (!dominant && sample.state === "supported")) {
    return designTokenColor("evidence-supported", Number(alpha));
  }
  if (dominant === "sourceOnly" || sample.state === "sourceOnly") {
    return designTokenColor("evidence-source-only", Number(alpha));
  }
  if (dominant === "targetOnly" || sample.state === "targetOnly") {
    return designTokenColor("evidence-target-only", Number(alpha));
  }
  if (dominant === "replacement" || sample.state === "conflicting") {
    return designTokenColor("evidence-replacement", Number(alpha));
  }
  return designTokenColor("content-subtle", Number(alpha));
}

export function evidenceDifferenceRisk(state: EvidenceSample["state"], strength: number) {
  if (state === "sourceOnly" || state === "targetOnly" || state === "conflicting") return 0.9;
  if (state === "weak") return 0.45;
  if (state === "noEvidence") return 0.22;
  return Math.max(0.04, 1 - strength);
}
