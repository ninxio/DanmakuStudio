/** Web overlays must hide intersecting native child windows, which ignore CSS z-index. */
const obstructions = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function registerNativeVideoObstruction(element: HTMLElement): () => void {
  obstructions.add(element);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(notify);
  observer?.observe(element);
  notify();
  return () => {
    observer?.disconnect();
    obstructions.delete(element);
    notify();
  };
}

export function subscribeNativeVideoLayout(listener: () => void): () => void {
  // Collapsing <details> can keep stale nonzero child rects without a resize event.
  if (listeners.size === 0) document.addEventListener("toggle", notify, true);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("toggle", notify, true);
  };
}

export function isNativeVideoObstructed(host: HTMLElement, rect: DOMRect): boolean {
  for (const overlay of obstructions) {
    if (
      !overlay.isConnected ||
      overlay.contains(host) ||
      overlay.ownerDocument !== host.ownerDocument
    )
      continue;
    const area = overlay.getBoundingClientRect();
    if (
      area.width > 0 &&
      area.height > 0 &&
      area.left < rect.right &&
      area.right > rect.left &&
      area.top < rect.bottom &&
      area.bottom > rect.top
    )
      return true;
  }
  return false;
}
