import { Check, CircleAlert } from "lucide-react";
import { Button } from "../../components/Button";
import type { UsabilityStepViewModel } from "../../domain/project/usabilityViewModel";
import type { WorkspacePage } from "../../stores/editorStore";

const LABELS: Record<WorkspacePage, string> = {
  materials: "素材",
  matching: "匹配",
  editing: "编辑",
  export: "导出"
};

export function WorkflowStepper({
  steps,
  activePage,
  onChange
}: {
  steps: UsabilityStepViewModel[];
  activePage: WorkspacePage;
  onChange: (page: WorkspacePage) => void;
}) {
  return (
    <nav
      aria-label="工作区页面"
      className="flex min-w-0 flex-1 items-center justify-center gap-1"
      data-testid="workflow-stepper"
    >
      {steps.map((step) => (
        <Button
          key={step.id}
          tone="unstyled"
          className="workflow-step"
          aria-current={activePage === step.id ? "page" : undefined}
          data-testid={"workspace-nav-" + step.id}
          title={
            step.headline +
            " · " +
            step.stateLabel +
            (step.issueCount ? " · " + step.issueCount + " 项待处理" : "")
          }
          onClick={() => onChange(step.id)}
        >
          <span className="workflow-step-number" aria-hidden="true">
            {step.state === "complete" ? <Check size={14} /> : step.order}
          </span>
          {LABELS[step.id]}
          {step.issueCount > 0 ? (
            <span className="text-feedback-warning" aria-label={step.issueCount + " 项待处理"}>
              <CircleAlert size={13} />
            </span>
          ) : null}
        </Button>
      ))}
    </nav>
  );
}
