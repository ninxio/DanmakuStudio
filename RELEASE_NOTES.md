# Danmaku Studio 0.4.1

[简体中文](#中文) · [English](#english)

## 中文

本次更新把私人弹幕库入口接入 [LogVar / danmu_api](https://github.com/huangxd-/danmu_api)，并补全首次使用说明。

- 支持 `https://你的服务/TOKEN`、`…/TOKEN/api/v2`，或服务根地址与单独填写的 TOKEN；ADMIN_TOKEN 用于上传。
- 列出已有影视，选择 XML 或使用本次导出的弹幕，预览新增／替换范围，再上传并通过播放器接口回读核验。支持只补缺集和在文件之间停止。
- 凭据由 Windows 加密保存在当前用户本机。旧版专用服务保留独立入口，不自动迁移凭据和云端数据。
- 更新中英文 README、无私人数据的真实界面预览、操作指南、原理说明和概述式版本历史。
- 保留 0.4.0 的本地音频匹配、AAP 画面匹配、纯 XML 编辑与 XML/ASS 导出。

**下载与运行：** Windows x64 安装包 `DanmakuStudio_0.4.1_windows_x64_setup.exe`。自动匹配需自行配置 FFmpeg/FFprobe；MKV/HEVC 等应用内预览需兼容 libmpv。安装包不附带这些工具或影片。

**升级与限制：** 同一 Windows 用户升级会继续使用自己的本地设置和登录状态，升级不会自动注销。LogVar 上传是替换整份弹幕；单文件最多 10 MiB、20 万条，转换为兼容 JSON 后时间精确到 0.01 秒。当前上游会改变某些正文或颜色，Studio 对无法保真的输入给出处理提示；具体规则见 [接入指南](docs/LOGVAR.md)。上传前检查目标版本，上传后回读；上游没有原子修订锁，请避免多台设备同时更新同一集。AAP 候选仍需人工检查，不能用合成测试推断任意实片精度。

[使用指南](docs/USER_GUIDE.md) · [本地数据与隐私](docs/PRIVACY.md) · [算法与限制](docs/ALGORITHMS.md)

## English

This update connects the private-library workflow to [LogVar / danmu_api](https://github.com/huangxd-/danmu_api).

- Accepts `https://your-service/TOKEN`, `…/TOKEN/api/v2`, or a service root with a separate TOKEN. ADMIN_TOKEN is used for uploads.
- Browse existing titles, select XML files or the current export, review additions and replacements, then upload and verify the result through the player endpoint. Missing-episode-only mode and stopping between files are supported.
- Credentials are encrypted locally for the current Windows user. Existing legacy connections remain separate.
- Adds bilingual documentation, actual UI screenshots made with synthetic data, workflow instructions and an approximate version history. The application UI remains in Simplified Chinese.

**Windows x64:** `DanmakuStudio_0.4.1_windows_x64_setup.exe`. FFmpeg/FFprobe and compatible libmpv are external requirements for matching and some media previews; they and media files are not bundled.

Upgrading preserves the current user's settings and sessions. LogVar replaces whole resources, limits each converted JSON upload to 10 MiB / 200,000 comments, and keeps timestamps to two decimal places. Unsupported transformations are reported before upload. A pre-upload version check and post-upload readback cannot replace an atomic server-side revision lock: avoid simultaneous edits from other devices. AAP still requires review; synthetic tests do not establish real-world accuracy.

[English README](README.en.md) · [LogVar guide](docs/LOGVAR.md#english-quick-start)
