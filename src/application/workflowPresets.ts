import type { WorkflowDefaults, WorkflowPreset } from "../domain/project/workflowPreset";
import { isWorkflowDefaults } from "../domain/project/workflowPreset";
import { loadAppSettings } from "../infrastructure/settings/appSettings";
import { persistDesktopAppSettings } from "../infrastructure/settings/desktopAppSettings";
/** Copy exactly the currently consumed settings; never spread machine configuration. */
export function currentWorkflowDefaults(): WorkflowDefaults {
  const settings = loadAppSettings(),
    a = settings.alignment;
  return {
    downloadAudio: settings.acquisition?.downloadAudio ?? true,
    provider: settings.acquisition?.provider ?? "ext",
    spectralBackend: a.spectralBackend,
    windowMs: a.windowMs,
    minGapMs: a.minGapMs,
    matchThreshold: a.matchThreshold
  };
}
export async function saveWorkflowPreset(preset: WorkflowPreset): Promise<void> {
  if (!preset.name.trim() || preset.name.length > 100 || !isWorkflowDefaults(preset.defaults))
    throw new Error("预设名称或选项无效。");
  const settings = loadAppSettings(),
    rows = settings.workflowPresets ?? [];
  if (rows.length >= 50 && !rows.some((p) => p.id === preset.id))
    throw new Error("最多保存 50 个预设。");
  await persistDesktopAppSettings({
    ...settings,
    workflowPresets: [...rows.filter((p) => p.id !== preset.id), structuredClone(preset)]
  });
}
export async function removeWorkflowPreset(id: string): Promise<void> {
  const settings = loadAppSettings();
  await persistDesktopAppSettings({
    ...settings,
    workflowPresets: (settings.workflowPresets ?? []).filter((p) => p.id !== id)
  });
}
export async function applyWorkflowDefaults(defaults: WorkflowDefaults): Promise<void> {
  if (!isWorkflowDefaults(defaults)) throw new Error("预设包含无效选项，未应用。");
  const settings = loadAppSettings();
  await persistDesktopAppSettings({
    ...settings,
    acquisition: { downloadAudio: defaults.downloadAudio, provider: defaults.provider },
    alignment: {
      ...settings.alignment,
      spectralBackend: defaults.spectralBackend,
      windowMs: defaults.windowMs,
      minGapMs: defaults.minGapMs,
      matchThreshold: defaults.matchThreshold
    }
  });
}
export async function rememberAcquisition(patch: Partial<WorkflowDefaults>): Promise<void> {
  const current = currentWorkflowDefaults();
  await applyWorkflowDefaults({ ...current, ...patch });
}
