import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAdapter } from "../../infrastructure/media/mediaAdapter";
import type { downloadTextFile } from "../../infrastructure/file-system/browserFiles";
import type { PlayerMediaSource } from "../../domain/player/playerEngine";
import type { Milliseconds } from "../../domain/shared/time";
import {
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import {
  createMultimodalBlindReviewPackFixture,
  createMultimodalBlindReviewPackFixtureWithTasks
} from "../../test/multimodalBlindReviewFixture";
import {
  buildMultimodalBlindReviewVoteSet,
  type MultimodalBlindReviewPack
} from "../../domain/alignment/multimodalBlindReview";
import {
  buildMultimodalBlindAdjudication,
  serializeMultimodalBlindAdjudication
} from "../../domain/alignment/multimodalBlindAdjudication";
import type { MultimodalBlindReviewDraftStorage } from "../../infrastructure/alignment/multimodalBlindReviewDraftStore";
import { MultimodalBlindReviewPanel } from "./MultimodalBlindReviewPanel";

function createStorage(): MultimodalBlindReviewDraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  };
}

function createAdapter() {
  let currentTimeMs = 0;
  const load = vi.fn((source: PlayerMediaSource, positionMs: Milliseconds = 0): Promise<void> => {
    void source;
    currentTimeMs = positionMs;
    return Promise.resolve();
  });
  const play = vi.fn((): Promise<void> => Promise.resolve());
  const adapter: MediaAdapter = {
    load,
    play,
    pause: vi.fn(),
    seek: vi.fn((positionMs: Milliseconds) => {
      currentTimeMs = positionMs;
    }),
    getCurrentTimeMs: vi.fn(() => currentTimeMs),
    getDurationMs: vi.fn(() => 65_000),
    getTracks: vi.fn(() => []),
    setPlaybackRate: vi.fn(),
    dispose: vi.fn()
  };
  return { adapter, load };
}

