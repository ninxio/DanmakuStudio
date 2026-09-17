import { ArrowRight } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import {
  createPageProgressHint,
  createWorkspaceProgress
} from "../../domain/project/workspaceProgress";
import { useEditorStore, type WorkspacePage } from "../../stores/editorStore";

/** One page summary. Global step navigation belongs exclusively to the window shell. */
export function WorkspaceProgressBanner({ pageId }: { pageId: WorkspacePage }) {
  const project = useEditorStore((state) => state.project);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const progress = createWorkspaceProgress(project);
  const current = progress.steps.find((step) => step.id === pageId);
  if (!current) return null;
  const next = progress.steps.find((step) => step.id === progress.recommendedPage);
  return (
    <section
      className="workspace-progress-summary"
      aria-label="工作流进度"
      data-testid="workspace-progress-banner"
    >
      <div className="min-w-0">
        <h2>{current.headline}</h2>
        <p>{createPageProgressHint(pageId, progress)}</p>
        {current.blockers.length > 1 ? (
          <p className="text-feedback-warning">{current.blockers.slice(1).join(" · ")}</p>
        ) : null}
      </div>
      {next && next.id !== pageId ? (
        <TextButton onClick={() => setWorkspacePage(next.id)}>
          去{next.label}页<ArrowRight size={14} />
        </TextButton>
      ) : null}
    </section>
  );
}
