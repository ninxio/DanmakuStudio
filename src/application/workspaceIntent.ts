export type WorkspacePage = "materials" | "matching" | "editing" | "export";

export type WorkspaceIntentTarget =
  | { kind: "media"; mediaId: string }
  | { kind: "xml"; assetId: string }
  | { kind: "candidate"; candidateId: string; spanIndex?: number }
  | { kind: "exportEntry"; targetMediaId: string }
  | { kind: "audioIssue"; mediaId: string };

export interface WorkspaceIntent {
  page: WorkspacePage;
  target: WorkspaceIntentTarget;
}

export interface WorkspaceIntentRequest {
  sequence: number;
  intent: WorkspaceIntent;
}
