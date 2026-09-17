//! LogVar local-danmu protocol. Separate vault: legacy credentials never migrate to this service.
use futures_util::StreamExt;
use reqwest::{multipart, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};
use unicode_normalization::UnicodeNormalization;

const MAX_UPLOAD: usize = 10 * 1024 * 1024;
const MAX_COMMENTS: usize = 200_000;
static UPLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    base_url: String,
    read_token: String,
    admin_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureRequest {
    api_address: String,
    read_token: String,
    admin_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    service_url: String,
    has_admin_token: bool,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法定位本机数据目录。")?
        .join("logvar-library/connection.dpapi"))
}
fn load(app: &AppHandle) -> Result<Option<Connection>, String> {
    let bytes = match std::fs::read(vault_path(app)?) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 LogVar 连接。".into()),
    };
    if bytes.len() > 16 * 1024 {
        return Err("LogVar 连接文件过大。".into());
    }
    let plain = crate::credential_protection::protect(&bytes, true)?;
    serde_json::from_slice(&plain)
        .map(Some)
        .map_err(|_| "LogVar 连接文件无效。".into())
}
fn connection(app: &AppHandle) -> Result<Connection, String> {
    load(app)?.ok_or("请先在设置中连接 LogVar danmu_api。".into())
}
fn status(c: Option<&Connection>) -> Status {
    Status {
        configured: c.is_some(),
        service_url: c.map(|c| c.base_url.clone()).unwrap_or_default(),
        has_admin_token: c.is_some_and(|c| !c.admin_token.is_empty()),
    }
}
fn token(value: &str) -> Result<(), String> {
    if value.len() > 256
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "/\\?#".contains(c))
    {
        return Err("TOKEN 不能包含空白、斜杠、查询参数或控制字符，最多 256 字节。".into());
    }
    Ok(())
}
fn normalize(request: ConfigureRequest, old: Option<&Connection>) -> Result<Connection, String> {
    let address = request.api_address.trim();
    let mut next = if address.is_empty() {
        old.cloned().ok_or("请输入 LogVar 接口地址。")?
    } else {
        if address.len() > 2048 || address.contains('\\') {
            return Err("LogVar 地址无效。".into());
        }
        let mut url = Url::parse(address).map_err(|_| "请输入完整的 HTTP 或 HTTPS 接口地址。")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("地址只接受 HTTP/HTTPS，不含用户名、查询参数或片段。".into());
        }
        let mut segments: Vec<String> = url
            .path_segments()
            .ok_or("地址路径无效。")?
            .filter(|s| !s.is_empty())
            .map(|s| {
                percent_encoding::percent_decode_str(s)
                    .decode_utf8()
                    .map(|s| s.into_owned())
                    .map_err(|_| "地址编码无效。".to_string())
            })
            .collect::<Result<_, _>>()?;
        if segments.ends_with(&["api".into(), "v2".into()]) {
            segments.truncate(segments.len() - 2);
        }
        let embedded = segments.pop().unwrap_or_default();
        token(&embedded)?;
        // Remaining segments are an explicit reverse-proxy prefix, before TOKEN/api/v2.
        for s in &segments {
            token(s)?;
        }
        url.set_path("/");
        {
            let mut path = url.path_segments_mut().map_err(|_| "地址路径无效。")?;
            path.clear();
            for s in segments {
                path.push(&s);
            }
        }
        Connection {
            base_url: url.as_str().trim_end_matches('/').into(),
            read_token: embedded,
            admin_token: String::new(),
        }
    };
    if !request.read_token.is_empty() {
        if !address.is_empty()
            && !next.read_token.is_empty()
            && next.read_token != request.read_token
        {
            return Err("地址内 TOKEN 与单独填写的 TOKEN 不一致，请只保留正确的一份。".into());
        }
        next.read_token = request.read_token;
    }
    if !address.is_empty() {
        if let Some(previous) =
            old.filter(|v| v.base_url == next.base_url && v.read_token == next.read_token)
        {
            next.admin_token.clone_from(&previous.admin_token);
        }
    }
    // Changing the reader/account must not silently reuse another account's admin credential.
    if old.is_some_and(|v| v.read_token != next.read_token) && request.admin_token.is_empty() {
        next.admin_token.clear();
    }
    if !request.admin_token.is_empty() {
        next.admin_token = request.admin_token;
    }
    token(&next.read_token)?;
    token(&next.admin_token)?;
    if next.read_token.is_empty() {
        return Err("请在接口地址或 TOKEN 栏中填写播放器 TOKEN；不自动使用默认密码。".into());
    }
    Ok(next)
}
fn endpoint(c: &Connection, admin: bool, parts: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse(&c.base_url).map_err(|_| "已保存的地址无效。")?;
    let credential = if admin && !c.admin_token.is_empty() {
        &c.admin_token
    } else {
        &c.read_token
    };
    {
        let mut path = url.path_segments_mut().map_err(|_| "已保存的地址无效。")?;
        path.pop_if_empty().push(credential);
        for part in parts {
            path.push(part);
        }
    }
    Ok(url)
}
fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "无法初始化 LogVar 连接。".into())
}
async fn response(request: reqwest::RequestBuilder, limit: usize) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "LogVar 请求中断；若正在上传，请先刷新列表核对，勿盲目重试。")?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "LogVar TOKEN 无效。".into(),
            403 => "LogVar 拒绝写入：请填写 ADMIN_TOKEN，或由服务端允许普通 TOKEN 上传。".into(),
            404 => "LogVar 接口或资源不存在，请确认已部署支持本地弹幕库的版本。".into(),
            413 => "LogVar 拒绝过大的文件；请分集整理后上传。".into(),
            300..=399 => "LogVar 地址发生跳转，请填写最终接口地址；凭据不会跟随跳转。".into(),
            _ => format!("LogVar 返回 HTTP {}，请检查服务端。", status.as_u16()),
        });
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "LogVar 响应读取中断。")?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("LogVar 响应超过安全上限。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "LogVar 返回非 JSON 数据，请核对接口地址。")?;
    if value.get("success") == Some(&Value::Bool(false)) {
        return Err("LogVar 未完成请求，请检查服务端配置或资源。".into());
    }
    Ok(value)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    resource_key: String,
    title: String,
    year: u16,
    #[serde(rename = "type")]
    kind: String,
    season: u16,
    episode: Option<u16>,
    count: usize,
    updated_at: String,
    #[serde(default)]
    filename: String,
}
impl Resource {
    fn version(&self) -> String {
        digest(serde_json::to_string(self).unwrap_or_default().as_bytes())
    }
}
async fn resources(c: &Connection) -> Result<Vec<Resource>, String> {
    let v = response(
        client()?.get(endpoint(c, true, &["api", "v2", "local-danmu", "list"])?),
        8 * 1024 * 1024,
    )
    .await?;
    let rows: Vec<Resource> = serde_json::from_value(
        v.get("resources")
            .cloned()
            .ok_or("不是兼容的 LogVar 本地弹幕库。")?,
    )
    .map_err(|_| "LogVar 资源列表格式不兼容，请更新服务端。")?;
    if rows.len() > 10_000 {
        return Err("本次列表超过 10000 项，请在服务端分库管理。".into());
    }
    Ok(rows)
}
#[tauri::command]
pub fn logvar_status(app: AppHandle) -> Result<Status, String> {
    Ok(status(load(&app)?.as_ref()))
}
#[tauri::command]
pub async fn configure_logvar(app: AppHandle, request: ConfigureRequest) -> Result<Status, String> {
    let c = normalize(request, load(&app)?.as_ref())?;
    resources(&c).await?;
    // Verify reader independently, without fetching any external video source.
    response(
        client()?.get(endpoint(&c, false, &["api", "v2", "local-danmu", "list"])?),
        8 * 1024 * 1024,
    )
    .await?;
    let encrypted = crate::credential_protection::protect(
        &serde_json::to_vec(&c).map_err(|_| "无法保存连接。")?,
        false,
    )?;
    let path = vault_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("目录无效。")?)
        .map_err(|_| "无法创建连接目录。")?;
    crate::project_files::atomic_write(&path, &encrypted)?;
    Ok(status(Some(&c)))
}
#[tauri::command]
pub fn clear_logvar(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(vault_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法移除本机连接。".into()),
    }
}
#[tauri::command]
pub fn logvar_player_url(app: AppHandle) -> Result<String, String> {
    Ok(endpoint(&connection(&app)?, false, &[])?.to_string())
}
#[tauri::command]
pub async fn list_logvar_library(app: AppHandle) -> Result<Vec<Resource>, String> {
    resources(&connection(&app)?).await
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    title: String,
    year: u16,
    #[serde(rename = "type")]
    kind: String,
    season: u16,
    episode: Option<u16>,
}
fn normalize_title(title: &str) -> String {
    let normalized: String = title.nfkc().collect();
    let without_extension = normalized
        .rfind('.')
        .filter(|i| *i + 1 < normalized.len())
        .map(|i| &normalized[..i])
        .unwrap_or(&normalized);
    without_extension
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn resource_key(meta: &Metadata) -> Result<String, String> {
    // LogVar validates the actual current year itself; the desktop rejects obviously invalid input.
    if meta.title.trim().is_empty()
        || meta.title.encode_utf16().count() > 120
        || !(1900..=2100).contains(&meta.year)
        || !matches!(meta.kind.as_str(), "tv" | "movie")
        || meta.season == 0
        || (meta.kind == "tv" && meta.episode.is_none())
        || meta.episode == Some(0)
    {
        return Err("请填写片名、有效年份、类型、季数和集数。".into());
    }
    let title = normalize_title(&meta.title);
    if title.is_empty() {
        return Err("片名归一化后为空。".into());
    }
    let mut parts = vec![title, meta.year.to_string(), meta.kind.clone()];
    if meta.season != 1 {
        parts.push(format!("s{}", meta.season));
    }
    parts.push(meta.episode.map(|n| n.to_string()).unwrap_or("all".into()));
    Ok(parts.join("|"))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    connection_key: String,
    source_hash: String,
    resource_key: String,
    expected_version: Option<String>,
    count: usize,
    upload_bytes: usize,
    trimmed_text_count: usize,
}
struct Prepared {
    bytes: Vec<u8>,
    comments: Vec<Value>,
    trimmed: usize,
}
fn prepare(xml: &str) -> Result<Prepared, String> {
    if xml.len() > 64 * 1024 * 1024 {
        return Err("XML 超过 64 MiB。".into());
    }
    let items = crate::xml_import_receipt::parse_publication_items(xml.as_bytes())?;
    if items.is_empty() || items.len() > MAX_COMMENTS {
        return Err("LogVar 每份文件需包含 1–200000 条弹幕；请分集整理，不能静默截断。".into());
    }
    let mut comments = Vec::with_capacity(items.len());
    let mut trimmed = 0;
    for item in items {
        let mode = item
            .mode
            .filter(|m| (1..=6).contains(m))
            .ok_or("LogVar 上传只支持普通滚动、顶部、底部与逆向弹幕。")?;
        let color = item
            .color
            .filter(|c| (1..=0xffffff).contains(c))
            .ok_or("当前 LogVar 会将黑色弹幕变为白色，或颜色无效；请先在编辑页处理颜色。")?;
        let text = item.text.trim();
        if text.is_empty() || text.find('<').is_some_and(|i| text[i + 1..].contains('>')) {
            return Err("当前 LogVar 会删除空正文或类似 HTML 标签的内容；为避免丢失，请先在编辑页处理这些弹幕。".into());
        }
        if text != item.text {
            trimmed += 1;
        }
        let cs = (item.source_time_ms + 5) / 10;
        comments.push(json!({"p":format!("{}.{:02},{mode},{color}",cs/100,cs%100),"m":text}));
    }
    let bytes = serde_json::to_vec(&json!({"comments":comments})).map_err(|_| "弹幕编码失败。")?;
    if bytes.len() > MAX_UPLOAD {
        return Err("转换后的 LogVar 上传文件超过 10 MiB，请按集拆分；原 XML 未修改。".into());
    }
    Ok(Prepared {
        bytes,
        comments,
        trimmed,
    })
}
fn connection_key(c: &Connection) -> String {
    digest(serde_json::to_string(c).unwrap_or_default().as_bytes())
}
async fn preview_with(c: &Connection, xml: &str, meta: &Metadata) -> Result<Preview, String> {
    let prepared = prepare(xml)?;
    let key = resource_key(meta)?;
    let rows = resources(c).await?;
    Ok(Preview {
        connection_key: connection_key(c),
        source_hash: digest(xml.as_bytes()),
        resource_key: key.clone(),
        expected_version: rows
            .iter()
            .find(|r| r.resource_key == key)
            .map(Resource::version),
        count: prepared.comments.len(),
        upload_bytes: prepared.bytes.len(),
        trimmed_text_count: prepared.trimmed,
    })
}
#[tauri::command]
pub async fn preview_logvar_upload(
    app: AppHandle,
    xml: String,
    metadata: Metadata,
) -> Result<Preview, String> {
    preview_with(&connection(&app)?, &xml, &metadata).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    xml: String,
    metadata: Metadata,
    preview: Preview,
}
async fn upload_with(c: &Connection, request: UploadRequest) -> Result<Value, String> {
    let _lock = UPLOAD.lock().await;
    let prepared = prepare(&request.xml)?;
    let key = resource_key(&request.metadata)?;
    if request.preview.connection_key != connection_key(c)
        || request.preview.source_hash != digest(request.xml.as_bytes())
        || request.preview.resource_key != key
    {
        return Err("连接、XML 或目标已变化，请重新预览上传清单。".into());
    }
    let rows = resources(c).await?;
    if rows
        .iter()
        .find(|r| r.resource_key == key)
        .map(Resource::version)
        != request.preview.expected_version
    {
        return Err("LogVar 该集已变化，请刷新并重新预览；本次未覆盖。".into());
    }
    let meta = request.metadata;
    let mut form = multipart::Form::new()
        .text("title", meta.title.trim().to_string())
        .text("year", meta.year.to_string())
        .text("type", meta.kind)
        .text("season", meta.season.to_string())
        .part(
            "file",
            multipart::Part::bytes(prepared.bytes)
                .file_name("danmaku.json")
                .mime_str("application/json")
                .map_err(|_| "上传格式无效。")?,
        );
    if let Some(ep) = meta.episode {
        form = form.text("episode", ep.to_string());
    }
    let http = client()?;
    let result = response(
        http.post(endpoint(c, true, &["api", "v2", "local-danmu", "upload"])?)
            .multipart(form),
        1024 * 1024,
    )
    .await?;
    let resource: Resource = serde_json::from_value(result["resource"].clone())
        .map_err(|_| "上传可能已完成，但返回资源无效；请刷新核对。")?;
    if resource.resource_key != key || resource.count != prepared.comments.len() {
        return Err("上传已提交，但资源身份或条数不一致；请在 LogVar 核对，不会自动重试。".into());
    }
    let check = response(
        http.get(endpoint(c, true, &["api", "v2", "local-danmu", &key])?),
        1024 * 1024,
    )
    .await?;
    let checked: Resource = serde_json::from_value(check["resource"].clone())
        .map_err(|_| "上传已提交，元数据回读无效。")?;
    if checked.version() != resource.version() {
        return Err("上传后资源又发生变化，请刷新核对。".into());
    }
    let value = response(
        http.get(endpoint(c, false, &["api", "v2", "comment"])?)
            .query(&[("url", format!("local:{key}")), ("format", "json".into())]),
        32 * 1024 * 1024,
    )
    .await?;
    verify_comments(&value, &prepared.comments)?;
    Ok(json!({"resource":resource,"verifiedCount":prepared.comments.len()}))
}
fn verify_comments(value: &Value, expected: &[Value]) -> Result<(), String> {
    let actual = value["comments"]
        .as_array()
        .ok_or("上传已提交，但播放器未返回弹幕列表。")?;
    let same = actual.len() == expected.len()
        && actual.iter().zip(expected).all(|(a, b)| {
            let fields = |v: &Value| {
                v["p"]
                    .as_str()
                    .unwrap_or("")
                    .split(',')
                    .take(3)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            };
            let af = fields(a);
            let bf = fields(b);
            af.len() == 3
                && bf.len() == 3
                && af
                    .iter()
                    .zip(&bf)
                    .all(|(x, y)| x.parse::<f64>().ok() == y.parse::<f64>().ok())
                && a["m"] == b["m"]
        });
    if !same {
        return Err("上传已提交，但播放器回读的条数、时间、颜色或正文不一致；请检查 LogVar 转换规则，不会自动重试。".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn upload_logvar_xml(app: AppHandle, request: UploadRequest) -> Result<Value, String> {
    upload_with(&connection(&app)?, request).await
}

#[cfg(test)]
mod tests;
