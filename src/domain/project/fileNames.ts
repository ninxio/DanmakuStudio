export function createProjectDownloadFileName(
  projectName: string,
  suffix: string,
  fallbackBaseName = "danmaku-project"
): string {
  return `${createProjectFileBaseName(projectName, fallbackBaseName)}${suffix}`;
}

export function createProjectFileBaseName(projectName: string, fallbackBaseName = "danmaku-project"): string {
  const trimmedName = projectName.trim();
  return trimmedName.length > 0 ? trimmedName : fallbackBaseName;
}
