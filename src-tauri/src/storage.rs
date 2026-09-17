//! One effective, immutable directory set per process. Settings select the next startup.
mod migration;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageSettings {
    pub root_directory: String,
    pub cache_directory: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoragePaths {
    pub root: PathBuf,
    pub projects: PathBuf,
    pub database: PathBuf,
    pub bilibili: PathBuf,
    pub originals: PathBuf,
    pub emby_audio: PathBuf,
    pub features: PathBuf,
    pub exports: PathBuf,
}

pub struct StorageRuntime {
    config: PathBuf,
    default_root: PathBuf,
    paths: Result<StoragePaths, String>,
    legacy_audio: Option<PathBuf>,
    // Global across ALL roots: two instances must not activate different libraries.
    _instance: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    retained_legacy_directories: Vec<PathBuf>,
    fixed_local_data: PathBuf,
    fixed_outbox: PathBuf,
    active: Option<StoragePaths>,
    requested: Option<StoragePaths>,
    restart_required: bool,
    error: Option<String>,
}

static FEATURE_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

pub(crate) fn feature_root(environment: &str, directory: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(environment).filter(|p| !p.is_empty()) {
        return Some(path.into());
    }
    if let Some(root) = FEATURE_ROOT.get() {
        return root.as_ref().map(|p| p.join(directory));
    }
    // Headless tools retain explicit environment overrides; tests never touch user caches.
    #[cfg(test)]
    {
        None
    }
    #[cfg(not(test))]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| {
            PathBuf::from(p)
                .join("studio.danmaku.timeline")
                .join(directory)
        })
    }
}

pub(crate) fn settings_from_content(content: &str) -> Result<StorageSettings, String> {
    let value: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    if !value.is_object()
        || value
            .get("schemaVersion")
            .is_some_and(|v| v.as_u64() != Some(1))
    {
        return Err("应用设置格式或版本无效，无法安全选择项目库。".into());
    }
    match value.get("storage") {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|e| format!("存储设置无效：{e}"))
        }
        None => Ok(StorageSettings::default()),
    }
}

fn read_settings(config: &Path) -> Result<StorageSettings, String> {
    match fs::read_to_string(config.join("app-settings.json")) {
        Ok(content) => settings_from_content(&content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StorageSettings::default()),
        Err(e) => Err(format!("无法读取存储设置：{e}")),
    }
}

impl StoragePaths {
    pub fn resolve(default_root: &Path, settings: &StorageSettings) -> Result<Self, String> {
        let root = configured_path(&settings.root_directory, default_root)?;
        let cache = configured_path(&settings.cache_directory, &root.join("cache"))?;
        let projects = normalize_path(&root.join("project-library/v1"))?;
        Ok(Self {
            database: projects.join("library.sqlite3"),
            projects,
            bilibili: normalize_path(&root.join("inputs/bilibili"))?,
            originals: normalize_path(&root.join("originals"))?,
            emby_audio: normalize_path(&cache.join("emby-audio-v1"))?,
            features: normalize_path(&cache.join("features"))?,
            exports: normalize_path(&root.join("exports"))?,
            root,
        })
    }

    fn prepare(&self) -> Result<(), String> {
        for directory in [
            &self.projects,
            &self.bilibili,
            &self.originals,
            &self.emby_audio,
            &self.features,
            &self.exports,
        ] {
            probe_directory(directory)?;
        }
        Ok(())
    }
}

fn configured_path(value: &str, default: &Path) -> Result<PathBuf, String> {
    let path = if value.trim().is_empty() {
        default.to_owned()
    } else {
        PathBuf::from(value.trim())
    };
    if !path.is_absolute()
        || path.parent().is_none()
        || path.components().any(|p| matches!(p, Component::ParentDir))
        || path.as_os_str().len() > 4096
    {
        return Err("存储目录必须是完整文件夹路径，不能是磁盘根目录或包含 ..。".into());
    }
    normalize_path(&path)
}

/// Resolve existing ancestors (including junctions), retaining missing leaf directories.
/// Return ordinary Windows/UNC paths so downstream Motrix never receives a \\?\ prefix.
pub(super) fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(ancestor) {
            Ok(mut normalized) => {
                #[cfg(windows)]
                {
                    let text = normalized.to_string_lossy();
                    normalized = if let Some(tail) = text.strip_prefix("\\\\?\\UNC\\") {
                        PathBuf::from(format!("\\\\{tail}"))
                    } else if let Some(tail) = text.strip_prefix("\\\\?\\") {
                        PathBuf::from(tail)
                    } else {
                        normalized
                    };
                }
                for part in suffix.iter().rev() {
                    normalized.push(part);
                }
                return Ok(normalized);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(
                    ancestor
                        .file_name()
                        .ok_or("目录不存在或不可访问。")?
                        .to_os_string(),
                );
                ancestor = ancestor.parent().ok_or("目录缺少有效上级路径。")?;
            }
            Err(e) => return Err(format!("无法解析目录 {}：{e}", path.display())),
        }
    }
}

