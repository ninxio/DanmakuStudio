export const TIMELINE_MIN_PIXELS_PER_SECOND = 0.01;
export const TIMELINE_MAX_PIXELS_PER_SECOND = 1600;
export const TIMELINE_ZOOM_SLIDER_MIN = 0;
export const TIMELINE_ZOOM_SLIDER_MAX = 1000;

export function formatPixelsPerSecond(pixelsPerSecond: number): string {
  if (pixelsPerSecond >= 10) {
    return `${Math.round(pixelsPerSecond)} px/s`;
  }
  if (pixelsPerSecond >= 1) {
    return `${pixelsPerSecond.toFixed(1)} px/s`;
  }
  return `${pixelsPerSecond.toFixed(2)} px/s`;
}

export function zoomToSliderValue(pixelsPerSecond: number): number {
  const min = Math.log(TIMELINE_MIN_PIXELS_PER_SECOND);
  const max = Math.log(TIMELINE_MAX_PIXELS_PER_SECOND);
  const value = Math.log(clampZoom(pixelsPerSecond));
  return Math.round(((value - min) / (max - min)) * TIMELINE_ZOOM_SLIDER_MAX);
}

export function sliderValueToZoom(sliderValue: number): number {
  const ratio =
    (Math.min(TIMELINE_ZOOM_SLIDER_MAX, Math.max(TIMELINE_ZOOM_SLIDER_MIN, sliderValue)) -
      TIMELINE_ZOOM_SLIDER_MIN) /
    (TIMELINE_ZOOM_SLIDER_MAX - TIMELINE_ZOOM_SLIDER_MIN);
  const min = Math.log(TIMELINE_MIN_PIXELS_PER_SECOND);
  const max = Math.log(TIMELINE_MAX_PIXELS_PER_SECOND);
  return Math.exp(min + (max - min) * ratio);
}

function clampZoom(pixelsPerSecond: number): number {
  return Math.min(TIMELINE_MAX_PIXELS_PER_SECOND, Math.max(TIMELINE_MIN_PIXELS_PER_SECOND, pixelsPerSecond));
}
