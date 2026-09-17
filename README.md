# Danmaku Studio

**简体中文** · [English](README.en.md)

把不同视频版本的弹幕，带回你真正想看的原片。

Danmaku Studio 是一个本地运行的 Windows 弹幕匹配与编辑工具。它面向有分 P、删减、填充和时间偏移的参考素材：导入弹幕 XML 和媒体，自动生成时间关系，检查疑点，再导出适合原片的弹幕。也可以只编辑 XML，无需视频。

[下载安装](https://github.com/ninxio/DanmakuStudio/releases/latest) · [使用指南](docs/USER_GUIDE.md) · [LogVar 接入](docs/LOGVAR.md) · [更新历史](CHANGELOG.md)

## 界面预览

素材、匹配、编辑、导出放在同一工作台中。以下为真实界面的合成示例，不含私人账号、影片或已保存连接；不是对齐精度演示。

![素材工作台](docs/images/workspace.png)

<details>
<summary>查看弹幕编辑与 LogVar 设置</summary>

![弹幕编辑](docs/images/editor.png)

![首次配置 LogVar](docs/images/logvar.png)

</details>

## 能做什么

- **音频匹配**：根据两侧音轨建立时间关系；保留 CPU 和可选 CUDA 声谱计算。
- **AAP 画面匹配**：比较图像感知哈希，生成分段映射；适用于画面相同、音轨不同或没有音轨的版本。
- **逐段检查**：共同内容、版本差异和不确定区域分别表达，支持预览、边界调整与手动校准。
- **编辑和导出**：保留原始时间，支持多份 XML、分 P、撤销、保存恢复与 XML/ASS 导出。
- **可选素材接入**：获取 B 站弹幕和参考音频，或通过 Emby、WebDAV、Motrix 接入素材。
- **可选私人弹幕库**：连接自己部署的 [LogVar / danmu_api](https://github.com/huangxd-/danmu_api)，上传整理好的弹幕，在兼容播放器中使用。主流程无需自建 API。

原始 XML 和视频不会被覆盖。匹配在本机运行，不需要 OpenAI、Gemini 或其他云端模型 API。

## 先理解它怎么工作

弹幕 XML 可以理解成一张“在第几秒显示哪句话”的清单。难点在于：参考版的第 90 秒，未必对应原片的第 90 秒。

Studio 用声音或画面寻找两侧共同内容，再建立一张分段的“时间换算表”。例如，参考版前面多了 12 秒片头，就需要把这一段弹幕提前 12 秒；中间又删了一段时，后面的换算关系也要改变，不能整部影片只加减一个数字。

音频匹配相当于“听声音找同一段”；AAP 相当于“给画面做小指纹，再找连续对应的镜头”。最后，Studio 按这张表重新计算弹幕出现的时间。没有可靠对应的片段会留给你检查，不会随意贴到最近的画面上。

## 三种开始方式

| 已有素材 | 操作 |
| --- | --- |
| 只有 XML | 素材 → 导入 XML → 编辑 → 导出 |
| 参考音频/视频、原片和 XML | 素材 → 匹配 → 音频匹配 → 检查 → 导出 |
| 两侧视频画面相同，但音轨不同 | 素材 → 匹配 → 画面匹配 AAP → 检查 → 导出 |

### 一次完整操作

1. **准备素材**：XML 是你想迁移的弹幕；参考媒体是它原本对应的版本；原片是你最终要观看的版本。
2. **导入并配对**：在素材页加入文件，把 XML 绑定到正确的参考素材。分 P 文件逐一确认归属。
3. **选择匹配方式**：声音接近时用音频匹配；画面接近、配音不同或无音轨时用 AAP。开始后可以停止。
4. **检查和修整**：进入编辑页，检查开头、中间删改点和结尾，处理重复镜头与未匹配区间。必要时手动调整边界和偏移。
5. **导出并试播**：确认导出范围，保存 XML 或 ASS，再用原片实际播放检查。项目另行保存，便于继续编辑。
6. **可选上传**：若要从播放器调用私人库，连接 LogVar，核对片名、年份和季集，预览新增/替换清单，再上传并回读核验。[详细步骤](docs/LOGVAR.md)

AAP 需要参考视频和原片的视频画面。只下载参考音频不能运行 AAP。重复画面、未匹配片段和边界不确定区间仍需检查，当前不会自动把视觉候选标成已验证成品。250 ms 采样也不意味着任意影片都有 250 ms 精度。

本项目不是通用弹幕聚合 API。已有接口能直接满足观看需求时，无需额外整理；Studio 用于需要自己对齐和修整的内容。“从 B 站获取”只能获取仍可访问内容的弹幕和参考音频，不能恢复下架视频，也不是完整视频存档工具。

## 下载、安装与首次使用

前往 [Releases](https://github.com/ninxio/DanmakuStudio/releases)，下载 Windows x64 安装包并运行。GitHub 自动附带的 `Source code` 是源码，不是安装包。

- 纯 XML 编辑不需要外部媒体工具。
- 自动匹配需要 FFmpeg 和 FFprobe，在“设置 → 播放器与工具”检测或指定路径。
- MKV/HEVC 等格式的应用内预览需要兼容的 x64 libmpv DLL。
- 安装包不包含 FFmpeg、libmpv 或原片；Windows 需要 WebView2 运行时。请使用你有权处理的素材。

**新用户不会继承开发者的配置。** 首次使用时 B 站未登录，LogVar/私人库未连接，服务地址为空；存储目录由当前 Windows 用户环境生成。你可以选择自己的目录，按需登录自己的 B 站账号和填写自己的 API 地址。升级安装会保留这台电脑已有的配置，因此老用户可能看到先前保存的路径和账号。

LogVar 配置需要结合 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) 使用。接受 `https://你的服务/TOKEN` 或 `https://你的服务/TOKEN/api/v2`，上传通常还需 `ADMIN_TOKEN`。旧版专用服务仅作为已有连接的兼容入口，不自动迁移凭据或内容。详见 [接入与限制](docs/LOGVAR.md) 和 [本地数据与隐私](docs/PRIVACY.md)。

## 迭代概览

以下是按能力整理的概述，不是每个补丁版本的逐项发布记录。

| 阶段 | 主要变化 |
| --- | --- |
| 早期 / 0.1 系列 | 从 XML 解析、时间偏移与 ASS 导出，逐步加入音频对齐、时间线编辑和桌面应用。 |
| 0.2 系列 | 整理为素材 → 匹配 → 编辑 → 导出的工作台；完善恢复、分集、私人库与本地存储。 |
| 0.3 | 完善影视资料、季集目录及素材接入流程。 |
| 0.4 | 加入 AAP 本地画面匹配，移除 Gemini，整理安全边界与公开源码。 |
| 0.4.1 | 私人库默认接入 LogVar；加入上传预览、限制检查与回读验证，补充双语文档。 |

详见 [更新历史](CHANGELOG.md)。

## 从源码运行

使用 Node.js 20、pnpm 9、Rust stable，以及 Tauri 2 所需的 Windows C++ 构建工具和 WebView2。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri:dev
```

网页开发预览使用 `corepack pnpm dev`；本地文件识别、持久化、媒体匹配和 LogVar 接入需要桌面后端。[构建与验证](docs/BUILDING.md)包含完整命令。

## 特别感谢

- [bili-danmaku-mapper](https://github.com/dowdah/bili-danmaku-mapper)：提供了 AAP 画面感知哈希匹配的方向参考。Studio 的分段求解与时间映射为独立实现。
- [LogVar / danmu_api](https://github.com/huangxd-/danmu_api)：提供弹幕聚合、播放器接口与本地弹幕库，成为 Studio 整理结果的可选使用端。
- [DanmakuBox 贡献者](docs/licenses/DanmakuBox-MIT.txt)：B 站素材获取部分改编自其 MIT 许可代码，完整授权保留在第三方通知中。
- [FFmpeg](https://ffmpeg.org/) 与 [mpv](https://mpv.io/)：为本地媒体解析、采样、音轨处理和预览提供基础能力，运行组件需用户另行安装。
- [Tauri](https://tauri.app/)、[React](https://react.dev/)、[Lucide](https://lucide.dev/) 与 [Material Color Utilities](https://github.com/material-foundation/material-color-utilities)：支持桌面外壳、界面、图标及主题配色。

## 反馈与贡献

欢迎提供不含私人信息的复现步骤、合成样本和错误时间点。请说明参考与原片分别发生了什么变化，以及错误区间；不要上传账号、授权播放地址或无权分享的影片。项目文件会包含媒体路径，分享前请检查。

项目仍处于早期开发阶段。由于此类需求确实比较小众，现阶段已满足个人使用需要，后续大概率不会再有版本更新。

源码采用 [GPL-3.0-only](LICENSE)。第三方依赖与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
