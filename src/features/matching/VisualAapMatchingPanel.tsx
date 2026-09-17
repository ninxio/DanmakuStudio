import { useEffect, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import { createMediaMatchCandidate } from "../../domain/alignment/mediaMatching";
import { createId } from "../../domain/project/factory";
import type { EditorProject } from "../../domain/project/types";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentJob
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";
import { MediaChoiceList } from "./MatchingTaskPanels";

export function VisualAapMatchingPanel({
  project,
  onBusyChange
}: {
  project: EditorProject;
  onBusyChange: (busy: boolean) => void;
}) {
  const [sources, setSources] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(
    "选择本地参考视频和目标原片。只有 XML 或音频时，请使用音频匹配或手动编辑。"
  );
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const control = useRef({
    cancelled: false,
    mounted: true,
    jobId: null as string | null,
    active: false
  });
  const epoch = useEditorStore((s) => s.projectEpoch);
  useEffect(() => {
    const task = control.current;
    task.mounted = true;
    return () => {
      task.mounted = false;
      task.cancelled = true;
      if (task.jobId) void cancelTauriAudioAlignmentJob(task.jobId).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    setSources([]);
    setTargets([]);
    control.current.cancelled = true;
    if (control.current.jobId)
      void cancelTauriAudioAlignmentJob(control.current.jobId).catch(() => undefined);
  }, [project.id, epoch]);
  const pairCount = sources.length * targets.length;
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
  const run = async () => {
    const task = control.current;
    if (task.active || task.jobId) return;
    const state = useEditorStore.getState();
    const runEpoch = state.projectEpoch;
    const runProject = state.project;
    const pairs = sources.flatMap((sourceId) =>
      targets.map((targetId) => ({ sourceId, targetId }))
    );
    if (!pairs.length || pairs.length > 64) return;
    const active = () =>
      task.mounted &&
      !task.cancelled &&
      useEditorStore.getState().project.id === runProject.id &&
      useEditorStore.getState().projectEpoch === runEpoch;
    task.active = true;
    task.cancelled = false;
    setRunning(true);
    onBusyChange(true);
    setError(null);
    setProgress(0);
    const batchId = createId("aap_batch");
    let completed = 0;
    try {
      for (const pair of pairs) {
        if (!active()) break;
        const source = runProject.mediaLibrary.find((m) => m.id === pair.sourceId);
        const target = runProject.mediaLibrary.find((m) => m.id === pair.targetId);
        if (!source?.localPath || !target?.localPath)
          throw new Error("素材已断开，请重新连接本地视频。");
        setMessage(`${completed + 1}/${pairs.length}：${source.name} → ${target.name}`);
        let snapshot = await startTauriAudioAlignmentJob({
          algorithm: "visual-aap",
          sourcePath: source.localPath,
          completePath: target.localPath,
          ffmpegPath: loadAppSettings().alignment.ffmpegPath || null,
          spectralBackend: "cpu"
        });
        task.jobId = snapshot.jobId;
        while (!isAudioAlignmentJobFinished(snapshot.status)) {
          if (!active()) await cancelTauriAudioAlignmentJob(snapshot.jobId);
          if (task.mounted) {
            setMessage(`${completed + 1}/${pairs.length}：${snapshot.message}`);
            setProgress((completed + snapshot.progress) / pairs.length);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          snapshot = await getTauriAudioAlignmentJob(snapshot.jobId);
        }
        task.jobId = null;
        if (!active() || snapshot.status === "cancelled") break;
        if (snapshot.status !== "completed" || !snapshot.proposal)
          throw new Error(snapshot.error || "画面匹配没有返回有效结果。");
        const current = useEditorStore.getState();
        // A replaced media reference invalidates results even when the project has not changed.
        if (
          current.project.mediaLibrary.find((m) => m.id === source.id)?.localPath !==
            source.localPath ||
          current.project.mediaLibrary.find((m) => m.id === target.id)?.localPath !==
            target.localPath
        )
          throw new Error("素材路径在匹配期间变化，结果未写入项目。请重新运行。");
        const candidate = createMediaMatchCandidate(current.project, {
          id: createId("aap_candidate"),
          batchId,
          sourceMediaId: source.id,
          targetMediaId: target.id,
          proposal: snapshot.proposal
        });
        current.addMediaMatchCandidate(candidate);
        completed += 1;
        if (task.mounted) setProgress(completed / pairs.length);
      }
      if (task.mounted)
        setMessage(
          task.cancelled
            ? `已停止，保留 ${completed} 组已完成候选。`
            : `已生成 ${completed} 组画面匹配候选。进入编辑页检查未匹配区间，再确认并导出。`
        );
    } catch (reason: unknown) {
      // Preserve the job handle if cleanup cannot be confirmed; never start overlapping work.
      if (task.jobId) {
        try {
          let snapshot = await cancelTauriAudioAlignmentJob(task.jobId);
          while (!isAudioAlignmentJobFinished(snapshot.status)) {
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
            snapshot = await getTauriAudioAlignmentJob(task.jobId);
          }
          task.jobId = null;
        } catch {
          /* The native active-run guard also blocks another decoder. */
        }
      }
      if (task.mounted)
        setError(
          `${String(reason)}${task.jobId ? "；任务退出尚未确认，请关闭应用后重试。" : ""}`
        );
    } finally {
      task.active = false;
      if (task.mounted) {
        setRunning(false);
        onBusyChange(Boolean(task.jobId));
      }
    }
  };
  const candidates = project.mediaMatchCandidates.filter(
    (c) => c.proposal.timeMap?.engineVersion === "visual-aap-v1"
  );
  return (
    <section className="grid gap-4" aria-label="AAP 画面匹配">
      <div className="rounded border border-panel-line bg-surface-inset p-4">
        <h2 className="font-semibold">画面匹配 AAP</h2>
        <p className="mt-2 text-sm text-content-secondary">
          适合画面相同但音轨不同、被配音或没有音轨的视频。全部计算在本机完成，需要两侧的视频文件。暂不适合大幅裁切、重新绘制或镜头乱序。
        </p>
        <p className="mt-2 text-sm text-content-muted">
          自动建立分段候选；重复画面、无关填充和未观察边界保留待确认，不会把这些弹幕硬套到最近一帧。
        </p>
      </div>
      <fieldset disabled={running} className="grid gap-3 md:grid-cols-2">
        <MediaChoiceList
          title="参考视频（弹幕来源）"
          items={project.mediaLibrary.filter((m) => m.role === "bilibiliReference")}
          selectedIds={sources}
          onToggle={(id) => setSources(toggle(sources, id))}
          audioPreparations={{}}
        />
        <MediaChoiceList
          title="最终观看的原片"
          items={project.mediaLibrary.filter((m) => m.role === "targetOriginal")}
          selectedIds={targets}
          onToggle={(id) => setTargets(toggle(targets, id))}
          audioPreparations={{}}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <TextButton
          tone="primary"
          disabled={running || !pairCount || pairCount > 64 || Boolean(control.current.jobId)}
          onClick={() => void run()}
        >
          开始画面匹配
        </TextButton>
        {running && (
          <TextButton
            onClick={() => {
              control.current.cancelled = true;
              setMessage("正在停止，等待本机进程退出…");
            }}
          >
            停止匹配
          </TextButton>
        )}
        <span className="text-sm text-content-muted">
          {pairCount
            ? `${pairCount} 个组合，按顺序处理（上限 64）`
            : "请至少选择一个参考视频和一个原片"}
        </span>
      </div>
      {running && (
        <progress aria-label="画面匹配进度" max={1} value={progress} className="w-full" />
      )}
      <p role="status" className="text-sm">
        {message}
      </p>
      {error && (
        <p role="alert" className="text-accent-red">
          {error}
        </p>
      )}
      <div className="grid gap-2">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="rounded border border-panel-line p-3">
            <p>
              {project.mediaLibrary.find((m) => m.id === candidate.sourceMediaId)?.name} →{" "}
              {project.mediaLibrary.find((m) => m.id === candidate.targetMediaId)?.name}
            </p>
            <p className="text-sm text-content-muted">
              共同内容覆盖 {Math.round((candidate.proposal.matchRange?.coverage ?? 0) * 100)}%；
              {candidate.proposal.timeMap?.spans.length ?? 0} 个分段。
              {candidate.state === "accepted" ? "已采用" : "待检查"}
            </p>
            <TextButton
              onClick={() =>
                useEditorStore.getState().requestWorkspaceIntent({
                  page: "editing",
                  target: { kind: "candidate", candidateId: candidate.id }
                })
              }
            >
              检查这组匹配
            </TextButton>
          </article>
        ))}
      </div>
    </section>
  );
}
