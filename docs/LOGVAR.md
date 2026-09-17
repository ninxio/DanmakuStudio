# 使用 LogVar 私人弹幕库

Studio 负责本地整理，**[LogVar / danmu_api](https://github.com/huangxd-/danmu_api) 负责保存和向播放器提供弹幕**。这项接入可选；只导出 XML/ASS 时不需要它。

## 1. 准备自己的服务

按上游 README 部署支持“本地弹幕”功能的版本，并配置持久化存储。准备播放器使用的 `TOKEN`；默认上传还需要 `ADMIN_TOKEN`。若服务端显式启用 `LOCAL_DANMU_NOT_REQUIRE_ADMIN=true`，普通 TOKEN 才能上传。不要把管理员凭据当作播放器地址分享。

## 2. 在 Studio 连接

打开“设置 → 私人弹幕库”，填写以下任一种形式：

- `https://你的服务/TOKEN`
- `https://你的服务/TOKEN/api/v2`
- 服务根地址（例如 `http://127.0.0.1:9321`），再单独填写 TOKEN。

反向代理有路径前缀时使用 `https://你的服务/前缀/TOKEN/api/v2`。不要粘贴搜索、上传等具体接口，也不要附查询参数。局域网 HTTP 地址可用，但传输没有 HTTPS 加密。

填入 ADMIN_TOKEN 后点“验证并保存连接”。没有管理员令牌时可以先连接查看；能否上传以服务端权限为准。地址内的 TOKEN 与独立 TOKEN 栏不能互相矛盾。

凭据由 Windows 加密保存在本机，界面不回显地址中的 TOKEN。保存后输入栏清空；留空继续使用已保存连接。更换服务或 TOKEN 时不会默默带走旧管理员凭据。

## 3. 上传整理结果

1. 在 Studio 完成导出后点“发布到私人弹幕库”，或从“管理私人弹幕库”选择需要上传的 XML。
2. 先搜索并选择已有影视资料；新增影视时填写正式片名、年份、类型、季数和对应集数。
3. 点“预览上传清单”。清单会逐份显示**新增、替换或跳过**。只想补缺集时勾选“只补缺集”。
4. 检查内容和季集，勾选确认后上传。一次最多 64 份，逐份处理；停止操作在当前文件结束后生效。
5. 只有播放器接口回读的条数、时间、颜色和正文一致，才显示“回读一致”。对齐是否正确仍由你检查；服务可读取不等于弹幕已对齐。

同一片名、年份、类型、季集的再次上传会替换已有内容。LogVar 没有 Studio 旧专用服务的原子修订锁；Studio 在上传前再次检查已知版本，但不能杜绝另一设备在同一瞬间更新。避免多端同时写同一集。失败后先刷新列表查看当前结果，尤其不要对“已提交、回读不一致”的提示直接重复上传。

## 4. 在播放器里使用

在设置页点击“复制播放器 API 地址”，粘贴到支持自定义弹幕 API 的播放器，按该播放器的说明配置与搜索。选择服务返回的 `local` 来源，即自己上传的弹幕。不同播放器的名称与入口可能不同，本文不承诺每款播放器和每个版本都兼容。

## 格式与容量边界

Studio 读取 XML，在内存中转换为 LogVar 接受的 JSON，再通过本地弹幕上传接口提交。**不会修改本地 XML，也不会上传视频。** 服务端的持久化形式由 LogVar 决定。

- 当前上游每文件最多 10 MiB、最多 200000 条。Studio 会提前拒绝超限，不用静默截断的方式凑出“成功”。
- LogVar 时间保留两位小数；Studio 先按 10 ms 取整，误差最多 5 ms。该变化与音视频对齐算法精度是两回事。
- 正文首尾空白会去除，清单会显示涉及条数。类似 HTML 标签的正文、空正文、黑色以及不支持的高级弹幕会提前报错，避免被上游静默删改。
- 服务端自定义过滤、转换或数量限制也可能影响播放器回读。发现不一致时保留错误，不宣布验证成功。
- 新连接不使用旧专用库的 `/admin/v1`、TMDB 目录、云端确认或历史回退接口。若本机确实保存了旧连接，可在管理弹幕库底部进入旧版兼容流程。

接口依据：[上游本地弹幕 API](https://github.com/huangxd-/danmu_api/blob/ea88a15a7a1990cb62a2dbaf637061f6a4249679/danmu_api/apis/local-danmu-api.js)与[格式转换实现](https://github.com/huangxd-/danmu_api/blob/ea88a15a7a1990cb62a2dbaf637061f6a4249679/danmu_api/utils/local-danmu-parser.js)。上游更新可能改变限制。

## English quick start

1. Deploy your own [LogVar / danmu_api](https://github.com/huangxd-/danmu_api) with local-danmu support and persistent storage. Prepare a reader `TOKEN` and normally an `ADMIN_TOKEN` for uploads.
2. Open 设置 → 私人弹幕库 (Settings → Private library). Enter `https://your-service/TOKEN`, `…/TOKEN/api/v2`, or the root URL plus a separate TOKEN. A proxy prefix is supported as `…/prefix/TOKEN/api/v2`.
3. Save and verify. Credentials are encrypted locally by Windows. The player URL uses the reader TOKEN; the separately entered admin token is not included.
4. Export in Studio or select XML files in the library dialog. Select an existing title or enter title/year/type/season/episode, preview additions and replacements, confirm, then upload. “Fill missing only” skips existing episodes.
5. Studio reads the comments back through the player API and checks the complete returned payload. Copy the player API URL into a compatible player and select the `local` source.

Uploads send converted JSON, not videos; local XML stays unchanged. The current integration checks the 10 MiB / 200,000 comment limits. Timestamps are rounded to 10 ms, with at most 5 ms change; leading/trailing whitespace is removed. Unsupported or silently destructive conversions are rejected. A successful readback does not prove video alignment accuracy. Avoid simultaneous updates to the same episode from other devices: LogVar does not provide an atomic revision lock.
