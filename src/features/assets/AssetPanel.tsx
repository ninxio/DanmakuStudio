import { MaterialsWorkspace } from "./MaterialsWorkspace";
import { LegacyEditingMaterialsPanel } from "./LegacyEditingMaterialsPanel";
import { MatchingWorkspace } from "../matching/MatchingWorkspace";
import { ExportWorkspace } from "../export/ExportWorkspace";

export type AssetPanelSection = "materials" | "matching" | "editing" | "export";

export { ProjectionExportPanel } from "../export/ProjectionExportPanel";

export function AssetPanel({ section }: { section: AssetPanelSection }) {
  if (section === "materials") return <MaterialsWorkspace />;
  if (section === "matching") return <MatchingWorkspace />;
  if (section === "export") return <ExportWorkspace />;
  return <LegacyEditingMaterialsPanel />;
}
