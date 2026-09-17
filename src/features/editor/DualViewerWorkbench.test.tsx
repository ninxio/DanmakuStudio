import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybackMediaPair } from "../../domain/player/playbackMediaPair";
import { DualViewerWorkbench } from "./DualViewerWorkbench";

describe("DualViewerWorkbench", () => {
  it("把 A/B 监视器固定为等宽，并明确 B 主时钟、默认只听 B 与可恢复联动", () => {
    const onSoloAxis = vi.fn();
    const onPlaybackMode = vi.fn();
    render(
      <DualViewerWorkbench
        playbackPair={createVideoPair()}
        positions={{ source: 1_000, target: 2_000 }}
        activeAxis="target"
        soloAxis="target"
        adapterReady={{ source: true, target: true }}
        playbackMode="linked"
        linkedModeAvailable
        onVideoRef={vi.fn()}
        onNativeHostRef={vi.fn()}
        onSoloAxis={onSoloAxis}
        onPlaybackMode={onPlaybackMode}
      />
    );

    expect(screen.getByRole("group", { name: "A/B 等宽监视器" })).toBeInTheDocument();
    expect(screen.getByText("B · 目标原片")).toHaveAttribute(
      "title",
      "原片 B 是联动播放的主时钟"
    );
    expect(screen.getByRole("button", { name: "正在听原片 B" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "联动播放" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "独立操作" }));
    fireEvent.click(screen.getByRole("button", { name: "只听参考 A" }));
    fireEvent.click(screen.getByRole("button", { name: "联动播放" }));

    expect(onPlaybackMode).toHaveBeenNthCalledWith(1, "independent");
    expect(onSoloAxis).toHaveBeenCalledWith("source");
    expect(onPlaybackMode).toHaveBeenNthCalledWith(2, "linked");
  });

  it("纯音频两侧保留 A/B 操作并明确说明没有画面", () => {
    const playbackPair: PlaybackMediaPair = {
      available: true,
      backend: "htmlVideo",
      source: { kind: "url", name: "reference.flac", url: "blob:reference" },
      target: { kind: "url", name: "original.m4a", url: "blob:original" },
      sourceContentKind: "audio",
      targetContentKind: "audio",
      message: "测试音频媒体对"
    };

    render(
      <DualViewerWorkbench
        playbackPair={playbackPair}
        positions={{ source: 1_000, target: 2_000 }}
        activeAxis="source"
        soloAxis="source"
        adapterReady={{ source: true, target: true }}
        playbackMode="linked"
        linkedModeAvailable
        onVideoRef={vi.fn()}
        onNativeHostRef={vi.fn()}
        onSoloAxis={vi.fn()}
        onPlaybackMode={vi.fn()}
      />
    );

    expect(screen.getAllByText("纯音频")).toHaveLength(2);
    expect(
      screen.getAllByText("纯音频素材：可试听、同步和编辑时间线，无画面可复核")
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "联动播放" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "正在听参考 A" })).toBeEnabled();
  });
});

function createVideoPair(): PlaybackMediaPair {
  return {
    available: true,
    backend: "htmlVideo",
    source: { kind: "url", name: "reference.mp4", url: "blob:reference" },
    target: { kind: "url", name: "original.mkv", url: "blob:original" },
    sourceContentKind: "video",
    targetContentKind: "video",
    message: "测试视频媒体对"
  };
}
