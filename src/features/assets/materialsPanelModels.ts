export interface MediaAudioPreparationViewModel {
  statusText: string;
  detailText: string;
  tone: "neutral" | "success" | "warning" | "error";
  selectionValue: string;
  selectionPlaceholder: string;
  selectionOptions: Array<{ value: string; label: string }>;
  canSelect: boolean;
}

export interface MediaLibraryItemViewModel {
  id: string;
  name: string;
  fileName: string;
  audioOnly: boolean;
  connectionText: string;
  durationText: string;
  reconnectWarning: string | null;
  canReconnect: boolean;
  details: {
    role: string;
    content: string;
    duration: string;
    source: string;
    reference: string;
  };
  audioPreparation: MediaAudioPreparationViewModel;
}
