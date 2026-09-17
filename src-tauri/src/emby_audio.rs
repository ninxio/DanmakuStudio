use futures_util::StreamExt;
use reqwest::{header, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, Command},
    sync::watch,
    task::JoinHandle,
    time::timeout,
};

const MAX_AUDIO_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_SOURCE_STREAM_BYTES: u64 = 128 * 1024 * 1024 * 1024;
const MIN_VALID_AUDIO_BYTES: u64 = 1024;
const FFMPEG_STDERR_LIMIT_BYTES: usize = 128 * 1024;
const FFMPEG_TERMINATION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbyAudioDownloadRequest {
    request_id: String,
    url: String,
    access_token: String,
    cache_identity: String,
    display_name: String,
    profile: String,
    strategy: String,
    audio_stream_index: Option<u32>,
    ffmpeg_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbyAudioDownloadResult {
    local_path: String,
    size_bytes: u64,
    cache_hit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbyAudioCacheStatus {
    file_count: usize,
    total_bytes: u64,
    directory_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbyAudioCacheClearReceipt {
    removed_files: usize,
    removed_bytes: u64,
    after: EmbyAudioCacheStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbyAudioDownloadProgress {
    request_id: String,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbyAudioCacheReceipt {
    schema_version: u32,
    cache_identity_digest: String,
    size_bytes: u64,
    profile: String,
}

fn active_downloads() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static DOWNLOADS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn download_emby_audio(
    app: AppHandle,
    request: EmbyAudioDownloadRequest,
) -> Result<EmbyAudioDownloadResult, String> {
    let _cache_use = crate::storage::audio_cache_use().await;
    validate_request(&request)?;
    let url = parse_request_url(&request.url, &request.strategy)?;
    let extension = profile_extension(&request.profile)?;
    let digest = sha256_hex(request.cache_identity.as_bytes());
    let root = cache_root(&app)?;
    fs::create_dir_all(&root)
        .await
        .map_err(|error| format!("创建 Emby 音频缓存目录失败：{error}"))?;
    let stem = format!(
        "{}--{}",
        sanitize_file_stem(&request.display_name),
        &digest[..12]
    );
    let final_path = root.join(format!("{stem}.{extension}"));
    let receipt_path = root.join(format!("{stem}.json"));
    if let Some(result) =
        read_valid_cache_hit(&final_path, &receipt_path, &digest, &request.profile).await?
    {
        return Ok(result);
    }

    let (cancellation_sender, cancellation_receiver) = watch::channel(false);
    {
        let mut active = active_downloads()
            .lock()
            .map_err(|_| "Emby 音频下载状态锁已损坏。".to_string())?;
        if active.contains_key(&request.request_id) {
            return Err("同一 Emby 音频下载请求已在运行。".to_string());
        }
        active.insert(request.request_id.clone(), cancellation_sender);
    }

    let temporary_path = root.join(format!("{stem}.partial"));
    let result = match request.strategy.as_str() {
        "serverAudio" => {
            download_to_cache(
                &app,
                &request,
                url,
                &temporary_path,
                &final_path,
                &receipt_path,
                &digest,
                cancellation_receiver,
            )
            .await
        }
        "directVideoLocalExtract" => {
            extract_audio_from_direct_video(
                &app,
                &request,
                url,
                &temporary_path,
                &final_path,
                &receipt_path,
                &digest,
                cancellation_receiver,
            )
            .await
        }
        _ => Err("不支持的 Emby 音频获取方式。".to_string()),
    };
    if let Ok(mut active) = active_downloads().lock() {
        active.remove(&request.request_id);
    }
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path).await;
    }
    result
}

#[tauri::command]
pub async fn get_emby_audio_cache_status(app: AppHandle) -> Result<EmbyAudioCacheStatus, String> {
    let root = cache_root(&app)?;
    read_cache_status(&root).await
}

#[tauri::command]
pub async fn clear_emby_audio_cache(app: AppHandle) -> Result<EmbyAudioCacheClearReceipt, String> {
    let _cleanup = crate::storage::audio_cache_cleanup()?;
    if !active_downloads()
        .lock()
        .map_err(|_| "Emby 音频下载状态锁已损坏。".to_string())?
        .is_empty()
    {
        return Err("仍有 Emby 音频正在下载，请先取消或等待完成。".to_string());
    }
    let root = cache_root(&app)?;
    clear_incomplete_audio_files(&root).await
}

async fn clear_incomplete_audio_files(root: &Path) -> Result<EmbyAudioCacheClearReceipt, String> {
    let before = read_cache_status(&root).await?;
    let mut removed_files = 0_usize;
    let mut removed_bytes = 0_u64;
    let mut entries = match fs::read_dir(&root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EmbyAudioCacheClearReceipt {
                removed_files: 0,
                removed_bytes: 0,
                after: before,
            });
        }
        Err(error) => return Err(format!("读取 Emby 音频缓存目录失败：{error}")),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("枚举 Emby 音频缓存失败：{error}"))?
    {
        let path = entry.path();
        // Conservative dependency protection includes every retained revision, recovery snapshot,
        // unsaved editor and unknown external reference: never delete complete audio or receipts.
        if !is_incomplete_audio_file(&path) || !entry.file_type().await.map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let size = entry
            .metadata()
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        fs::remove_file(&path)
            .await
            .map_err(|error| format!("清理 Emby 音频缓存失败：{error}"))?;
        removed_files += 1;
        removed_bytes = removed_bytes.saturating_add(size);
    }
    Ok(EmbyAudioCacheClearReceipt {
        removed_files,
        removed_bytes,
        after: read_cache_status(&root).await?,
    })
}

#[tauri::command]
pub fn cancel_emby_audio_download(request_id: String) -> Result<bool, String> {
    let active = active_downloads()
        .lock()
        .map_err(|_| "Emby 音频下载状态锁已损坏。".to_string())?;
    let Some(sender) = active.get(request_id.trim()) else {
        return Ok(false);
    };
    Ok(sender.send(true).is_ok())
}

async fn download_to_cache(
    app: &AppHandle,
    request: &EmbyAudioDownloadRequest,
    url: Url,
    temporary_path: &Path,
    final_path: &Path,
    receipt_path: &Path,
    digest: &str,
    mut cancellation: watch::Receiver<bool>,
) -> Result<EmbyAudioDownloadResult, String> {
    let client = crate::emby_transport::client(Duration::from_secs(3 * 60 * 60))
        .map_err(|error| format!("初始化 Emby 音频下载器失败：{error}"))?;
    let response_request = client
        .get(url)
        .header("X-Emby-Token", request.access_token.trim())
        .header(
            "X-Emby-Authorization",
            r#"MediaBrowser Client="Danmaku Timeline Studio", Device="Windows Desktop", DeviceId="danmaku-timeline-studio-desktop", Version="0.1.0""#,
        )
        .send();
    let response = tokio::select! {
        result = response_request => result,
        _ = await_cancellation(&mut cancellation) => {
            return Err("Emby 音频下载已取消。".to_string());
        }
    }
    .map_err(|error| format!("请求 Emby 音轨失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Emby 拒绝音轨请求（HTTP {}）。请确认该服务器允许转码和第三方客户端音频流。",
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if content_type.contains("text/html") || content_type.contains("application/json") {
        return Err(format!(
            "Emby 返回了非音频内容（{content_type}），没有保存为素材。"
        ));
    }
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MAX_AUDIO_BYTES) {
        return Err("Emby 音轨超过 4 GiB 安全上限，已停止下载。".to_string());
    }

    let mut file = fs::File::create(temporary_path)
        .await
        .map_err(|error| format!("创建 Emby 音频临时文件失败：{error}"))?;
    let mut received_bytes = 0_u64;
    let mut last_reported_bytes = 0_u64;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            chunk = stream.next() => chunk,
            _ = await_cancellation(&mut cancellation) => {
                return Err("Emby 音频下载已取消。".to_string());
            }
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|error| format!("读取 Emby 音频流失败：{error}"))?;
        received_bytes = received_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "Emby 音轨大小溢出。".to_string())?;
        if received_bytes > MAX_AUDIO_BYTES {
            return Err("Emby 音轨超过 4 GiB 安全上限，已停止下载。".to_string());
        }
        tokio::select! {
            result = file.write_all(&chunk) => {
                result.map_err(|error| format!("写入 Emby 音频缓存失败：{error}"))?;
            }
            _ = await_cancellation(&mut cancellation) => {
                return Err("Emby 音频下载已取消。".to_string());
            }
        }
        if received_bytes.saturating_sub(last_reported_bytes) >= 1024 * 1024
            || total_bytes.is_some_and(|total| received_bytes >= total)
        {
            last_reported_bytes = received_bytes;
            let _ = app.emit(
                "emby-audio-download-progress",
                EmbyAudioDownloadProgress {
                    request_id: request.request_id.clone(),
                    received_bytes,
                    total_bytes,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("刷新 Emby 音频缓存失败：{error}"))?;
    drop(file);
    if received_bytes < MIN_VALID_AUDIO_BYTES {
        return Err("Emby 返回的音轨为空或过短，没有保存为素材。".to_string());
    }

    replace_file(temporary_path, final_path).await?;
    let receipt = EmbyAudioCacheReceipt {
        schema_version: 1,
        cache_identity_digest: digest.to_string(),
        size_bytes: received_bytes,
        profile: request.profile.clone(),
    };
    let receipt_json = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| format!("生成 Emby 音频缓存收据失败：{error}"))?;
    fs::write(receipt_path, receipt_json)
        .await
        .map_err(|error| format!("保存 Emby 音频缓存收据失败：{error}"))?;

    Ok(EmbyAudioDownloadResult {
        local_path: path_to_string(final_path)?,
        size_bytes: received_bytes,
        cache_hit: false,
    })
}

async fn extract_audio_from_direct_video(
    app: &AppHandle,
    request: &EmbyAudioDownloadRequest,
    url: Url,
    temporary_path: &Path,
    final_path: &Path,
    receipt_path: &Path,
    digest: &str,
    mut cancellation: watch::Receiver<bool>,
) -> Result<EmbyAudioDownloadResult, String> {
    let audio_stream_index = request
        .audio_stream_index
        .ok_or_else(|| "本机提取请求缺少音轨编号。".to_string())?;
    let client = crate::emby_transport::client(Duration::from_secs(6 * 60 * 60))
        .map_err(|error| format!("初始化 Emby 直连读取器失败：{error}"))?;
    let response_request = client
        .get(url)
        .header("X-Emby-Token", request.access_token.trim())
        .header(
            "X-Emby-Authorization",
            r#"MediaBrowser Client="Danmaku Timeline Studio", Device="Windows Desktop", DeviceId="danmaku-timeline-studio-desktop", Version="0.1.0""#,
        )
        .send();
    let response = tokio::select! {
        result = response_request => result,
        _ = await_cancellation(&mut cancellation) => {
            return Err("Emby 原片音频获取已取消。".to_string());
        }
    }
    .map_err(|error| format!("请求 Emby 原始媒体流失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Emby 拒绝原始媒体直连（HTTP {}）。该账户或媒体源可能不允许 Direct Play。",
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if content_type.contains("text/html") || content_type.contains("application/json") {
        return Err(format!(
            "Emby 返回了非媒体内容（{content_type}），本机没有开始提取。"
        ));
    }
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MAX_SOURCE_STREAM_BYTES) {
        return Err("Emby 原始媒体流超过 128 GiB 安全上限，已停止。".to_string());
    }

    let executable = crate::media_tool_detection::resolve_tool_executable_path(
        "ffmpeg",
        request.ffmpeg_path.as_deref(),
    );
    let mut command = Command::new(executable);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("warning")
        .arg("-i")
        .arg("pipe:0")
        .arg("-map")
        .arg(format!("0:{audio_stream_index}"))
        .arg("-vn")
        .args(ffmpeg_profile_arguments(&request.profile)?)
        .arg("-y")
        .arg(temporary_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 FFmpeg 本机音轨提取失败：{error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "FFmpeg 输入管道创建失败。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "FFmpeg 诊断管道创建失败。".to_string())?;
    let mut stderr_task = Some(tokio::spawn(capture_ffmpeg_stderr(stderr)));

    let mut received_bytes = 0_u64;
    let mut last_reported_bytes = 0_u64;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            chunk = stream.next() => chunk,
            _ = await_cancellation(&mut cancellation) => {
                terminate_ffmpeg(&mut child).await;
                drain_ffmpeg_stderr(stderr_task.take()).await;
                return Err("Emby 原片音频获取已取消。".to_string());
            }
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                terminate_ffmpeg(&mut child).await;
                drain_ffmpeg_stderr(stderr_task.take()).await;
                return Err(format!("读取 Emby 原始媒体流失败：{error}"));
            }
        };
        received_bytes = received_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "Emby 原始媒体流大小溢出。".to_string())?;
        if received_bytes > MAX_SOURCE_STREAM_BYTES {
            terminate_ffmpeg(&mut child).await;
            drain_ffmpeg_stderr(stderr_task.take()).await;
            return Err("Emby 原始媒体流超过 128 GiB 安全上限，已停止。".to_string());
        }
        let write_result = tokio::select! {
            result = stdin.write_all(&chunk) => Some(result),
            _ = await_cancellation(&mut cancellation) => None,
        };
        match write_result {
            Some(Ok(())) => {}
            Some(Err(error)) => {
                terminate_ffmpeg(&mut child).await;
                let diagnostic = drain_ffmpeg_stderr(stderr_task.take()).await;
                return Err(format!(
                    "FFmpeg 提前停止接收媒体流：{error}{}",
                    format_ffmpeg_diagnostic(&diagnostic)
                ));
            }
            None => {
                terminate_ffmpeg(&mut child).await;
                drain_ffmpeg_stderr(stderr_task.take()).await;
                return Err("Emby 原片音频获取已取消。".to_string());
            }
        }
        if received_bytes.saturating_sub(last_reported_bytes) >= 4 * 1024 * 1024
            || total_bytes.is_some_and(|total| received_bytes >= total)
        {
            last_reported_bytes = received_bytes;
            let _ = app.emit(
                "emby-audio-download-progress",
                EmbyAudioDownloadProgress {
                    request_id: request.request_id.clone(),
                    received_bytes,
                    total_bytes,
                },
            );
        }
    }
    tokio::select! {
        result = stdin.shutdown() => {
            result.map_err(|error| format!("结束 FFmpeg 输入失败：{error}"))?;
        }
        _ = await_cancellation(&mut cancellation) => {
            terminate_ffmpeg(&mut child).await;
            drain_ffmpeg_stderr(stderr_task.take()).await;
            return Err("Emby 原片音频获取已取消。".to_string());
        }
    }
    drop(stdin);
    let wait_result = tokio::select! {
        result = child.wait() => Some(result),
        _ = await_cancellation(&mut cancellation) => None,
    };
    let status = match wait_result {
        Some(result) => result.map_err(|error| format!("等待 FFmpeg 音轨提取完成失败：{error}"))?,
        None => {
            terminate_ffmpeg(&mut child).await;
            drain_ffmpeg_stderr(stderr_task.take()).await;
            return Err("Emby 原片音频获取已取消。".to_string());
        }
    };
    let diagnostic = drain_ffmpeg_stderr(stderr_task.take()).await;
    if !status.success() {
        return Err(format!(
            "FFmpeg 无法从所选媒体源提取第 {audio_stream_index} 号音轨（退出码 {:?}）{}",
            status.code(),
            format_ffmpeg_diagnostic(&diagnostic)
        ));
    }
    let output_size = fs::metadata(temporary_path)
        .await
        .map_err(|error| format!("读取本机音频提取结果失败：{error}"))?
        .len();
    if output_size < MIN_VALID_AUDIO_BYTES {
        return Err("FFmpeg 提取结果为空或过短，没有保存为素材。".to_string());
    }
    if output_size > MAX_AUDIO_BYTES {
        return Err("提取后的音频超过 16 GiB 安全上限，已停止。".to_string());
    }

    replace_file(temporary_path, final_path).await?;
    let receipt = EmbyAudioCacheReceipt {
        schema_version: 2,
        cache_identity_digest: digest.to_string(),
        size_bytes: output_size,
        profile: request.profile.clone(),
    };
    let receipt_json = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| format!("生成 Emby 音频缓存收据失败：{error}"))?;
    fs::write(receipt_path, receipt_json)
        .await
        .map_err(|error| format!("保存 Emby 音频缓存收据失败：{error}"))?;
    Ok(EmbyAudioDownloadResult {
        local_path: path_to_string(final_path)?,
        size_bytes: output_size,
        cache_hit: false,
    })
}

