import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { Badge } from "../../components/Badge";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";
import type {
  ProjectReadinessDiagnostic,
  ProjectReadinessItem,
  ProjectReadinessStatus,
  ProjectReadinessSummary
} from "../../domain/project/readiness";

export function ExportReadinessSummary({ readiness }: { readiness: ProjectReadinessSummary }) {
  const StatusIcon =
    readiness.status === "blocked"
      ? CircleAlert
      : readiness.status === "attention"
        ? TriangleAlert
        : CircleCheck;

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
            <StatusIcon size={16} className={projectReadinessIconClass(readiness.status)} />
            <span>导出前检查</span>
          </div>
          <p className="mt-1 text-xs font-medium leading-5 text-content-secondary">
            {readiness.headline}
          </p>
          <p className="mt-1 text-xs leading-5 text-content-muted">{readiness.detail}</p>
        </div>
        <Badge
          tone={getStatusVocabulary(readiness.statusId).tone}
          title={getStatusVocabulary(readiness.statusId).description}
          className="shrink-0"
        >
          {readiness.statusLabel}
        </Badge>
      </div>
      {readiness.items.length > 0 ? (
        <ul className="mt-3 divide-y divide-panel-line border-t border-panel-line">
          {readiness.items.map((item) => (
            <ProjectReadinessItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded border border-feedback-success/30 bg-feedback-success/10 p-2 text-xs leading-5 text-feedback-success">
          没有需要你现在处理的问题。可以继续编辑，或直接导出 XML。
        </div>
      )}
    </>
  );
}

export function ExportReadinessDiagnostics({
  diagnostics
}: {
  diagnostics: ProjectReadinessDiagnostic[];
}) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-panel-line pt-3">
      {diagnostics.map((diagnostic) => (
        <HealthMetric
          key={diagnostic.label}
          label={diagnostic.label}
          value={diagnostic.value}
        />
      ))}
    </dl>
  );
}

function HealthMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-panel-line/70 bg-surface-inset px-2 py-1.5">
      <dt className="truncate text-ui-caption text-content-muted">{label}</dt>
      <dd className="truncate text-xs font-medium text-content-secondary" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ProjectReadinessItemRow({ item }: { item: ProjectReadinessItem }) {
  const FindingIcon =
    item.severity === "error"
      ? CircleAlert
      : item.severity === "warning"
        ? TriangleAlert
        : CircleCheck;
  return (
    <li className="flex gap-2 py-2 first:pt-3 last:pb-0">
      <FindingIcon
        size={14}
        className={`mt-0.5 shrink-0 ${projectReadinessItemIconClass(item.severity)}`}
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-content-secondary">{item.title}</p>
        <p className="mt-0.5 text-ui-caption leading-5 text-content-muted">{item.detail}</p>
        {item.evidence.length > 0 ? (
          <ul className="mt-1 grid gap-1 text-ui-caption leading-5 text-content-muted">
            {item.evidence.map((evidenceItem) => (
              <li key={evidenceItem} className="break-words">
                {evidenceItem}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function projectReadinessIconClass(status: ProjectReadinessStatus): string {
  if (status === "blocked") {
    return "text-feedback-danger";
  }
  if (status === "attention") {
    return "text-feedback-warning";
  }
  return "text-feedback-success";
}

function projectReadinessItemIconClass(severity: ProjectReadinessItem["severity"]): string {
  if (severity === "error") {
    return "text-feedback-danger";
  }
  if (severity === "warning") {
    return "text-feedback-warning";
  }
  return "text-feedback-success";
}
