use super::*;
use sha2::{Digest, Sha256};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Downloading,
    AwaitingTrack,
    Extracting,
    Verifying,
    Cancelling,
    Cancelled,
    Interrupted,
    Failed,
    Completed,
}
impl JobStatus {
    fn active(&self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::Downloading
                | Self::Extracting
                | Self::Verifying
                | Self::Cancelling
        )
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub connection_id: String,
    pub href: String,
    pub name: String,
    pub stream_index: u32,
    pub status: JobStatus,
    pub message: String,
    pub created_at_ms: u64,
    pub directory: PathBuf,
    pub receipt: Option<Receipt>,
    #[serde(default)]
    pub source: Option<super::temporary::LocalSource>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub version: u32,
    pub source_presentation_origin_ms: i64,
    pub source_reported_duration_ms: Option<u64>,
    pub source_presentation_end_ms: Option<i64>,
    pub output_duration_ms: u64,
    pub tail_policy: String,
    pub decoded_pts_monotonicity: pts::PtsEvidence,
    pub sha256: String,
    pub size_bytes: u64,
    pub source_consistency: String,
    pub temporary_source_sha256: Option<String>,
    pub(super) source_validator: transport::Validator,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudio {
    pub local_path: String,
    pub file_name: String,
    pub duration_ms: u64,
    pub name: String,
    pub audio_track_label: String,
    pub receipt: Receipt,
}
pub(super) fn load(path: &Path) -> Result<Vec<Job>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = read_bounded(path, 2 * 1024 * 1024)?;
    let mut jobs: Vec<Job> =
        serde_json::from_slice(&bytes).map_err(|_| "WebDAV 任务记录损坏，原文件已保留。")?;
    if jobs.len() > 256 {
        return Err("WebDAV 任务记录超过上限。".into());
    }
    let mut changed = false;
    for j in &mut jobs {
        if j.status.active() {
            j.status = JobStatus::Interrupted;
            j.message = "上次运行已中断。重新探测源文件后重试；已有音轨与项目引用保留。".into();
            changed = true;
        }
    }
    if changed {
        save(path, &jobs)?;
    }
    Ok(jobs)
}
pub(super) fn save(path: &Path, jobs: &[Job]) -> Result<(), String> {
    let bytes = serde_json::to_vec(jobs).map_err(|_| "无法编码 WebDAV 任务记录。")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("WebDAV 任务记录超过大小上限。".into());
    }
    crate::project_files::atomic_write(path, &bytes)
        .map_err(|_| "WebDAV 任务记录写盘失败，不能宣告完成。".into())
}
pub(super) fn change(s: &mut Store, id: &str, update: impl FnOnce(&mut Job)) -> Result<(), String> {
    let mut next = s.jobs.clone();
    let j = next
        .iter_mut()
        .find(|j| j.id == id)
        .ok_or("WebDAV 任务不存在。")?;
    update(j);
    save(&s.root.join("jobs.json"), &next)?;
    s.jobs = next;
    Ok(())
}
pub(super) fn new(p: &media::Prepared, stream_index: u32, cache: PathBuf) -> Result<Job, String> {
    let id = random_id()?;
    Ok(Job {
        id: id.clone(),
        connection_id: p.connection.id.clone(),
        href: p.target.path().into(),
        name: p.public.name.clone(),
        stream_index,
        status: JobStatus::Queued,
        message: "等待获取音轨；关闭此窗口不会取消任务。".into(),
        created_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时钟不合法。")?
            .as_millis() as u64,
        directory: cache.join(id),
        receipt: None,
        source: None,
    })
}
pub(super) async fn run(
    app: tauri::AppHandle,
    p: media::Prepared,
    job: Job,
    cancel: Arc<AtomicBool>,
) {
    let _cache_use = crate::storage::audio_cache_use().await;
    let result = acquire(&p, &job, cancel.clone(), |status, message| {
        with_store(&app, |s| {
            change(s, &job.id, |j| {
                if j.status != JobStatus::Cancelling {
                    j.status = status;
                    j.message = message.into();
                }
            })
        })
    })
    .await;
    let _ = with_store(&app, |s| {
        // Cancellation and completion use the same lock. A late successful child cannot publish
        // after cancellation; durable completion happens only after artifact + receipt commits.
        let terminal = if cancel.load(Ordering::Acquire) {
            Err("任务已取消。".into())
        } else {
            result
        };
        let write = change(s, &job.id, |j| match terminal {
            Ok(receipt) => {
                j.status = JobStatus::Completed;
                j.message =
                    "音轨已缓存。可导入当前项目；完整原片版本及音轨尾部覆盖未获证明。".into();
                j.receipt = Some(receipt);
            }
            Err(message) => {
                j.status = if cancel.load(Ordering::Acquire) {
                    JobStatus::Cancelled
                } else {
                    JobStatus::Failed
                };
                j.message = message;
            }
        });
        s.active.remove(&job.id);
        if let Err(e) = write {
            if let Some(j) = s.jobs.iter_mut().find(|j| j.id == job.id) {
                j.status = JobStatus::Failed;
                j.message = e;
                j.receipt = None;
            }
        }
        Ok(())
    });
    // Only our attempt's incomplete file is disposable. Completed/unknown audio is retained.
    let _ = super::temporary::remove_owned(&job, &["audio.partial"]);
    if p.local.is_some() {
        let _ = super::temporary::remove_inputs(&job);
    }
}
pub(super) async fn acquire(
    p: &media::Prepared,
    job: &Job,
    cancel: Arc<AtomicBool>,
    phase: impl Fn(JobStatus, &str) -> Result<(), String>,
) -> Result<Receipt, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("已取消。".into());
    }
    phase(
        JobStatus::Extracting,
        "正在读取媒体并解码音轨…远程读取可能传输大部分视频字节。",
    )?;
    std::fs::create_dir_all(job.directory.parent().ok_or("缓存目录不合法。")?)
        .map_err(|_| "无法创建音轨缓存根目录。")?;
    if p.local.is_none() {
        super::temporary::create_directory(job)?;
    }
    let (proxy, url) = if let Some((_, path, hash)) = &p.local {
        let path = path.clone();
        let expected = hash.clone();
        let token = cancel.clone();
        let value = tauri::async_runtime::spawn_blocking(move || hash_file(&path, &token))
            .await
            .map_err(|_| "临时原片检查异常。")??;
        if value.0 != expected {
            return Err("临时原片自探测后已改变。".into());
        }
        (
            None,
            p.local.as_ref().unwrap().1.to_string_lossy().to_string(),
        )
    } else {
        let current = tokio::select! {result=tokio::time::timeout(Duration::from_secs(45),transport::pin(&p.connection,&p.target))=>result.map_err(|_|"源版本复核超时。")??,_=super::temporary::cancelled(&cancel)=>return Err("已取消。".into())};
        if current != p.validator {
            return Err("源文件自探测后发生变化，请重新探测。".into());
        }
        let proxy =
            transport::Proxy::open(p.connection.clone(), p.target.clone(), p.validator.clone())
                .await?;
        let url = proxy.url.clone();
        (Some(proxy), url)
    };
    let prepared = p.clone();
    let partial = job.directory.join("audio.partial");
    let output = partial.clone();
    let token = cancel.clone();
    let stream = job.stream_index;
    let result = tauri::async_runtime::spawn_blocking(move || {
        media::extract(&prepared, &url, stream, &output, &token)
    })
    .await
    .map_err(|_| "音轨进程任务异常。")?;
    let transport_result = if let Some(proxy) = proxy {
        proxy.close().await
    } else {
        Ok(())
    };
    let evidence = result?;
    transport_result?;
    if let Some((_, path, expected)) = &p.local {
        let path = path.clone();
        let expected = expected.clone();
        let token = cancel.clone();
        let (actual, _) = tauri::async_runtime::spawn_blocking(move || hash_file(&path, &token))
            .await
            .map_err(|_| "临时原片复核异常。")??;
        if actual != expected {
            return Err("临时原片在提取期间已改变。".into());
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err("已取消。".into());
    }
    phase(JobStatus::Verifying, "正在验证音轨、计算摘要并保存收据…")?;
    let ffprobe = p.ffprobe.clone();
    let token = cancel.clone();
    let check_path = partial.clone();
    let (duration, hash, size) = tauri::async_runtime::spawn_blocking(move || {
        let duration = media::output_duration(&ffprobe, &check_path, &token)?;
        let (hash, size) = hash_file(&check_path, &token)?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&check_path)
            .and_then(|f| f.sync_all())
            .map_err(|_| "音轨写盘同步失败。")?;
        Ok::<_, String>((duration, hash, size))
    })
    .await
    .map_err(|_| "音轨检查任务异常。")??;
    if cancel.load(Ordering::Acquire) {
        return Err("已取消。".into());
    }
    let receipt = Receipt {
        version: 1,
        source_presentation_origin_ms: p.public.source_presentation_origin_ms,
        source_reported_duration_ms: p.public.source_reported_duration_ms,
        source_presentation_end_ms: None,
        output_duration_ms: duration,
        tail_policy: "preserve-decoded-audio-end".into(),
        decoded_pts_monotonicity: evidence,
        sha256: hash,
        size_bytes: size,
        source_validator: p.validator.clone(),
        source_consistency: if p.local.is_some() {
            "single-response-local-sha256"
        } else {
            "strong-etag-range"
        }
        .into(),
        temporary_source_sha256: p.local.as_ref().map(|(_, _, hash)| hash.clone()),
    };
    // Unique attempt directories make rename non-overwriting. No automatic cross-run cache reuse.
    std::fs::rename(&partial, job.directory.join("audio.flac"))
        .map_err(|_| "无法提交音轨缓存。")?;
    crate::project_files::atomic_write(
        &job.directory.join("receipt.json"),
        &serde_json::to_vec(&receipt).map_err(|_| "收据编码失败。")?,
    )
    .map_err(|_| "音轨收据写盘失败，未标记完成。")?;
    Ok(receipt)
}
pub(super) fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<(String, u64), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| "音轨缓存不存在或不可读。")?;
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut buf = [0; 128 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("已取消。".into());
        }
        let n = file.read(&mut buf).map_err(|_| "读取音轨缓存失败。")?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > 100 * 1024 * 1024 * 1024 {
            return Err("文件超过 100 GiB。".into());
        }
        hash.update(&buf[..n]);
    }
    if count == 0 {
        return Err("音轨缓存为空。".into());
    }
    Ok((format!("{:x}", hash.finalize()), count))
}
pub(super) fn validate_import(job: &Job) -> Result<ImportAudio, String> {
    if job.status != JobStatus::Completed {
        return Err("任务尚未可信完成。".into());
    }
    let receipt = job.receipt.clone().ok_or("任务缺少完成收据。")?;
    let disk: Receipt = serde_json::from_slice(&read_bounded(
        &job.directory.join("receipt.json"),
        64 * 1024,
    )?)
    .map_err(|_| "音轨收据损坏。")?;
    if serde_json::to_value(&disk).ok() != serde_json::to_value(&receipt).ok() {
        return Err("音轨收据与任务记录不一致。".into());
    }
    let path = job.directory.join("audio.flac");
    let (hash, size) = hash_file(&path, &AtomicBool::new(false))?;
    if hash != receipt.sha256 || size != receipt.size_bytes {
        return Err("音轨缓存已改变，请重新获取。".into());
    }
    let stem = Path::new(&job.name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("WebDAV")
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(180)
        .collect::<String>();
    Ok(ImportAudio {
        local_path: path.to_string_lossy().into_owned(),
        file_name: format!(
            "{stem}.audio-{}-{}.flac",
            job.stream_index,
            job.id.chars().take(10).collect::<String>()
        ),
        duration_ms: receipt.output_duration_ms,
        name: job.name.clone(),
        audio_track_label: format!("音轨 {} · 单声道 16 kHz FLAC", job.stream_index),
        receipt,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_marks_inflight_interrupted_and_preserves_artifacts() {
        let root = std::env::temp_dir().join(format!("studio-webdav-{}", random_id().unwrap()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("jobs.json");
        let job = Job {
            id: "j".into(),
            connection_id: "c".into(),
            href: "/dav/a".into(),
            name: "a".into(),
            stream_index: 0,
            status: JobStatus::Extracting,
            message: String::new(),
            created_at_ms: 0,
            directory: root.clone(),
            receipt: None,
            source: None,
        };
        save(&path, &[job]).unwrap();
        std::fs::write(root.join("audio.partial"), b"keep").unwrap();
        let jobs = load(&path).unwrap();
        assert_eq!(jobs[0].status, JobStatus::Interrupted);
        assert!(root.join("audio.partial").exists());
        assert!(validate_import(&jobs[0]).is_err());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(root.join("audio.partial")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
