import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimeMapEvidenceCanvas } from "./TimeMapEvidenceCanvas";

describe("TimeMapEvidenceCanvas", () => {
  it("保持可访问名称，并把 hover 命中解释为用户可读风险", () => {
    render(
      <TimeMapEvidenceCanvas
        label="原片轨道差异风险热力图和时间偏移阶梯"
        rangeStartMs={0}
        rangeEndMs={10_000}
        samples={[
          {
            axis: "target",
            startMs: 0,
            endMs: 10_000,
            counterpartMs: 0,
            strength: 0.1,
            anchorCount: 1,
            heldOutAnchorCount: 0,
            medianAbsResidualMs: 100,
            offsetMs: -1_250,
            state: "targetOnly"
          }
        ]}
      />
    );

    const canvas = screen.getByRole("img", {
      name: "原片轨道差异风险热力图和时间偏移阶梯"
    });
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, width: 100, height: 28 })
    });
    fireEvent.mouseMove(canvas, { clientX: 50 });

    expect(screen.getByRole("tooltip")).toHaveTextContent("原片可能多出内容");
    expect(screen.getByRole("tooltip")).toHaveTextContent("00:00:00.000–00:00:10.000");
    expect(screen.getByRole("tooltip")).toHaveTextContent("时间差 −1.250 秒");
  });
});
