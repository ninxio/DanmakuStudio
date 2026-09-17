import { useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  LoaderCircle,
  TriangleAlert
} from "lucide-react";
import { TextButton } from "../../components/TextButton";
import { Badge } from "../../components/Badge";

type DeliveryEpisodeState =
  "waiting" | "ready" | "blocked" | "running" | "completed" | "failed";

interface DeliveryBlocker {
  id: string;
  message: string;
  targetLabel: string;
  locationLabel: string;
}

interface DeliveryEpisodeRow {
  id: string;
  targetLabel: string;
  fileName: string;
  sourceSummary: string;
  segmentSummary: string;
  correctionSummary: string;
  danmakuSummary: string;
  verificationLabel: string;
  outputLabel: string;
  state: DeliveryEpisodeState;
  blockers: DeliveryBlocker[];
}

interface ProjectionExportPresentationProps {
  rows: DeliveryEpisodeRow[];
  onIntent: (intent: { type: "locate-blocker"; issueId: string }) => void;
}

export function ProjectionExportPresentation({
  rows,
  onIntent
}: ProjectionExportPresentationProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-panel-line bg-surface-inset p-4 text-xs leading-5 text-content-muted">
        这里会按目标原片列出每一集的交付状态。请先在匹配页建立来源段与原片关系。
      </div>
    );
  }

  return (
    <div
      className="thin-scrollbar min-h-0 min-w-0 space-y-2 overflow-y-auto pr-1"
      role="list"
      aria-label="逐集交付队列"
      data-testid="delivery-episode-list"
    >
      {rows.map((row) => (
        <DeliveryEpisodeDisclosure
          key={`${row.id}-${row.state === "blocked" || row.state === "failed" ? "attention" : "normal"}`}
          row={row}
          onIntent={onIntent}
        />
      ))}
    </div>
  );
}

function DeliveryEpisodeDisclosure({
  row,
  onIntent
}: {
  row: DeliveryEpisodeRow;
  onIntent: ProjectionExportPresentationProps["onIntent"];
}) {
  const [open, setOpen] = useState(row.state === "blocked" || row.state === "failed");
  return (
    <details
      className={`performance-list-item min-w-0 overflow-hidden rounded-lg border bg-surface-inset px-3 py-2 ${rowBorderClass(row.state)}`}
      data-testid="delivery-episode-row"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <RowStateIcon state={row.state} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-content-primary">
            {row.targetLabel}
          </span>
          <Badge tone={rowBadgeTone(row.state)} className="shrink-0">
            {row.outputLabel}
          </Badge>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 pl-5 text-ui-caption text-content-muted">
          <span className="truncate" title={row.fileName}>
            {row.fileName}
          </span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{row.danmakuSummary}</span>
        </div>
      </summary>
      <div className="mt-2 grid gap-2 border-t border-panel-line/70 pt-2 text-ui-caption leading-5 text-content-muted">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <DeliveryFact label="来源范围" value={row.sourceSummary} />
          <DeliveryFact label="来源组成" value={row.segmentSummary} />
          <DeliveryFact label="编辑修正" value={row.correctionSummary} />
          <DeliveryFact label="验证状态" value={row.verificationLabel} />
        </dl>
        {row.blockers.map((blocker) => (
          <div
            key={blocker.id}
            className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded border border-accent-red/30 bg-accent-red/10 p-2 text-accent-red"
          >
            <span className="min-w-0 flex-[1_1_12rem] break-words">{blocker.message}</span>
            <TextButton
              className="shrink-0"
              onClick={() => onIntent({ type: "locate-blocker", issueId: blocker.id })}
            >
              <ExternalLink size={13} />
              定位处理
            </TextButton>
          </div>
        ))}
      </div>
    </details>
  );
}

function DeliveryFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ui-caption text-content-muted">{label}</dt>
      <dd className="truncate text-content-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}

function RowStateIcon({ state }: { state: DeliveryEpisodeState }) {
  if (state === "running") {
    return <LoaderCircle size={14} className="shrink-0 animate-spin text-accent-cyan" />;
  }
  if (state === "completed") {
    return <CircleCheck size={14} className="shrink-0 text-accent-green" />;
  }
  if (state === "blocked" || state === "failed") {
    return <CircleAlert size={14} className="shrink-0 text-accent-red" />;
  }
  return <TriangleAlert size={14} className="shrink-0 text-accent-yellow" />;
}

function rowBorderClass(state: DeliveryEpisodeState): string {
  if (state === "blocked" || state === "failed") return "border-accent-red/35";
  if (state === "running") return "border-accent-cyan/35";
  if (state === "completed") return "border-accent-green/35";
  return "border-panel-line";
}

function rowBadgeTone(
  state: DeliveryEpisodeState
): "neutral" | "running" | "success" | "danger" {
  if (state === "blocked" || state === "failed") return "danger";
  if (state === "running") return "running";
  if (state === "completed") return "success";
  return "neutral";
}
