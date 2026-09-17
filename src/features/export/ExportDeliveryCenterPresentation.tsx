import { ToolSheet } from "../../components/ToolSheet";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { WorkspaceStatePanel } from "../../components/WorkspaceStatePanel";
import { useRovingFocusList } from "../../components/useRovingFocusList";
import { useState, useRef, type ComponentProps } from "react";
import {
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle
} from "lucide-react";
import { TextButton } from "../../components/TextButton";
import { ProjectionExportPresentation } from "./ProjectionExportPresentation";

type DeliveryRows = ComponentProps<typeof ProjectionExportPresentation>["rows"];
type DeliveryBlocker = DeliveryRows[number]["blockers"][number];

interface DeliveryCenterModel {
  summary: {
    state: "ready" | "blocked" | "unavailable";
    badgeLabel: string;
    headline: string;
    detail: string;
    exportableCount: number;
    totalCount: number;
    blockerCount: number;
    projectedItemCount: number;
  };
  availability: {
    title: string;
    message: string;
  } | null;
  primaryAction:
    | { type: "export-all"; label: string; disabledReason?: string | null }
    | { type: "locate-blocker"; issueId: string; label: string }
    | null;
  phase: "idle" | "running" | "completed" | "failed";
  completion: {
    fileCount: number;
    directoryPath: string | null;
    filePath: string | null;
    wasRenamed: boolean;
  } | null;
  failureMessage: string | null;
  blockers: DeliveryBlocker[];
  notices: Array<{ id: string; message: string }>;
  omitted: {
    ignoredItemCount: number;
    sourceOnlyItemCount: number;
    unexpectedUnmappedItemCount: number;
  };
  rows: DeliveryRows;
}

type DeliveryCenterIntent =
  | { type: "export-all" }
  | { type: "locate-blocker"; issueId: string }
  | { type: "open-directory" };

