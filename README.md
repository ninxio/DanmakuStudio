# Danmaku Studio

把不同视频版本的弹幕，带回你真正想看的原片。

Danmaku Studio 是一个本地运行的 Windows 弹幕匹配与编辑工具。它面向有分 P、删减、填充和时间偏移的参考素材：导入弹幕 XML 和媒体，自动生成时间关系，检查疑点，再导出适合原片的弹幕。也可以只编辑 XML，无需视频。

## 能做什么

- **音频匹配**：根据两侧音轨建立时间关系；保留 CPU 和可选 CUDA 声谱计算。
- **AAP 画面匹配**：比较图像感知哈希，生成分段映射；适用于画面相同、音轨不同或没有音轨的版本。
- **逐段检查**：共同内容、版本差异和不确定区域分别表达，支持预览、边界调整与手动校准。
- **编辑和导出**：保留原始时间，支持多份 XML、分 P、撤销、保存恢复与 XML/ASS 导出。
- **可选素材接入**：获取 B 站弹幕和参考音频，或通过 Emby、WebDAV、Motrix 接入素材。主流程无需自建弹幕 API。

原始 XML 和视频不会被覆盖。匹配在本机运行；不需要 Gemini 或其他云端模型账号。

## 三种开始方式

| 已有素材                     | 操作                                     |
| ---------------------------- | ---------------------------------------- |
| 只有 XML                     | 素材 → 导入 XML → 编辑 → 导出            |
| 参考音频/视频、原片和 XML    | 素材 → 匹配 → 音频匹配 → 检查 → 导出     |
| 两侧视频相同画面，但音轨不同 | 素材 → 匹配 → 画面匹配 AAP → 检查 → 导出 |

AAP 需要参考视频和原片的视频画面。只下载参考音频不能运行 AAP。它会保留重复画面、未匹配片段和边界不确定区间，当前不会自动把视觉候选标成已验证成品。250 ms 采样也不意味着任意影片都有 250 ms 精度。

本项目不是通用弹幕聚合 API。已有接口能直接满足观看需求时，无需额外整理；Studio 用于需要自己对齐和修整的内容。

## 运行环境

- Windows 桌面版；纯 XML 编辑不需要外部媒体工具。
- 自动匹配需要 FFmpeg 和 FFprobe，设置页可配置路径。
- MKV/HEVC 等格式的应用内预览需要兼容的 libmpv DLL。
- 安装包不包含 FFmpeg、libmpv 或原片；请使用你有权处理的素材。

[使用指南](docs/USER_GUIDE.md) · [算法与限制](docs/ALGORITHMS.md) · [本地数据与隐私](docs/PRIVACY.md)

## 从源码运行

使用 Node.js 20、pnpm 9、Rust stable，以及 Tauri 2 所需的 Windows C++ 构建工具和 WebView2。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri:dev
```

网页开发预览使用 `corepack pnpm dev`；本地文件识别、持久化和媒体匹配需要桌面后端。[构建与验证](docs/BUILDING.md)包含完整命令。

## 反馈与贡献

欢迎提供不含私人信息的复现步骤、合成样本和错误时间点。请说明参考与原片分别发生了什么变化，以及错误区间；不要上传账号、授权播放地址或无权分享的影片。项目文件会包含媒体路径，分享前请检查。

AAP 的产品方向参考了 [bili-danmaku-mapper](https://github.com/dowdah/bili-danmaku-mapper) 的画面感知哈希匹配思路。本实现使用独立的分段求解和现有 Studio 时间映射系统。[算法说明](docs/ALGORITHMS.md)列出可复现测试和证据边界。

源码采用 [GPL-3.0-only](LICENSE)。第三方依赖与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
