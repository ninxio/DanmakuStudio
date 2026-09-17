import { useSyncExternalStore } from "react";
import { themeController } from "../infrastructure/settings/themePreferences";

/** Subscribe only where colors or the theme control need React work (not the app root). */
export function useTheme() {
  return useSyncExternalStore(
    themeController.subscribe,
    themeController.getSnapshot,
    themeController.getSnapshot
  );
}
