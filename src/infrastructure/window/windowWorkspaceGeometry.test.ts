import { describe, expect, it } from "vitest";
import { fitWindowToWorkArea, nearestWorkArea } from "./windowWorkspaceGeometry";
import type { WindowGeometry } from "./windowWorkspaceGeometry";

const normal: WindowGeometry = {
  position: { x: 120, y: 80 },
  outerSize: { width: 1000, height: 700 },
  innerSize: { width: 1000, height: 700 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1
};

describe("window work area geometry", () => {
  it("preserves a fitting window, including one aligned to the work area edge", () => {
    expect(fitWindowToWorkArea(normal)).toEqual({
      minimumSize: { width: 720, height: 480 },
      size: null,
      position: null
    });
    expect(fitWindowToWorkArea({ ...normal, position: { x: 0, y: 0 } })?.position).toBeNull();
  });

  it("fits a restored high-DPI window to the physical work area, excluding the taskbar", () => {
    expect(
      fitWindowToWorkArea({
        ...normal,
        position: { x: 100, y: 0 },
        outerSize: { width: 2160, height: 1350 },
        innerSize: { width: 2160, height: 1350 },
        workArea: { x: 0, y: 40, width: 1920, height: 1040 },
        scaleFactor: 1.5
      })
    ).toEqual({
      minimumSize: { width: 1080, height: 720 },
      size: { width: 1728, height: 936 },
      position: { x: 100, y: 40 }
    });
  });

  it("handles monitors left of the primary and subtracts nonclient window extents", () => {
    expect(
      fitWindowToWorkArea({
        ...normal,
        position: { x: -2000, y: -100 },
        outerSize: { width: 1800, height: 1100 },
        innerSize: { width: 1784, height: 1062 },
        workArea: { x: -1600, y: -40, width: 1600, height: 860 }
      })
    ).toEqual({
      minimumSize: { width: 720, height: 480 },
      size: { width: 1425, height: 739 },
      position: { x: -1600, y: -40 }
    });
  });

  it("lowers the usual logical minimum when even that would overflow a small work area", () => {
    expect(
      fitWindowToWorkArea({
        ...normal,
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1000, height: 600 }
      })?.minimumSize
    ).toEqual({ width: 1000, height: 600 });
  });

  it("moves an offscreen fitting window without resizing it", () => {
    expect(fitWindowToWorkArea({ ...normal, position: { x: 1600, y: 700 } })).toEqual({
      minimumSize: { width: 720, height: 480 },
      size: null,
      position: { x: 920, y: 340 }
    });
  });

  it("chooses a nearby connected monitor after the previous monitor disappears", () => {
    const left = { x: -1600, y: 0, width: 1600, height: 860 };
    const right = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(nearestWorkArea({ x: -2600, y: 100 }, normal.outerSize, [right, left])).toEqual(
      left
    );
    expect(nearestWorkArea(normal.position, normal.outerSize, [])).toBeNull();
  });

  it("does not issue invalid native geometry", () => {
    expect(fitWindowToWorkArea({ ...normal, position: { x: NaN, y: 0 } })).toBeNull();
    expect(fitWindowToWorkArea({ ...normal, scaleFactor: 0 })).toBeNull();
  });
});
