import { beforeEach, expect, it } from "vitest";
import {
  applyWorkflowDefaults,
  currentWorkflowDefaults,
  removeWorkflowPreset,
  saveWorkflowPreset
} from "./workflowPresets";
import {
  loadAppSettings,
  saveAppSettings,
  DEFAULT_APP_SETTINGS
} from "../infrastructure/settings/appSettings";
import { createAlignmentExperimentQueue } from "../domain/alignment/alignmentExperimentQueue";
import { resolveMatchingDefaults } from "./matchingDefaults";
beforeEach(() => localStorage.clear());
it("presets whitelist real defaults and preserve host configuration when applied or deleted", async () => {
  saveAppSettings({
    ...DEFAULT_APP_SETTINGS,
    alignment: { ...DEFAULT_APP_SETTINGS.alignment, ffmpegPath: "D:/ffmpeg.exe" },
    acquisition: { downloadAudio: false, provider: "nyaa" }
  });
  const defaults = currentWorkflowDefaults();
  expect(defaults).not.toHaveProperty("ffmpegPath");
  expect(defaults).not.toHaveProperty("pairingScope");
  await saveWorkflowPreset({ id: "preset", name: "音轨采集", defaults });
  await applyWorkflowDefaults({
    ...defaults,
    provider: "ext",
    spectralBackend: "cpu",
    windowMs: 9000
  });
  expect(loadAppSettings().alignment).toMatchObject({
    ffmpegPath: "D:/ffmpeg.exe",
    spectralBackend: "cpu",
    windowMs: 9000
  });
  await removeWorkflowPreset("preset");
  expect(loadAppSettings().workflowPresets).toEqual([]);
  expect(currentWorkflowDefaults().windowMs).toBe(9000);
});
it("a resumed queue retains all frozen matching defaults", () => {
  const settings = currentWorkflowDefaults();
  const queue = createAlignmentExperimentQueue({
    queueId: "q",
    projectId: "p",
    nowMs: 1,
    config: {
      sourceMediaIds: ["s"],
      targetMediaIds: ["t"],
      pairs: [{ sourceMediaId: "s", targetMediaId: "t" }],
      versionReuseGroups: [],
      audioStreamSelections: { s: 0, t: 0 },
      ...resolveMatchingDefaults(settings, settings.spectralBackend, null),
      enableVisualEvidence: true
    }
  });
  queue.state = "interrupted";
  const before = JSON.stringify(queue);
  expect(
    resolveMatchingDefaults(
      { ...settings, spectralBackend: "cpu", windowMs: 9999 },
      "cpu",
      queue
    )
  ).toEqual({
    spectralBackend: settings.spectralBackend,
    windowMs: settings.windowMs,
    minGapMs: settings.minGapMs,
    matchThreshold: settings.matchThreshold
  });
  expect(JSON.stringify(queue)).toBe(before);
});
