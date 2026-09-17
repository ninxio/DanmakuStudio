import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "中文时间映射",
      "7ce720d109ac5d3a93998fee8d51639add420d8174ae0ea81caaaa6730dd16bd"
    ]
  ])("计算标准向量 %#", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it("跨越多个压缩块", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
  });
});