fn ffmpeg_profile_arguments(profile: &str) -> Result<Vec<&'static str>, String> {
    match profile {
        "originalCopy" => Ok(vec!["-c:a", "copy", "-f", "matroska"]),
        "losslessFlac" => Ok(vec![
            "-c:a",
            "flac",
            "-compression_level",
            "5",
            "-f",
            "flac",
        ]),
        "compactAac" => Ok(vec![
            "-c:a", "aac", "-b:a", "256k", "-ac", "2", "-f", "adts",
        ]),
        _ => Err("不支持的 Emby 音频缓存质量档位。".to_string()),
    }
}

async fn capture_ffmpeg_stderr(mut stderr: ChildStderr) -> Vec<u8> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        retained.extend_from_slice(&buffer[..read]);
        if retained.len() > FFMPEG_STDERR_LIMIT_BYTES {
            let overflow = retained.len() - FFMPEG_STDERR_LIMIT_BYTES;
            retained.drain(..overflow);
        }
    }
    retained
}

async fn terminate_ffmpeg(child: &mut Child) {
    let _ = child.start_kill();
    let _ = timeout(FFMPEG_TERMINATION_TIMEOUT, child.wait()).await;
}

async fn drain_ffmpeg_stderr(task: Option<JoinHandle<Vec<u8>>>) -> Vec<u8> {
    let Some(mut task) = task else {
        return Vec::new();
    };
    match timeout(FFMPEG_TERMINATION_TIMEOUT, &mut task).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => Vec::new(),
        Err(_) => {
            task.abort();
            Vec::new()
        }
    }
}

