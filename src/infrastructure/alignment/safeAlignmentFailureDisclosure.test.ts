import { describe, expect, it } from "vitest";
import { discloseKnownAlignmentFailure } from "./safeAlignmentFailureDisclosure";

describe("对齐失败安全披露", () => {
  it.each([
    "blocked:cuda-fft-runtime：native detail",
    "音频对齐任务启动失败：blocked:cuda-fft-runtime：native detail"
  ])("接受起点或受控包装前缀后的白名单码：%s", (message) => {
    expect(discloseKnownAlignmentFailure(new Error(message))).toMatchObject({
      code: "blocked:cuda-fft-runtime"
    });
  });

  it.each([
    "attacker blocked:cuda-fft-runtime：native detail",
    "attackerblocked:cuda-fft-runtime：native detail",
    "未知包装：blocked:cuda-fft-runtime：native detail",
    " 音频对齐任务启动失败：blocked:cuda-fft-runtime：native detail"
  ])("拒绝任意前缀中嵌入的白名单码：%s", (message) => {
    expect(discloseKnownAlignmentFailure(new Error(message))).toBeNull();
  });

  it("仍拒绝在白名单码后拼接伪造后缀", () => {
    expect(
      discloseKnownAlignmentFailure(
        new Error("blocked:cuda-fft-runtime-private：native detail")
      )
    ).toBeNull();
  });
});
