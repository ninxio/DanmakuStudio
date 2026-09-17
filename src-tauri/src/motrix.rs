//! MDXP acquisition connector; bundled aria2 is used only for verified torrent metadata.
mod content_files;
mod metadata;
mod recovery;
#[cfg(test)]
mod recovery_tests;
mod rpc_response;
mod task_state;
use base64::Engine;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

static QUEUE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_PAGE: usize = 4 * 1024 * 1024;
const MAX_QUEUE: usize = 2 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    port: u16,
    local_token: String,
}

#[cfg(test)]
tokio::task_local! { static TEST_RPC_ENDPOINT: Endpoint; }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    key: String,
    project_id: String,
    title: String,
    uri: String,
    save_dir: String,
    task_id: Option<String>,
    #[serde(default)]
    metadata_task_id: Option<String>,
    #[serde(default)]
    attempt: u32,
    status: String,
    progress: f64,
    message: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    content_files: Vec<content_files::ContentFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    connected: bool,
    message: String,
    default_directory: String,
    downloads: Vec<Download>,
}

fn endpoint_path() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let root = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root =
        std::env::var_os("HOME").map(|v| PathBuf::from(v).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|v| PathBuf::from(v).join(".config")));
    root.map(|v| v.join("Motrix/bridge/endpoint.json"))
        .ok_or_else(|| "找不到 Motrix 的当前用户目录。".into())
}
fn endpoint() -> Result<Endpoint, String> {
    #[cfg(test)]
    if let Ok(endpoint) = TEST_RPC_ENDPOINT.try_with(Clone::clone) {
        return Ok(endpoint);
    }
    let path = endpoint_path()?;
    if std::fs::metadata(&path)
        .map(|m| m.len() > 16384)
        .unwrap_or(true)
    {
        return Err("请先启动 Motrix 2，再点击刷新连接。".into());
    }
    let data = std::fs::read(path).map_err(|_| "无法读取 Motrix 本机连接。")?;
    let result: Endpoint =
        serde_json::from_slice(&data).map_err(|_| "Motrix 本机连接格式无法识别。")?;
    if result.port == 0 || result.local_token.len() < 16 || result.local_token.len() > 512 {
        return Err("Motrix 本机连接无效，请重启 Motrix。".into());
    }
    Ok(result)
}
async fn bounded(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err("响应超过安全读取上限。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "响应读取中断，请重试。")?
    {
        if bytes.len() + chunk.len() > max {
            return Err("响应超过安全读取上限。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn rpc(method: &str, params: Value) -> Result<Value, String> {
    rpc_detailed(method, params).await.map_err(|e| e.message)
}
async fn rpc_detailed(method: &str, params: Value) -> Result<Value, rpc_response::Failure> {
    let ep = endpoint()?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "无法创建 Motrix 连接。")?;
    let response = client
        .post(format!("http://127.0.0.1:{}/mdxp", ep.port))
        .bearer_auth(ep.local_token)
        .json(&json!({"jsonrpc":"2.0","id":"studio","method":method,"params":params}))
        .send()
        .await
        .map_err(|_| "无法连接 Motrix；请确认它正在运行，然后重试。")?;
    let status = response.status();
    let value: Value = serde_json::from_slice(&bounded(response, MAX_QUEUE).await?)
        .map_err(|_| "Motrix 响应格式无法识别。")?;
    rpc_response::decode(status, value)
}
fn queue_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|v| v.join("acquisition/motrix-v1.json"))
        .map_err(|_| "无法定位下载记录目录。".into())
}
fn load_queue(path: &Path) -> Result<Vec<Download>, String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("无法读取下载记录。".into()),
        Ok(m) if m.len() > MAX_QUEUE as u64 => return Err("下载记录过大，请备份后检查。".into()),
        _ => {}
    }
    let bytes = std::fs::read(path).map_err(|_| "无法读取下载记录。")?;
    serde_json::from_slice(&bytes).map_err(|_| "下载记录损坏；原文件已保留，未覆盖。".into())
}
fn save_queue(path: &Path, rows: &[Download]) -> Result<(), String> {
    let bytes = serde_json::to_vec(rows).map_err(|_| "下载记录编码失败。")?;
    if bytes.len() > MAX_QUEUE {
        return Err("下载记录已达到容量上限。".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建下载记录目录。")?;
    }
    crate::project_files::atomic_write(path, &bytes)
}
fn project_key(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 200 {
        return Err("项目身份无效。".into());
    }
    Ok(())
}
fn request_key(row: &Download) -> String {
    if row.attempt == 0 {
        row.key.clone()
    } else {
        format!("{}:{}", row.key, row.attempt)
    }
}
fn prepare_recreation(row: &mut Download, latest: &Value) -> Result<(), String> {
    if latest.get("task") != Some(&Value::Null) {
        return Err("尚未确认旧任务已移除；请到 Motrix 确认任务后刷新。".into());
    }
    row.attempt = row.attempt.checked_add(1).ok_or("重建次数已达到上限。")?;
    row.task_id = None;
    row.status = "submitting".into();
    row.progress = 0.0;
    row.message.clear();
    row.files.clear();
    Ok(())
}
pub(crate) fn magnet(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "磁力链接格式无效。")?;
    let valid = url.query_pairs().any(|(key, value)| {
        key == "xt"
            && (value.strip_prefix("urn:btih:").is_some_and(|h| {
                (h.len() == 40 && h.bytes().all(|c| c.is_ascii_hexdigit()))
                    || (h.len() == 32
                        && h.bytes()
                            .all(|c| c.is_ascii_alphabetic() || (b'2'..=b'7').contains(&c)))
            }) || value
                .strip_prefix("urn:btmh:1220")
                .is_some_and(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit())))
    });
    if value.len() > 16384
        || url.scheme() != "magnet"
        || url.host_str().is_some()
        || !url.path().is_empty()
        || !valid
    {
        return Err("需要有效 magnet 链接，不能使用网站的数字编号。".into());
    }
    Ok(url)
}
fn update_task(row: &mut Download, value: &Value) -> Result<(), String> {
    let id = value["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or("Motrix 响应缺少任务 ID，请用原请求重试。")?;
    row.task_id = Some(id.into());
    row.status = value["status"].as_str().unwrap_or("unknown").into();
    row.progress = value["progress"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0);
    row.message = if row.status == "error" {
        "Motrix 下载失败，请打开 Motrix 查看详情。".into()
    } else {
        String::new()
    };
    row.files.clear();
    if value["type"] == "magnet" {
        row.metadata_task_id = Some(id.into());
        if row.status == "completed" {
            row.status = "awaiting_download".into();
            row.progress = 0.0;
            row.message = "磁力元数据已就绪，正在核对后续原片任务。".into();
        }
        return Ok(());
    }
    if row.status == "error" && value["errorCode"] == "DL_FILE_WRITE_ERROR" {
        row.message =
            "Motrix 无法写入原片。请使用普通磁盘路径；可选择新文件夹重新下载，旧文件保留。".into();
    }
    if row.status == "seeding"
        && row.progress == 1.0
        && value["bytesTotal"].as_u64().is_some_and(|total| {
            total > 0
                && value["bytesDone"]
                    .as_u64()
                    .is_some_and(|done| done >= total)
        })
    {
        row.files = content_files::verified(Path::new(&row.save_dir), &row.content_files)?;
        if !row.files.is_empty() {
            row.message = "原片已下载并核对文件，做种期间也可导入。".into();
        }
    }
    if row.status == "completed" {
        if let Some(path) = value["finalPath"].as_str().filter(|s| !s.is_empty()) {
            row.files = completed_files(Path::new(&row.save_dir), Path::new(path))?;
        }
    }
    Ok(())
}
fn media_file(path: &Path) -> bool {
    path.extension().and_then(|v| v.to_str()).is_some_and(|v| {
        matches!(
            v.to_ascii_lowercase().as_str(),
            "mkv"
                | "mp4"
                | "m4v"
                | "avi"
                | "mov"
                | "webm"
                | "ts"
                | "m2ts"
                | "flv"
                | "wav"
                | "flac"
                | "mp3"
                | "m4a"
                | "aac"
                | "ogg"
                | "opus"
                | "wave"
                | "oga"
                | "wma"
                | "alac"
                | "aiff"
                | "aif"
                | "ape"
                | "ac3"
                | "eac3"
                | "dts"
                | "mka"
        )
    })
}
fn completed_files(root: &Path, final_path: &Path) -> Result<Vec<String>, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "下载目录已移动或不可访问。")?;
    let path = final_path
        .canonicalize()
        .map_err(|_| "Motrix 报告完成，但文件已移动或不可访问。")?;
    if !path.starts_with(&root) {
        return Err("完成路径位于本次下载目录之外，请在素材页手动确认导入。".into());
    }
    let mut stack = vec![(path, 0)];
    let mut files = vec![];
    let mut visited = 0;
    while let Some((path, depth)) = stack.pop() {
        visited += 1;
        if visited > 5000 || depth > 12 {
            return Err("下载目录内容过多，请使用批量导入选择原片。".into());
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "读取下载文件失败。")?;
        if meta.file_type().is_symlink() {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        if meta.is_file() && meta.len() > 0 && media_file(&path) {
            files.push(path.to_string_lossy().into_owned());
        } else if meta.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|_| "读取下载目录失败。")? {
                stack.push((entry.map_err(|_| "读取下载条目失败。")?.path(), depth + 1));
            }
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
pub async fn get_motrix_workspace(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Workspace, String> {
    project_key(&project_id)?;
    let downloads = {
        let _guard = QUEUE_LOCK.lock().await;
        load_queue(&queue_path(&app)?)?
            .into_iter()
            .filter(|r| r.project_id == project_id)
            .collect()
    };
    let status = rpc("engine/status", json!({})).await;
    let connected = status.as_ref().is_ok_and(|v| v["state"] == "ready");
    let message = match status {
        Ok(_) if connected => "Motrix 已连接".into(),
        Ok(_) => "Motrix 正在准备下载引擎，请稍后刷新。".into(),
        Err(e) => e,
    };
    let default_directory = crate::storage::paths(&app)?
        .originals
        .to_string_lossy()
        .into_owned();
    Ok(Workspace {
        connected,
        message,
        default_directory,
        downloads,
    })
}
#[tauri::command]
pub async fn add_motrix_download(
    app: tauri::AppHandle,
    project_id: String,
    title: String,
    uri: String,
    directory: String,
    restart_missing: Option<bool>,
) -> Result<Download, String> {
    project_key(&project_id)?;
    let uri = task_state::safe_magnet(&uri)?;
    if title.len() > 1000 || directory.len() > 4096 || !Path::new(&directory).is_absolute() {
        return Err("请指定有效的下载目录。".into());
    }
    let save_dir = task_state::prepare_directory(&directory)?;
    let key = format!(
        "studio-{:x}",
        Sha256::digest(format!("{project_id}\n{uri}\n{save_dir}"))
    );
    let _guard = QUEUE_LOCK.lock().await;
    let path = queue_path(&app)?;
    let mut rows = load_queue(&path)?;
    let index = if let Some(index) = rows.iter().position(|r| {
        r.key == key
            || (r.project_id == project_id
                && task_state::same_directory(&r.save_dir, &save_dir)
                && task_state::safe_magnet(&r.uri).is_ok_and(|u| u == uri))
    }) {
        index
    } else {
        if rows.len() >= 500 {
            return Err("已有 500 条下载记录，请先备份整理记录。".into());
        }
        rows.push(Download {
            key: key.clone(),
            project_id,
            title,
            uri: uri.clone(),
            save_dir: save_dir.clone(),
            task_id: None,
            metadata_task_id: None,
            attempt: 0,
            status: "submitting".into(),
            progress: 0.0,
            message: String::new(),
            files: vec![],
            content_files: vec![],
        });
        rows.len() - 1
    };
    if let Some(id) = &rows[index].task_id {
        if !restart_missing.unwrap_or(false) {
            return Ok(rows[index].clone());
        }
        // Only an explicit user action plus a fresh missing-task response can create a new attempt.
        let latest = rpc("task/get", json!({"taskId":id})).await?;
        prepare_recreation(&mut rows[index], &latest)?;
    }
    dispatch_download(&path, &mut rows, index).await
}

async fn dispatch_download(
    path: &Path,
    rows: &mut [Download],
    index: usize,
) -> Result<Download, String> {
    let uri = task_state::safe_magnet(&rows[index].uri)?;
    let save_dir = task_state::prepare_directory(&rows[index].save_dir)?;
    rows[index].save_dir = save_dir.clone();
    // Persist intent before dispatch; retry after a crash keeps the same Motrix idempotency key.
    rows[index].status = "fetching_metadata".into();
    save_queue(&path, &rows)?;
    let cache = path.parent().ok_or("下载记录目录无效。")?.join("metadata");
    let torrent = match metadata::resolve(uri.clone(), cache).await {
        Ok(bytes) => bytes,
        Err(error) => {
            rows[index].status = "metadata_error".into();
            rows[index].message = error;
            save_queue(&path, &rows)?;
            return Ok(rows[index].clone());
        }
    };
    rows[index].content_files = content_files::manifest(&torrent)?;
    rows[index].status = "submitting".into();
    save_queue(&path, &rows)?;
    match rpc_detailed(
        "download/add",
        json!({"kind":"torrent","base64":base64::engine::general_purpose::STANDARD.encode(torrent),"saveDir":save_dir,"idempotencyKey":request_key(&rows[index])}),
    )
    .await
    {
        Ok(result) => {
            if let Err(e) = update_task(&mut rows[index], &result) {
                if rows[index].task_id.is_none() {
                    rows[index].status = "uncertain".into();
                }
                rows[index].message = e;
            }
        }
        Err(e) => {
            rows[index].status = e.status.into();
            rows[index].message = e.message;
            if e.status == "uncertain" {
                rows[index].message.push_str(" 再次提交同一磁力会复用原请求。");
            }
            if e.status == "duplicate_conflict" {
                if let Err(message) = recovery::reconcile(&mut rows[index]).await {
                    rows[index].message.push_str(&format!(" 核对已有任务失败：{message}"));
                }
            }
        }
    }
    save_queue(&path, &rows)?;
    Ok(rows[index].clone())
}

#[tauri::command]
pub async fn repair_motrix_download(
    app: tauri::AppHandle,
    project_id: String,
    key: String,
) -> Result<Download, String> {
    let _guard = QUEUE_LOCK.lock().await;
    let path = queue_path(&app)?;
    let mut rows = load_queue(&path)?;
    let index = rows
        .iter()
        .position(|r| r.key == key && r.project_id == project_id)
        .ok_or("下载记录不存在。")?;
    recovery::repair(&path, &mut rows, index).await
}
#[tauri::command]
pub async fn refresh_motrix_downloads(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<Download>, String> {
    project_key(&project_id)?;
    let _guard = QUEUE_LOCK.lock().await;
    let path = queue_path(&app)?;
    let mut rows = load_queue(&path)?;
    // One bounded snapshot per refresh, shared by all records without receipts.
    let pending_tasks = if rows
        .iter()
        .any(|r| r.project_id == project_id && recovery::needs_reconciliation(r))
    {
        Some(task_state::task_list().await)
    } else {
        None
    };
    for row in rows.iter_mut().filter(|r| r.project_id == project_id) {
        let Some(_) = &row.task_id else {
            if recovery::needs_reconciliation(row) {
                let result = match &pending_tasks {
                    Some(Ok(tasks)) => recovery::reconcile_with_tasks(row, tasks),
                    Some(Err(message)) => Err(message.clone()),
                    None => Ok(()),
                };
                if let Err(message) = result {
                    row.message = message;
                }
            }
            continue;
        };
        row.save_dir = task_state::interoperable_path(&row.save_dir);
        if let Err(e) = task_state::refresh_row(row).await {
            row.files.clear();
            row.message = e;
        }
    }
    save_queue(&path, &rows)?;
    Ok(rows
        .into_iter()
        .filter(|r| r.project_id == project_id)
        .collect())
}
#[tauri::command]
pub async fn get_motrix_completed_files(
    app: tauri::AppHandle,
    project_id: String,
    key: String,
) -> Result<Vec<String>, String> {
    project_key(&project_id)?;
    let mut row = {
        let _guard = QUEUE_LOCK.lock().await;
        load_queue(&queue_path(&app)?)?
            .into_iter()
            .find(|r| r.key == key && r.project_id == project_id)
            .ok_or("下载记录不存在。")?
    };
    task_state::refresh_row(&mut row).await?;
    if !matches!(row.status.as_str(), "completed" | "seeding") || row.files.is_empty() {
        return Err("尚无已核验的完成原片；请等待下载完成或手动选择文件。".into());
    }
    Ok(row.files)
}
pub(crate) fn source_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "来源网址无效。")?;
    if value.len() > 4096
        || url.scheme() != "https"
        || !matches!(url.host_str(), Some("ext.to" | "nyaa.si"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("仅支持 EXT 和 Nyaa 的 HTTPS 页面。其它网站请粘贴磁力链接。".into());
    }
    Ok(url)
}
#[tauri::command]
pub async fn fetch_original_source_page(url: String) -> Result<String, String> {
    let mut url = source_url(&url)?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .user_agent("Mozilla/5.0 DanmakuStudio/0.1 SourceSearch")
        .build()
        .map_err(|_| "无法创建来源连接。")?;
    for _ in 0..4 {
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| "网站连接失败或超时；可以打开搜索页后复制磁力。")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("网站返回无效跳转。")?;
            url = source_url(url.join(location).map_err(|_| "网站跳转无效。")?.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "网站返回 HTTP {}；可打开网页完成验证后复制磁力。",
                response.status().as_u16()
            ));
        }
        return String::from_utf8(bounded(response, MAX_PAGE).await?)
            .map_err(|_| "来源页面不是有效 UTF-8 文本。".into());
    }
    Err("来源页面跳转次数过多。".into())
}
#[tauri::command]
pub fn open_original_source_page(url: String) -> Result<(), String> {
    let url = source_url(&url)?;
    #[cfg(windows)]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .arg(url.as_str())
        .spawn()
        .map_err(|_| "无法打开浏览器。请复制网址后打开。")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_magnet_metadata_is_never_a_completed_original() {
        let mut row: Download = serde_json::from_value(json!({
            "key":"k", "projectId":"p", "title":"test", "uri":"magnet:example",
            "saveDir":"D:\\DanmakuStudio\\原片", "taskId":"metadata", "status":"downloading",
            "progress":0, "message":"", "files":[]
        }))
        .unwrap();
        update_task(
            &mut row,
            &json!({
                "id":"metadata", "type":"magnet", "status":"completed", "progress":1,
                "bytesDone":67879, "bytesTotal":67879, "finalPath":null
            }),
        )
        .unwrap();
        assert_ne!(
            row.status, "completed",
            "Only torrent metadata is complete; the BT payload has not completed"
        );
        assert_eq!(row.progress, 0.0);
        assert!(row.files.is_empty());
    }
    #[test]
    fn restricts_sources_and_validates_real_hashes() {
        for url in [
            "http://ext.to/",
            "https://ext.to.evil.test/",
            "https://user:pass@ext.to/",
            "https://ext.to:123/",
        ] {
            assert!(source_url(url).is_err());
        }
        assert!(source_url("https://ext.to/browse/?q=test").is_ok());
        assert!(magnet("magnet:?xt=urn:btih:5860855").is_err());
        assert!(magnet(&format!("magnet:?xt=urn:btih:{}", "a".repeat(40))).is_ok());
        assert!(magnet("https://ext.to/").is_err());
    }
    #[test]
    fn recreation_requires_confirmed_absence_and_persists_a_new_request_identity() {
        let mut row: Download = serde_json::from_value(json!({
            "key":"stable", "projectId":"p", "title":"x", "uri":"magnet:example",
            "saveDir":"x", "taskId":"old", "status":"missing", "progress":1,
            "message":"removed", "files":[]
        }))
        .unwrap();
        assert_eq!(request_key(&row), "stable"); // Migrated records retain their original request.
        assert!(prepare_recreation(&mut row, &json!({})).is_err());
        assert!(prepare_recreation(&mut row, &json!({"task":{"id":"old"}})).is_err());
        assert_eq!(row.task_id.as_deref(), Some("old"));
        prepare_recreation(&mut row, &json!({"task":null})).unwrap();
        assert!(row.task_id.is_none());
        assert_eq!(request_key(&row), "stable:1");
        let recovered: Download =
            serde_json::from_slice(&serde_json::to_vec(&row).unwrap()).unwrap();
        assert_eq!(request_key(&recovered), "stable:1");
    }
    #[test]
    fn supported_extensions_follow_the_studio_import_contract() {
        let source = include_str!("../../src/domain/project/mediaFormat.ts");
        let arrays = source.split("export type MediaContentKind").next().unwrap();
        for (i, quoted) in arrays.split('"').enumerate() {
            if i % 2 == 1 {
                assert!(
                    media_file(Path::new(&format!("example.{quoted}"))),
                    "{quoted}"
                );
            }
        }
        assert!(!media_file(Path::new("example.mpeg")));
        assert!(!media_file(Path::new("example.mpg")));
        assert!(!media_file(Path::new("example.exe")));
    }
    #[test]
    fn seeding_never_exposes_unverified_paths() {
        let mut row = Download {
            key: "k".into(),
            project_id: "p".into(),
            title: "x".into(),
            uri: "".into(),
            save_dir: "".into(),
            task_id: None,
            metadata_task_id: None,
            attempt: 0,
            status: "".into(),
            progress: 0.0,
            message: "".into(),
            files: vec!["stale.mp4".into()],
            content_files: vec![],
        };
        update_task(
            &mut row,
            &json!({"id":"123","status":"seeding","progress":1,"finalPath":null}),
        )
        .unwrap();
        assert!(row.files.is_empty());
        assert_eq!(row.status, "seeding");
    }
    #[test]
    fn completion_uses_actual_files_inside_the_task_root() {
        let root = std::env::temp_dir().join(format!("studio-motrix-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("season")).unwrap();
        std::fs::write(root.join("season/episode.mkv"), b"test").unwrap();
        std::fs::write(root.join("season/audio.mka"), b"test").unwrap();
        std::fs::write(root.join("season/legacy.mpeg"), b"test").unwrap();
        std::fs::write(root.join("season/readme.exe"), b"test").unwrap();
        assert_eq!(
            completed_files(&root, &root.join("season")).unwrap().len(),
            2
        );
        assert!(completed_files(&root.join("season"), &root).is_err());
        std::fs::remove_file(root.join("season/episode.mkv")).unwrap();
        std::fs::remove_file(root.join("season/audio.mka")).unwrap();
        std::fs::remove_file(root.join("season/legacy.mpeg")).unwrap();
        std::fs::remove_file(root.join("season/readme.exe")).unwrap();
        std::fs::remove_dir(root.join("season")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "explicit live read-only Motrix integration"]
    async fn live_motrix_connection() {
        let v = rpc("engine/status", json!({})).await.unwrap();
        assert_eq!(v["state"], "ready");
    }

    #[test]
    fn queue_roundtrip_preserves_the_retry_identity() {
        let path =
            std::env::temp_dir().join(format!("studio-motrix-queue-{}.json", std::process::id()));
        let row = Download {
            key: "stable-retry".into(),
            attempt: 0,
            project_id: "p".into(),
            title: "test".into(),
            uri: format!("magnet:?xt=urn:btih:{}", "b".repeat(40)),
            save_dir: "I:/Downloads".into(),
            task_id: None,
            metadata_task_id: None,
            status: "uncertain".into(),
            progress: 0.0,
            message: "retry".into(),
            files: vec![],
            content_files: vec![],
        };
        save_queue(&path, &[row]).unwrap();
        let loaded = load_queue(&path).unwrap();
        assert_eq!(loaded[0].key, "stable-retry");
        assert!(loaded[0].task_id.is_none());
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    #[ignore = "explicit live test; creates and removes one synthetic magnet task"]
    async fn live_motrix_canonical_directory() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("studio-motrix-live-{stamp}"));
        std::fs::create_dir(&root).unwrap();
        let directory = root.canonicalize().unwrap();
        let params = json!({"kind":"magnet","uri":format!("magnet:?xt=urn:btih:{}&dn=Studio-synthetic-check","c".repeat(40)),"saveDir":directory.to_string_lossy(),"idempotencyKey":format!("studio-test-{stamp}")});
        let task = rpc("download/add", params.clone()).await.unwrap();
        let again = rpc("download/add", params).await;
        rpc(
            "task/remove",
            json!({"taskId":task["id"],"deleteFiles":false}),
        )
        .await
        .unwrap();
        assert_eq!(again.unwrap()["id"], task["id"]);
    }
}
