import { describe, expect, it } from "vitest";
import {
  createPlayerReliabilitySummary,
  PLAYER_SEEK_SYNC_TOLERANCE_MS
} from "./playerReliability";

describe("播放器可靠性摘要", () => {
  it("无媒体时提示等待接入，并暴露同步目标", () => {
    const summary = createPlayerReliabilitySummary({
      backend: "htmlVideo",
      loadState: "empty",
      hasPreviewSource: false,
      sourceKind: "none",
      videoError: null,
      mpvConfigured: false
    });

    expect(PLAYER_SEEK_SYNC_TOLERANCE_MS).toBe(240);
    expect(summary.statusLabel).toBe("等待媒体");
    expect(summary.performanceTargetLabel).toBe("同步目标 240ms 内");
    expect(summary.cachePolicyLabel).toBe("等待媒体后可缓存");
    expect(summary.recoveryDetail).toContain("导入参考视频");
  });

  it("Emby 授权流说明临时地址不落盘，并给出重新生成路径", () => {
    const summary = createPlayerReliabilitySummary({
      backend: "nativeMpv",
      loadState: "ready",
      hasPreviewSource: true,
      sourceKind: "embyStream",
      videoError: null,
      mpvConfigured: true
    });

    expect(summary.statusLabel).toBe("可靠性正常");
    expect(summary.performanceStateLabel).toBe("mpv 超过目标偏差时主动纠偏");
    expect(summary.cachePolicyLabel).toBe("临时流不落盘");
    expect(summary.cacheDetail).toContain("遮蔽 key");
    expect(summary.recoveryLabel).toBe("可重新生成授权流");
  });

  it("格式失败时给出可执行恢复动作", () => {
    const summary = createPlayerReliabilitySummary({
      backend: "htmlVideo",
      loadState: "unsupported",
      hasPreviewSource: true,
      sourceKind: "localObject",
      videoError: "HTML Video 无法播放此视频。",
      mpvConfigured: false
    });

    expect(summary.statusLabel).toBe("需要恢复");
    expect(summary.performanceStateLabel).toBe("当前不能同步播放头");
    expect(summary.recoveryLabel).toBe("已阻断静默失败");
    expect(summary.recoveryDetail).toBe("改用 MP4/WebM、本地路径或 mpv 后端。");
  });
});