async fn await_cancellation(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn format_ffmpeg_diagnostic(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.is_empty() {
        String::new()
    } else {
        format!("；FFmpeg：{text}")
    }
}

async fn read_valid_cache_hit(
    final_path: &Path,
    receipt_path: &Path,
    digest: &str,
    profile: &str,
) -> Result<Option<EmbyAudioDownloadResult>, String> {
    let (Ok(metadata), Ok(receipt_bytes)) =
        (fs::metadata(final_path).await, fs::read(receipt_path).await)
    else {
        return Ok(None);
    };
    let Ok(receipt) = serde_json::from_slice::<EmbyAudioCacheReceipt>(&receipt_bytes) else {
        return Ok(None);
    };
    if !(1..=2).contains(&receipt.schema_version)
        || receipt.cache_identity_digest != digest
        || receipt.profile != profile
        || receipt.size_bytes != metadata.len()
        || metadata.len() < MIN_VALID_AUDIO_BYTES
    {
        return Ok(None);
    }
    Ok(Some(EmbyAudioDownloadResult {
        local_path: path_to_string(final_path)?,
        size_bytes: metadata.len(),
        cache_hit: true,
    }))
}

async fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    if fs::metadata(destination).await.is_ok() {
        fs::remove_file(destination)
            .await
            .map_err(|error| format!("替换旧 Emby 音频缓存失败：{error}"))?;
    }
    fs::rename(source, destination)
        .await
        .map_err(|error| format!("完成 Emby 音频缓存写入失败：{error}"))
}

