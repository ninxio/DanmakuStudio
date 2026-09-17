export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowWorkArea extends WindowPosition, WindowSize {}

export interface WindowGeometry {
  position: WindowPosition;
  outerSize: WindowSize;
  innerSize: WindowSize;
  workArea: WindowWorkArea;
  scaleFactor: number;
}

export interface WindowWorkspaceFit {
  minimumSize: WindowSize;
  size: WindowSize | null;
  position: WindowPosition | null;
}

/** All inputs and outputs are physical pixels, including negative monitor coordinates. */
export function fitWindowToWorkArea(geometry: WindowGeometry): WindowWorkspaceFit | null {
  const { position, outerSize, innerSize, workArea, scaleFactor } = geometry;
  if (
    ![position.x, position.y, workArea.x, workArea.y].every(Number.isFinite) ||
    ![
      outerSize.width,
      outerSize.height,
      innerSize.width,
      innerSize.height,
      workArea.width,
      workArea.height,
      scaleFactor
    ].every((value) => Number.isFinite(value) && value > 0)
  )
    return null;

  // Tauri's setSize addresses the inner window; its position and bounds are outer geometry.
  const frameWidth = Math.max(0, outerSize.width - innerSize.width);
  const frameHeight = Math.max(0, outerSize.height - innerSize.height);
  const availableWidth = Math.max(1, Math.floor(workArea.width - frameWidth));
  const availableHeight = Math.max(1, Math.floor(workArea.height - frameHeight));
  const minimumWidth = Math.min(Math.round(720 * scaleFactor), availableWidth);
  const minimumHeight = Math.min(Math.round(480 * scaleFactor), availableHeight);
  // Repair an oversized restored window with breathing room; preserve all already-fitting user sizes.
  const oversized = innerSize.width > availableWidth || innerSize.height > availableHeight;
  const width = oversized
    ? Math.min(
        availableWidth,
        Math.max(minimumWidth, Math.min(innerSize.width, Math.floor(availableWidth * 0.9)))
      )
    : innerSize.width;
  const height = oversized
    ? Math.min(
        availableHeight,
        Math.max(minimumHeight, Math.min(innerSize.height, Math.floor(availableHeight * 0.9)))
      )
    : innerSize.height;
  const x = Math.round(
    Math.max(workArea.x, Math.min(position.x, workArea.x + workArea.width - width - frameWidth))
  );
  const y = Math.round(
    Math.max(
      workArea.y,
      Math.min(position.y, workArea.y + workArea.height - height - frameHeight)
    )
  );

  return {
    minimumSize: {
      width: minimumWidth,
      height: minimumHeight
    },
    size: width === innerSize.width && height === innerSize.height ? null : { width, height },
    position: x === position.x && y === position.y ? null : { x, y }
  };
}

/** Fallback when the window no longer belongs to a connected monitor. */
export function nearestWorkArea(
  position: WindowPosition,
  size: WindowSize,
  areas: WindowWorkArea[]
): WindowWorkArea | null {
  let best: WindowWorkArea | null = null;
  let bestDistance = Infinity;
  const centerX = position.x + size.width / 2;
  const centerY = position.y + size.height / 2;
  for (const area of areas) {
    if (area.width <= 0 || area.height <= 0) continue;
    const dx = centerX - Math.max(area.x, Math.min(centerX, area.x + area.width));
    const dy = centerY - Math.max(area.y, Math.min(centerY, area.y + area.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = area;
      bestDistance = distance;
    }
  }
  return best;
}