describe("MultimodalBlindReviewPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      player: { mpvPath: "C:\\tools\\mpv.exe", preferredBackend: "nativeMpv" }
    });
  });

  it("imports a blinded pack, plays B in-app and exports a Python-compatible anonymous vote", async () => {
    const user = userEvent.setup();
    const pack = createMultimodalBlindReviewPackFixture();
    const storage = createStorage();
    const adapterHarness = createAdapter();
    const downloadText = vi.fn<typeof downloadTextFile>(() => "vote.json");
    render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride
        draftStorage={storage}
        adapterFactory={() => adapterHarness.adapter}
        downloadText={downloadText}
      />
    );

    const file = new File([JSON.stringify(pack)], "blind-pack.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("导入多模态盲复核任务包"), file);
    expect(await screen.findByText("任务 1/1")).toBeInTheDocument();
    expect(screen.queryByText(/DINOv2 候选/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /A · 00:00:11/ }));
    await user.click(screen.getByLabelText("逐帧定位（可参与 Gold）"));
    await user.click(screen.getByRole("button", { name: "打开播放器" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "B · 目标原片" })).toBeEnabled());
    await waitFor(() =>
      expect(adapterHarness.load).toHaveBeenCalledWith(
        { kind: "file", name: "原片 B", url: pack.target.path },
        11_500
      )
    );
    await user.click(screen.getByRole("button", { name: "B · 目标原片" }));
    await waitFor(() =>
      expect(adapterHarness.load).toHaveBeenCalledWith(
        { kind: "file", name: "原片 B", url: pack.target.path },
        11_500
      )
    );

    await user.type(
      screen.getByPlaceholderText("例如 reviewer-demo"),
      "reviewer-a"
    );
    await user.click(screen.getByRole("button", { name: "导出匿名复核票" }));
    expect(downloadText).toHaveBeenCalledTimes(1);
    const content = downloadText.mock.calls[0][1];
    const vote = JSON.parse(content) as Record<string, unknown>;
    expect(content).not.toContain("reviewer-a");
    expect(vote).toMatchObject({
      schemaVersion: "alignment-multimodal-blind-review-vote-v1",
      packId: pack.packId,
      permission: "local-blind-review-vote-only",
      releaseEligible: false
    });
    expect(vote.votes).toEqual([
      expect.objectContaining({
        decision: "matched",
        targetTimestampMs: 11_500,
        precision: "frameAccurate"
      })
    ]);
    await waitFor(() => expect(storage.data.size).toBe(1));
    expect([...storage.data.values()][0]).not.toContain(pack.source.path);
  });

  it("shows the libmpv runtime failure instead of leaving a misleading black player", async () => {
    const user = userEvent.setup();
    const pack = createMultimodalBlindReviewPackFixture();
    const adapterHarness = createAdapter();
    const adapter = Object.assign(adapterHarness.adapter, {
      prepare: vi.fn(() =>
        Promise.reject(
          new Error("配置的 mpv 目录中没有 libmpv-2.dll 或 mpv-2.dll。")
        )
      )
    });
    render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride
        adapterFactory={() => adapter}
      />
    );

    await user.upload(
      screen.getByLabelText("导入多模态盲复核任务包"),
      new File([JSON.stringify(pack)], "blind-pack.json", { type: "application/json" })
    );
    await user.click(await screen.findByRole("button", { name: "打开播放器" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /应用内播放器不可用：配置的 mpv 目录中没有 libmpv-2\.dll/
    );
    expect(screen.getByRole("button", { name: "B · 目标原片" })).toBeDisabled();
    expect(adapterHarness.load).not.toHaveBeenCalled();
  });

  it("restores the answer draft but never restores the raw reviewer id", async () => {
    const user = userEvent.setup();
    const pack = createMultimodalBlindReviewPackFixture();
    const storage = createStorage();
    const first = render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride={false}
        draftStorage={storage}
      />
    );
    const file = new File([JSON.stringify(pack)], "blind-pack.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("导入多模态盲复核任务包"), file);
    await user.click(await screen.findByRole("button", { name: /B · 00:00:12/ }));
    await user.type(screen.getByPlaceholderText("例如 reviewer-demo"), "private-reviewer");
    first.unmount();

    render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride={false}
        draftStorage={storage}
      />
    );
    const secondFile = new File([JSON.stringify(pack)], "blind-pack.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("导入多模态盲复核任务包"), {
      target: { files: [secondFile] }
    });
    expect(await screen.findByText(/已恢复这份任务包/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /B · 00:00:12/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("例如 reviewer-demo")).toHaveValue("");
  });

  it("imports independent anonymous votes and exports a path-free family adjudication", async () => {
    const user = userEvent.setup();
    const pack = createMultimodalBlindReviewPackFixture();
    const first = createCompleteVote(pack, "reviewer-a", 0);
    const second = createCompleteVote(pack, "reviewer-b", 500);
    const downloadText = vi.fn<typeof downloadTextFile>(() => "adjudication.json");
    render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride={false}
        initialPackJson={JSON.stringify(pack)}
        downloadText={downloadText}
      />
    );

    expect(await screen.findByText("任务 1/1")).toBeInTheDocument();
    await user.upload(screen.getByLabelText("导入匿名复核票"), [
      new File([JSON.stringify(first)], "reviewer-a.json", { type: "application/json" }),
      new File([JSON.stringify(second)], "reviewer-b.json", { type: "application/json" })
    ]);

    expect(await screen.findByText(/Gold 1\/1 · 冲突 0/)).toBeInTheDocument();
    expect(screen.getByText(/已收集 2\/2 名独立复核者/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出家族裁决" }));
    const content = downloadText.mock.calls[0][1];
    expect(content).not.toContain(pack.source.path);
    expect(JSON.parse(content)).toMatchObject({
      schemaVersion: "alignment-multimodal-blind-adjudication-v1",
      containsMediaPaths: false,
      summary: { tasks: 1, gold: 1 }
    });
  });

  it("merges three complete family adjudications into private labels and a commitment", async () => {
    const user = userEvent.setup();
    const adjudications = [0, 1, 2].map((familyIndex) => {
      const pack = createMultimodalBlindReviewPackFixtureWithTasks(familyIndex);
      return buildMultimodalBlindAdjudication(pack, [
        createCompleteVote(pack, `reviewer-a-${familyIndex}`, 0),
        createCompleteVote(pack, `reviewer-b-${familyIndex}`, 200)
      ]);
    });
    const downloadText = vi.fn<typeof downloadTextFile>(() => "frozen.json");
    render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride={false}
        downloadText={downloadText}
      />
    );

    await user.upload(
      screen.getByLabelText("导入家族裁决"),
      adjudications.map(
        (value, index) =>
          new File(
            [serializeMultimodalBlindAdjudication(value)],
            `family-${index}.json`,
            { type: "application/json" }
          )
      )
    );

    expect(await screen.findByText(/冻结准备已满足：3 个家族、60 条 Gold/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出私有 Gold 标签" }));
    await user.click(screen.getByRole("button", { name: "导出冻结标签承诺" }));
    expect(downloadText).toHaveBeenCalledTimes(2);
    const privateLabels = JSON.parse(downloadText.mock.calls[0][1]) as { labels: unknown[] };
    const commitment = JSON.parse(downloadText.mock.calls[1][1]) as Record<string, unknown>;
    expect(privateLabels.labels).toHaveLength(60);
    expect(commitment).toMatchObject({
      schemaVersion: "alignment-multimodal-blind-label-merge-v1",
      familyCount: 3,
      queryCount: 60,
      releaseEligible: false
    });
  });

  it("keeps a cleared draft removed instead of immediately recreating an empty draft", async () => {
    const user = userEvent.setup();
    const pack = createMultimodalBlindReviewPackFixture();
    const storage = createStorage();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <MultimodalBlindReviewPanel
        desktopAvailableOverride={false}
        draftStorage={storage}
      />
    );
    await user.upload(
      screen.getByLabelText("导入多模态盲复核任务包"),
      new File([JSON.stringify(pack)], "blind-pack.json", { type: "application/json" })
    );
    await user.click(await screen.findByRole("button", { name: /B · 00:00:12/ }));
    await waitFor(() => expect(storage.data.size).toBe(1));
    await user.click(screen.getByRole("button", { name: "清除草稿" }));
    await waitFor(() => expect(storage.data.size).toBe(0));
    expect(screen.getByText("尚无草稿")).toBeInTheDocument();
    expect(screen.getByText(/本机应用数据中的草稿已清除/)).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("fails closed when the pack identity is changed", async () => {
    const user = userEvent.setup();
    const pack = createMultimodalBlindReviewPackFixture();
    pack.tasks[0].sourceTimestampMs += 1;
    render(<MultimodalBlindReviewPanel desktopAvailableOverride={false} />);
    await user.upload(
      screen.getByLabelText("导入多模态盲复核任务包"),
      new File([JSON.stringify(pack)], "tampered.json", { type: "application/json" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/身份不一致/);
    expect(screen.queryByText("任务 1/1")).not.toBeInTheDocument();
  });
});

function createCompleteVote(
  pack: MultimodalBlindReviewPack,
  reviewer: string,
  offsetMs: number
) {
  return buildMultimodalBlindReviewVoteSet(
    pack,
    reviewer,
    pack.tasks.map((task) => ({
      taskId: task.taskId,
      decision: "matched" as const,
      targetTimestampMs: task.candidateSlots[0].timestampMs + offsetMs,
      boundaryToleranceMs: 500,
      precision: "frameAccurate" as const
    }))
  );
}
