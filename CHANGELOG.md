# 版本迭代 / Development history

本页概述能力演进，不公开个人开发日志、素材清单或原始提交历史。早期阶段按系列归纳，不保证每项对应某一个补丁版本。

## 0.4.1 — LogVar 接入与使用文档

- 私人弹幕库默认接入 LogVar `danmu_api`，支持带 TOKEN 的播放器地址和可选 ADMIN_TOKEN。
- 凭据独立加密保存；读取列表、选择已有影视、明确新增/替换/只补缺集、串行上传、文件间停止和播放器回读核验。
- 上传前检查兼容格式、10 MiB / 20 万条上限及已知内容变化；原始 XML 保留本地。
- 新增中英文 README、合成界面示例、操作步骤、隐私说明及使用端配置指南。
- 旧版专用连接保留兼容入口，不自动迁移。

## 0.4.0 — 本地 AAP

独立画面感知哈希匹配、无音轨输入、分段时间映射、候选检查与保存恢复；移除 Gemini，完善媒体访问、凭据和网络边界，整理公开源码。

## 0.3 — 影视与季集资料

整理影视元数据、季集目录与可复用资料，让素材选择和成品归属更清楚。

## 0.2 系列 — 工作台与私人库

统一素材、匹配、编辑、导出流程；逐步完善项目恢复、分 P/分集安排、人工校准、私人库更新与存储管理。

## 早期 / 0.1 系列 — 从 XML 工具到桌面应用

从 XML 解析、时间调整与 ASS 导出开始，加入音频匹配、时间线编辑、预览、项目保存及桌面打包。

## English overview

- **0.4.1:** LogVar connection and uploads, explicit review, limits and readback checks; bilingual documentation and synthetic UI previews.
- **0.4.0:** local AAP, Gemini removal and privacy-reviewed public source.
- **0.3:** title metadata and season/episode workflows.
- **0.2 series:** unified workspaces, recovery, episode handling and private library updates.
- **Early / 0.1 series:** XML and ASS utilities evolved into audio alignment and a desktop editor.
