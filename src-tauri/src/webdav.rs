//! WebDAV audio acquisition. The vault, bounded transport, and durable jobs own their invariants.
mod browse;
mod connection;
mod jobs;
mod media;
mod pts;
mod temporary;
#[cfg(test)]
mod tests;
mod transport;
use connection::{Connection, ConnectionInput, ConnectionSummary};
use jobs::{Job, JobStatus};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub(crate) struct WebDavRuntime {
    inner: Mutex<Option<Store>>,
    inspections: Arc<tokio::sync::Semaphore>,
}
impl Default for WebDavRuntime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            inspections: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
}
fn inspect_permit(app: &tauri::AppHandle) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    app.state::<WebDavRuntime>()
        .inspections
        .clone()
        .try_acquire_owned()
        .map_err(|_| "已有两个 WebDAV 探测正在运行，请稍后重试。".into())
}
struct Store {
    root: PathBuf,
    connections: Vec<Connection>,
    jobs: Vec<Job>,
    probes: BTreeMap<String, media::Prepared>,
    active: BTreeMap<String, Arc<AtomicBool>>,
}
fn with_store<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let runtime = app.state::<WebDavRuntime>();
    let mut guard = runtime.inner.lock().map_err(|_| "WebDAV 状态锁不可用。")?;
    if guard.is_none() {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "无法定位 WebDAV 本机记录。")?
            .join("webdav-v1");
        std::fs::create_dir_all(&root).map_err(|_| "无法创建 WebDAV 本机记录目录。")?;
        let connections = connection::load(&root.join("connections.dpapi"))?;
        let jobs = jobs::load(&root.join("jobs.json"))?;
        *guard = Some(Store {
            root,
            connections,
            jobs,
            probes: BTreeMap::new(),
            active: BTreeMap::new(),
        });
    }
    f(guard.as_mut().unwrap())
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成安全标识。")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn read_bounded(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut out = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "无法读取 WebDAV 本机记录。")?
        .take(cap + 1)
        .read_to_end(&mut out)
        .map_err(|_| "无法读取 WebDAV 本机记录。")?;
    if out.len() as u64 > cap {
        return Err("WebDAV 本机记录超过上限。".into());
    }
    Ok(out)
}
fn find_connection(s: &Store, id: &str) -> Result<Connection, String> {
    s.connections
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or("WebDAV 连接已不存在。".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    connections: Vec<ConnectionSummary>,
    jobs: Vec<Job>,
}
#[tauri::command]
pub async fn get_webdav_workspace(app: tauri::AppHandle) -> Result<Workspace, String> {
    with_store(&app, |s| {
        Ok(Workspace {
            connections: s.connections.iter().map(Connection::summary).collect(),
            jobs: s.jobs.clone(),
        })
    })
}
#[tauri::command]
pub async fn save_webdav_connection(
    app: tauri::AppHandle,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let root = connection::root(&input.root)?;
    if input.name.trim().is_empty()
        || input.name.len() > 128
        || input.username.len() > 512
        || input.password.len() > 4096
        || input.username.contains(':')
        || input.username.chars().any(char::is_control)
        || input.password.chars().any(char::is_control)
    {
        return Err("连接名称或账户字段不合法。".into());
    }
    with_store(&app, |s| {
        if s.connections.len() >= 16 {
            return Err("最多保存 16 个 WebDAV 连接。".into());
        }
        let c = Connection {
            id: random_id()?,
            name: input.name.trim().into(),
            root: root.to_string(),
            username: input.username,
            password: input.password,
        };
        let mut next = s.connections.clone();
        next.push(c.clone());
        connection::save(&s.root.join("connections.dpapi"), &next)?;
        s.connections = next;
        Ok(c.summary())
    })
}
#[tauri::command]
pub async fn remove_webdav_connection(
    app: tauri::AppHandle,
    connection_id: String,
) -> Result<(), String> {
    with_store(&app, |s| {
        if s.jobs
            .iter()
            .any(|j| j.connection_id == connection_id && s.active.contains_key(&j.id))
        {
            return Err("请先取消该连接的获取任务，等待收尾后再移除。".into());
        }
        let next = s
            .connections
            .iter()
            .filter(|c| c.id != connection_id)
            .cloned()
            .collect::<Vec<_>>();
        connection::save(&s.root.join("connections.dpapi"), &next)?;
        s.connections = next;
        s.probes.retain(|_, p| p.connection.id != connection_id);
        Ok(())
    })
}
#[tauri::command]
pub async fn list_webdav_entries(
    app: tauri::AppHandle,
    connection_id: String,
    directory: String,
) -> Result<Vec<browse::Entry>, String> {
    let c = with_store(&app, |s| find_connection(s, &connection_id))?;
    tokio::time::timeout(Duration::from_secs(45), browse::list(&c, &directory))
        .await
        .map_err(|_| "目录请求超时。")?
}
#[tauri::command]
pub async fn inspect_webdav_entry(
    app: tauri::AppHandle,
    connection_id: String,
    href: String,
    ffmpeg_path: Option<String>,
) -> Result<media::Inspection, String> {
    let _permit = inspect_permit(&app)?;
    let c = with_store(&app, |s| find_connection(s, &connection_id))?;
    let prepared = media::inspect(c, href, ffmpeg_path).await?;
    with_store(&app, |s| {
        find_connection(s, &connection_id)?;
        s.probes
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
        if s.probes.len() >= 16 {
            return Err("待选音轨的探测过多，请稍后重试。".into());
        }
        let public = prepared.public.clone();
        s.probes.insert(public.probe_id.clone(), prepared);
        Ok(public)
    })
}
#[tauri::command]
pub async fn start_webdav_audio_job(
    app: tauri::AppHandle,
    probe_id: String,
    stream_index: u32,
) -> Result<Job, String> {
    let cache = crate::storage::audio_cache_root(&app)?.join("webdav-v1");
    let (prepared, job, cancel) = with_store(&app, |s| {
        if s.active.len() >= 2 {
            return Err("最多同时获取两个 WebDAV 音轨。".into());
        }
        if s.jobs.len() >= 256 {
            return Err("WebDAV 任务记录达到 256 项上限，请先移除已结束记录。".into());
        }
        let p = s
            .probes
            .get(&probe_id)
            .ok_or("探测已失效，请重新选择文件。")?
            .clone();
        if p.created.elapsed() > Duration::from_secs(600) {
            return Err("探测已过期，请重新探测。".into());
        }
        if p.local.is_none() {
            find_connection(s, &p.connection.id)?;
        }
        if !p.public.streams.iter().any(|a| a.index == stream_index) {
            return Err("所选音轨不在探测结果中。".into());
        }
        let mut next = s.jobs.clone();
        let job = if let Some((id, _, _)) = &p.local {
            let job = next
                .iter_mut()
                .find(|j| &j.id == id && j.status == JobStatus::AwaitingTrack)
                .ok_or("临时原片任务已改变，请重新探测。")?;
            job.stream_index = stream_index;
            job.status = JobStatus::Queued;
            job.message = "等待从临时原片获取音轨…".into();
            job.clone()
        } else {
            let job = jobs::new(&p, stream_index, cache.clone())?;
            next.push(job.clone());
            job
        };
        jobs::save(&s.root.join("jobs.json"), &next)?;
        let cancel = Arc::new(AtomicBool::new(false));
        s.jobs = next;
        s.active.insert(job.id.clone(), cancel.clone());
        s.probes.remove(&probe_id);
        Ok((p, job, cancel))
    })?;
    let returned = job.clone();
    tauri::async_runtime::spawn(async move {
        jobs::run(app, prepared, job, cancel).await;
    });
    Ok(returned)
}
#[tauri::command]
pub async fn cancel_webdav_audio_job(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
    with_store(&app, |s| {
        let Some(cancel) = s.active.get(&job_id) else {
            return Ok(());
        };
        cancel.store(true, Ordering::Release);
        jobs::change(s, &job_id, |j| {
            j.status = JobStatus::Cancelling;
            j.message = "正在停止子进程并关闭媒体通道…".into();
        })
    })
}
#[tauri::command]
pub async fn remove_webdav_job(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
    let _cache_use = crate::storage::audio_cache_use().await;
    with_store(&app, |s| {
        if s.active.contains_key(&job_id) {
            return Err("任务仍在运行，不能移除记录。".into());
        }
        if let Some(job) = s.jobs.iter().find(|j| j.id == job_id) {
            temporary::remove_inputs(job)?;
        }
        let next = s
            .jobs
            .iter()
            .filter(|j| j.id != job_id)
            .cloned()
            .collect::<Vec<_>>();
        jobs::save(&s.root.join("jobs.json"), &next)?;
        s.jobs = next;
        s.probes
            .retain(|_, p| p.local.as_ref().is_none_or(|(id, _, _)| id != &job_id));
        Ok(())
    })
}

#[tauri::command]
pub async fn prepare_webdav_source_job(
    app: tauri::AppHandle,
    connection_id: String,
    href: String,
) -> Result<Job, String> {
    let cache = crate::storage::audio_cache_root(&app)?.join("webdav-v1");
    let (c, target, job, cancel) = with_store(&app, |s| {
        if s.active.len() >= 2 || s.jobs.len() >= 256 {
            return Err("WebDAV 活跃任务或记录达到上限。".into());
        }
        let c = find_connection(s, &connection_id)?;
        let root = connection::root(&c.root)?;
        let target = connection::href(&root, &root, &href)?;
        if target.path().ends_with('/') {
            return Err("请选择媒体文件。".into());
        }
        let id = random_id()?;
        let job = Job {
            id: id.clone(),
            connection_id,
            href: target.path().into(),
            name: connection::display_name(&target),
            stream_index: 0,
            status: JobStatus::Queued,
            message: "等待一次下载临时原片。".into(),
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "系统时钟错误。")?
                .as_millis() as u64,
            directory: cache.join(&id),
            receipt: None,
            source: None,
        };
        let mut next = s.jobs.clone();
        next.push(job.clone());
        jobs::save(&s.root.join("jobs.json"), &next)?;
        s.jobs = next;
        let cancel = Arc::new(AtomicBool::new(false));
        s.active.insert(id, cancel.clone());
        Ok((c, target, job, cancel))
    })?;
    let returned = job.clone();
    tauri::async_runtime::spawn(async move {
        temporary::run(app, c, target, job, cancel).await;
    });
    Ok(returned)
}
#[tauri::command]
pub async fn inspect_webdav_source_job(
    app: tauri::AppHandle,
    job_id: String,
    ffmpeg_path: Option<String>,
) -> Result<media::Inspection, String> {
    let _permit = inspect_permit(&app)?;
    let job = with_store(&app, |s| {
        s.jobs
            .iter()
            .find(|j| j.id == job_id)
            .cloned()
            .ok_or("临时原片任务不存在。".into())
    })?;
    let _cache_use = crate::storage::audio_cache_use().await;
    let p = temporary::inspect(job, ffmpeg_path).await?;
    with_store(&app, |s| {
        if !s
            .jobs
            .iter()
            .any(|j| j.id == job_id && j.status == JobStatus::AwaitingTrack)
        {
            return Err("临时原片任务已改变。".into());
        }
        s.probes
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
        if s.probes.len() >= 16 {
            return Err("待选音轨探测过多，请稍后重试。".into());
        }
        let public = p.public.clone();
        s.probes.insert(public.probe_id.clone(), p);
        Ok(public)
    })
}
#[tauri::command]
pub async fn import_webdav_audio_job(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<jobs::ImportAudio, String> {
    let job = with_store(&app, |s| {
        s.jobs
            .iter()
            .find(|j| j.id == job_id)
            .cloned()
            .ok_or("任务记录不存在。".into())
    })?;
    let _use_guard = crate::storage::audio_cache_use().await;
    tauri::async_runtime::spawn_blocking(move || jobs::validate_import(&job))
        .await
        .map_err(|_| "音轨完整性检查未能完成。")?
}
