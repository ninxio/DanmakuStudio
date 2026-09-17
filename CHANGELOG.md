# 版本迭代 / Development history

以下按版本系列概述主要变化，早期记录为阶段性归纳。

## 0.4.1 — LogVar 接入与使用文档

- 私人弹幕库默认接入 LogVar `danmu_api`，支持带 TOKEN 的播放器地址和可选 ADMIN_TOKEN。
- 凭据独立加密保存；读取列表、选择已有影视、明确新增/替换/只补缺集、串行上传、文件间停止和播放器回读核验。
- 上传前检查兼容格式、10 MiB / 20 万条上限及已知内容变化；原始 XML 保留本地。
- 新增中英文 README、合成界面示例、操作步骤、隐私说明及使用端配置指南。
- 精简首页说明，补充使用与权利联系说明。
- 更新“关于”页的产品介绍和 MD3 样式，修正参考项目致谢，并明确 AAP 尚未经过实际使用测试。
- 使用手工绘制的双对话气泡 SVG 图标，统一窗口、关于页、网页图标及桌面安装包。
- 旧版专用连接保留兼容入口，不自动迁移。

## 0.4.0 — 本地 AAP

尝试实现画面感知哈希匹配、无音轨输入、分段时间映射、候选检查与保存恢复；AAP 尚未经过实际使用测试，保留供后续 fork 验证和改进。移除 Gemini，改进本地媒体访问和凭据管理。

## 0.3 — 影视与季集资料

整理影视元数据、季集目录与可复用资料，让素材选择和成品归属更清楚。

## 0.2 系列 — 工作台与私人库

统一素材、匹配、编辑、导出流程；逐步完善项目恢复、分 P/分集安排、人工校准、私人库更新与存储管理。

## 早期 / 0.1 系列 — 从 XML 工具到桌面应用

从 XML 解析、时间调整与 ASS 导出开始，加入音频匹配、时间线编辑、预览、项目保存及桌面打包。

## English overview

- **0.4.1:** LogVar connection and uploads, explicit review, limits and readback checks; bilingual documentation and synthetic UI previews.
- **0.4.0:** experimental local AAP (not tested in actual use), Gemini removal and improvements to media access and credential management.
- **0.3:** title metadata and season/episode workflows.
- **0.2 series:** unified workspaces, recovery, episode handling and private library updates.
- **Early / 0.1 series:** XML and ASS utilities evolved into audio alignment and a desktop editor.
