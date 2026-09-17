//! Explicit fallback: one GET, owned temporary input, free-space check, no automatic resume.
use super::*;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSource {
    pub sha256: String,
    pub size: u64,
}
pub(super) fn create_directory(job: &Job) -> Result<(), String> {
    std::fs::create_dir_all(job.directory.parent().ok_or("无效缓存根。")?)
        .map_err(|_| "无法创建音轨缓存根。")?;
    std::fs::create_dir(&job.directory).map_err(|_| "任务目录已存在或不可写，未覆盖任何文件。")?;
    crate::project_files::atomic_write(&job.directory.join("owner.txt"), job.id.as_bytes())
        .map_err(|_| "无法保存任务目录归属。".into())
}
pub(super) fn remove_inputs(job: &Job) -> Result<(), String> {
    remove_owned(job, &["source.input", "source.partial"])
}
pub(super) fn remove_owned(job: &Job, names: &[&str]) -> Result<(), String> {
    if !job.directory.exists() {
        return Ok(());
    }
    if !job.directory.is_absolute()
        || job
            .directory
            .ancestors()
            .any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err("临时目录路径含链接，保守保留。".into());
    }
    if read_bounded(&job.directory.join("owner.txt"), 128)? != job.id.as_bytes() {
        return Err("临时目录归属不明，保守保留。".into());
    }
    for name in names {
        let path = job.directory.join(name);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("临时输入是链接，保守保留。".into());
        }
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("临时原片仍被占用或不可移除；记录已保留，可稍后重试。".into()),
        }
    }
    Ok(())
}
pub(super) async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
#[cfg(windows)]
fn available(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut free = 0;
    // SAFETY: a live NUL-terminated path and a valid output pointer, other outputs optional.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err("无法检查临时原片磁盘空间。".into());
    }
    Ok(free)
}
#[cfg(not(windows))]
fn available(_path: &Path) -> Result<u64, String> {
    Err("当前系统尚未接入临时原片磁盘空间检查。".into())
}

