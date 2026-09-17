import { useEffect, useMemo, useState } from "react";
import { Plus, ArrowRight, Copy, ArrowUp, ArrowDown } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import { analyzeMediaFamily } from "../../domain/project/mediaFamily";
import {
  buildFamilyArrangementExport,
  createFamilyArrangement
} from "../../domain/project/familyArrangement";
import type {
  FamilyArrangement,
  FamilyArrangementRow,
  FamilyWorkflowIntent
} from "../../domain/project/mediaFamilyTypes";
import { createId } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { FamilyRecognitionPanel } from "./FamilyRecognitionPanel";
import { FamilyGroupNavigation } from "./FamilyGroupNavigation";
import type { FamilyNumberingMode } from "../../domain/project/mediaFamilyTypes";

const choices: Array<{ value: FamilyWorkflowIntent; label: string; description: string }> = [
  {
    value: "episodeParts",
    label: "按识别结果分集",
    description: "同集的多个片段放在一起；分集范围先保留完整来源。"
  },
  {
    value: "movieParts",
    label: "分 P 合成正片",
    description: "按来源版本分别整理为一部正片，片段顺序和区间仍可修改。"
  },
  {
    value: "episodes",
    label: "每个文件独立",
    description: "每个文件单独输出，适合每 P 一集或并列的不同版本。"
  },
  {
    value: "longCollection",
    label: "长视频拆分 / 自定义",
    description: "同一个来源可添加多个窗口，分别送到不同集，也可排除片头干扰。"
  }
];

export function MediaFamilyWorkbench() {
  const id = useEditorStore((state) => state.project.id);
  const epoch = useEditorStore((state) => state.projectEpoch);
  return <FamilySession key={`${id}:${epoch}`} />;
}

