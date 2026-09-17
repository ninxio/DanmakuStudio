import { Button } from "../../components/Button";
import { useRovingFocusList } from "../../components/useRovingFocusList";
import { useEffect, useRef, useState, type KeyboardEventHandler } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, Gauge } from "lucide-react";
import {
  hydrateDesktopAlignmentExperimentQueue,
  loadAlignmentExperimentQueue
} from "../../infrastructure/alignment/alignmentExperimentQueueStore";
import { useEditorStore } from "../../stores/editorStore";
import { alignmentExperimentQueueToBatchTasks } from "../matching/matchingExperimentQueue";
import type { BatchTask } from "../matching/matchingTaskModels";
import {
  createAlignmentReviewWorkbenchModel,
  type AlignmentReviewGroupKind,
  type AlignmentReviewIntent,
  type AlignmentReviewItemViewModel,
  type AlignmentReviewWorkbenchViewModel
} from "./alignmentReviewWorkbenchModel";

interface QueueTaskSnapshot {
  projectId: string;
  tasks: BatchTask[];
}

interface AlignmentReviewWorkbenchPresentationProps {
  model: AlignmentReviewWorkbenchViewModel;
  selectedCandidateId: string | null;
  onIntent: (intent: AlignmentReviewIntent) => void;
}

export function AlignmentRelationNavigator() {
  const project = useEditorStore((state) => state.project);
  const selectedCandidateId = useEditorStore((state) => state.alignmentEditorCandidateId);
  const requestWorkspaceIntent = useEditorStore((state) => state.requestWorkspaceIntent);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueTaskSnapshot>(() =>
    readLocalQueueTasks(project.id)
  );

  useEffect(() => {
    const projectId = project.id;
    let current = true;
    setQueueSnapshot((snapshot) =>
      snapshot.projectId === projectId ? snapshot : readLocalQueueTasks(projectId)
    );
    void hydrateDesktopAlignmentExperimentQueue(projectId)
      .then((queue) => {
        if (!current || useEditorStore.getState().project.id !== projectId) {
          return;
        }
        setQueueSnapshot({
          projectId,
          tasks: queue ? alignmentExperimentQueueToBatchTasks(queue) : []
        });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [project.id]);

  const model = createAlignmentReviewWorkbenchModel({
    media: project.mediaLibrary,
    candidates: project.mediaMatchCandidates,
    timeMaps: project.mediaTimeMaps,
    bindings: project.danmakuSourceBindings,
    tasks: queueSnapshot.projectId === project.id ? queueSnapshot.tasks : []
  });

  const handleIntent = (intent: AlignmentReviewIntent) => {
    if (intent.kind === "openCandidate") {
      requestWorkspaceIntent({
        page: "editing",
        target: { kind: "candidate", candidateId: intent.candidateId }
      });
      return;
    }
    setWorkspacePage("matching");
  };

  return (
    <AlignmentReviewWorkbenchPresentation
      model={model}
      selectedCandidateId={selectedCandidateId}
      onIntent={handleIntent}
    />
  );
}

function AlignmentReviewWorkbenchPresentation({
  model,
  selectedCandidateId,
  onIntent
}: AlignmentReviewWorkbenchPresentationProps) {
  const [completedOpen, setCompletedOpen] = useState(false);
  const returnButtonRef = useRef<HTMLButtonElement | null>(null);
  const hasResults =
    model.summary.priorityCount > 0 ||
    model.summary.completedCount > 0 ||
    model.summary.inProgressCount > 0;
  const priorityItems = model.priorityGroups.flatMap((group) => group.items);
  const visibleItems = completedOpen
    ? [...priorityItems, ...model.completedItems]
    : priorityItems;
  const rovingItems = useRovingFocusList({
    itemIds: visibleItems.map((item) => item.pairId),
    preferredId:
      visibleItems.find(
        (item) =>
          item.nextAction.kind === "openCandidate" &&
          item.nextAction.candidateId === selectedCandidateId
      )?.pairId ?? null,
    onEscape: () => returnButtonRef.current?.focus()
  });

  return (
    <section
      className="relation-navigator"
      data-testid="alignment-relation-navigator"
      aria-label="异常优先复核工作台"
    >
      <div className="relation-navigator-heading">
        <div className="flex items-center justify-between gap-2">
          <h2>{model.summary.label}</h2>
          <span className="tabular-nums text-content-muted">{model.summary.priorityCount}</span>
        </div>
        <p className="text-xs text-content-muted">
          <span>{model.summary.completedCount} 项已完成</span>
          {model.summary.inProgressCount > 0 ? (
            <span>
              {" "}
              · <span>{model.summary.inProgressCount} 项分析中</span>
            </span>
          ) : null}
        </p>
        <Button
          ref={returnButtonRef}
          tone="unstyled"
          className="navigator-return"
          onClick={() => onIntent({ kind: "resumeMatching" })}
        >
          <ArrowLeft size={13} />
          返回智能匹配
        </Button>
      </div>
      {!hasResults ? (
        <div className="m-3 rounded border border-dashed border-panel-line p-3 text-xs leading-5 text-content-muted">
          还没有可复核的关系。先到“匹配”运行智能分析，候选结果会出现在这里。
        </div>
      ) : (
        <div role="list" className="relation-queue-scroll" aria-label="异常优先复核队列">
          {model.priorityGroups.flatMap((group) => [
            <h3
              key={`heading:${group.kind}`}
              className="mb-1.5 mt-1 flex items-center justify-between px-1 text-ui-caption font-medium text-content-secondary first:mt-0"
            >
              <span>{group.title}</span>
              <span className="tabular-nums text-content-muted">{group.items.length}</span>
            </h3>,
            ...group.items.map((item) => (
              <ReviewItemButton
                key={item.pairId}
                item={item}
                group={group.kind}
                selectedCandidateId={selectedCandidateId}
                onIntent={onIntent}
                tabIndex={rovingItems.getItemTabIndex(item.pairId)}
                buttonRef={(element) => rovingItems.setItemRef(item.pairId, element)}
                onFocus={() => rovingItems.onItemFocus(item.pairId)}
                onKeyDown={(event) => rovingItems.onItemKeyDown(event, item.pairId)}
              />
            ))
          ])}

          {model.summary.inProgressCount > 0 ? (
            <div className="px-2 py-3 text-xs text-content-muted">
              <Clock3 className="mr-1 inline" size={13} />
              后台正在分析 {model.summary.inProgressCount} 组关系。
            </div>
          ) : null}

          {model.completedItems.length > 0 ? (
            <details
              className="relation-completed"
              open={completedOpen}
              onToggle={(event) => setCompletedOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer select-none px-2.5 py-2 text-ui-caption font-medium text-feedback-success focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan">
                已完成并验证 {model.completedItems.length}
              </summary>
              <div className="pt-1">
                {model.completedItems.map((item) => (
                  <ReviewItemButton
                    key={item.pairId}
                    item={item}
                    group="completed"
                    selectedCandidateId={selectedCandidateId}
                    onIntent={onIntent}
                    tabIndex={rovingItems.getItemTabIndex(item.pairId)}
                    buttonRef={(element) => rovingItems.setItemRef(item.pairId, element)}
                    onFocus={() => rovingItems.onItemFocus(item.pairId)}
                    onKeyDown={(event) => rovingItems.onItemKeyDown(event, item.pairId)}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ReviewItemButton({
  item,
  group,
  selectedCandidateId,
  onIntent,
  tabIndex,
  buttonRef,
  onFocus,
  onKeyDown
}: {
  item: AlignmentReviewItemViewModel;
  group: AlignmentReviewGroupKind | "completed";
  selectedCandidateId: string | null;
  onIntent: (intent: AlignmentReviewIntent) => void;
  tabIndex: 0 | -1;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}) {
  const candidateId =
    item.nextAction.kind === "openCandidate" ? item.nextAction.candidateId : null;
  const selected = candidateId !== null && candidateId === selectedCandidateId;
  const visual = groupVisual(group);
  const Icon = visual.icon;

  return (
    <div role="listitem" className="relation-queue-row">
      <Button
        tone="unstyled"
        ref={buttonRef}
        type="button"
        aria-pressed={candidateId === null ? undefined : selected}
        tabIndex={tabIndex}
        className="relation-queue-item"
        aria-label={`${item.statusLabel} ${item.targetLabel} ${item.sourceLabel} ${item.nextAction.kind === "openCandidate" ? "打开这条关系" : "返回匹配处理"}`}
        aria-description={item.reasons.join("；")}
        title={[item.targetLabel, ...item.reasons, item.rangeLabel].filter(Boolean).join("\n")}
        onClick={() => onIntent(item.nextAction)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        <span className={`relation-queue-icon ${visual.textClass}`}>
          <Icon size={15} />
        </span>
        <span className="relation-queue-content">
          <span className="relation-queue-name">{item.sourceLabel}</span>
          <span className="relation-queue-target">
            <span aria-hidden="true">→ </span>
            <span>{item.targetLabel}</span>
          </span>
          <span className={`text-ui-caption ${visual.textClass}`}>{item.statusLabel}</span>
        </span>
        <span className="sr-only">
          {item.nextAction.kind === "openCandidate" ? "打开这条关系" : "返回匹配处理"}
        </span>
      </Button>
    </div>
  );
}

function readLocalQueueTasks(projectId: string): QueueTaskSnapshot {
  const queue = loadAlignmentExperimentQueue(projectId);
  return {
    projectId,
    tasks: queue ? alignmentExperimentQueueToBatchTasks(queue) : []
  };
}

function groupVisual(group: AlignmentReviewGroupKind | "completed") {
  if (group === "blocked") {
    return {
      icon: CircleAlert,
      textClass: "text-feedback-warning",
      borderClass: "border-feedback-warning/30"
    };
  }
  if (group === "lowConfidence") {
    return {
      icon: Gauge,
      textClass: "text-feedback-warning",
      borderClass: "border-orange-400/25"
    };
  }
  if (group === "completed") {
    return {
      icon: CheckCircle2,
      textClass: "text-feedback-success",
      borderClass: "border-feedback-success/25"
    };
  }
  return {
    icon: Clock3,
    textClass: "text-feedback-running",
    borderClass: "border-feedback-running/25"
  };
}
