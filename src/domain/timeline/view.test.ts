import { describe, expect, it } from "vitest";
import {
  sliderValueToZoom,
  TIMELINE_MAX_PIXELS_PER_SECOND,
  TIMELINE_MIN_PIXELS_PER_SECOND,
  TIMELINE_ZOOM_SLIDER_MAX,
  TIMELINE_ZOOM_SLIDER_MIN,
  zoomToSliderValue
} from "./view";

describe("timeline view zoom", () => {
  it("使用对数滑杆覆盖小时级和帧级缩放范围", () => {
    expect(sliderValueToZoom(TIMELINE_ZOOM_SLIDER_MIN)).toBeCloseTo(TIMELINE_MIN_PIXELS_PER_SECOND, 6);
    expect(sliderValueToZoom(TIMELINE_ZOOM_SLIDER_MAX)).toBeCloseTo(TIMELINE_MAX_PIXELS_PER_SECOND, 6);
    expect(zoomToSliderValue(8)).toBeGreaterThan(TIMELINE_ZOOM_SLIDER_MIN);
    expect(zoomToSliderValue(8)).toBeLessThan(TIMELINE_ZOOM_SLIDER_MAX);
  });
});
