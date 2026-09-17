import { beforeEach, describe, expect, it } from "vitest";
import type { SyntheticAlignmentLabQueueSummary } from "../../domain/alignment/syntheticAlignmentLabQueue";
import {
  SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY,
  clearDesktopSyntheticAlignmentLabBaseline,
  hydrateDesktopSyntheticAlignmentLabBaseline,
  loadSyntheticAlignmentLabBaseline,
  persistDesktopSyntheticAlignmentLabBaseline,
  type DesktopSyntheticAlignmentLabBaselineBridge
} from "./syntheticAlignmentLabBaselineStore";

describe("程序化回归基线持久化", () => {
  beforeEach(() => localStorage.clear());

  it("本地镜像严格读取并清除损坏内容", () => {
    localStorage.setItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY, "{}");
    expect(loadSyntheticAlignmentLabBaseline(localStorage)).toBeNull();
    expect(localStorage.getItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY)).toBeNull();
  });

  it("桌面文件不存在时迁移浏览器兼容镜像", async () => {
    const value = summary("local");
    localStorage.setItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY, JSON.stringify(value));
    const bridge = memoryBridge(null);

    await expect(
      hydrateDesktopSyntheticAlignmentLabBaseline(localStorage, bridge)
    ).resolves.toEqual(value);
    expect(bridge.saved()).toContain("alignment-synthetic-lab-summary-v1");
  });

  it("桌面基线为权威并同步覆盖本地镜像", async () => {
    const desktop = summary("desktop");
    const bridge = memoryBridge(JSON.stringify(desktop));

    await expect(
      hydrateDesktopSyntheticAlignmentLabBaseline(localStorage, bridge)
    ).resolves.toEqual(desktop);
    expect(localStorage.getItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY)).toContain(
      "desktop"
    );
  });

  it("串行保存并同时清除桌面与本地基线", async () => {
    const bridge = memoryBridge(null);
    await persistDesktopSyntheticAlignmentLabBaseline(summary("first"), localStorage, bridge);
    await persistDesktopSyntheticAlignmentLabBaseline(summary("second"), localStorage, bridge);
    expect(bridge.saved()).toContain("second");
    await clearDesktopSyntheticAlignmentLabBaseline(localStorage, bridge);
    expect(bridge.saved()).toBeNull();
    expect(localStorage.getItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY)).toBeNull();
  });

  it("拒绝把尚未完成的汇总保存成历史基线", () => {
    const pending = summary("pending");
    pending.state = "ready";
    pending.suites[0].state = "pending";
    pending.suites[0].receipt = null;
    expect(() =>
      persistDesktopSyntheticAlignmentLabBaseline(pending, localStorage, memoryBridge(null))
    ).toThrow("必须已经运行到终态");
  });
});

function memoryBridge(initial: string | null): DesktopSyntheticAlignmentLabBaselineBridge & {
  saved: () => string | null;
} {
  let value = initial;
  return {
    load: () => Promise.resolve(value),
    save: (content) => {
      value = content;
      return Promise.resolve();
    },
    clear: () => {
      value = null;
      return Promise.resolve();
    },
    saved: () => value
  };
}

function summary(queueId: string): SyntheticAlignmentLabQueueSummary {
  return {
    schemaVersion: "alignment-synthetic-lab-summary-v1",
    queueId,
    state: "completed",
    createdAtMs: 1,
    updatedAtMs: 2,
    suiteCount: 1,
    totalCaseCount: 1,
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold",
    suites: [
      {
        suiteId: "suite-a",
        manifestDigest: `sha256:${"a".repeat(64)}`,
        manifestId: "manifest-a",
        datasetVersion: "v1",
        caseCount: 1,
        state: "completed",
        attemptCount: 1,
        interruptionCount: 0,
        receipt: {
          status: "completed",
          completedAtMs: 2,
          completedCaseCount: 1,
          failedCaseCount: 0,
          cancelledCaseCount: 0,
          missingPredictionCount: 0,
          boundaryP95Ms: 500,
          editClassificationF1: 1,
          mappingCoverage: 1,
          failureCode: null
        }
      }
    ]
  };
}
