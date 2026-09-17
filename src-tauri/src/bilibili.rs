//! Bilibili acquisition: one cancellable queue publishes complete per-page packages.
//! Adapted from DanmakuBox (MIT), copyright 2026 DanmakuBox Contributors.
//! See docs/licenses/DanmakuBox-MIT.txt. Downloaded streams are never transcoded.

mod api;
mod files;
pub(crate) mod auth;

use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::Emitter;
use tokio::sync::Notify;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PAGES: usize = 10_000;
const MAX_DANMAKUS: usize = 250_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliVideoInfo {
    bvid: String,
    aid: u64,
    title: String,
    owner_name: String,
    page_count: usize,
    pages: Vec<BilibiliPageInfo>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliPageInfo {
    cid: u64,
    page: u32,
    part: String,
    duration_ms: u64,
    duration_source: String,
    exact_duration: bool,
    audio_available: Option<bool>,
    audio_codec: Option<String>,
    audio_bandwidth: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BilibiliDownloadRequest {
    request_id: String,
    input: String,
    cookie: Option<String>,
    output_folder: String,
    selected_cids: Vec<u64>,
    download_audio: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BilibiliDownloadResult {
    bvid: String,
    aid: u64,
    cid: u64,
    page: u32,
    part: String,
    duration_ms: u64,
    duration_source: String,
    exact_duration: bool,
    danmaku_count: usize,
    xml_path: String,
    audio_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliDownloadOutcome {
    request_id: String,
    status: &'static str,
    results: Vec<BilibiliDownloadResult>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliLoginStatus {
    logged_in: bool,
    username: Option<String>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BilibiliDownloadProgress {
    request_id: String,
    stage: &'static str,
    current: usize,
    total: usize,
    page: u32,
    percent: f64,
    message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ErrorKind {
    Retryable,
    RateControl,
    Permanent,
    Cancelled,
}

#[derive(Debug)]
struct DownloadError {
    kind: ErrorKind,
    message: String,
}

impl DownloadError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    fn permanent(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Permanent, message)
    }
    fn io(context: &str, error: std::io::Error) -> Self {
        Self::permanent(format!("{context}：{error}"))
    }
}

type DownloadResult<T> = Result<T, DownloadError>;

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }
    fn check(&self) -> DownloadResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(DownloadError::new(
                ErrorKind::Cancelled,
                "下载已取消，已完成的分 P 已保留。",
            ))
        } else {
            Ok(())
        }
    }
    async fn run<T>(&self, future: impl Future<Output = DownloadResult<T>>) -> DownloadResult<T> {
        self.check()?;
        tokio::select! {
            biased;
            _ = self.notify.notified() => {
                self.check()?;
                Err(DownloadError::new(ErrorKind::Cancelled, "下载已取消。"))
            }
            result = future => result,
        }
    }
}

struct ActiveDownload {
    request_id: String,
    cancellation: Arc<Cancellation>,
}
static ACTIVE_DOWNLOAD: OnceLock<Mutex<Option<ActiveDownload>>> = OnceLock::new();

fn active_download() -> &'static Mutex<Option<ActiveDownload>> {
    ACTIVE_DOWNLOAD.get_or_init(|| Mutex::new(None))
}

struct DownloadLease;
impl Drop for DownloadLease {
    fn drop(&mut self) {
        if let Ok(mut active) = active_download().lock() {
            *active = None;
        }
    }
}

struct RunContext {
    request_id: String,
    cancellation: Arc<Cancellation>,
    progress_sink: Option<Arc<dyn Fn(BilibiliDownloadProgress) + Send + Sync>>,
}

