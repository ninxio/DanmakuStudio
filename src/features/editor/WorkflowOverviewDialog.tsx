import { useMemo } from "react";
import {
  createWorkflowOverview,
  type WorkflowActionId
} from "../../domain/project/workflowOverview";
import { useEditorStore } from "../../stores/editorStore";
import { WorkflowOverviewPresentation } from "./WorkflowOverviewPresentation";

interface WorkflowOverviewDialogProps {
  onClose: () => void;
  onImportVideo: () => void;
  onImportXml: () => void;
  onGoMatching: () => void;
  onGoEditing: () => void;
  onSaveProject: () => void;
  onExportXml: () => void;
}

export function WorkflowOverviewDialog({
  onClose,
  onImportVideo,
  onImportXml,
  onGoMatching,
  onGoEditing,
  onSaveProject,
  onExportXml
}: WorkflowOverviewDialogProps) {
  const project = useEditorStore((state) => state.project);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const cleanupProjectEditReferences = useEditorStore(
    (state) => state.cleanupProjectEditReferences
  );
  const cleanupProjectMissingAssetClips = useEditorStore(
    (state) => state.cleanupProjectMissingAssetClips
  );
  const overview = useMemo(
    () => createWorkflowOverview(project, alignmentProposal ?? project.alignmentProposal),
    [alignmentProposal, project]
  );
  const actionHandlers: Record<WorkflowActionId, () => void> = {
    "import-video": onImportVideo,
    "import-xml": onImportXml,
    "auto-arrange": autoArrangeClips,
    "review-matches": () => {
      onClose();
      onGoMatching();
    },
    "edit-relations": () => {
      onClose();
      onGoEditing();
    },
    "cleanup-edit-references": cleanupProjectEditReferences,
    "cleanup-missing-clips": cleanupProjectMissingAssetClips,
    "save-project": onSaveProject,
    "export-xml": () => {
      onClose();
      onExportXml();
    }
  };

  return (
    <WorkflowOverviewPresentation
      viewModel={overview}
      onIntent={(intent) => {
        if (intent.type === "dismiss") {
          onClose();
          return;
        }
        actionHandlers[intent.actionId]();
      }}
    />
  );
}