pub(super) async fn download(
    c: &Connection,
    target: &reqwest::Url,
    dir: &Path,
    cancel: &AtomicBool,
) -> Result<LocalSource, String> {
    let response = tokio::select! {r=transport::request(c,target,reqwest::Method::GET,None,None)=>r?,_=cancelled(cancel)=>return Err("已取消。".into())};
    if response.status() != reqwest::StatusCode::OK {
        return Err(transport::status_error(response.status()));
    }
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|v| v != "identity")
    {
        return Err("不支持压缩的原片响应。".into());
    }
    let length = response
        .content_length()
        .ok_or("临时原片下载要求服务器提供 Content-Length，以便检查磁盘空间。")?;
    if length == 0 || length > 100 * 1024 * 1024 * 1024 {
        return Err("临时原片大小须为 1 字节至 100 GiB。".into());
    }
    if available(dir)? < length.saturating_add(8 * 1024 * 1024 * 1024) {
        return Err("磁盘空间不足：须容纳临时原片并预留 8 GiB 音轨空间。".into());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("source.partial"))
        .await
        .map_err(|_| "无法创建临时原片。")?;
    let mut response = response;
    let mut hash = Sha256::new();
    let mut count = 0;
    loop {
        let chunk = tokio::select! {r=response.chunk()=>r.map_err(|_|"临时原片读取失败，不续传混合版本。")?,_=cancelled(cancel)=>return Err("已取消。".into())};
        let Some(chunk) = chunk else {
            break;
        };
        count += chunk.len() as u64;
        if count > length {
            return Err("临时原片响应超过声明长度。".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| "临时原片写盘失败。")?;
    }
    if count != length {
        return Err("临时原片响应被截断。".into());
    }
    file.sync_all()
        .await
        .map_err(|_| "临时原片写盘同步失败。")?;
    drop(file);
    tokio::fs::rename(dir.join("source.partial"), dir.join("source.input"))
        .await
        .map_err(|_| "无法提交临时原片。")?;
    Ok(LocalSource {
        sha256: format!("{:x}", hash.finalize()),
        size: count,
    })
}
pub(super) async fn run(
    app: tauri::AppHandle,
    c: Connection,
    target: reqwest::Url,
    job: Job,
    cancel: Arc<AtomicBool>,
) {
    let _cache_use = crate::storage::audio_cache_use().await;
    let result = async {
        create_directory(&job)?;
        with_store(&app, |s| {
            jobs::change(s, &job.id, |j| {
                j.status = JobStatus::Downloading;
                j.message =
                    "正在一次下载临时原片；关闭窗口后继续，退出 Studio 后须重新获取。".into();
            })
        })?;
        tokio::time::timeout(
            Duration::from_secs(4 * 3600),
            download(&c, &target, &job.directory, &cancel),
        )
        .await
        .map_err(|_| "临时原片下载超时。")?
    }
    .await;
    let mut keep = false;
    let _ = with_store(&app, |s| {
        let result = if cancel.load(Ordering::Acquire) {
            Err("已取消。".into())
        } else {
            result
        };
        let write = jobs::change(s, &job.id, |j| match result {
            Ok(source) => {
                j.source = Some(source);
                j.status = JobStatus::AwaitingTrack;
                j.message = "临时原片下载完成，请探测并选择音轨。提取结束后删除临时原片。".into();
                keep = true;
            }
            Err(e) => {
                j.status = if cancel.load(Ordering::Acquire) {
                    JobStatus::Cancelled
                } else {
                    JobStatus::Failed
                };
                j.message = e;
            }
        });
        s.active.remove(&job.id);
        if let Err(e) = write {
            keep = false;
            if let Some(j) = s.jobs.iter_mut().find(|j| j.id == job.id) {
                j.status = JobStatus::Failed;
                j.message = e;
            }
        }
        Ok(())
    });
    let _ = remove_owned(&job, &["source.partial"]);
    if !keep {
        let _ = remove_inputs(&job);
    }
}
pub(super) async fn inspect(
    job: Job,
    ffmpeg_path: Option<String>,
) -> Result<media::Prepared, String> {
    if job.status != JobStatus::AwaitingTrack {
        return Err("临时原片尚未完成下载。".into());
    }
    let source = job.source.as_ref().ok_or("临时原片缺少摘要。")?;
    let expected = source.sha256.clone();
    let path = job.directory.join("source.input");
    let input = path.clone();
    let ffmpeg =
        crate::media_tool_detection::resolve_tool_executable_path("ffmpeg", ffmpeg_path.as_deref());
    let ffprobe = crate::media_probe::resolve_ffprobe_path(&ffmpeg)
        .to_string_lossy()
        .to_string();
    let tool = ffprobe.clone();
    let value = tauri::async_runtime::spawn_blocking(move || {
        if jobs::hash_file(&input, &AtomicBool::new(false))?.0 != expected {
            return Err("临时原片已改变，请重新下载。".into());
        }
        media::probe(
            &tool,
            input.to_str().ok_or("无效临时路径。")?,
            &AtomicBool::new(false),
        )
    })
    .await
    .map_err(|_| "临时原片探测异常。")??;
    let (origin, duration, streams) = media::parse(&value)?;
    if streams.is_empty() {
        return Err("临时原片没有可用音轨。".into());
    }
    Ok(media::Prepared {
        connection: Connection {
            id: job.connection_id.clone(),
            name: String::new(),
            root: "http://localhost/".into(),
            username: String::new(),
            password: String::new(),
        },
        target: reqwest::Url::parse("http://localhost/").unwrap(),
        validator: transport::Validator {
            size: source.size,
            etag: None,
            modified: None,
        },
        public: media::Inspection {
            probe_id: random_id()?,
            name: job.name,
            source_presentation_origin_ms: origin,
            source_reported_duration_ms: duration,
            streams,
        },
        created: Instant::now(),
        ffmpeg,
        ffprobe,
        local: Some((job.id, path, source.sha256.clone())),
    })
}
