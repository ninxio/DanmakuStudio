import { createId } from "../../domain/project/factory";
import { createEmbyItemMediaBinding } from "../../domain/project/mediaBinding";
import type { MediaBinding } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import type { EmbyItemMetadata } from "../../infrastructure/metadata/embyClient";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { loadVolatileEmbyPassword } from "../../infrastructure/settings/volatileEmbyCredentials";
import { useEditorStore, type EditorStatus } from "../../stores/editorStore";

export interface EmbyConnectionState {
  config: {
    serverUrl: string;
    pathPrefix: string;
  };
  username: string;
  password: string;
  sessionKey: string;
}

export function setStatus(status: EditorStatus) {
  useEditorStore.setState({ status });
}

export function loadEmbyConnectionState(): EmbyConnectionState {
  const settings = loadAppSettings();
  const password = loadVolatileEmbyPassword(settings.emby);
  const serverUrl = settings.emby.serverUrl.trim();
  const pathPrefix = settings.emby.pathPrefix.trim();
  const username = settings.emby.username.trim();
  return {
    config: { serverUrl, pathPrefix },
    username,
    password,
    sessionKey: [serverUrl, pathPrefix, username, password].join("\n")
  };
}

export function createEmbyBindingFromItem(
  item: EmbyItemMetadata,
  connection: EmbyConnectionState
): MediaBinding {
  return createEmbyItemMediaBinding(createId("media_binding"), item, {
    serverUrl: connection.config.serverUrl,
    pathPrefix: connection.config.pathPrefix,
    username: connection.username
  });
}

export function validateEmbyConnectionState(connection: EmbyConnectionState): boolean {
  if (connection.config.serverUrl.length === 0) {
    setStatus({ message: "请先在设置中心填写 Emby 服务器地址。", tone: "warning" });
    return false;
  }
  if (connection.username.length === 0) {
    setStatus({ message: "请先在设置中心填写 Emby 用户名。", tone: "warning" });
    return false;
  }
  if (connection.password.length === 0) {
    setStatus({
      message: "请先在设置中心填写本次会话密码。密码不会写入本地设置。",
      tone: "warning"
    });
    return false;
  }
  return true;
}

export function formatSignedDuration(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "+";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}