fn validate_request(request: &EmbyAudioDownloadRequest) -> Result<(), String> {
    if request.request_id.trim().is_empty()
        || request.access_token.trim().is_empty()
        || request.cache_identity.trim().is_empty()
    {
        return Err("Emby 音频下载请求缺少请求 ID、令牌或缓存身份。".to_string());
    }
    match request.strategy.as_str() {
        "serverAudio" if request.profile == "originalCopy" => {
            return Err("服务器音频接口不能使用原始音轨复制档位。".to_string());
        }
        "serverAudio" => {}
        "directVideoLocalExtract" if request.audio_stream_index.is_none() => {
            return Err("本机提取请求缺少音轨编号。".to_string());
        }
        "directVideoLocalExtract" => {}
        _ => return Err("不支持的 Emby 音频获取方式。".to_string()),
    }
    Ok(())
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage::audio_cache_root(app)
}

fn is_incomplete_audio_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("partial") &&
        path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.rsplit_once("--"))
            .is_some_and(|(_, digest)| digest.len() == 12 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
}

async fn read_cache_status(root: &Path) -> Result<EmbyAudioCacheStatus, String> {
    let mut file_count = 0_usize;
    let mut total_bytes = 0_u64;
    let mut entries = match fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EmbyAudioCacheStatus {
                file_count,
                total_bytes,
                directory_path: path_to_string(root)?,
            });
        }
        Err(error) => return Err(format!("读取 Emby 音频缓存目录失败：{error}")),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("枚举 Emby 音频缓存失败：{error}"))?
    {
        let path = entry.path();
        if !is_complete_audio_cache_file(&path) {
            continue;
        }
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| format!("读取 Emby 音频缓存大小失败：{error}"))?;
        file_count += 1;
        total_bytes = total_bytes.saturating_add(metadata.len());
    }
    Ok(EmbyAudioCacheStatus {
        file_count,
        total_bytes,
        directory_path: path_to_string(root)?,
    })
}

