import { describe, expect, it, vi } from "vitest";
import {
  pickMediaPaths,
  pickXmlPaths,
  pickMultipleNativePaths,
  pickAlignmentMediaPath,
  pickExportDirectoryPath,
  pickFfmpegExecutablePath,
  pickMpvExecutablePath,
  pickSingleNativeDirectoryPath,
  pickSingleNativePath
} from "./nativeDialogs";

describe("原生文件选择器封装", () => {
  it("网页模式下不会伪装成可选择真实本地路径", async () => {
    await expect(pickSingleNativePath({ title: "选择文件" })).rejects.toThrow("Tauri 桌面端");
    await expect(pickMultipleNativePaths({ title: "选择多个文件" })).rejects.toThrow("Tauri 桌面端");
    await expect(pickSingleNativeDirectoryPath({ title: "选择目录" })).rejects.toThrow("Tauri 桌面端");
  });

  it("按原片角色打开原生媒体多选并同时允许视频和音频", async () => {
    const dialog = vi.fn().mockResolvedValue([
      " D:\\media\\S01E01.mkv ",
      "",
      "d:\\MEDIA\\s01e01.MKV",
      "D:\\media\\S01E02.mp4"
    ]);

    const paths = await pickMediaPaths("targetOriginal", dialog);

    expect(paths).toEqual(["D:\\media\\S01E01.mkv", "D:\\media\\S01E02.mp4"]);
    expect(dialog).toHaveBeenCalledWith({
      title: "选择原片素材",
      filters: [
        {
          name: "视频或音频文件",
          extensions: [
            "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts",
            "mp3", "m4a", "aac", "flac", "wav", "wave", "ogg", "oga", "opus",
            "wma", "alac", "aiff", "aif", "ape", "ac3", "eac3", "dts", "mka"
          ]
        }
      ],
      multiple: true,
      directory: false
    });
  });

  it("为弹幕 XML 打开原生多选并限制文件类型", async () => {
    const dialog = vi.fn().mockResolvedValue([
      " D:\\danmaku\\episode-1.xml ",
      "D:\\danmaku\\episode-2.xml"
    ]);

    await expect(pickXmlPaths(dialog)).resolves.toEqual([
      "D:\\danmaku\\episode-1.xml",
      "D:\\danmaku\\episode-2.xml"
    ]);
    expect(dialog).toHaveBeenCalledWith({
      title: "选择弹幕 XML",
      filters: [{ name: "B 站弹幕 XML", extensions: ["xml"] }],
      multiple: true,
      directory: false
    });
  });

  it("按参考素材角色设置标题并兼容原生选择器返回单一路径", async () => {
    const dialog = vi.fn().mockResolvedValue(" D:\\media\\bilibili.mp4 ");

    const paths = await pickMediaPaths("bilibiliReference", dialog);

    expect(paths).toEqual(["D:\\media\\bilibili.mp4"]);
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择 B 站参考素材",
        multiple: true,
        directory: false
      })
    );
  });

  it("多选取消时返回空数组", async () => {
    const dialog = vi.fn().mockResolvedValue(null);

    await expect(pickMultipleNativePaths({ title: "选择多个文件" }, dialog)).resolves.toEqual([]);
  });

  it("为音频对齐媒体路径传递标题、过滤器和默认路径", async () => {
    const dialog = vi.fn().mockResolvedValue("D:\\media\\full.mkv");
    const path = await pickAlignmentMediaPath(" D:\\media ", dialog);

    expect(path).toBe("D:\\media\\full.mkv");
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择完整版或当前媒体",
        defaultPath: "D:\\media",
        multiple: false,
        directory: false,
        filters: [
          {
            name: "视频或音频文件",
            extensions: [
              "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts",
              "mp3", "m4a", "aac", "flac", "wav", "wave", "ogg", "oga", "opus",
              "wma", "alac", "aiff", "aif", "ape", "ac3", "eac3", "dts", "mka"
            ]
          }
        ]
      })
    );
  });

  it("为 FFmpeg 路径选择保留用户当前输入并处理取消", async () => {
    const dialog = vi.fn().mockResolvedValue(null);
    const path = await pickFfmpegExecutablePath("C:\\tools\\ffmpeg.exe", dialog);

    expect(path).toBeNull();
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择 FFmpeg 可执行文件",
        defaultPath: "C:\\tools\\ffmpeg.exe",
        multiple: false,
        directory: false
      })
    );
  });

  it("为 mpv 路径选择保留用户当前输入", async () => {
    const dialog = vi.fn().mockResolvedValue("C:\\tools\\mpv.exe");
    const path = await pickMpvExecutablePath(" C:\\tools ", dialog);

    expect(path).toBe("C:\\tools\\mpv.exe");
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择 mpv 可执行文件",
        defaultPath: "C:\\tools",
        multiple: false,
        directory: false
      })
    );
  });

  it("为默认导出目录使用原生目录选择器", async () => {
    const dialog = vi.fn().mockResolvedValue("D:\\exports");
    const path = await pickExportDirectoryPath(" D:\\old-exports ", dialog);

    expect(path).toBe("D:\\exports");
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择导出文件夹",
        defaultPath: "D:\\old-exports",
        multiple: false,
        directory: true
      })
    );
  });
});
