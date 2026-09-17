import { Layers3 } from "lucide-react";
import { DesktopWindowControls } from "./DesktopWindowControls";

/** Business controls never enter this hit-test surface. Tauri owns drag/double-click. */
export function WindowChrome() {
  return (
    <div className="window-chrome" aria-label="窗口标题栏">
      <div
        className="window-drag-region"
        data-tauri-drag-region
        data-testid="window-drag-region"
      >
        <span className="pointer-events-none flex items-center gap-2">
          <Layers3 size={16} className="text-primary" aria-hidden="true" />
          <span>Danmaku Studio</span>
        </span>
      </div>
      <DesktopWindowControls />
    </div>
  );
}
