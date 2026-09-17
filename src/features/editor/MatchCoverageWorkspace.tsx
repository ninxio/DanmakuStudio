import {
  parseProjectMediaEpisodeIdentity,
  formatEpisodeIdentity
} from "../../domain/project/episodeIdentity";
import type { ProjectMediaReference } from "../../domain/project/types";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  createExportSessionKey,
  exportTaskChannel,
  IDLE_EXPORT_SESSION
} from "../../application/backgroundTasks/exportTaskChannel";
import { Button } from "../../components/Button";
import { TimeRuler } from "../../components/TimeRuler";
import { clockLabel } from "../../domain/timeline/timeScale";
import { TextButton } from "../../components/TextButton";
import { analyzeMatchCoverage } from "../../domain/alignment/matchCoverage";
import { formatTimecode } from "../../domain/shared/time";
import { projectDanmakuToTargets } from "../../domain/timeline/sourceProjection";
import { savePortableProject } from "../../infrastructure/persistence/projectFiles";
import { downloadTextFiles } from "../../infrastructure/file-system/browserFiles";
import { serializeBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { exportProjectionGroups } from "../export/exportProjectionService";

export function MatchCoverageWorkspace({
  exportGroups = exportProjectionGroups,
  onManualPosition
}: {
  exportGroups?: typeof exportProjectionGroups;
  onManualPosition?: () => void;
}) {
  const project = useEditorStore((state) => state.project);
  const adopt = useEditorStore((state) => state.adoptMatchesForPlayback);
  const requestIntent = useEditorStore((state) => state.requestWorkspaceIntent);
  const report = useMemo(() => analyzeMatchCoverage(project), [project]);
  const [selection, setSelection] = useState(
    () =>
      project.mediaMatchCandidates.find(
        (candidate) => candidate.id === useEditorStore.getState().alignmentEditorCandidateId
      )?.targetMediaId ?? ""
  );
  const sessionKey = createExportSessionKey(project);
  const subscribe = useCallback(
    (listener: () => void) => exportTaskChannel.subscribe(sessionKey, listener),
    [sessionKey]
  );
  const readSession = useCallback(
    () => exportTaskChannel.read(sessionKey) ?? IDLE_EXPORT_SESSION,
    [sessionKey]
  );
  const session = useSyncExternalStore(subscribe, readSession, readSession);
  const busy = session.phase === "running";
  const [notice, setNotice] = useState("");
  const episode =
    report.episodes.find((item) => item.media.id === selection) ?? report.episodes[0];
  const usable =
    report.projection.projectedItemCount > 0 && report.projection.status !== "blocked";
  const open = (candidateId: string, spanIndex = 0) =>
    requestIntent({ page: "editing", target: { kind: "candidate", candidateId, spanIndex } });
  const exportAll = async () => {
    if (exportTaskChannel.read(sessionKey)?.phase === "running") return;
    const unavailable = new Set(report.adoption.issues.map((issue) => issue.candidateId));
    if (
      !adopt(
        project.mediaMatchCandidates
          .filter((candidate) => !unavailable.has(candidate.id))
          .map((candidate) => candidate.id)
      )
    ) {
      setNotice(useEditorStore.getState().status.message);
      return;
    }
    const snapshot = useEditorStore.getState().project;
    const key = createExportSessionKey(snapshot);
    if (exportTaskChannel.read(key)?.phase === "running") return;
    const startedAtMs = Date.now();
    exportTaskChannel.publish(key, {
      phase: "running",
      result: null,
      failureMessage: null,
      startedAtMs,
      updatedAtMs: startedAtMs
    });
    setNotice("");
    try {
      const result = await exportGroups(projectDanmakuToTargets(snapshot), snapshot);
      exportTaskChannel.publish(key, {
        phase: result ? "completed" : "failed",
        result,
        failureMessage: result ? null : useEditorStore.getState().status.message,
        startedAtMs,
        updatedAtMs: Date.now()
      });
    } catch (error) {
      exportTaskChannel.publish(key, {
        phase: "failed",
        result: null,
        failureMessage: `导出未完成：${error instanceof Error ? error.message : String(error)}。已采用的映射仍保留，可重试。`,
        startedAtMs,
        updatedAtMs: Date.now()
      });
    }
  };
  return (
    <section className="coverage-workspace" aria-label="匹配覆盖分析">
      <header className="coverage-header">
        <div>
          <h2>匹配覆盖</h2>
          <p>先使用，发现问题再回来修正。采用结果不代表已经逐段审查。</p>
        </div>
        <Button
          tone="primary"
          onClick={() => void exportAll()}
          disabled={busy || !usable}
          disabledReason={busy ? "正在验证并导出" : "尚无可导出的映射内容，见下方说明"}
        >
          {busy ? "正在导出…" : "采用全部并导出"}
        </Button>
      </header>
      <div className="coverage-summary" aria-label="覆盖统计">
        <span>
          <strong>{report.episodes.length}</strong> 集原片
        </span>
        <span>
          <strong>{report.projection.projectedItemCount}</strong> 条可导出
        </span>
        <span>
          <strong>{report.retainedCount}</strong> 条未覆盖，保留在项目
        </span>
        <span>
          <strong>{report.unlocated.length}</strong> 个参考未定位
        </span>
      </div>
      <div className="coverage-body">
        <nav className="coverage-episodes" aria-label="选择原片集数">
          {report.episodes.map((item) => (
            <button
              key={item.media.id}
              type="button"
              aria-pressed={item === episode}
              onClick={() => setSelection(item.media.id)}
            >
              <span>{coverageEpisodeLabel(item.media)}</span>
              <small>
                {item.relations.length} 个参考 · {item.projectedCount} 条
              </small>
              <span className="coverage-mini">
                <span
                  style={{
                    width: `${item.durationMs ? (item.coveredMs / item.durationMs) * 100 : 0}%`
                  }}
                />
              </span>
            </button>
          ))}
        </nav>
        <div className="coverage-content">
          {episode ? (
            <>
              <h3 className="coverage-title">{episode.media.name}</h3>
              <p>
                {episode.durationKnown
                  ? `原片 ${formatTimecode(episode.durationMs)} · 已覆盖 ${formatTimecode(episode.coveredMs)}`
                  : "原片总时长未知，图示范围仅包含已知位置"}{" "}
                · {episode.gaps.length} 段未覆盖
              </p>
              <div className="coverage-legend">
                <span>■ 已有映射</span>
                <span className="coverage-provisional-legend">■ 暂用／尚未审查</span>
                <span className="text-content-muted">□ 未覆盖</span>
                <span className="coverage-overlap-legend">▨ 多个参考重叠</span>
              </div>
              <p>
                每行是一个参考，横向位置均为原片时间；上下排列不表示首尾衔接，也不会折行。重叠区域表示多个参考对应同一段原片。
              </p>
              <div className="coverage-ruler">
                <TimeRuler startMs={0} endMs={episode.durationMs} label="原片时间刻度" />
              </div>
              <div className="coverage-relation coverage-union-row">
                <div className="coverage-source">
                  整集汇总<small>合并所有参考的覆盖范围</small>
                </div>
                <div
                  className="coverage-track coverage-union"
                  role="img"
                  aria-label="整集覆盖汇总"
                >
                  {episode.bands.map((band) => (
                    <span
                      key={band.startMs}
                      className={`coverage-fill ${band.count > 1 ? "overlap" : band.count === 0 ? "uncovered" : ""}`}
                      style={{
                        left: `${(band.startMs / Math.max(1, episode.durationMs)) * 100}%`,
                        width: `${((band.endMs - band.startMs) / Math.max(1, episode.durationMs)) * 100}%`
                      }}
                      title={`${clockLabel(band.startMs)}–${clockLabel(band.endMs)} · ${band.count ? band.count + " 个参考覆盖" : "未覆盖"}`}
                    />
                  ))}
                  <TimeRuler startMs={0} endMs={episode.durationMs} label="" grid />
                </div>
              </div>
              <p className="coverage-overlap-summary">
                重复覆盖时长 {clockLabel(episode.overlapMs)}；空白时长{" "}
                {clockLabel(episode.durationMs - episode.coveredMs)}
                {episode.durationKnown ? "" : "（仅计算已知范围）"}
                。实际位置以每行起止时间为准。
              </p>
              {episode.relations.map(({ candidate, source, map, adopted, issue }) => (
                <div className="coverage-relation" key={candidate.id}>
                  <button
                    className="coverage-source"
                    onClick={() => open(candidate.id)}
                    title={source?.name}
                  >
                    {source?.name ?? "参考素材"}
                    <small>
                      {issue || (adopted ? "已采用 · 可随时修正" : "可采用现有映射")}
                    </small>
                    <small className="coverage-range">
                      {map
                        ? `${clockLabel(map.targetStartMs)} → ${clockLabel(map.targetEndMs)}`
                        : "尚无原片位置"}
                    </small>
                  </button>
                  <button
                    className="coverage-track"
                    aria-label={`定位 ${source?.name ?? "参考"} 的时间区间`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const targetMs =
                        event.detail === 0
                          ? 0
                          : ((event.clientX - rect.left) / rect.width) * episode.durationMs;
                      const index =
                        map?.spans.findIndex(
                          (span) =>
                            span.targetStartMs <= targetMs && span.targetEndMs > targetMs
                        ) ?? -1;
                      open(candidate.id, Math.max(0, index));
                    }}
                  >
                    {episode.intervals
                      .filter((interval) => interval.candidateId === candidate.id)
                      .map((interval) => (
                        <span
                          key={interval.spanIndex}
                          title={`原片 ${formatTimecode(interval.startMs)} → ${formatTimecode(interval.endMs)}${interval.provisional ? " · 暂用映射" : ""}`}
                          className={
                            interval.provisional ? "coverage-fill provisional" : "coverage-fill"
                          }
                          style={{
                            left: `${(interval.startMs / Math.max(1, episode.durationMs)) * 100}%`,
                            width: `${((interval.endMs - interval.startMs) / Math.max(1, episode.durationMs)) * 100}%`
                          }}
                        />
                      ))}
                    <TimeRuler startMs={0} endMs={episode.durationMs} label="" grid />
                  </button>
                </div>
              ))}
              {!episode.relations.length && (
                <p>这一集尚无可用时间关系。可回到匹配页分析，或使用手工定位。</p>
              )}
              <details className="coverage-details">
                <summary>衔接与重叠明细</summary>
                {episode.bands.map((band) => (
                  <div key={band.startMs}>
                    {formatTimecode(band.startMs)} — {formatTimecode(band.endMs)} ·{" "}
                    {band.count > 1
                      ? `${band.count} 个参考重叠`
                      : band.count === 1
                        ? "单个参考覆盖"
                        : "未覆盖"}
                  </div>
                ))}
              </details>
              <details className="coverage-details">
                <summary>未覆盖的原片区间（{episode.gaps.length}）</summary>
                <p>
                  这里没有来源弹幕覆盖，不等于原片缺失。片头、片尾或参考中没有的内容也会形成空白。
                </p>
                {episode.gaps.map((gap) => (
                  <div key={gap.startMs}>
                    {formatTimecode(gap.startMs)} — {formatTimecode(gap.endMs)}
                  </div>
                ))}
              </details>
            </>
          ) : (
            <p>尚未导入原片。请到素材页导入，然后运行匹配。</p>
          )}
          {report.unlocated.length > 0 && (
            <details className="coverage-details" open>
              <summary>尚未定位的参考（{report.unlocated.length}）</summary>
              <p>尚无可用时间图；这些弹幕保留在项目和原 XML 中，本次不猜测其原片位置。</p>
              {report.unlocated.map(({ media, itemCount }) => (
                <div key={media.id} className="coverage-unlocated">
                  <span>
                    {media.name} · {itemCount} 条
                  </span>
                  {onManualPosition && (
                    <TextButton onClick={onManualPosition}>手工定位</TextButton>
                  )}
                  <TextButton
                    onClick={() =>
                      requestIntent({
                        page: "materials",
                        target: { kind: "media", mediaId: media.id }
                      })
                    }
                  >
                    查看素材
                  </TextButton>
                </div>
              ))}
            </details>
          )}
          {report.adoption.issues.length > 0 && (
            <div role="alert">
              {report.adoption.issues.map((issue) => (
                <p key={issue.candidateId}>{issue.message}</p>
              ))}
            </div>
          )}
          {!usable && (
            <p role="status">
              {report.projection.issues.find((issue) => issue.severity === "error")?.message ??
                "暂时没有可导出的映射内容。可以先匹配或手动定位。"}
            </p>
          )}
        </div>
      </div>
      <footer className="coverage-footer">
        <p role="status">
          {notice ||
            (busy
              ? "正在采用映射并导出…"
              : session.phase === "completed"
                ? "已导出。匹配逻辑保留在项目中，发现问题后可按集和时间返回修正。"
                : session.failureMessage ||
                  "点击时间图可定位修正；未覆盖条目不删除。项目保存状态见顶部。")}
        </p>
        <TextButton
          onClick={() =>
            void savePortableProject(project).catch((error) => setNotice(String(error)))
          }
        >
          保存匹配备份
        </TextButton>
        <TextButton
          disabled={!report.retainedCount}
          onClick={() =>
            downloadTextFiles(
              report.retainedAssets.map((asset) => ({
                fileName: `未覆盖-${asset.fileName}`,
                content: serializeBilibiliXml(
                  asset.items.map((item) => ({ item, finalTimeMs: item.sourceTimeMs }))
                ).xml
              })),
              "未覆盖弹幕-原参考时间.zip"
            )
          }
        >
          保留未覆盖 XML
        </TextButton>
      </footer>
    </section>
  );
}

function coverageEpisodeLabel(media: ProjectMediaReference): string {
  const identity = parseProjectMediaEpisodeIdentity(media);
  return media.episodeLabel || (identity ? formatEpisodeIdentity(identity) : media.name);
}
