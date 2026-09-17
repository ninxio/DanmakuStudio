import { useEffect } from "react";
import { getProjectDurationMs } from "../../domain/timeline/mapping";
import { useEditorStore } from "../../stores/editorStore";
import { resolveWorkspaceShortcut } from "../workspace/workspaceCommands";

interface KeyboardShortcutsProps {
  onOpenCommandPalette: () => void;
}

export function KeyboardShortcuts({ onOpenCommandPalette }: KeyboardShortcutsProps) {
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const selectAllClips = useEditorStore((state) => state.selectAllClips);
  const moveSelectedDanmaku = useEditorStore((state) => state.moveSelectedDanmaku);
  const moveSelectedClips = useEditorStore((state) => state.moveSelectedClips);
  const moveSelectedCutMarkers = useEditorStore((state) => state.moveSelectedCutMarkers);
  const addCutMarkerAtPlayhead = useEditorStore((state) => state.addCutMarkerAtPlayhead);
  const fitTimelineToContent = useEditorStore((state) => state.fitTimelineToContent);
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const setTimelineTool = useEditorStore((state) => state.setTimelineTool);
  const splitSelectedClipsAtPlayhead = useEditorStore(
    (state) => state.splitSelectedClipsAtPlayhead
  );
  const mergeSelectedClips = useEditorStore((state) => state.mergeSelectedClips);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (useEditorStore.getState().projectLibrary.switchingProject) return;
      // A disabled submit button can release focus to the document while a modal
      // is busy. Global editing shortcuts must still leave dismissal to that modal.
      if (
        event.defaultPrevented ||
        document.querySelector('[role="dialog"][aria-modal="true"]') ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      const shortcut = resolveWorkspaceShortcut(event);
      if (!shortcut) {
        return;
      }

      event.preventDefault();
      switch (shortcut) {
        case "command-palette":
          onOpenCommandPalette();
          break;
        case "toggle-playback":
          togglePlayback();
          break;
        case "redo":
          redo();
          break;
        case "undo":
          undo();
          break;
        case "select-all-clips":
          selectAllClips();
          break;
        case "split-clips":
          splitSelectedClipsAtPlayhead();
          break;
        case "merge-clips":
          mergeSelectedClips();
          break;
        case "delete-selection":
          deleteSelection();
          break;
        case "nudge-left":
        case "nudge-right": {
          const direction = shortcut === "nudge-right" ? 1 : -1;
          const step = event.altKey ? 1000 : event.shiftKey ? 100 : 10;
          if (selection.kind === "clip") {
            moveSelectedClips(direction * step);
          } else if (selection.kind === "cut") {
            moveSelectedCutMarkers(direction * step);
          } else if (selection.kind === "danmaku") {
            moveSelectedDanmaku(direction * step);
          } else {
            setPlayhead(project.timeline.playheadMs + direction * step);
          }
          break;
        }
        case "timeline-start":
          setPlayhead(0);
          break;
        case "timeline-end":
          setPlayhead(getProjectDurationMs(project));
          break;
        case "clear-selection":
          clearSelection();
          break;
        case "add-marker":
          addCutMarkerAtPlayhead();
          break;
        case "select-tool":
          setTimelineTool("select");
          break;
        case "blade-tool":
          setTimelineTool("blade");
          break;
        case "fit-timeline":
          fitTimelineToContent();
          break;
        case "zoom-in":
          setTimelineZoom(project.timeline.pixelsPerSecond * 1.2);
          break;
        case "zoom-out":
          setTimelineZoom(project.timeline.pixelsPerSecond * 0.84);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    addCutMarkerAtPlayhead,
    clearSelection,
    deleteSelection,
    fitTimelineToContent,
    mergeSelectedClips,
    moveSelectedClips,
    moveSelectedCutMarkers,
    moveSelectedDanmaku,
    onOpenCommandPalette,
    project,
    project.timeline.pixelsPerSecond,
    project.timeline.playheadMs,
    redo,
    selectAllClips,
    selection.kind,
    setPlayhead,
    setTimelineZoom,
    setTimelineTool,
    splitSelectedClipsAtPlayhead,
    togglePlayback,
    undo
  ]);

  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, dialog, [role="dialog"], [contenteditable]:not([contenteditable="false"])'
    )
  );
}
