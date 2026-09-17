import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  FileDown,
  FileUp,
  Save,
  Shuffle,
  Sparkles,
  Trash2,
  Video,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { Dialog } from "../../components/Dialog";
import { Badge } from "../../components/Badge";
import { IconButton } from "../../components/IconButton";
import { ProgressBar } from "../../components/ProgressBar";
import { TextButton } from "../../components/TextButton";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";
import type {
  WorkflowActionDescriptor,
  WorkflowActionId,
  WorkflowOverview,
  WorkflowStage,
  WorkflowStageState
} from "../../domain/project/workflowOverview";

type WorkflowOverviewIntent =
  { type: "dismiss" } | { type: "activate-action"; actionId: WorkflowActionId };

interface WorkflowOverviewPresentationProps {
  viewModel: WorkflowOverview;
  onIntent: (intent: WorkflowOverviewIntent) => void;
}

export function WorkflowOverviewPresentation({
  viewModel,
  onIntent
}: WorkflowOverviewPresentationProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const nextAction =
    viewModel.actions.find((action) => action.id === viewModel.nextActionId) ??
    viewModel.actions[0];
  return (
    <Dialog
      ariaLabelledBy="workflow-overview-title"
      onClose={() => onIntent({ type: "dismiss" })}
      initialFocusRef={closeButtonRef}
      overlayClassName="z-40 bg-surface-canvas/70 p-6"
      className="flex max-h-[calc(100vh-48px)] w-[min(1180px,calc(100vw-48px))] min-h-0 flex-col rounded border-panel-line bg-panel-base"
      testId="workflow-overview-dialog"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-panel-line bg-surface-inset px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan">
              <Sparkles size={16} />
            </span>
            <div className="min-w-0">
              <h2
                id="workflow-overview-title"
                className="truncate text-base font-semibold text-content-primary"
              >
                开始 / 下一步
              </h2>
              <p
                className="mt-1 truncate text-xs text-content-muted"
                title={viewModel.projectName}
              >
                {viewModel.projectName} · {viewModel.liveSummary}
              </p>
            </div>
          </div>
        </div>
        <IconButton
          ref={closeButtonRef}
          label="关闭新手引导"
          icon={<X size={16} />}
          className="shrink-0"
          onClick={() => onIntent({ type: "dismiss" })}
        />
      </header>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="grid gap-4">
            <div className="rounded border border-panel-line bg-panel-soft p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-content-muted">当前阶段</p>
                  <p className="mt-1 text-sm font-medium text-content-primary">
                    {viewModel.completeStageCount} / {viewModel.totalStageCount} 个阶段已完成
                  </p>
                </div>
                <ProgressBar
                  label="完成进度"
                  value={viewModel.progressPercent}
                  className="min-w-44"
                />
              </div>
            </div>

            <ol className="grid gap-3" aria-label="工作流阶段">
              {viewModel.stages.map((stage) => (
                <WorkflowStageCard key={stage.id} stage={stage} />
              ))}
            </ol>
          </section>

          <aside className="grid content-start gap-4">
            <section className="rounded border border-accent-cyan/40 bg-accent-cyan/10 p-4">
              <p className="text-xs text-feedback-running/80">建议下一步</p>
              <h3 className="mt-1 text-sm font-semibold text-content-primary">
                {viewModel.nextActionLabel}
              </h3>
              <p className="mt-2 text-xs leading-5 text-content-secondary">
                {nextAction.detail}
              </p>
              <ActionButton
                action={nextAction}
                onClick={() =>
                  onIntent({
                    type: "activate-action",
                    actionId: nextAction.id
                  })
                }
                className="mt-3 w-full"
              />
            </section>

            <section className="rounded border border-panel-line bg-panel-soft p-4">
              <h3 className="text-sm font-semibold text-content-primary">常用操作</h3>
              <div className="mt-3 grid gap-2">
                {viewModel.actions.map((action) => (
                  <ActionButton
                    key={action.id}
                    action={action}
                    onClick={() =>
                      onIntent({
                        type: "activate-action",
                        actionId: action.id
                      })
                    }
                    className="w-full justify-start"
                  />
                ))}
              </div>
            </section>

            <section className="rounded border border-panel-line bg-surface-inset p-4">
              <h3 className="text-sm font-semibold text-content-primary">提示</h3>
              <p className="mt-2 text-xs leading-5 text-content-muted">
                这里会跟着当前项目变化，只保留你下一步最可能需要的动作。
              </p>
            </section>
          </aside>
        </div>
      </div>
    </Dialog>
  );
}

function WorkflowStageCard({ stage }: { stage: WorkflowStage }) {
  const StageIcon = getStageIcon(stage.state);
  return (
    <li className="rounded border border-panel-line bg-panel-soft p-4">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border ${stageStateClass(
            stage.state
          )}`}
        >
          <StageIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-content-muted">0{stage.order}</span>
            <h3 className="text-sm font-semibold text-content-primary">{stage.title}</h3>
            <Badge
              tone={getStatusVocabulary(stage.statusId).tone}
              title={getStatusVocabulary(stage.statusId).description}
            >
              {stage.stateText}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-content-secondary">{stage.headline}</p>
          <p className="mt-1 text-xs leading-5 text-content-muted">{stage.detail}</p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-3">
            {stage.metrics.map((metric) => (
              <div
                key={metric.label}
                className="min-w-0 rounded border border-panel-line/70 bg-surface-inset px-2 py-1.5"
              >
                <dt className="truncate text-ui-caption text-content-muted">{metric.label}</dt>
                <dd
                  className="truncate text-xs font-medium text-content-secondary"
                  title={metric.value}
                >
                  {metric.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </li>
  );
}

function ActionButton({
  action,
  onClick,
  className = ""
}: {
  action: WorkflowActionDescriptor;
  onClick: () => void;
  className?: string;
}) {
  return (
    <TextButton
      tone={action.tone}
      disabled={!action.enabled}
      title={action.reason ?? action.detail}
      onClick={onClick}
      className={className}
    >
      {actionIcon(action.id)}
      <span className="truncate">{action.label}</span>
    </TextButton>
  );
}

function actionIcon(actionId: WorkflowActionId): ReactNode {
  if (actionId === "import-video") {
    return <Video size={14} />;
  }
  if (actionId === "import-xml") {
    return <FileUp size={14} />;
  }
  if (actionId === "auto-arrange") {
    return <Shuffle size={14} />;
  }
  if (actionId === "review-matches") {
    return <Sparkles size={14} />;
  }
  if (actionId === "edit-relations") {
    return <Video size={14} />;
  }
  if (actionId === "cleanup-edit-references" || actionId === "cleanup-missing-clips") {
    return <Trash2 size={14} />;
  }
  if (actionId === "save-project") {
    return <Save size={14} />;
  }
  return <FileDown size={14} />;
}

function getStageIcon(state: WorkflowStageState) {
  if (state === "complete") {
    return CheckCircle2;
  }
  if (state === "active") {
    return Clock3;
  }
  if (state === "blocked") {
    return CircleAlert;
  }
  return Circle;
}

function stageStateClass(state: WorkflowStageState): string {
  if (state === "complete") {
    return "border-feedback-success/40 bg-feedback-success/10 text-feedback-success";
  }
  if (state === "active") {
    return "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan";
  }
  if (state === "blocked") {
    return "border-feedback-warning/40 bg-feedback-warning/10 text-feedback-warning";
  }
  return "border-panel-line bg-surface-inset text-content-muted";
}
