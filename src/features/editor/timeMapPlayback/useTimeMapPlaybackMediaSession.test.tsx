import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybackMediaPair } from "../../../domain/player/playbackMediaPair";
import type { EmbeddedMpvMediaAdapter } from "../../../infrastructure/media/mediaAdapter";
import {
  useTimeMapPlaybackMediaSession,
  type TimeMapPlaybackAdapterFactory
} from "./useTimeMapPlaybackMediaSession";

const NATIVE_PAIR: PlaybackMediaPair = {
  available: true,
  backend: "nativeMpv",
  source: { kind: "url", name: "reference.mkv", url: "D:\\reference.mkv" },
  target: { kind: "url", name: "original.mkv", url: "D:\\original.mkv" },
  sourceContentKind: "video",
  targetContentKind: "video",
  message: "测试原生媒体对"
};

const SESSION_IDS = {
  source: "review-source",
  target: "review-target"
} as const;

describe("useTimeMapPlaybackMediaSession", () => {
  it("每轴只创建和释放一个 adapter，并由会话拥有 bounds、solo 与联动状态", () => {
    const source = createNativeAdapter();
    const target = createNativeAdapter();
    const factory = vi.fn<TimeMapPlaybackAdapterFactory>(({ axis }) =>
      axis === "source" ? source.adapter : target.adapter
    );
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    try {
      const view = render(<SessionHarness factory={factory} />);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(source.setHostBounds).toHaveBeenCalled();
      expect(target.setHostBounds).toHaveBeenCalled();
      expect(screen.getByTestId("session-mode")).toHaveTextContent("linked:target");

      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(source.setHostBounds.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(target.setHostBounds.mock.calls.length).toBeGreaterThanOrEqual(3);

      act(() => screen.getByRole("button", { name: "只听参考 A" }).click());
      act(() => screen.getByRole("button", { name: "独立操作" }).click());
      expect(screen.getByTestId("session-mode")).toHaveTextContent("independent:source");

      view.rerender(<SessionHarness factory={factory} suffix={<span>稳定重渲染</span>} />);
      expect(factory).toHaveBeenCalledTimes(2);

      view.unmount();
      expect(source.pause).toHaveBeenCalledTimes(1);
      expect(target.pause).toHaveBeenCalledTimes(1);
      expect(source.dispose).toHaveBeenCalledTimes(1);
      expect(target.dispose).toHaveBeenCalledTimes(1);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
});

function SessionHarness({
  factory,
  suffix
}: {
  factory: TimeMapPlaybackAdapterFactory;
  suffix?: ReactNode;
}) {
  const session = useTimeMapPlaybackMediaSession({
    open: true,
    playbackPair: NATIVE_PAIR,
    nativeSessionIds: SESSION_IDS,
    mpvPath: "C:\\mpv",
    initialPositions: { source: 1_000, target: 2_000 },
    initialPlaybackMode: "linked",
    initialSoloAxis: "target",
    adapterFactory: factory,
    onPlaybackStopped: vi.fn()
  });

  return (
    <>
      <div ref={(element) => session.hosts.native("source", element)} />
      <div ref={(element) => session.hosts.native("target", element)} />
      <output data-testid="session-mode">
        {session.snapshot.playbackMode}:{session.snapshot.soloAxis}
      </output>
      <button type="button" onClick={() => session.actions.setSoloAxis("source")}>
        只听参考 A
      </button>
      <button type="button" onClick={() => session.actions.setPlaybackMode("independent")}>
        独立操作
      </button>
      {suffix}
    </>
  );
}

function createNativeAdapter(): {
  adapter: EmbeddedMpvMediaAdapter;
  pause: ReturnType<typeof vi.fn<EmbeddedMpvMediaAdapter["pause"]>>;
  dispose: ReturnType<typeof vi.fn<EmbeddedMpvMediaAdapter["dispose"]>>;
  setHostBounds: ReturnType<typeof vi.fn<EmbeddedMpvMediaAdapter["setHostBounds"]>>;
} {
  const pause = vi.fn<EmbeddedMpvMediaAdapter["pause"]>();
  const dispose = vi.fn<EmbeddedMpvMediaAdapter["dispose"]>();
  const setHostBounds = vi.fn<EmbeddedMpvMediaAdapter["setHostBounds"]>();
  return {
    pause,
    dispose,
    setHostBounds,
    adapter: {
      kind: "native-mpv",
      prepare: vi.fn(() => Promise.resolve()),
      load: vi.fn(() => Promise.resolve()),
      play: vi.fn(() => Promise.resolve()),
      pause,
      seek: vi.fn(),
      getCurrentTimeMs: vi.fn(() => 0),
      getDurationMs: vi.fn(() => 60_000),
      getTracks: vi.fn(() => []),
      setPlaybackRate: vi.fn(),
      setMuted: vi.fn(),
      setHostBounds,
      getSupportedContainerNote: vi.fn(() => "测试"),
      dispose
    }
  };
}
