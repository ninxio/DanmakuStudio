import type { EditorProject } from "../../domain/project/types";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { parseProjectJson, serializeProject } from "../../domain/project/schema";
import { downloadTextFile } from "../file-system/browserFiles";

export function exportProjectBackup(project: EditorProject): string {
  return downloadTextFile(
    createProjectDownloadFileName(project.name, ".danmaku-project.json"),
    serializeProject(project),
    "application/json;charset=utf-8"
  );
}

export function loadProjectFromBackupText(text: string): EditorProject {
  return parseProjectJson(text);
}

/** @deprecated 兼容旧调用；新界面应称为导出项目备份。 */
export const saveProjectToDownload = exportProjectBackup;

/** @deprecated 兼容旧调用；新界面应称为从备份导入。 */
export const loadProjectFromText = loadProjectFromBackupText;