fn is_complete_audio_cache_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("flac" | "aac" | "mka")
    )
}

fn parse_request_url(raw: &str, strategy: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("Emby 音频 URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Emby 音频下载只允许 http 或 https 地址。".to_string());
    }
    let path = url.path().to_ascii_lowercase();
    let allowed = match strategy {
        "serverAudio" => {
            path.contains("/audio/")
                && (path.ends_with("/stream.flac") || path.ends_with("/stream.aac"))
        }
        "directVideoLocalExtract" => {
            path.contains("/videos/")
                && path.ends_with("/stream")
                && url
                    .query_pairs()
                    .any(|(name, value)| name.eq_ignore_ascii_case("Static") && value == "true")
        }
        _ => false,
    };
    if !allowed {
        return Err("Emby 媒体 URL 与所选获取方式不匹配。".to_string());
    }
    Ok(url)
}

fn profile_extension(profile: &str) -> Result<&'static str, String> {
    match profile {
        "losslessFlac" => Ok("flac"),
        "compactAac" => Ok("aac"),
        "originalCopy" => Ok("mka"),
        _ => Err("不支持的 Emby 音频缓存质量档位。".to_string()),
    }
}

fn sanitize_file_stem(raw: &str) -> String {
    let mut stem = String::new();
    let mut previous_separator = false;
    for character in raw.trim().chars().take(80) {
        if character.is_alphanumeric() || character == '-' {
            stem.push(character);
            previous_separator = false;
        } else if !previous_separator {
            stem.push(if character == ' ' { ' ' } else { '_' });
            previous_separator = true;
        }
    }
    let stem = stem.trim_matches([' ', '_', '.']);
    if stem.is_empty() {
        "emby-audio".to_string()
    } else {
        stem.to_string()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Emby 音频缓存路径不是有效 UTF-8。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_url_rejects_local_file_and_script_schemes() {
        assert!(parse_request_url("file:///secret", "serverAudio").is_err());
        assert!(parse_request_url("javascript:alert(1)", "serverAudio").is_err());
        assert!(parse_request_url("https://emby.example/Users", "serverAudio").is_err());
        assert!(
            parse_request_url("https://emby.example/Audio/1/stream.flac", "serverAudio").is_ok()
        );
        assert!(parse_request_url(
            "https://emby.example/Videos/1/stream?Static=true",
            "directVideoLocalExtract"
        )
        .is_ok());
        assert!(parse_request_url(
            "https://emby.example/Videos/1/stream?Static=false",
            "directVideoLocalExtract"
        )
        .is_err());
    }

    #[test]
    fn profiles_have_fixed_extensions() {
        assert_eq!(profile_extension("losslessFlac").unwrap(), "flac");
        assert_eq!(profile_extension("compactAac").unwrap(), "aac");
        assert_eq!(profile_extension("originalCopy").unwrap(), "mka");
        assert_eq!(
            ffmpeg_profile_arguments("originalCopy").unwrap(),
            vec!["-c:a", "copy", "-f", "matroska"]
        );
        assert!(profile_extension("../../exe").is_err());
    }

    #[test]
    fn cache_file_name_is_human_readable_without_path_control() {
        assert_eq!(
            sanitize_file_stem(r#"Dark S03E01: "Episode" / test"#),
            "Dark S03E01_Episode_test"
        );
        assert_eq!(sanitize_file_stem("../../"), "emby-audio");
    }

    #[test]
    fn cache_cleanup_only_manages_known_files() {
        assert!(!is_incomplete_audio_file(Path::new("episode.flac")));
        assert!(!is_incomplete_audio_file(Path::new("episode.partial")));
        assert!(!is_incomplete_audio_file(Path::new("episode.mka")));
        assert!(!is_incomplete_audio_file(Path::new("notes.txt")));
        assert!(is_incomplete_audio_file(Path::new("episode--012345abcdef.partial")));
        assert!(is_complete_audio_cache_file(Path::new("episode.aac")));
        assert!(!is_complete_audio_cache_file(Path::new("episode.json")));
    }

    #[tokio::test]
    async fn complete_audio_and_unknown_references_survive_actual_cleanup() {
        let mut nonce=[0u8;12]; getrandom::fill(&mut nonce).unwrap();
        let dir=std::env::temp_dir().join(format!("studio-audio-clean-{:x}",sha2::Sha256::digest(nonce)));
        fs::create_dir(&dir).await.unwrap();
        let retained=["project-head.flac","old-revision.aac","unsaved.mka","unknown.json","unknown.partial"];
        for name in retained {fs::write(dir.join(name),b"preserve").await.unwrap();}
        fs::write(dir.join("episode--012345abcdef.partial"),b"incomplete").await.unwrap();
        let receipt=clear_incomplete_audio_files(&dir).await.unwrap();
        assert_eq!(receipt.removed_files,1);
        for name in retained {assert_eq!(fs::read(dir.join(name)).await.unwrap(),b"preserve");}
        fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_channel_wakes_without_polling_delay() {
        let (sender, mut receiver) = watch::channel(false);
        sender.send(true).unwrap();
        assert!(
            timeout(Duration::from_millis(50), await_cancellation(&mut receiver))
                .await
                .is_ok()
        );
    }
}
