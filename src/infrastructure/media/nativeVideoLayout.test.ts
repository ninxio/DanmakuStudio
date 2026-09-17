import { describe, expect, it, vi } from "vitest";
import {
  isNativeVideoObstructed,
  registerNativeVideoObstruction,
  subscribeNativeVideoLayout
} from "./nativeVideoLayout";

describe("native video overlay coordination", () => {
  it("only hides intersecting sibling windows and restores on close", () => {
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    document.body.append(host, overlay);
    const rect = new DOMRect(100, 100, 400, 250);
    let overlayRect = new DOMRect(700, 100, 150, 200);
    overlay.getBoundingClientRect = () => overlayRect;
    const listener = vi.fn();
    const unsubscribe = subscribeNativeVideoLayout(listener);
    const close = registerNativeVideoObstruction(overlay);
    expect(isNativeVideoObstructed(host, rect)).toBe(false);
    overlayRect = new DOMRect(120, 100, 150, 200);
    expect(isNativeVideoObstructed(host, rect)).toBe(true);
    overlay.append(host);
    expect(isNativeVideoObstructed(host, rect)).toBe(false);
    document.body.append(host);
    const previousNotifications = listener.mock.calls.length;
    close();
    expect(isNativeVideoObstructed(host, rect)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(previousNotifications + 1);
    unsubscribe();
    host.remove();
    overlay.remove();
  });
});
