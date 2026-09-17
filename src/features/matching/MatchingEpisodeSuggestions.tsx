import { useState } from "react";
import { TextButton } from "../../components/TextButton";
import type { SmartBatchPairingPlan } from "../../domain/alignment/smartBatchPairing";
import type { ProjectMediaReference } from "../../domain/project/types";

export function MatchingEpisodeSuggestions({
  plan,
  sources,
  targets,
  disabled,
  draft,
  onDraftChange,
  onSave
}: {
  plan: SmartBatchPairingPlan;
  sources: readonly ProjectMediaReference[];
  targets: readonly ProjectMediaReference[];
  disabled: boolean;
  draft: { mediaId: string; text: string };
  onDraftChange: (draft: { mediaId: string; text: string }) => void;
  onSave: (mediaId: string, text: string) => boolean;
}) {
  const [message, setMessage] = useState("");
  const source = sources.find((item) => item.id === draft.mediaId) ?? sources[0];
  const text = source?.id === draft.mediaId ? draft.text : (source?.episodeKey ?? "");
  const sourceNames = new Map(sources.map((item) => [item.id, item.name]));
  return (
    <details className="mt-2" aria-label="分集匹配建议">
      <summary className="cursor-pointer">查看分集对应与修正编号</summary>
      <p className="my-2">
        只调整参考的分集提示和下次匹配范围，不改变已确认的时间关系或 XML 输出安排。
      </p>
      {targets.map((target) => {
        const pairs = plan.pairs.filter((pair) => pair.targetMediaId === target.id);
        return (
          <details key={target.id} className="my-2">
            <summary className="break-words cursor-pointer">
              {target.name} ← {pairs.length} 个参考
            </summary>
            <ul className="pl-4">
              {pairs.map((pair) => (
                <li key={pair.sourceMediaId} className="my-1 break-words">
                  {sourceNames.get(pair.sourceMediaId)} · {pair.reason}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      {plan.warnings.length > 0 && (
        <details className="my-2">
          <summary>待核对的编号（{plan.warnings.length}）</summary>
          {plan.warnings.map((warning, index) => (
            <p key={index} className="break-words">
              {warning}
            </p>
          ))}
        </details>
      )}
      {source && (
        <fieldset disabled={disabled} className="mt-3 grid gap-2">
          <label>
            修正参考
            <select
              aria-label="修正参考"
              className="w-full rounded border border-panel-line bg-panel p-2"
              value={source.id}
              onChange={(event) => {
                const media = sources.find((item) => item.id === event.target.value)!;
                onDraftChange({ mediaId: media.id, text: media.episodeKey ?? "" });
                setMessage("");
              }}
            >
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            参考集号
            <input
              aria-label="参考集号"
              className="w-full rounded border border-panel-line bg-panel p-2"
              value={text}
              placeholder="S01E01 或 S01E01-E03，留空恢复自动判断"
              onChange={(event) => {
                onDraftChange({ mediaId: source.id, text: event.target.value });
                setMessage("");
              }}
            />
          </label>
          <TextButton
            onClick={() =>
              setMessage(
                onSave(source.id, text)
                  ? "已应用参考集号，可撤销并随项目保存。"
                  : "未应用。请输入 S01E01、S01E01-E03 或第 1 集；留空恢复自动判断。"
              )
            }
          >
            应用参考集号
          </TextButton>
          {message && <p role="status">{message}</p>}
        </fieldset>
      )}
    </details>
  );
}
