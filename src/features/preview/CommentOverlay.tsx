import {
  previewCommentDuration,
  visiblePreviewComments,
  type PreviewComment
} from "../../domain/preview/danmakuTrack";

export function CommentOverlay({
  events,
  time,
  opacity = 1
}: {
  events: readonly PreviewComment[];
  time: number;
  opacity?: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="danmaku-overlay"
    >
      {visiblePreviewComments(events, time).map((event) => {
        const mode = event.item.mode ?? 1;
        const fixed = mode === 4 || mode === 5;
        const progress = (time - event.finalTimeMs) / previewCommentDuration(event.item);
        const lane = event.originalIndex % 10;
        return (
          <span
            key={event.id}
            className="danmaku-preview-text absolute whitespace-nowrap font-semibold"
            style={{
              opacity,
              color: `#${((event.item.color ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
              fontSize: "clamp(12px, 1.3vw, 26px)",
              top: mode === 4 ? undefined : `${6 + lane * 7}%`,
              bottom: mode === 4 ? `${6 + lane * 7}%` : undefined,
              left: fixed
                ? "50%"
                : `${mode === 6 ? -45 + progress * 145 : 100 - progress * 145}%`,
              transform: fixed ? "translateX(-50%)" : undefined
            }}
          >
            {event.item.text}
          </span>
        );
      })}
    </div>
  );
}
