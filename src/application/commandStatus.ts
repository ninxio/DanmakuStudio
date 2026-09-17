export interface EditorStatus {
  message: string;
  tone: "neutral" | "success" | "warning" | "error";
  action?: {
    type: "openDirectory";
    label: string;
    directoryPath: string;
  };
}
