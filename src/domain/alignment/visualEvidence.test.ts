import { describe, expect, it } from "vitest";
import {
  createRobustVisualFeatureFrame,
  getVisualFeatureDistance,
  summarizeVisualEvidence,
  type VisualFeatureFrame
} from "./visualEvidence";

describe("鲁棒视觉证据", () => {
  it("会忽略右上水印和底部字幕带的强干扰", () => {
    const base = createScenePixels(90);
    const noisy = new Uint8Array(base);
    paintRect(noisy, 24, 1, 8, 5, 255);
    paintRect(noisy, 0, 14, 32, 4, 0);

    const baseFrame = createRobustVisualFeatureFrame(0, base);
    const noisyFrame = createRobustVisualFeatureFrame(0, noisy);

    expect(getVisualFeatureDistance(baseFrame, noisyFrame)).toBeLessThan(0.01);
  });

  it("主体区域变化会形成明显距离", () => {
    const base = createRobustVisualFeatureFrame(0, createScenePixels(80));
    const changedPixels = createScenePixels(80);
    paintRect(changedPixels, 8, 4, 12, 6, 220);
    const changed = createRobustVisualFeatureFrame(0, changedPixels);

    expect(getVisualFeatureDistance(base, changed)).toBeGreaterThan(0.12);
  });

  it("可以复核时间映射锚点的视觉支持率", () => {
    const complete = createVisualFrames([80, 100, 120]);
    const source = createVisualFrames([80, 100, 30]);

    const summary = summarizeVisualEvidence(complete, source, [
      { sourceMs: 0, targetMs: 0 },
      { sourceMs: 5000, targetMs: 5000 },
      { sourceMs: 10_000, targetMs: 10_000 }
    ]);

    expect(summary).toMatchObject({
      observations: 3,
      supportedObservations: 2,
      supportRatio: 2 / 3
    });
    expect(summary?.meanDistance).toBeGreaterThan(0);
  });
});

function createVisualFrames(levels: number[]): VisualFeatureFrame[] {
  return levels.map((level, index) => createRobustVisualFeatureFrame(index * 5000, createScenePixels(level)));
}

function createScenePixels(level: number): Uint8Array {
  const pixels = new Uint8Array(32 * 18);
  for (let y = 0; y < 18; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      pixels[y * 32 + x] = Math.min(255, Math.max(0, level + x + y));
    }
  }
  return pixels;
}

function paintRect(pixels: Uint8Array, startX: number, startY: number, width: number, height: number, value: number): void {
  for (let y = startY; y < startY + height; y += 1) {
    for (let x = startX; x < startX + width; x += 1) {
      pixels[y * 32 + x] = value;
    }
  }
}
