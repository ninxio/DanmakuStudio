import { useEffect, useMemo, useRef } from "react";
import {
  createMediaInventorySupervisor,
  type MediaInventorySupervisor
} from "../../application/mediaInventorySupervisor";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";
import { createMediaInventorySignature } from "../../stores/slices/mediaInventorySlice";

export function MediaInventoryLifecycle() {
  const project = useEditorStore((state) => state.project);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const inventoryGeneration = useEditorStore((state) => state.mediaInventoryGeneration);
  const inventoryPaused = useEditorStore((state) => state.mediaInventoryPaused);
  const synchronizeMediaInventory = useEditorStore(
    (state) => state.synchronizeMediaInventory
  );
  const supervisorRef = useRef<MediaInventorySupervisor | null>(null);
  const mountedRef = useRef(false);
  if (supervisorRef.current === null) {
    supervisorRef.current = createMediaInventorySupervisor({
      publish: (publication) => {
        useEditorStore.getState().applyMediaInventoryPublication(publication);
      }
    });
  }

  const mediaSignature = useMemo(
    () => createMediaInventorySignature(project.mediaLibrary),
    [project.mediaLibrary]
  );
  const desiredItems = useMemo(
    () =>
      project.mediaLibrary.flatMap((media) => {
        const localPath = media.localPath?.trim();
        return media.connectionState === "connected" && localPath
          ? [{ mediaId: media.id, localPath }]
          : [];
      }),
    [project.mediaLibrary]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const supervisor = supervisorRef.current;
      queueMicrotask(() => {
        if (!mountedRef.current && supervisorRef.current === supervisor && supervisor) {
          supervisorRef.current = null;
          void supervisor.dispose();
        }
      });
    };
  }, []);

  useEffect(() => {
    const supervisor = supervisorRef.current;
    if (!supervisor) return;
    const generationKey = synchronizeMediaInventory();
    if (inventoryPaused || desiredItems.length === 0) {
      void supervisor.reconcile(null);
      return;
    }
    const settings = loadAppSettings().alignment;
    void supervisor.reconcile({
      generationKey,
      items: desiredItems,
      ffmpegPath: settings.ffmpegPath.trim() || null,
      ffprobePath: null,
      cachePolicy: "reuseFresh"
    });
  }, [
    desiredItems,
    inventoryGeneration,
    inventoryPaused,
    mediaSignature,
    project.id,
    projectEpoch,
    synchronizeMediaInventory
  ]);

  return null;
}
