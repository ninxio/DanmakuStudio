import { describe, expect, it } from "vitest";
import { designTokenColor } from "./designTokens";

describe("designTokenColor", () => {
  it("isolates document caches and refreshes static Canvas colors after a theme revision", () => {
    const doc = document.implementation.createHTMLDocument();
    let channels = "32 36 51";
    Object.defineProperty(doc, "defaultView", {
      value: { getComputedStyle: () => ({ getPropertyValue: () => channels }) }
    });
    doc.documentElement.dataset.theme = "light";
    expect(designTokenColor("content-primary", 1, doc)).toBe("rgb(32 36 51 / 1)");
    channels = "233 237 249";
    doc.documentElement.dataset.theme = "dark";
    doc.documentElement.dataset.themeRevision = "1";
    expect(designTokenColor("content-primary", 1, doc)).toBe("rgb(233 237 249 / 1)");
    const other = document.implementation.createHTMLDocument();
    Object.defineProperty(other, "defaultView", {
      value: { getComputedStyle: () => ({ getPropertyValue: () => "91 100 120" }) }
    });
    expect(designTokenColor("content-primary", 1, other)).toBe("rgb(91 100 120 / 1)");
  });
  it("为 Canvas 和 SVG 提供集中令牌与受限透明度", () => {
    expect(designTokenColor("feedback-running", 0.16, null)).toBe("rgb(76 201 240 / 0.16)");
    expect(designTokenColor("feedback-danger", 4, null)).toBe("rgb(255 107 107 / 1)");
    expect(designTokenColor("surface-canvas", -1, null)).toBe("rgb(13 16 21 / 0)");
  });
});
