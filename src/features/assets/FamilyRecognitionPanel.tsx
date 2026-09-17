import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import { createFamilyArrangement } from "../../domain/project/familyArrangement";
import type {
  FamilyNumberingMode,
  MediaFamilyAnalysis
} from "../../domain/project/mediaFamilyTypes";

const labels: Record<FamilyNumberingMode, string> = {
  auto: "自动判断",
  episodePart: "集号 · 片段（1.2 = 第 1 集第 2 段）",
  seasonEpisode: "季号 · 集号（1.2 = 第 1 季第 2 集）",
  episodeRange: "集范围（1-3 = 第 1 至 3 集）",
  episode: "单个数字是集号"
};

export function FamilyRecognitionPanel({
  analysis,
  compact,
  onNumberingChange,
  onApply
}: {
  analysis: MediaFamilyAnalysis;
  compact: boolean;
  onNumberingChange: (source: string, mode: FamilyNumberingMode) => void;
  onApply: () => void;
}) {
  const [selectedSource, setSelectedSource] = useState("");
  const suggestion =
    analysis.numberingSuggestions.find((item) => item.sourceGroupKey === selectedSource) ??
    analysis.numberingSuggestions[0];
  const preview = useMemo(() => {
    const draft = createFamilyArrangement(analysis, "episodeParts");
    const groups = new Map<string, { label: string; count: number; duration: number | null }>();
    for (const row of draft.rows) {
      const key = row.episodeKey ?? row.id;
      const group = groups.get(key) ?? { label: row.episodeLabel, count: 0, duration: 0 };
      group.count++;
      group.duration =
        group.duration !== null && row.sourceOutMs !== null
          ? group.duration + row.sourceOutMs - row.sourceInMs
          : null;
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [analysis]);
  const recognized = analysis.files.filter((file) => file.episodeIdentity).length;
  const unknown = analysis.files.length - recognized;
  const caution = analysis.issues.filter((issue) =>
    [
      "missingParts",
      "missingEpisodes",
      "overlappingEpisodes",
      "duplicatePart",
      "conflictingIdentity",
      "parallelVersions",
      "crossSeasonRange"
    ].includes(issue.code)
  );
  return (
    <section className="family-recognition" aria-label="分集识别建议">
      <div className="family-recognition-heading">
        <div>
          <h3>
            <Sparkles size={17} />
            {recognized ? `建议整理为 ${preview.length} 个输出` : "先确认编号的含义"}
          </h3>
          <p>
            {recognized} / {analysis.files.length} 个文件已识别季集
            {unknown > 0 ? `，${unknown} 个待确认` : ""}。应用后仍可改顺序、区间和归属。
          </p>
        </div>
        <TextButton tone="primary" disabled={!recognized} onClick={onApply}>
          应用识别建议（{preview.length} 个输出）
        </TextButton>
      </div>
      <details open={!compact} key={compact ? "compact" : "expanded"}>
        <summary>查看依据、切换数字含义与预览</summary>
        {suggestion && (
          <div className="family-numbering">
            {analysis.numberingSuggestions.length > 1 && (
              <label>
                来源
                <select
                  aria-label="选择编号来源"
                  value={suggestion.sourceGroupKey}
                  onChange={(event) => setSelectedSource(event.target.value)}
                >
                  {analysis.numberingSuggestions.map((item) => (
                    <option key={item.sourceGroupKey} value={item.sourceGroupKey}>
                      {item.sourceLabel} · {item.fileCount} 个文件
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              数字含义
              <select
                aria-label="数字含义"
                value={suggestion.selectedMode}
                onChange={(event) =>
                  onNumberingChange(
                    suggestion.sourceGroupKey,
                    event.target.value as FamilyNumberingMode
                  )
                }
              >
                {suggestion.modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {labels[mode]}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {suggestion.reasons.join(" ") || "季、集、片段分别记录；只生成可修改的安排。"}
            </p>
          </div>
        )}
        {recognized > 0 && (
          <p className="family-recognition-preview" aria-label="识别预览">
            {preview.slice(0, 8).map((group, index) => (
              <span key={index}>
                {group.label}{" "}
                <b>
                  {group.count} 段
                  {group.duration !== null
                    ? ` · ${Math.floor(group.duration / 60000)} 分 ${Math.floor(group.duration / 1000) % 60} 秒`
                    : " · 时长待补"}
                </b>
              </span>
            ))}
            {preview.length > 8 && <span>另有 {preview.length - 8} 个输出</span>}
          </p>
        )}
        {caution.length > 0 && (
          <details className="family-recognition-cautions">
            <summary>有 {caution.length} 处需要留意：缺片、重复或编号冲突</summary>
            {[...new Set(caution.map((issue) => issue.message))].map((message) => (
              <p key={message}>{message}</p>
            ))}
          </details>
        )}
        <p className="text-xs text-content-subtle">
          来源名称和编号只能解释结构，无法判断广告、审核删减或正片起点。播放时长用于顺接，内容区间可在下方调整。
        </p>
      </details>
    </section>
  );
}
