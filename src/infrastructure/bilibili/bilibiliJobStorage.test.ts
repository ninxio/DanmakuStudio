import { beforeEach, describe, expect, it } from "vitest";
import { loadBilibiliJob, saveBilibiliJob } from "./bilibiliJobStorage";
describe("Bilibili task persistence", () => {
  beforeEach(() => localStorage.clear());
  it("persists only a resumable request, never a Cookie or progress/error text", () => {
    const draft = {
      input: "BV1xx411c7mD",
      outputFolder: "C:/media",
      selectedCids: [1],
      downloadAudio: true,
      cookie: "secret"
    };
    saveBilibiliJob({
      version: 1,
      draft,
      context: { projectId: "p", projectEpoch: 1, projectName: "项目" },
      results: [],
      phase: "running"
    });
    expect(localStorage.getItem("danmaku-bilibili-acquisition-v1")).not.toContain("secret");
    expect(loadBilibiliJob()?.draft).not.toHaveProperty("cookie");
    expect(loadBilibiliJob()?.phase).toBe("running");
  });
  it("rejects corrupt or unbounded records", () => {
    localStorage.setItem("danmaku-bilibili-acquisition-v1", '{"version":1}');
    expect(() => loadBilibiliJob()).toThrow();
  });
});