impl RunContext {
    fn quiet() -> Self {
        Self {
            request_id: String::new(),
            cancellation: Arc::default(),
            progress_sink: None,
        }
    }
    async fn wait(&self, milliseconds: u64) -> DownloadResult<()> {
        self.cancellation
            .run(async {
                tokio::time::sleep(Duration::from_millis(milliseconds)).await;
                Ok(())
            })
            .await
    }
    fn progress(
        &self,
        stage: &'static str,
        current: usize,
        total: usize,
        page: u32,
        percent: f64,
        message: String,
    ) {
        if let Some(sink) = &self.progress_sink {
            sink(BilibiliDownloadProgress {
                request_id: self.request_id.clone(),
                stage,
                current,
                total,
                page,
                percent: percent.clamp(0.0, 100.0),
                message,
            });
        }
    }
}

#[tauri::command]
pub async fn inspect_bilibili_video(
    app: tauri::AppHandle,
    input: String,
    cookie: Option<String>,
) -> Result<BilibiliVideoInfo, String> {
    let cookie = auth::acquisition_cookie(&app, cookie).await?;
    let context = RunContext::quiet();
    let client = api::build_client(cookie.as_deref(), false).map_err(|e| e.message)?;
    let view = api::fetch_view(&context, &client, &input)
        .await
        .map_err(|e| e.message)?;
    Ok(BilibiliVideoInfo {
        bvid: view.bvid,
        aid: view.aid,
        title: view.title,
        owner_name: view.owner.name,
        page_count: view.pages.len(),
        pages: view
            .pages
            .into_iter()
            .map(|page| BilibiliPageInfo {
                cid: page.cid,
                page: page.page,
                part: page.part,
                duration_ms: api::seconds_to_millis(page.duration),
                duration_source: "view.pages.duration".into(),
                exact_duration: false,
                audio_available: None,
                audio_codec: None,
                audio_bandwidth: None,
            })
            .collect(),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn check_bilibili_login(cookie: String) -> Result<BilibiliLoginStatus, String> {
    api::check_login(&RunContext::quiet(), &cookie)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
pub fn cancel_bilibili_download(request_id: String) -> bool {
    let Ok(active) = active_download().lock() else {
        return false;
    };
    if let Some(active) = active
        .as_ref()
        .filter(|value| value.request_id == request_id)
    {
        active.cancellation.cancel();
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn download_bilibili_package(
    app: tauri::AppHandle,
    mut request: BilibiliDownloadRequest,
) -> Result<BilibiliDownloadOutcome, String> {
    if request.output_folder.trim().is_empty() {
        request.output_folder = crate::storage::paths(&app)?.bilibili.to_string_lossy().into_owned();
    }
    request.cookie = auth::acquisition_cookie(&app, request.cookie).await?;
    validate_request(&request).map_err(|e| e.message)?;
    let cancellation = Arc::new(Cancellation::default());
    let _lease = {
        let mut active = active_download().lock().map_err(|_| "下载队列暂不可用。")?;
        if active.is_some() {
            return Err("已有 B 站采集任务正在进行，请先完成或取消该任务。".into());
        }
        *active = Some(ActiveDownload {
            request_id: request.request_id.clone(),
            cancellation: cancellation.clone(),
        });
        DownloadLease
    };
    let context = RunContext {
        request_id: request.request_id.clone(),
        cancellation,
        progress_sink: Some(Arc::new(move |progress| {
            let _ = app.emit("bilibili-download-progress", progress);
        })),
    };
    Ok(run_download(&context, request).await)
}

fn validate_request(request: &BilibiliDownloadRequest) -> DownloadResult<()> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(DownloadError::permanent("下载任务标识无效。"));
    }
    let selected: std::collections::HashSet<_> = request.selected_cids.iter().collect();
    if selected.is_empty()
        || selected.len() != request.selected_cids.len()
        || selected.len() > MAX_PAGES
        || selected
            .iter()
            .any(|&&cid| cid == 0 || cid > MAX_SAFE_INTEGER)
    {
        return Err(DownloadError::permanent("请选择有效且不重复的分 P。"));
    }
    api::parse_video_identity(&request.input)?;
    Ok(())
}

async fn run_download(
    context: &RunContext,
    request: BilibiliDownloadRequest,
) -> BilibiliDownloadOutcome {
    let mut results = Vec::new();
    let result = acquire(context, &request, &mut results).await;
    let (status, error) = match result {
        Ok(()) => ("completed", None),
        Err(error) if error.kind == ErrorKind::Cancelled => ("cancelled", None),
        Err(error) => ("failed", Some(error.message)),
    };
    BilibiliDownloadOutcome {
        request_id: request.request_id,
        status,
        results,
        error,
    }
}

async fn acquire(
    context: &RunContext,
    request: &BilibiliDownloadRequest,
    results: &mut Vec<BilibiliDownloadResult>,
) -> DownloadResult<()> {
    context.cancellation.check()?;
    let folder = tokio::fs::canonicalize(PathBuf::from(&request.output_folder))
        .await
        .map_err(|e| DownloadError::io("无法打开下载目录", e))?;
    if !folder.is_dir() {
        return Err(DownloadError::permanent("请选择存在的下载文件夹。"));
    }
    let client = api::build_client(request.cookie.as_deref(), false)?;
    let media_client = api::build_client(None, true)?;
    let view = api::fetch_view(context, &client, &request.input).await?;
    let selected: Vec<_> = view
        .pages
        .iter()
        .filter(|page| request.selected_cids.contains(&page.cid))
        .collect();
    if selected.len() != request.selected_cids.len() {
        return Err(DownloadError::permanent(
            "部分所选分 P 不属于当前视频，请重新扫描。",
        ));
    }
    let mut network_pages = 0;
    for (index, page) in selected.iter().enumerate() {
        context.cancellation.check()?;
        let output = files::PageOutput::new(&folder, &view, page, request.download_audio)?;
        if let Some(existing) = output
            .resume(context, &view, page, request.download_audio)
            .await?
        {
            results.push(existing);
            context.progress(
                "complete",
                index + 1,
                selected.len(),
                page.page,
                100.0,
                format!("P{} 已完成并通过校验，已复用", page.page),
            );
            continue;
        }
        if network_pages > 0 {
            let delay = bulk_page_delay_ms(selected.len(), network_pages, page.cid);
            context.progress(
                "cooldown",
                index,
                selected.len(),
                page.page,
                0.0,
                format!("等待后继续读取 P{}", page.page),
            );
            context.wait(delay).await?;
        }
        network_pages += 1;
        context.progress(
            "metadata",
            index + 1,
            selected.len(),
            page.page,
            0.0,
            format!("正在读取 P{} 的播放时长与音轨", page.page),
        );
        let probe = api::fetch_play_probe(context, &client, &view, page).await?;
        if request.download_audio && probe.audio.is_none() {
            return Err(DownloadError::permanent(format!(
                "P{} 没有可下载的普通 DASH 音轨；可关闭音轨选项后继续获取弹幕。",
                page.page
            )));
        }
        let comments = api::fetch_all_danmakus(
            context,
            &client,
            view.aid,
            page.cid,
            index + 1,
            selected.len(),
            page.page,
        )
        .await?;
        let completed = output
            .publish(
                context,
                &media_client,
                &view,
                page,
                &probe,
                &comments,
                request.download_audio,
                index + 1,
                selected.len(),
            )
            .await?;
        // Publication is a short non-cancellable transaction. Record its receipt even if cancel
        // arrived while publishing; the next page will observe cancellation.
        results.push(completed);
        context.progress(
            "complete",
            index + 1,
            selected.len(),
            page.page,
            100.0,
            format!("P{} 已保存", page.page),
        );
    }
    Ok(())
}

fn bulk_page_delay_ms(page_count: usize, sequence: usize, cid: u64) -> u64 {
    let base = match page_count {
        0 | 1 => 0,
        2..=5 => 250,
        6..=24 => 750,
        _ => 1_250,
    };
    if base == 0 {
        0
    } else {
        base + (cid.wrapping_add(sequence as u64 * 173) % 351)
    }
}

#[cfg(test)]
mod tests;