fn probe_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("无法创建目录 {}：{e}", path.display()))?;
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let name = random
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    let probe = path.join(format!(".studio-write-check-{name}"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(|e| e.to_string())?;
        file.write_all(b"storage check")
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())
    })();
    if probe.exists() {
        fs::remove_file(&probe).map_err(|e| format!("无法清理目录检测文件：{e}"))?;
    }
    result.map_err(|e| format!("目录不可写 {}：{e}", path.display()))
}

impl StorageRuntime {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let mut runtime = Self::start(config, root)?;
        runtime.legacy_audio = app
            .path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("emby-audio-cache-v1"));
        FEATURE_ROOT
            .set(runtime.paths.as_ref().ok().map(|p| p.features.clone()))
            .map_err(|_| "存储目录已经初始化。")?;
        Ok(runtime)
    }

    fn start(config: PathBuf, default_root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config).map_err(|e| e.to_string())?;
        let instance = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(config.join("studio-instance.lock"))
            .map_err(|e| e.to_string())?;
        instance
            .try_lock()
            .map_err(|_| "已有 Studio 实例正在使用本机数据。请保存并关闭另一实例后重试。")?;
        let paths = (|| {
            let paths = StoragePaths::resolve(&default_root, &read_settings(&config)?)?;
            paths.prepare()?;
            migration::activate(
                &config,
                &default_root.join("project-library/v1/library.sqlite3"),
                &paths.database,
            )?;
            Ok(paths)
        })();
        Ok(Self {
            config,
            default_root,
            paths,
            legacy_audio: None,
            _instance: instance,
        })
    }

    pub fn paths(&self) -> Result<&StoragePaths, String> {
        self.paths.as_ref().map_err(Clone::clone)
    }

    pub fn validate_settings(&self, content: &str) -> Result<(), String> {
        let paths = StoragePaths::resolve(&self.default_root, &settings_from_content(content)?)?;
        // A folder chooser is not proof that the target is writable. Never overwrite a library.
        if self
            .paths
            .as_ref()
            .is_ok_and(|active| active.database != paths.database)
            && paths.database.exists()
        {
            return Err("目标目录已有项目库，请选择新文件夹；不会覆盖或自动合并已有项目。".into());
        }
        paths.prepare()
    }

    fn status(&self) -> StorageStatus {
        let requested =
            read_settings(&self.config).and_then(|s| StoragePaths::resolve(&self.default_root, &s));
        StorageStatus {
            retained_legacy_directories: [
                Some(self.default_root.join("alignment-v2-coarse-cache-v2")),
                Some(self.default_root.join("alignment-v2-fine-pcm-cache-v1")),
                Some(self.default_root.join("alignment-v2-visual-cache-v1")),
                self.legacy_audio.clone(),
            ]
            .into_iter()
            .flatten()
            .filter(|p| p.is_dir())
            .collect(),
            fixed_local_data: self.default_root.clone(),
            fixed_outbox: self.default_root.join("private-library/outbox"),
            restart_required: match (&self.paths, &requested) {
                (Ok(a), Ok(b)) => a != b,
                _ => true,
            },
            active: self.paths.as_ref().ok().cloned(),
            requested: requested.as_ref().ok().cloned(),
            error: self
                .paths
                .as_ref()
                .err()
                .cloned()
                .or_else(|| requested.err()),
        }
    }
}

pub(crate) fn paths(app: &AppHandle) -> Result<StoragePaths, String> {
    app.state::<StorageRuntime>().paths().cloned()
}

/// Shared by Emby and future HTTP/WebDAV audio acquisition. Complete audio is project data.
pub(crate) fn audio_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(paths(app)?.emby_audio)
}

fn audio_cache_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}
pub(crate) async fn audio_cache_use() -> tokio::sync::RwLockReadGuard<'static, ()> {
    audio_cache_gate().read().await
}
pub(crate) fn audio_cache_cleanup() -> Result<tokio::sync::RwLockWriteGuard<'static, ()>, String> {
    audio_cache_gate()
        .try_write()
        .map_err(|_| "仍有音轨正在读取或下载，请完成或取消后重试。".into())
}

#[tauri::command]
pub fn get_storage_status(app: AppHandle) -> StorageStatus {
    app.state::<StorageRuntime>().status()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEnvironment {
    os: &'static str,
    architecture: &'static str,
    logical_cpus: Option<usize>,
}

#[tauri::command]
pub fn get_host_environment() -> HostEnvironment {
    HostEnvironment {
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        logical_cpus: std::thread::available_parallelism().ok().map(usize::from),
    }
}
