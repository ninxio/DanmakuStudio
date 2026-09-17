import { getAssetTimeRange } from "../../domain/timeline/mapping";
import { useEditorStore } from "../../stores/editorStore";
import { LegacyEditingMaterialsPresentation } from "./LegacyEditingMaterialsPresentation";

export function LegacyEditingMaterialsPanel() {
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline);
  const removeAssetFromTimeline = useEditorStore((state) => state.removeAssetFromTimeline);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const select = useEditorStore((state) => state.select);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const updateCutMarker = useEditorStore((state) => state.updateCutMarker);
  const deleteCutMarker = useEditorStore((state) => state.deleteCutMarker);
  const updateSyncAnchor = useEditorStore((state) => state.updateSyncAnchor);
  const deleteSyncAnchor = useEditorStore((state) => state.deleteSyncAnchor);

  return (
    <LegacyEditingMaterialsPresentation
      viewModel={{
        guidance:
          project.assets.length === 0
            ? "needsImport"
            : project.clips.length === 0
              ? "needsTimeline"
              : "ready",
        assetRows: project.assets.map((asset) => {
          const range = getAssetTimeRange(asset);
          return {
            assetId: asset.id,
            color: asset.color,
            fileName: asset.fileName,
            itemCount: asset.items.length,
            earliestMs: range.earliestMs,
            latestMs: range.latestMs,
            inTimeline: project.clips.some((clip) => clip.assetId === asset.id)
          };
        }),
        cutMarkerGroup: {
          markers: project.cutMarkers,
          selectedIds: selection.kind === "cut" ? selection.ids : []
        },
        syncAnchorGroup: {
          anchors: project.syncAnchors
        }
      }}
      onIntent={(intent) => {
        switch (intent.type) {
          case "goToMaterials":
            setWorkspacePage("materials");
            return;
          case "arrangeAssets":
            autoArrangeClips();
            return;
          case "placeAsset":
            addAssetToTimeline(intent.assetId);
            return;
          case "selectAssetClip": {
            const clip = project.clips.find(
              (candidate) => candidate.assetId === intent.assetId
            );
            if (clip) {
              select({ kind: "clip", ids: [clip.id] });
            }
            return;
          }
          case "unplaceAsset":
            removeAssetFromTimeline(intent.assetId);
            return;
          case "focusVersionDifference":
            select({ kind: "cut", ids: [intent.marker.id] });
            setPlayhead(intent.marker.sourceAtMs);
            return;
          case "changeVersionDifference":
            updateCutMarker(intent.id, intent.patch);
            return;
          case "removeVersionDifference":
            deleteCutMarker(intent.id);
            return;
          case "focusSyncAnchor":
            setPlayhead(intent.anchor.sourceMs);
            return;
          case "changeSyncAnchor":
            updateSyncAnchor(intent.id, intent.patch);
            return;
          case "removeSyncAnchor":
            deleteSyncAnchor(intent.id);
        }
      }}
    />
  );
}
