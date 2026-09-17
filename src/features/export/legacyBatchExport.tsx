import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { Layers, Search, WandSparkles } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import { getStatusVocabulary, statusLabel } from "../../domain/shared/statusVocabulary";
import type { buildBatchMergePlan } from "../../domain/danmaku/batchMerge";
import {
  formatMediaBindingTitle,
  formatMediaSourceSummary
} from "../../domain/project/mediaBinding";
import {
  createSeasonEpisodeKey,
  findSeasonEpisodeBinding
} from "../../domain/project/seasonEpisodeBinding";
import type { SeasonWorkbenchSummary } from "../../domain/project/seasonWorkbench";
import type { MediaBinding, SeasonEpisodeBinding } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import type { EmbyItemMetadata } from "../../infrastructure/metadata/embyClient";
import type { EmbyMetadataController } from "./useEmbyMetadataController";
import { Row } from "../assets/assetPanelShared";
import { formatSignedDuration } from "../assets/assetPanelSharedLogic";
import type { LongSplitMode, PartWindowMode } from "./legacyBatchExportOptions";
const EMBY_INPUT_CLASS =
  "h-8 min-w-0 w-full rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary";

export function EmbyMetadataPanel({ controller }: { controller: EmbyMetadataController }) {
  const {
    itemId,
    searchTerm,
    loadedItem,
    episodeItems,
    searchResults,
    durationLines,
    loading,
    hasSelectedItem,
    setSearchTerm,
    searchItems,
    selectSearchResult,
    importLoadedItemDuration,
    bindLoadedItemAsTarget,
    readItem,
    readEpisodes,
    importDurationLines
  } = controller;
  return (
    <section className="min-w-0 overflow-hidden rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium text-content-primary">Emby 时长</h3>
        <span className="shrink-0 rounded border border-panel-line bg-surface-inset px-2 py-0.5 text-ui-caption text-content-muted">
          设置中心
        </span>
      </div>
      <p className="mt-2 text-ui-caption leading-5 text-content-muted">
        连接、路径和账号在设置中心维护；这里仅搜索并导入真实时长。
      </p>
      <div className="mt-3 grid min-w-0 gap-2">
        <label className="grid min-w-0 gap-1">
          <span className="text-content-muted">搜索</span>
          <input
            className={EMBY_INPUT_CLASS}
            value={searchTerm}
            placeholder="片名 / 剧名 / S01E02 / 第1季第2集"
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void searchItems();
              }
            }}
          />
        </label>
        <div className="grid min-w-0 gap-2">
          <TextButton
            tone="primary"
            className="w-full min-w-0 px-2"
            onClick={() => void searchItems()}
            disabled={loading !== null}
          >
            <Search size={14} />
            <span className="truncate">
              {loading === "auth" ? "连接中" : loading === "search" ? "搜索中" : "搜索"}
            </span>
          </TextButton>
        </div>
        {searchResults.length > 0 ? (
          <div className="grid min-w-0 gap-1 rounded border border-panel-line bg-surface-inset p-2">
            <div className="text-content-muted">搜索结果</div>
            {searchResults.map((item) => (
              <Button
                tone="unstyled"
                key={item.id}
                type="button"
                className={`grid min-w-0 gap-0.5 rounded px-2 py-1 text-left transition hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan ${
                  item.id === itemId
                    ? "bg-accent-cyan/15 text-accent-cyan"
                    : "text-content-secondary"
                }`}
                onClick={() => selectSearchResult(item)}
              >
                <span className="truncate">{item.name}</span>
                <span className="truncate text-ui-caption text-content-muted">
                  {formatEmbySearchResultMeta(item)}
                </span>
              </Button>
            ))}
          </div>
        ) : null}
        {loadedItem ? (
          <div className="min-w-0 rounded border border-panel-line bg-surface-inset p-2">
            <Row label="条目" value={loadedItem.name} />
            <Row label="类型" value={loadedItem.type} />
            {loadedItem.seriesName ? <Row label="剧名" value={loadedItem.seriesName} /> : null}
            <Row
              label="时长"
              value={
                loadedItem.durationMs === null ? "未知" : formatTimecode(loadedItem.durationMs)
              }
            />
            <Row
              label="媒体源"
              value={
                loadedItem.mediaSources[0]
                  ? formatMediaSourceSummary(loadedItem.mediaSources[0])
                  : "暂未读取"
              }
            />
            <div className="mt-2 grid min-w-0 gap-2">
              <TextButton
                className="w-full min-w-0 px-2"
                onClick={() => void readItem()}
                disabled={loading !== null || !hasSelectedItem}
              >
                <span className="truncate">{loading === "item" ? "读取中" : "读取条目"}</span>
              </TextButton>
              <TextButton
                className="w-full min-w-0 px-2"
                onClick={() => void readEpisodes()}
                disabled={loading !== null || !hasSelectedItem}
              >
                <span className="truncate">
                  {loading === "episodes" ? "读取中" : "读取下级剧集"}
                </span>
              </TextButton>
              {loadedItem.durationMs !== null ? (
                <TextButton className="w-full min-w-0 px-2" onClick={importLoadedItemDuration}>
                  <span className="truncate">导入单条时长</span>
                </TextButton>
              ) : null}
              <TextButton
                tone="primary"
                className="w-full min-w-0 px-2"
                onClick={bindLoadedItemAsTarget}
              >
                <span className="truncate">绑定为目标原片</span>
              </TextButton>
            </div>
          </div>
        ) : null}
        {durationLines.length > 0 ? (
          <div className="grid min-w-0 gap-2">
            <textarea
              className="min-h-24 min-w-0 resize-y rounded border border-panel-line bg-surface-inset p-2 font-mono text-xs leading-5 text-content-primary"
              value={durationLines}
              readOnly
            />
            <div className="grid min-w-0 gap-2">
              <span className="min-w-0 truncate text-content-muted">
                {episodeItems.length} 个条目
              </span>
              <TextButton
                tone="primary"
                className="w-full min-w-0 px-2"
                onClick={importDurationLines}
              >
                <span className="truncate">导入时长规则</span>
              </TextButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function formatEmbySearchResultMeta(item: EmbyItemMetadata): string {
  const parts = [formatEmbyItemType(item.type)];
  if (item.seasonNumber !== null) {
    parts.push(`第 ${item.seasonNumber} 季`);
  }
  if (item.episodeNumber !== null) {
    parts.push(`第 ${item.episodeNumber} 集`);
  }
  if (item.durationMs !== null) {
    parts.push(formatTimecode(item.durationMs));
  }
  return parts.join(" / ");
}

function formatEmbyItemType(type: string): string {
  if (type === "Movie") {
    return "电影";
  }
  if (type === "Series") {
    return "剧集";
  }
  if (type === "Season") {
    return "季";
  }
  if (type === "Episode") {
    return "单集";
  }
  return type;
}

export function ManualRulePanel({
  partWindowMode,
  partWindowMinutes,
  partRangeStartMinutes,
  partRangeEndMinutes,
  longSplitMode,
  episodeDurationsText,
  cutPointsText,
  warnings,
  onPartWindowModeChange,
  onPartWindowMinutesChange,
  onPartRangeStartMinutesChange,
  onPartRangeEndMinutesChange,
  onLongSplitModeChange,
  onEpisodeDurationsTextChange,
  onCutPointsTextChange
}: {
  partWindowMode: PartWindowMode;
  partWindowMinutes: string;
  partRangeStartMinutes: string;
  partRangeEndMinutes: string;
  longSplitMode: LongSplitMode;
  episodeDurationsText: string;
  cutPointsText: string;
  warnings: string[];
  onPartWindowModeChange: (mode: PartWindowMode) => void;
  onPartWindowMinutesChange: (value: string) => void;
  onPartRangeStartMinutesChange: (value: string) => void;
  onPartRangeEndMinutesChange: (value: string) => void;
  onLongSplitModeChange: (mode: LongSplitMode) => void;
  onEpisodeDurationsTextChange: (value: string) => void;
  onCutPointsTextChange: (value: string) => void;
}) {
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <h3 className="text-sm font-medium text-content-primary">人工整理规则</h3>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-1">
          <span className="text-content-muted">每个分 P</span>
          <select
            className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
            value={partWindowMode}
            onChange={(event) => onPartWindowModeChange(event.target.value as PartWindowMode)}
          >
            <option value="full">完整保留</option>
            <option value="prefix">只取前 N 分钟</option>
            <option value="suffix">只取后 N 分钟</option>
            <option value="range">统一起止分钟</option>
          </select>
        </label>
        {partWindowMode === "prefix" || partWindowMode === "suffix" ? (
          <label className="grid gap-1">
            <span className="text-content-muted">N 分钟</span>
            <input
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              value={partWindowMinutes}
              inputMode="decimal"
              onChange={(event) => onPartWindowMinutesChange(event.target.value)}
            />
          </label>
        ) : null}
        {partWindowMode === "range" ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="text-content-muted">开始分钟</span>
              <input
                className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                value={partRangeStartMinutes}
                inputMode="decimal"
                onChange={(event) => onPartRangeStartMinutesChange(event.target.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-content-muted">结束分钟</span>
              <input
                className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
                value={partRangeEndMinutes}
                inputMode="decimal"
                onChange={(event) => onPartRangeEndMinutesChange(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        <label className="grid gap-1">
          <span className="text-content-muted">长合集切分</span>
          <select
            className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
            value={longSplitMode}
            onChange={(event) => onLongSplitModeChange(event.target.value as LongSplitMode)}
          >
            <option value="auto">按文件名自动切分</option>
            <option value="durations">按真实集时长</option>
            <option value="cuts">按人工切点</option>
          </select>
        </label>
        {longSplitMode === "durations" ? (
          <textarea
            className="min-h-20 resize-y rounded border border-panel-line bg-surface-inset p-2 text-xs leading-5 text-content-primary"
            value={episodeDurationsText}
            placeholder={"每行一个时长，例如：\nS01E01 51:20\nS01E02 50:45"}
            onChange={(event) => onEpisodeDurationsTextChange(event.target.value)}
          />
        ) : null}
        {longSplitMode === "cuts" ? (
          <textarea
            className="min-h-16 resize-y rounded border border-panel-line bg-surface-inset p-2 text-xs leading-5 text-content-primary"
            value={cutPointsText}
            placeholder="切点用逗号或换行分隔，例如：51:20, 1:42:05"
            onChange={(event) => onCutPointsTextChange(event.target.value)}
          />
        ) : null}
        {warnings.length > 0 ? (
          <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-accent-yellow">
            {warnings[0]}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function BatchMergeSummary({
  plan,
  warnings
}: {
  plan: ReturnType<typeof buildBatchMergePlan>;
  warnings: string[];
}) {
  const previewEpisodes = plan.episodes.slice(0, 4);
  const hiddenCount = Math.max(0, plan.episodes.length - previewEpisodes.length);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <WandSparkles size={15} className="text-accent-cyan" />
        <span>分集合并草案</span>
        <span className="ml-auto rounded border border-panel-line bg-surface-inset px-1.5 py-0.5 text-ui-caption text-content-muted">
          {confidenceLabel(plan.confidence)}
        </span>
      </div>
      <div className="mt-2 grid gap-1">
        {[...plan.diagnostics, ...warnings].map((diagnostic, index) => (
          <p key={`${diagnostic}-${index}`} className="leading-5 text-content-muted">
            {diagnostic}
          </p>
        ))}
      </div>
      {previewEpisodes.length > 0 ? (
        <div className="mt-3 grid gap-1">
          {previewEpisodes.map((episode) => (
            <div key={episode.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <span
                className="truncate"
                title={`${episode.label}：${episode.sourceFileNames.join("、")}`}
              >
                {episode.label}
              </span>
              <span className="text-content-muted">
                {episode.itemCount.toLocaleString("zh-CN")} 条
              </span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <p className="text-content-muted">另有 {hiddenCount} 个输出。</p>
          ) : null}
        </div>
      ) : null}
      {plan.compensation.markerCount > 0 ? (
        <div className="mt-3 grid gap-1 border-t border-panel-line pt-3 text-content-muted">
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-content-muted">版本差异</span>
            <span>{plan.compensation.markerCount} 个</span>
          </div>
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-content-muted">总时长</span>
            <span>{formatSignedDuration(plan.compensation.totalGapMs)}</span>
          </div>
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-content-muted">影响</span>
            <span>
              {plan.compensation.affectedEpisodeCount} 个输出，
              {plan.compensation.affectedEntryCount.toLocaleString("zh-CN")} 条弹幕
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SeasonWorkbenchPanel({ summary }: { summary: SeasonWorkbenchSummary }) {
  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary"
      aria-label="剧集工作台"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <WandSparkles size={15} className="text-accent-cyan" />
        <span>剧集工作台</span>
        <Badge
          tone={getStatusVocabulary(summary.statusId).tone}
          title={getStatusVocabulary(summary.statusId).description}
          className="ml-auto"
        >
          {summary.statusLabel}
        </Badge>
      </div>
      <p className="mt-2 text-ui-caption leading-5 text-content-muted">{summary.headline}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {summary.metrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded border border-panel-line bg-surface-inset p-2"
          >
            <div className="text-ui-caption text-content-muted">{metric.label}</div>
            <div className="mt-1 text-sm font-medium text-content-primary">{metric.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2">
        {summary.steps.map((step) => (
          <div
            key={step.id}
            className="grid gap-1 rounded border border-panel-line bg-surface-inset p-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-content-primary">{step.label}</span>
              <Badge
                tone={getStatusVocabulary(step.statusId).tone}
                title={getStatusVocabulary(step.statusId).description}
              >
                {step.stateText}
              </Badge>
            </div>
            <p className="leading-5 text-content-muted">{step.detail}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-ui-caption leading-5 text-content-muted">
        下一步：{summary.nextActionLabel}
      </p>
    </section>
  );
}

export function SeasonEpisodeBindingPanel({
  plan,
  bindings,
  currentBinding,
  onBindCurrent,
  onClear,
  onOpenMediaTab
}: {
  plan: ReturnType<typeof buildBatchMergePlan>;
  bindings: SeasonEpisodeBinding[];
  currentBinding: MediaBinding | null;
  onBindCurrent: (episodeKey: string, episodeLabel: string) => void;
  onClear: (episodeKey: string) => void;
  onOpenMediaTab: () => void;
}) {
  const previewEpisodes = plan.episodes.slice(0, 6);
  const hiddenCount = Math.max(0, plan.episodes.length - previewEpisodes.length);
  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary"
      aria-label="逐集目标绑定"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <Layers size={15} className="text-accent-cyan" />
        <span>逐集目标绑定</span>
        <span className="ml-auto rounded border border-panel-line bg-surface-inset px-1.5 py-0.5 text-ui-caption text-content-muted">
          {bindings.length} 个已绑定
        </span>
      </div>
      <p className="mt-2 text-ui-caption leading-5 text-content-muted">
        把当前目标原片分配给具体输出集，保存项目后仍可恢复；这里不保存视频内容、密码或临时播放地址。
      </p>
      {previewEpisodes.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {previewEpisodes.map((episode) => {
            const episodeKey = createSeasonEpisodeKey(episode);
            const savedBinding = findSeasonEpisodeBinding(bindings, episodeKey);
            const canBindCurrent = Boolean(currentBinding);
            return (
              <div
                key={episodeKey}
                className="grid gap-2 rounded border border-panel-line bg-surface-inset p-2"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <div className="min-w-0">
                    <div
                      className="truncate text-content-primary"
                      title={`${episode.label}：${episode.sourceFileNames.join("、")}`}
                    >
                      {episode.label}
                    </div>
                    <div className="mt-0.5 truncate text-ui-caption text-content-muted">
                      {episode.sourceFileNames.join("、")} /{" "}
                      {episode.itemCount.toLocaleString("zh-CN")} 条
                    </div>
                  </div>
                  <span
                    className={`h-fit rounded border px-1.5 py-0.5 text-ui-caption ${
                      savedBinding
                        ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
                        : canBindCurrent
                          ? "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
                          : "border-panel-line bg-surface-inset text-content-muted"
                    }`}
                  >
                    {savedBinding ? "已绑定" : canBindCurrent ? "可绑定" : "待目标"}
                  </span>
                </div>
                <div className="text-ui-caption leading-5 text-content-muted">
                  {savedBinding
                    ? `目标原片：${formatMediaBindingTitle(savedBinding.targetBinding)}`
                    : currentBinding
                      ? `当前目标：${formatMediaBindingTitle(currentBinding)}`
                      : "先在“媒体”页绑定本地文件或 Emby 条目。"}
                </div>
                <div className="flex flex-wrap gap-2">
                  {currentBinding ? (
                    <TextButton onClick={() => onBindCurrent(episodeKey, episode.label)}>
                      {savedBinding ? "更新目标" : "绑定当前目标"}
                    </TextButton>
                  ) : (
                    <TextButton onClick={onOpenMediaTab}>去绑定目标</TextButton>
                  )}
                  {savedBinding ? (
                    <TextButton onClick={() => onClear(episodeKey)}>清除</TextButton>
                  ) : null}
                </div>
              </div>
            );
          })}
          {hiddenCount > 0 ? (
            <p className="text-ui-caption text-content-muted">
              另有 {hiddenCount} 个输出，可继续调整规则后查看。
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 rounded border border-panel-line bg-surface-inset p-2 text-content-muted">
          先生成分集草案，再为每一集绑定目标原片。
        </div>
      )}
    </section>
  );
}

function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") {
    return "高置信";
  }
  if (confidence === "medium") {
    return "中置信";
  }
  return statusLabel("reviewRequired");
}
