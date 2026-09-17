import { isTauri } from "@tauri-apps/api/core";
import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import {
  SUPPORTED_AUDIO_FILE_EXTENSIONS,
  SUPPORTED_MEDIA_FILE_EXTENSIONS,
  SUPPORTED_VIDEO_FILE_EXTENSIONS
} from "../../domain/project/mediaFormat";
import type { ProjectMediaRole } from "../../domain/project/types";

export type NativeOpenDialog = (options: OpenDialogOptions) => Promise<string | string[] | null>;

export const VIDEO_FILE_EXTENSIONS = [...SUPPORTED_VIDEO_FILE_EXTENSIONS];
export const AUDIO_FILE_EXTENSIONS = [...SUPPORTED_AUDIO_FILE_EXTENSIONS];
export const MEDIA_FILE_EXTENSIONS = [...SUPPORTED_MEDIA_FILE_EXTENSIONS];

export const VIDEO_FILE_FILTERS = [
  {
    name: "视频文件",
    extensions: VIDEO_FILE_EXTENSIONS
  }
];

export const MEDIA_FILE_FILTERS = [
  {
    name: "视频或音频文件",
    extensions: MEDIA_FILE_EXTENSIONS
  }
];

export const XML_FILE_FILTERS = [
  {
    name: "B 站弹幕 XML",
    extensions: ["xml"]
  }
];

export async function pickXmlPaths(
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string[]> {
  return pickMultipleNativePaths(
    {
      title: "选择弹幕 XML",
      filters: XML_FILE_FILTERS
    },
    dialog
  );
}

export async function pickMediaPaths(
  role: ProjectMediaRole,
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string[]> {
  return pickMultipleNativePaths(
    {
      title: role === "targetOriginal" ? "选择原片素材" : "选择 B 站参考素材",
      filters: MEDIA_FILE_FILTERS
    },
    dialog
  );
}

export async function pickAlignmentMediaPath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativePath(
    {
      title: "选择完整版或当前媒体",
      filters: MEDIA_FILE_FILTERS,
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickFfmpegExecutablePath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativePath(
    {
      title: "选择 FFmpeg 可执行文件",
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickMpvExecutablePath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativePath(
    {
      title: "选择 mpv 可执行文件",
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickExportDirectoryPath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativeDirectoryPath(
    {
      title: "选择导出文件夹",
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickSingleNativePath(
  options: OpenDialogOptions,
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  if (dialog === defaultNativeOpenDialog && !isTauri()) {
    throw new Error("原生文件选择器需要在 Tauri 桌面端运行。");
  }
  const selected = await dialog({
    ...options,
    multiple: false,
    directory: false
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  return path && path.trim().length > 0 ? path : null;
}

export async function pickMultipleNativePaths(
  options: OpenDialogOptions,
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string[]> {
  if (dialog === defaultNativeOpenDialog && !isTauri()) {
    throw new Error("原生文件选择器需要在 Tauri 桌面端运行。");
  }
  const selected = await dialog({
    ...options,
    multiple: true,
    directory: false
  });
  return normalizeSelectedPaths(selected);
}

export async function pickSingleNativeDirectoryPath(
  options: OpenDialogOptions,
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  if (dialog === defaultNativeOpenDialog && !isTauri()) {
    throw new Error("原生目录选择器需要在 Tauri 桌面端运行。");
  }
  const selected = await dialog({
    ...options,
    multiple: false,
    directory: true
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  return path && path.trim().length > 0 ? path : null;
}

function defaultNativeOpenDialog(options: OpenDialogOptions): Promise<string | string[] | null> {
  return open(options);
}

function normalizeDefaultPath(path: string): string | undefined {
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSelectedPaths(selected: string | string[] | null): string[] {
  const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
  const normalized: string[] = [];
  const seen = new Set<string>();
  paths.forEach((path) => {
    const trimmed = path.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    normalized.push(trimmed);
  });
  return normalized;
}
