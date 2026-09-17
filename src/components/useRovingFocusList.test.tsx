import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRovingFocusList } from "./useRovingFocusList";

describe("useRovingFocusList", () => {
  it("聚焦行被移除时把唯一 Tab stop 与焦点交给原位置的下一行", () => {
    const { rerender } = render(<RovingHarness itemIds={["a", "b", "c"]} />);
    const middle = screen.getByRole("button", { name: "b" });
    fireEvent.focus(middle);

    rerender(<RovingHarness itemIds={["a", "c"]} />);

    expect(screen.getByRole("button", { name: "c" })).toHaveFocus();
    expect(
      screen.getAllByRole("button").map((button) => button.tabIndex)
    ).toEqual([-1, 0]);
  });
});

function RovingHarness({ itemIds }: { itemIds: string[] }) {
  const roving = useRovingFocusList({ itemIds });
  return (
    <div>
      {itemIds.map((id) => (
        <button
          key={id}
          ref={(element) => roving.setItemRef(id, element)}
          type="button"
          tabIndex={roving.getItemTabIndex(id)}
          onFocus={() => roving.onItemFocus(id)}
          onKeyDown={(event) => roving.onItemKeyDown(event, id)}
        >
          {id}
        </button>
      ))}
    </div>
  );
}
