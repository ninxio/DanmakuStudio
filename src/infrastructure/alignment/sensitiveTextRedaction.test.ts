import { describe, expect, it } from "vitest";
import {
  collectSensitiveTextVariants,
  containsSensitiveText,
  redactSensitiveText
} from "./sensitiveTextRedaction";

describe("C137 sensitive Windows path redaction", () => {
  const path = "C:\\Users\\Alice\\Media Files\\Episode 01.mkv";

  it.each([
    "C:\\Users\\Alice\\Media Files\\Episode 01.mkv",
    "c:/users/alice/media files/episode 01.mkv",
    "\\\\?\\C:\\USERS\\ALICE\\MEDIA FILES\\EPISODE 01.MKV",
    "//?/C:/Users/Alice/Media Files/Episode 01.mkv",
    "C:\\\\Users\\\\Alice\\\\Media Files\\\\Episode 01.mkv"
  ])("移除等价路径表示：%s", (variant) => {
    const redacted = redactSensitiveText(`工具失败：${variant}`, [path]);
    expect(redacted).toBe("工具失败：[已隐藏本地媒体]");
    expect(containsSensitiveText(redacted, [path])).toBe(false);
  });

  it("同时移除 SHA-256，且变体按长前缀优先", () => {
    const digest = "a".repeat(64);
    expect(redactSensitiveText(`${path} ${digest}`, [path, digest])).toBe(
      "[已隐藏本地媒体] [已隐藏本地媒体]"
    );
    const variants = collectSensitiveTextVariants([path]);
    expect(variants[0]?.length).toBeGreaterThan(path.length);
    expect(variants.some((variant) => variant.includes("?"))).toBe(true);
  });

  it.each([
    "\\\\server\\share\\Series\\Episode 01.mkv",
    "//SERVER/SHARE/series/episode 01.mkv",
    "\\\\?\\UNC\\Server\\Share\\Series\\Episode 01.mkv",
    "//?/UNC/server/share/Series/Episode 01.mkv",
    "\\\\\\\\server\\\\share\\\\Series\\\\Episode 01.mkv"
  ])("移除 UNC 与扩展 UNC 等价路径：%s", (variant) => {
    const unc = "\\\\Server\\Share\\Series\\Episode 01.mkv";
    const redacted = redactSensitiveText(`工具失败：${variant}`, [unc]);
    expect(redacted).toBe("工具失败：[已隐藏本地媒体]");
    expect(containsSensitiveText(redacted, [unc])).toBe(false);
  });
});