export function ExportDeliveryCenterPresentation({
  model,
  onIntent
}: {
  model: DeliveryCenterModel;
  onIntent: (intent: DeliveryCenterIntent) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const firstBlocker = model.blockers[0] ?? null;
  const additionalBlockers = model.blockers.slice(1);
  const rovingBlockers = useRovingFocusList({
    itemIds: additionalBlockers.map((blocker) => blocker.id),
    onEscape: () =>
      rootRef.current
        ?.querySelector<HTMLButtonElement>('[data-testid="delivery-primary-action"]')
        ?.focus()
  });
  return (
    <section
      ref={rootRef}
      className="workspace-page text-xs text-content-secondary"
      aria-label="按原片分集导出"
      data-testid="export-delivery-center"
    >
      <header className="export-page-heading">
        <h3 className="sr-only">确认导出内容</h3>
        <div className="flex w-full flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-semibold text-content-primary">导出</h2>
              <Badge
                tone={
                  model.summary.state === "blocked"
                    ? "danger"
                    : model.summary.state === "ready"
                      ? "success"
                      : "warning"
                }
              >
                {model.summary.badgeLabel}
              </Badge>
            </div>
            <p className="mt-1 text-sm font-medium text-content-secondary">
              {model.summary.headline}
            </p>
          </div>
          {model.primaryAction ? (
            <TextButton
              data-testid="delivery-primary-action"
              tone="primary"
              className="w-40 shrink-0"
              disabled={
                model.phase === "running" ||
                (model.primaryAction.type === "export-all" &&
                  Boolean(model.primaryAction.disabledReason))
              }
              title={
                model.primaryAction.type === "export-all"
                  ? (model.primaryAction.disabledReason ?? undefined)
                  : undefined
              }
              onClick={() => {
                if (model.primaryAction?.type === "export-all") {
                  onIntent({ type: "export-all" });
                } else if (model.primaryAction) {
                  onIntent({ type: "locate-blocker", issueId: model.primaryAction.issueId });
                }
              }}
            >
              {model.phase === "running" ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : model.primaryAction.type === "export-all" ? (
                <Download size={14} />
              ) : (
                <ExternalLink size={14} />
              )}
              {model.phase === "running" ? (
                "正在核验并导出…"
              ) : model.primaryAction.type === "export-all" ? (
                <>
                  <span aria-hidden="true">{model.primaryAction.label}</span>
                  <span className="sr-only">
                    {model.phase === "completed" ? "再次导出全部分集 XML" : "导出全部分集 XML"}
                  </span>
                </>
              ) : (
                model.primaryAction.label
              )}
            </TextButton>
          ) : null}
        </div>
        <dl className="mt-3 grid grid-cols-4 gap-2">
          <SummaryMetric label="目标分集" value={`${model.summary.totalCount} 集`} />
          <SummaryMetric label="可交付" value={`${model.summary.exportableCount} 集`} />
          <SummaryMetric label="阻断" value={`${model.summary.blockerCount} 项`} />
          <SummaryMetric
            label="投影弹幕"
            value={`${model.summary.projectedItemCount.toLocaleString("zh-CN")} 条`}
          />
        </dl>
        <span className="sr-only">可导出分集 {model.summary.exportableCount} 个</span>
      </header>

      {model.phase === "completed" && model.completion ? (
        <div className="mx-7 mb-3">
          <CompletionCard
            completion={model.completion}
            onOpenDirectory={() => onIntent({ type: "open-directory" })}
          />
        </div>
      ) : null}
      {model.phase === "failed" && model.failureMessage ? (
        <p role="alert" className="page-notice">
          {model.failureMessage}
        </p>
      ) : null}
      {model.availability ? (
        <div className="page-notice" role="status" data-testid="delivery-availability">
          <CircleAlert size={16} className="shrink-0 text-feedback-warning" />
          <p>
            <strong>{model.availability.title}</strong> · {model.availability.message}
          </p>
        </div>
      ) : null}
      <div className="workspace-bar">
        <span>
          {model.summary.totalCount} 个目标文件 ·{" "}
          {model.summary.projectedItemCount.toLocaleString("zh-CN")} 条弹幕
        </span>
        <TextButton onClick={() => setDetailsOpen(true)}>
          检查详情{model.summary.blockerCount > 0 ? " · " + model.summary.blockerCount : ""}
        </TextButton>
      </div>
      <ToolSheet title="导出检查详情" open={detailsOpen} onClose={() => setDetailsOpen(false)}>
        <aside aria-label="交付状态与异常">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-content-primary">交付状态与异常</h3>
            <span className="text-ui-caption text-content-muted">异常优先</span>
          </div>
          {model.phase === "failed" && model.failureMessage ? (
            <WorkspaceStatePanel
              state="error"
              title="导出未完成"
              description={model.failureMessage}
              impact="本次没有生成新的分集 XML；已有文件不会被覆盖。"
              recovery="处理上述原因后，使用右上角主动作重新核验并导出。"
              className="mt-3"
            />
          ) : null}
          {firstBlocker ? (
            <div
              className="mt-3 rounded-lg border border-accent-red/35 bg-accent-red/10 p-3"
              data-testid="delivery-first-blocker"
            >
              <div className="flex items-center gap-2 font-medium text-accent-red">
                <CircleAlert size={14} />
                首先处理
              </div>
              <p className="mt-1 leading-5 text-content-secondary">{firstBlocker.message}</p>
              <p className="mt-1 text-ui-caption text-content-muted">
                将定位到：{firstBlocker.locationLabel}
              </p>
            </div>
          ) : model.phase !== "completed" ? (
            <div className="mt-3 rounded-lg border border-accent-green/30 bg-accent-green/10 p-3 leading-5 text-content-secondary">
              <div className="flex items-center gap-2 font-medium text-accent-green">
                <CircleCheck size={14} />
                {model.availability ? "投影内容没有交付阻断" : "没有交付阻断"}
              </div>
              <p className="mt-1 text-ui-caption">
                正常分集已折叠；可展开查看来源范围、修正与验证状态。
              </p>
            </div>
          ) : null}
          {additionalBlockers.length > 0 ? (
            <div
              className="thin-scrollbar mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1"
              role="list"
              aria-label="其余交付阻断"
            >
              {additionalBlockers.map((blocker) => (
                <div key={blocker.id} role="listitem">
                  <Button
                    tone="unstyled"
                    ref={(element) => rovingBlockers.setItemRef(blocker.id, element)}
                    type="button"
                    tabIndex={rovingBlockers.getItemTabIndex(blocker.id)}
                    className="w-full rounded border border-panel-line bg-surface-inset p-2 text-left leading-5 text-content-muted hover:border-accent-cyan/40 hover:text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                    onClick={() => onIntent({ type: "locate-blocker", issueId: blocker.id })}
                    onFocus={() => rovingBlockers.onItemFocus(blocker.id)}
                    onKeyDown={(event) => rovingBlockers.onItemKeyDown(event, blocker.id)}
                  >
                    <span className="block truncate text-ui-caption text-content-secondary">
                      {blocker.targetLabel}
                    </span>
                    <span className="line-clamp-2 text-ui-caption">{blocker.message}</span>
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {model.notices.length > 0 ||
          model.omitted.ignoredItemCount > 0 ||
          model.omitted.sourceOnlyItemCount > 0 ||
          model.omitted.unexpectedUnmappedItemCount > 0 ? (
            <details className="mt-2 rounded border border-panel-line bg-surface-inset px-2.5 py-2">
              <summary className="cursor-pointer text-ui-caption text-content-muted">
                <span>查看未导出弹幕统计</span>
                <span className="ml-1">与提示</span>
              </summary>
              <dl className="mt-2 grid grid-cols-3 gap-1 border-t border-panel-line/70 pt-2">
                <SummaryMetric
                  label="忽略段"
                  value={`${model.omitted.ignoredItemCount.toLocaleString("zh-CN")} 条`}
                />
                <SummaryMetric
                  label="参考独有"
                  value={`${model.omitted.sourceOnlyItemCount.toLocaleString("zh-CN")} 条`}
                />
                <SummaryMetric
                  label="意外未覆盖"
                  value={`${model.omitted.unexpectedUnmappedItemCount.toLocaleString("zh-CN")} 条`}
                />
              </dl>
              <ul className="mt-2 space-y-1 text-ui-caption leading-4 text-accent-yellow">
                {model.notices.map((notice) => (
                  <li key={notice.id}>{notice.message}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>
      </ToolSheet>
      <div className="export-file-list">
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-content-primary">输出文件</h3>
          <span className="text-ui-caption text-content-muted">展开文件查看详情</span>
        </div>
        <ProjectionExportPresentation rows={model.rows} onIntent={onIntent} />
      </div>
    </section>
  );
}

function CompletionCard({
  completion,
  onOpenDirectory
}: {
  completion: NonNullable<DeliveryCenterModel["completion"]>;
  onOpenDirectory: () => void;
}) {
  return (
    <div
      className="mt-3 rounded-lg border border-accent-green/30 bg-accent-green/10 p-3"
      data-testid="export-completion"
    >
      <div className="flex items-center gap-2 font-medium text-accent-green">
        <CircleCheck size={14} />
        已导出 {completion.fileCount} 个分集 XML
      </div>
      <p className="mt-1 break-all text-ui-caption leading-5 text-content-secondary">
        {completion.directoryPath ?? completion.filePath ?? "浏览器下载已触发"}
        {completion.wasRenamed ? "（已有同名文件，已自动改名）" : ""}
      </p>
      {completion.directoryPath && completion.filePath ? (
        <p className="mt-1 break-all text-ui-caption leading-4 text-content-muted">
          最新文件：{completion.filePath}
        </p>
      ) : null}
      {completion.directoryPath ? (
        <div className="mt-2">
          <TextButton onClick={onOpenDirectory}>
            <FolderOpen size={14} />
            打开导出目录
          </TextButton>
        </div>
      ) : null}
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded border border-panel-line bg-surface-inset px-2 py-1.5">
      <dt className="text-ui-caption text-content-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-xs font-medium text-content-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}
