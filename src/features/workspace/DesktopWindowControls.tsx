import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { observeDesktopWindowWorkspace } from "../../infrastructure/window/tauriWindowWorkspace";
import { useEditorStore } from "../../stores/editorStore";

export function DesktopWindowControls() {
  if (!isTauri()) return null;
  return <NativeWindowControls />;
}

function NativeWindowControls() {
  const [appWindow] = useState(getCurrentWindow);
  const [maximized, setMaximized] = useState(false);
  useEffect(
    () =>
      observeDesktopWindowWorkspace(appWindow, setMaximized, (error) => {
        useEditorStore.setState({
          status: {
            message: `窗口工作区适配失败：${formatWindowActionError(error)}`,
            tone: "error"
          }
        });
      }),
    [appWindow]
  );
  const runWindowAction = (label: string, action: () => Promise<void>) => {
    void action().catch((error: unknown) => {
      useEditorStore.setState({
        status: {
          message: `${label}失败：${formatWindowActionError(error)}`,
          tone: "error"
        }
      });
    });
  };

  return (
    <div role="group" aria-label="窗口控制" className="flex shrink-0 items-stretch">
      <IconButton
        label="最小化窗口"
        icon={<Minus size={15} />}
        className="!h-10 !w-12 rounded-none border-transparent bg-transparent"
        onClick={() => runWindowAction("最小化窗口", () => appWindow.minimize())}
      />
      <IconButton
        label={maximized ? "还原窗口" : "最大化窗口"}
        icon={maximized ? <Copy size={13} /> : <Square size={13} />}
        className="!h-10 !w-12 rounded-none border-transparent bg-transparent"
        onClick={() => runWindowAction("最大化或还原窗口", () => appWindow.toggleMaximize())}
      />
      <IconButton
        label="关闭窗口"
        icon={<X size={16} />}
        danger
        className="!h-10 !w-12 rounded-none border-transparent bg-transparent"
        onClick={() => runWindowAction("关闭窗口", () => appWindow.close())}
      />
    </div>
  );
}

function formatWindowActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error).trim();
  return text || "未知错误";
}
