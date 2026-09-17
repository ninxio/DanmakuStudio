import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Lazy modules can be transformed concurrently with CPU-heavy fixture validation.
configure({ asyncUtilTimeout: 5_000 });

class ResizeObserverMock implements ResizeObserver {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    const entry = {
      target,
      contentRect: target.getBoundingClientRect()
    } as ResizeObserverEntry;
    this.callback([entry], this);
  }

  unobserve(): void {
    return;
  }

  disconnect(): void {
    return;
  }
}

globalThis.ResizeObserver = ResizeObserverMock;

const getContextMock = function getContext(this: HTMLCanvasElement, contextId: string): RenderingContext | null {
  if (contextId !== "2d") {
    return null;
  }
  const noop = (): void => undefined;
  const context: Partial<CanvasRenderingContext2D> = {
    canvas: this,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    globalAlpha: 1,
    textAlign: "start",
    textBaseline: "alphabetic",
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    arc: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    setTransform: noop,
    setLineDash: noop,
    fillText: noop,
    measureText: (text: string) => ({ width: text.length * 8 }) as TextMetrics
  };
  return context as unknown as CanvasRenderingContext2D;
};

HTMLCanvasElement.prototype.getContext = getContextMock as typeof HTMLCanvasElement.prototype.getContext;
