import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EditorProject } from "../../domain/project/types";
import { serializeProject } from "../../domain/project/schema";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { exportProjectBackup } from "./projectPersistence";

export interface ProjectStorageLocation {
  directoryPath: string;
  databasePath: string;
}
let storageLocation: Promise<ProjectStorageLocation> | null = null;
export function getProjectStorageLocation(): Promise<ProjectStorageLocation | null> {
  if (!isTauri()) return Promise.resolve(null);
  storageLocation ??= invoke<ProjectStorageLocation>("get_project_storage_location").catch(
    (error) => {
      storageLocation = null;
      throw error;
    }
  );
  return storageLocation;
}
export function openProjectFolder(directoryPath: string): Promise<void> {
  return invoke("open_export_directory", { directoryPath });
}
export async function savePortableProject(project: EditorProject): Promise<string | null> {
  if (!isTauri()) return exportProjectBackup(project);
  return invoke<string | null>("save_portable_project", {
    fileName: createProjectDownloadFileName(project.name, ".danmaku-project.json"),
    content: serializeProject(project)
  });
}
