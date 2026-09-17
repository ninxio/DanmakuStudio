import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("保留标题与语义区块", () => {
    render(<Panel title="素材队列">队列内容</Panel>);
    expect(screen.getByRole("region", { name: "素材队列" })).toBeInTheDocument();
    expect(screen.getByText("队列内容")).toBeVisible();
  });
});
