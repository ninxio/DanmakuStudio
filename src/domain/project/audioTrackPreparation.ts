export type AudioTrackIntent =
  | { mode: "auto" }
  | {
      mode: "explicit";
      streamIndex: number;
      inventoryRevision: string;
    };

export type AudioTrackProbeCompleteness = "complete" | "partial" | "fallbackRequired";

export type AudioTrackInventoryRecommendation =
  | { state: "recommended"; streamIndex: number | null }
  | { state: "needsChoice" | "unavailable"; streamIndex: null };

export type AudioTrackInventoryObservation =
  | { state: "unobserved" | "queued" | "probing" | "cancelled" }
  | { state: "notEligible"; reason: "missingLocalPath" | "needsReconnect" }
  | { state: "failed"; message: string }
  | {
      state: "ready";
      inventoryRevision: string;
      streamIndexes: readonly number[];
      probeCompleteness: AudioTrackProbeCompleteness;
      recommendation: AudioTrackInventoryRecommendation;
    };

export type AudioTrackPreparation =
  | {
      state: "ready";
      source: "auto" | "explicit";
      inventoryRevision: string;
      finalStreamIndex: number;
    }
  | {
      state: "preparing";
      phase: "unobserved" | "queued" | "probing";
      finalStreamIndex: null;
    }
  | {
      state: "notEligible";
      reason: "missingLocalPath" | "needsReconnect";
      finalStreamIndex: null;
    }
  | {
      state: "failed";
      message: string;
      finalStreamIndex: null;
    }
  | { state: "cancelled"; finalStreamIndex: null }
  | {
      state: "needsChoice";
      reason: "metadataPartial" | "recommendationNeedsChoice" | "recommendedTrackMissing";
      inventoryRevision: string;
      finalStreamIndex: null;
    }
  | {
      state: "unavailable";
      inventoryRevision: string;
      finalStreamIndex: null;
    }
  | {
      state: "needsReview";
      reason: "inventoryRevisionChanged" | "streamMissing";
      inventoryRevision: string;
      previousStreamIndex: number;
      finalStreamIndex: null;
    };

export type AudioTrackIntentCommand =
  | { mode: "auto" }
  | { mode: "explicit"; streamIndex: number };

export function isAudioTrackIntent(value: unknown): value is AudioTrackIntent {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === "auto") {
    return Object.keys(value).length === 1;
  }
  if (value.mode !== "explicit") {
    return false;
  }
  return (
    Object.keys(value).length === 3 &&
    Number.isSafeInteger(value.streamIndex) &&
    (value.streamIndex as number) >= 0 &&
    typeof value.inventoryRevision === "string" &&
    value.inventoryRevision.trim().length > 0 &&
    new TextEncoder().encode(value.inventoryRevision).byteLength <= 128
  );
}

export function applyAudioTrackIntentCommand(
  observation: AudioTrackInventoryObservation,
  command: AudioTrackIntentCommand
): AudioTrackIntent {
  if (command.mode === "auto") {
    return { mode: "auto" };
  }
  if (observation.state !== "ready") {
    throw new Error("音轨清单尚未就绪，不能保存显式选择。");
  }
  if (!observation.streamIndexes.includes(command.streamIndex)) {
    throw new Error(`当前音轨清单中不存在 #${command.streamIndex}。`);
  }
  return {
    mode: "explicit",
    streamIndex: command.streamIndex,
    inventoryRevision: observation.inventoryRevision
  };
}

export function evaluateAudioTrackPreparation(
  intent: AudioTrackIntent,
  observation: AudioTrackInventoryObservation
): AudioTrackPreparation {
  if (observation.state !== "ready") {
    if (observation.state === "notEligible") {
      return { state: "notEligible", reason: observation.reason, finalStreamIndex: null };
    }
    if (observation.state === "failed") {
      return { state: "failed", message: observation.message, finalStreamIndex: null };
    }
    if (observation.state === "cancelled") {
      return { state: "cancelled", finalStreamIndex: null };
    }
    return {
      state: "preparing",
      phase: observation.state,
      finalStreamIndex: null
    };
  }

  const streamIndexes = new Set(observation.streamIndexes);
  if (intent.mode === "explicit") {
    if (intent.inventoryRevision !== observation.inventoryRevision) {
      return {
        state: "needsReview",
        reason: "inventoryRevisionChanged",
        inventoryRevision: observation.inventoryRevision,
        previousStreamIndex: intent.streamIndex,
        finalStreamIndex: null
      };
    }
    if (!streamIndexes.has(intent.streamIndex)) {
      return {
        state: "needsReview",
        reason: "streamMissing",
        inventoryRevision: observation.inventoryRevision,
        previousStreamIndex: intent.streamIndex,
        finalStreamIndex: null
      };
    }
    return {
      state: "ready",
      source: "explicit",
      inventoryRevision: observation.inventoryRevision,
      finalStreamIndex: intent.streamIndex
    };
  }

  if (observation.probeCompleteness === "partial") {
    return {
      state: "needsChoice",
      reason: "metadataPartial",
      inventoryRevision: observation.inventoryRevision,
      finalStreamIndex: null
    };
  }
  if (observation.recommendation.state === "unavailable") {
    return {
      state: "unavailable",
      inventoryRevision: observation.inventoryRevision,
      finalStreamIndex: null
    };
  }
  if (observation.recommendation.state === "needsChoice") {
    return {
      state: "needsChoice",
      reason: "recommendationNeedsChoice",
      inventoryRevision: observation.inventoryRevision,
      finalStreamIndex: null
    };
  }
  const recommendedStreamIndex = observation.recommendation.streamIndex;
  if (recommendedStreamIndex === null || !streamIndexes.has(recommendedStreamIndex)) {
    return {
      state: "needsChoice",
      reason: "recommendedTrackMissing",
      inventoryRevision: observation.inventoryRevision,
      finalStreamIndex: null
    };
  }
  return {
    state: "ready",
    source: "auto",
    inventoryRevision: observation.inventoryRevision,
    finalStreamIndex: recommendedStreamIndex
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