function FamilySession() {
  const project = useEditorStore((state) => state.project);
  const save = useEditorStore((state) => state.saveFamilyArrangement);
  const rename = useEditorStore((state) => state.renameProject);
  const go = useEditorStore((state) => state.setWorkspacePage);
  const { assets: familyAssets, mediaLibrary, danmakuSourceBindings } = project;
  const [numbering, setNumbering] = useState<Record<string, FamilyNumberingMode>>({});
  const analysis = useMemo(
    () =>
      analyzeMediaFamily(
        { assets: familyAssets, mediaLibrary, danmakuSourceBindings },
        { numberingBySource: numbering }
      ),
    [familyAssets, mediaLibrary, danmakuSourceBindings, numbering]
  );
  const [draft, setDraft] = useState<FamilyArrangement | null>(null);
  const [previousDraft, setPreviousDraft] = useState<FamilyArrangement | null>(null);
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const ids = new Set(familyAssets.map((asset) => asset.id));
    setDraft((current) =>
      current && current.rows.some((row) => !ids.has(row.assetId))
        ? { ...current, rows: current.rows.filter((row) => ids.has(row.assetId)) }
        : current
    );
  }, [familyAssets]);
  const arrangement = draft ?? project.familyArrangement;
  const plan = useMemo(
    () => (arrangement ? buildFamilyArrangementExport(project, arrangement) : null),
    [project, arrangement]
  );
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const groups = arrangement
    ? [
        ...new Map(
          arrangement.rows.map((row) => [row.episodeKey ?? row.id, row.episodeLabel])
        ).entries()
      ]
    : [];
  const activeKey = groups.some(([key]) => key === selectedGroup)
    ? selectedGroup
    : groups[0]?.[0];
  const visible =
    arrangement?.rows.filter((row) => (row.episodeKey ?? row.id) === activeKey) ?? [];
  const modify = (id: string, patch: Partial<FamilyArrangementRow>) => {
    if (!arrangement) return;
    const owner = arrangement.rows.find((row) => row.id === id);
    setDraft({
      ...arrangement,
      rows: arrangement.rows.map((row) =>
        row.id === id
          ? { ...row, ...patch }
          : patch.episodeLabel !== undefined &&
              patch.episodeKey === undefined &&
              row.episodeKey === owner?.episodeKey
            ? { ...row, episodeLabel: patch.episodeLabel }
            : row
      )
    });
  };
  const create = (workflow: FamilyWorkflowIntent) => {
    setPreviousDraft(arrangement ?? null);
    setDraft(createFamilyArrangement(analysis, workflow));
    setSelectedGroup("");
    setNotice("已生成可编辑安排，检查后保存。原 XML 保持不变。");
  };
  const saveDraft = () => {
    if (!arrangement) return false;
    const success = save({ ...arrangement, title: name.trim() || project.name });
    if (success) {
      rename(name);
      setDraft(null);
      setNotice("分集安排已保存。你可以继续微调，或前往导出。");
    }
    return success;
  };
  const move = (id: string, delta: number) => {
    if (!arrangement) return;
    const rows = [...arrangement.rows];
    const index = rows.findIndex((row) => row.id === id);
    const targetId = visible[visible.findIndex((row) => row.id === id) + delta]?.id;
    const other = rows.findIndex((row) => row.id === targetId);
    if (index < 0 || other < 0) return;
    [rows[index], rows[other]] = [rows[other], rows[index]];
    setDraft({ ...arrangement, rows });
  };
  if (!project.assets.length)
    return <p className="page-empty">导入一批弹幕后，在这里识别家族、整理分集和来源区间。</p>;
  return (
    <section className="family-workbench" aria-label="智能分集安排">
      <details
        className="family-overview"
        open={!arrangement}
        key={arrangement ? "arranged" : "intro"}
      >
        <summary>
          项目名称与来源 · {analysis.files.length} 个文件 ·{" "}
          {new Set(analysis.files.map((file) => file.sourceGroupKey)).size} 个来源
        </summary>
        <label className="family-project-name">
          项目名称
          <input
            aria-label="项目名称"
            value={name}
            maxLength={180}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => rename(name)}
            list="family-title-candidates"
          />
        </label>
        <datalist id="family-title-candidates">
          {analysis.titleCandidates.map((candidate) => (
            <option key={candidate.title} value={candidate.title} />
          ))}
        </datalist>
      </details>
      <FamilyRecognitionPanel
        analysis={analysis}
        compact={Boolean(arrangement)}
        onNumberingChange={(source, mode) =>
          setNumbering((current) => ({ ...current, [source]: mode }))
        }
        onApply={() => create("episodeParts")}
      />
      {!arrangement ? (
        <div className="family-choices">
          {choices.map((choice) => (
            <button key={choice.value} type="button" onClick={() => create(choice.value)}>
              <span>
                {choice.label}
                <ArrowRight size={16} />
              </span>
              <small>{choice.description}</small>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="family-actions">
            <label>
              重新安排{" "}
              <select
                aria-label="重新安排方式"
                value=""
                onChange={(event) => {
                  if (event.target.value) create(event.target.value as FamilyWorkflowIntent);
                }}
              >
                <option value="">选择其他方式…</option>
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <TextButton
              onClick={() => {
                const included = new Set(arrangement.rows.map((row) => row.assetId));
                const additions = createFamilyArrangement(
                  analysis,
                  arrangement.workflow
                ).rows.filter((row) => !included.has(row.assetId));
                setDraft({ ...arrangement, rows: [...arrangement.rows, ...additions] });
                setNotice(
                  additions.length
                    ? `已追加 ${additions.length} 个新文件，已有安排未改动。`
                    : "所有文件都已在安排中。"
                );
              }}
            >
              <Plus size={14} />
              追加新导入文件
            </TextButton>
            <TextButton tone="primary" onClick={saveDraft}>
              保存安排
            </TextButton>
            {previousDraft && (
              <TextButton
                onClick={() => {
                  setDraft(previousDraft);
                  setPreviousDraft(null);
                  setNotice("已恢复重新识别前的安排。");
                }}
              >
                恢复上次安排
              </TextButton>
            )}
            <TextButton
              onClick={() => {
                if (saveDraft()) go("export");
              }}
            >
              保存并去导出 <ArrowRight size={14} />
            </TextButton>
          </div>
          <FamilyGroupNavigation
            groups={groups}
            activeKey={activeKey}
            onSelect={setSelectedGroup}
            counts={arrangement.rows.reduce((counts, row) => {
              const key = row.episodeKey ?? row.id;
              counts.set(key, (counts.get(key) ?? 0) + 1);
              return counts;
            }, new Map<string, number>())}
          />
          <p className="text-xs text-content-muted">
            各片段默认顺接。结束未知时，请填准确结束时间或下一段的输出起点；输入单位为秒。只保留正片时，可从任意时间开始。
          </p>
          <div className="family-rows">
            {visible.map((row, index) => (
              <article key={row.id} className="family-row" data-disabled={!row.enabled}>
                <div className="family-row-heading">
                  <label>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(event) => modify(row.id, { enabled: event.target.checked })}
                      aria-label={`启用 ${assets.get(row.assetId)?.fileName ?? row.id}`}
                    />
                    <span title={assets.get(row.assetId)?.fileName}>
                      {assets.get(row.assetId)?.fileName ?? "文件已移除"}
                    </span>
                  </label>
                  <div className="flex gap-1">
                    <TextButton
                      aria-label={`上移片段 ${index + 1}`}
                      disabled={index === 0}
                      onClick={() => move(row.id, -1)}
                    >
                      <ArrowUp size={13} />
                    </TextButton>
                    <TextButton
                      aria-label={`下移片段 ${index + 1}`}
                      disabled={index === visible.length - 1}
                      onClick={() => move(row.id, 1)}
                    >
                      <ArrowDown size={13} />
                    </TextButton>
                  </div>
                </div>
                <div className="family-row-fields">
                  <label>
                    输出名称
                    <input
                      aria-label={`片段 ${index + 1} 输出名称`}
                      value={row.episodeLabel}
                      onChange={(event) => modify(row.id, { episodeLabel: event.target.value })}
                    />
                  </label>
                  <label>
                    归到其他集
                    <select
                      aria-label={`片段 ${index + 1} 分组`}
                      value={row.episodeKey ?? row.id}
                      onChange={(event) =>
                        modify(row.id, {
                          episodeKey: event.target.value,
                          episodeLabel:
                            groups.find(([key]) => key === event.target.value)?.[1] ??
                            row.episodeLabel
                        })
                      }
                    >
                      {groups.map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TimeInput
                    label={`片段 ${index + 1} 来源开始`}
                    caption="来源开始"
                    value={row.sourceInMs}
                    onChange={(value) => modify(row.id, { sourceInMs: value ?? 0 })}
                  />
                  <TimeInput
                    label={`片段 ${index + 1} 来源结束`}
                    caption="来源结束"
                    value={row.sourceOutMs}
                    onChange={(value) => modify(row.id, { sourceOutMs: value })}
                    placeholder="未知 / 到文件末尾"
                  />
                  <TimeInput
                    label={`片段 ${index + 1} 输出起点`}
                    caption="输出起点"
                    value={row.targetStartMs}
                    onChange={(value) => modify(row.id, { targetStartMs: value })}
                    placeholder="接在前段之后"
                  />
                </div>
                <div className="family-row-footer">
                  <span>{assets.get(row.assetId)?.items.length ?? 0} 条弹幕</span>
                  <TextButton
                    onClick={() => {
                      const clone: FamilyArrangementRow = {
                        ...row,
                        id: createId("family"),
                        episodeKey: createId("episode"),
                        episodeLabel: `${row.episodeLabel}（新窗口）`,
                        sourceInMs: row.sourceOutMs ?? row.sourceInMs,
                        sourceOutMs: null,
                        targetStartMs: 0
                      };
                      const rows = [...arrangement.rows];
                      rows.splice(rows.findIndex((item) => item.id === row.id) + 1, 0, clone);
                      setDraft({ ...arrangement, rows });
                      setSelectedGroup(clone.episodeKey!);
                    }}
                  >
                    <Copy size={13} />
                    从此文件拆出另一集
                  </TextButton>
                </div>
                {plan?.issues
                  .filter((issue) => issue.rowId === row.id)
                  .map((issue, i) => (
                    <p
                      key={i}
                      className={
                        issue.severity === "error"
                          ? "text-feedback-warning"
                          : "text-content-muted"
                      }
                    >
                      {issue.message}
                    </p>
                  ))}
              </article>
            ))}
          </div>
        </>
      )}
      {notice ? (
        <p role="status" className="text-feedback-success">
          {notice}
        </p>
      ) : null}
      <details className="family-evidence">
        <summary>识别依据与不确定之处</summary>
        <ul>
          {[...new Set(analysis.issues.map((issue) => issue.message))].map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs">
          名称只能帮助组织素材。删减、插入、片头干扰和准确切点需要媒体匹配或你的确认。
        </p>
      </details>
    </section>
  );
}

function TimeInput({
  label,
  caption,
  value,
  onChange,
  placeholder
}: {
  label: string;
  caption: string;
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
}) {
  return (
    <label>
      {caption}
      <input
        type="number"
        min="0"
        step="0.001"
        aria-label={label}
        value={value === null ? "" : value / 1000}
        placeholder={placeholder}
        onChange={(event) => {
          const n = event.target.valueAsNumber;
          onChange(Number.isFinite(n) ? Math.round(n * 1000) : null);
        }}
      />
    </label>
  );
}
