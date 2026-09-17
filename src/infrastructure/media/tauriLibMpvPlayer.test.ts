import { describe, expect, it, vi } from "vitest";
import { measureNativeVideoBounds } from "./tauriLibMpvPlayer";
import { subscribeNativeVideoLayout } from "./nativeVideoLayout";

describe("libmpv 原生视频宿主", () => {
  it("把 WebView CSS 坐标换算为原生物理像素", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 210,
      bottom: 120,
      width: 200,
      height: 100,
      toJSON: () => undefined
    });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 1_280
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 720
    });

    expect(measureNativeVideoBounds(element)).toEqual({
      x: 15,
      y: 30,
      width: 300,
      height: 150,
      visible: true
    });
  });

  it("折叠详情即使留下非零几何也隐藏宿主，并通知布局恢复", () => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const host = document.createElement("div");
    details.append(summary, host);
    document.body.append(details);
    host.getBoundingClientRect = () => new DOMRect(10, 20, 200, 100);
    const listener = vi.fn();
    const unsubscribe = subscribeNativeVideoLayout(listener);
    try {
      expect(measureNativeVideoBounds(host).visible).toBe(false);
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      expect(listener).toHaveBeenCalled();
      expect(measureNativeVideoBounds(host).visible).toBe(true);
      details.open = false;
      expect(measureNativeVideoBounds(host).visible).toBe(false);
    } finally {
      unsubscribe();
      details.remove();
    }
  });
});
