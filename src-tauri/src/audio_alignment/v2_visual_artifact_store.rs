use super::{
    benchmark_telemetry::{self, BenchmarkCacheEvent, BenchmarkCacheKind},
    replace_persistent_v2_coarse_cache_file, VisualFeatureFrame,
};
use crate::media_probe::{MediaContentIdentity, VideoStreamProbe};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    mem::size_of,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) const ALIGNMENT_V2_VISUAL_FEATURE_VERSION: &str = "visual-dct-gradient-pts-v1";
pub(super) const ALIGNMENT_V2_VISUAL_MAX_SAMPLE_INTERVAL_MS: u64 = 10_000;
pub(super) const ALIGNMENT_V2_VISUAL_MAX_DURATION_MS: u64 = 6 * 60 * 60 * 1_000;
pub(super) const ALIGNMENT_V2_VISUAL_MAX_FRAMES: usize = 10_000;
pub(super) const ALIGNMENT_V2_VISUAL_FEATURE_VALUE_COUNT: usize = 147;

const MAX_MEMORY_ENTRIES: usize = 12;
const MAX_MEMORY_BYTES: usize = 192 * 1024 * 1024;
const PERSISTENT_SCHEMA_VERSION: u8 = 1;
const PERSISTENT_MAX_FILE_BYTES: u64 = 96 * 1024 * 1024;
const PERSISTENT_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const PERSISTENT_MAX_ENTRIES: usize = 64;
const PERSISTENT_DIRECTORY: &str = "alignment-v2-visual-cache-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct V2VisualArtifactKey(String);

impl V2VisualArtifactKey {
    pub(super) fn legacy(
        identity: &MediaContentIdentity,
        interval_ms: u64,
        toolchain_identity: &str,
    ) -> Self {
        Self(format!(
            "contentIdentity={}:{}:{}:{}:{}:{}|visualInterval={interval_ms}|{toolchain_identity}",
            identity.algorithm,
            identity.size_bytes,
            identity.modified_unix_ms,
            identity.first_sample_digest,
            identity.middle_sample_digest,
            identity.last_sample_digest,
        ))
    }

    pub(super) fn pts_v2(
        identity: &MediaContentIdentity,
        presentation_origin_ms: i64,
        stream: &VideoStreamProbe,
        interval_ms: u64,
        toolchain_identity: &str,
    ) -> Self {
        Self(format!(
            "feature={ALIGNMENT_V2_VISUAL_FEATURE_VERSION}|identity={}:{}:{}:{}:{}:{}|presentationOrigin={presentation_origin_ms}|stream={}:{}:{}:{:?}|interval={interval_ms}|{toolchain_identity}",
            identity.algorithm,
            identity.size_bytes,
            identity.modified_unix_ms,
            identity.first_sample_digest,
            identity.middle_sample_digest,
            identity.last_sample_digest,
            stream.stream_index,
            stream.start_time_ms,
            stream.timeline_offset_ms,
            stream.time_base,
        ))
    }

    #[cfg(test)]
    pub(super) fn contains(&self, needle: &str) -> bool {
        self.0.contains(needle)
    }
}

#[derive(Debug, Clone)]
pub(super) struct V2VisualArtifactHandle {
    frames: Arc<[VisualFeatureFrame]>,
    cache_hit: bool,
}

impl V2VisualArtifactHandle {
    pub(super) fn frames(&self) -> &[VisualFeatureFrame] {
        &self.frames
    }

    pub(super) fn cache_hit(&self) -> bool {
        self.cache_hit
    }

    #[cfg(test)]
    pub(super) fn for_test(frames: Vec<VisualFeatureFrame>, cache_hit: bool) -> Self {
        Self {
            frames: Arc::from(frames),
            cache_hit,
        }
    }
}

struct MemoryEntry {
    frames: Arc<[VisualFeatureFrame]>,
    resident_bytes: usize,
    last_access: u64,
}

#[derive(Default)]
struct MemoryState {
    entries: HashMap<String, MemoryEntry>,
    resident_bytes: usize,
    access_clock: u64,
    generation: u64,
}

enum PersistentRoot {
    Environment,
    #[cfg(test)]
    Explicit(Option<PathBuf>),
}

#[derive(Debug, Clone)]
pub(super) struct V2VisualArtifactStoreStatus {
    pub(super) memory_entries: usize,
    pub(super) persistent_entries: usize,
    pub(super) persistent_bytes: u64,
    pub(super) max_persistent_entries: usize,
    pub(super) max_persistent_bytes: u64,
    pub(super) directory: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct V2VisualArtifactClearReceipt {
    pub(super) removed_files: usize,
    pub(super) removed_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default)]
struct PersistentStats {
    entries: usize,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentVisualPayloadRef<'a> {
    cache_key_digest: &'a str,
    feature_version: &'static str,
    frames: &'a [VisualFeatureFrame],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentVisualEnvelopeRef<'a> {
    schema_version: u8,
    payload_digest: String,
    last_access_ms: u64,
    payload: PersistentVisualPayloadRef<'a>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentVisualPayload {
    cache_key_digest: String,
    feature_version: String,
    frames: Vec<VisualFeatureFrame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentVisualEnvelope {
    schema_version: u8,
    payload_digest: String,
    last_access_ms: u64,
    payload: PersistentVisualPayload,
}

pub(super) struct V2VisualArtifactStore {
    memory: Mutex<MemoryState>,
    persistent_root: PersistentRoot,
    max_memory_entries: usize,
    max_memory_bytes: usize,
}

static V2_VISUAL_ARTIFACT_STORE: OnceLock<V2VisualArtifactStore> = OnceLock::new();

pub(super) fn v2_visual_artifact_store() -> &'static V2VisualArtifactStore {
    V2_VISUAL_ARTIFACT_STORE.get_or_init(V2VisualArtifactStore::process_local)
}

impl V2VisualArtifactStore {
    fn process_local() -> Self {
        Self {
            memory: Mutex::new(MemoryState::default()),
            persistent_root: PersistentRoot::Environment,
            max_memory_entries: MAX_MEMORY_ENTRIES,
            max_memory_bytes: MAX_MEMORY_BYTES,
        }
    }

    #[cfg(test)]
    fn isolated(
        persistent_root: Option<PathBuf>,
        max_memory_entries: usize,
        max_memory_bytes: usize,
    ) -> Self {
        Self {
            memory: Mutex::new(MemoryState::default()),
            persistent_root: PersistentRoot::Explicit(persistent_root),
            max_memory_entries,
            max_memory_bytes,
        }
    }

    pub(super) fn publish(
        &self,
        key: V2VisualArtifactKey,
        frames: Vec<VisualFeatureFrame>,
    ) -> Result<V2VisualArtifactHandle, String> {
        let frames = Arc::<[VisualFeatureFrame]>::from(frames);
        let resident_bytes = resident_bytes(&key.0, &frames);
        validate_frames(&frames)?;
        let evicted = {
            let mut memory = self
                .memory
                .lock()
                .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
            self.insert_memory(&mut memory, key.0.clone(), frames.clone(), resident_bytes)
        };
        if evicted {
            benchmark_telemetry::cache_event(
                BenchmarkCacheKind::VisualFeatures,
                BenchmarkCacheEvent::Eviction,
            );
        }
        // Persistence is an optimization, never a reason to discard otherwise valid local
        // evidence. Status reports what actually reached disk.
        let _ = self.write_persistent(&key, &frames);
        benchmark_telemetry::cache_event(
            BenchmarkCacheKind::VisualFeatures,
            BenchmarkCacheEvent::Write,
        );
        Ok(V2VisualArtifactHandle {
            frames,
            cache_hit: false,
        })
    }

    pub(super) fn lookup(
        &self,
        key: &V2VisualArtifactKey,
    ) -> Result<Option<V2VisualArtifactHandle>, String> {
        {
            let mut memory = self
                .memory
                .lock()
                .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
            memory.access_clock = memory.access_clock.saturating_add(1);
            let access = memory.access_clock;
            if let Some(entry) = memory.entries.get_mut(&key.0) {
                entry.last_access = access;
                benchmark_telemetry::cache_event(
                    BenchmarkCacheKind::VisualFeatures,
                    BenchmarkCacheEvent::Hit,
                );
                return Ok(Some(V2VisualArtifactHandle {
                    frames: entry.frames.clone(),
                    cache_hit: true,
                }));
            }
        }

        let Some(frames) = self.load_persistent(key) else {
            benchmark_telemetry::cache_event(
                BenchmarkCacheKind::VisualFeatures,
                BenchmarkCacheEvent::Miss,
            );
            return Ok(None);
        };
        let resident_bytes = resident_bytes(&key.0, &frames);
        let evicted = {
            let mut memory = self
                .memory
                .lock()
                .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
            self.insert_memory(&mut memory, key.0.clone(), frames.clone(), resident_bytes)
        };
        if evicted {
            benchmark_telemetry::cache_event(
                BenchmarkCacheKind::VisualFeatures,
                BenchmarkCacheEvent::Eviction,
            );
        }
        benchmark_telemetry::cache_event(
            BenchmarkCacheKind::VisualFeatures,
            BenchmarkCacheEvent::Hit,
        );
        Ok(Some(V2VisualArtifactHandle {
            frames,
            cache_hit: true,
        }))
    }

    pub(super) fn clear_memory(&self) -> Result<(), String> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
        memory.entries.clear();
        memory.resident_bytes = 0;
        memory.generation = memory.generation.saturating_add(1);
        Ok(())
    }

    pub(super) fn memory_entry_count(&self) -> Result<usize, String> {
        self.memory
            .lock()
            .map(|memory| memory.entries.len())
            .map_err(|_| "视觉特征缓存锁已损坏。".to_string())
    }

    #[cfg(test)]
    fn generation(&self) -> Result<u64, String> {
        self.memory
            .lock()
            .map(|memory| memory.generation)
            .map_err(|_| "视觉特征缓存锁已损坏。".to_string())
    }

    pub(super) fn status(&self) -> Result<V2VisualArtifactStoreStatus, String> {
        let memory_entries = self.memory_entry_count()?;
        let root = self.root();
        let persistent = root.as_deref().map(persistent_stats).unwrap_or_default();
        Ok(V2VisualArtifactStoreStatus {
            memory_entries,
            persistent_entries: persistent.entries,
            persistent_bytes: persistent.bytes,
            max_persistent_entries: PERSISTENT_MAX_ENTRIES,
            max_persistent_bytes: PERSISTENT_MAX_TOTAL_BYTES,
            directory: root.map(|path| path.to_string_lossy().into_owned()),
        })
    }

    pub(super) fn clear_all(&self) -> Result<V2VisualArtifactClearReceipt, String> {
        self.clear_memory()?;
        let Some(root) = self.root() else {
            return Ok(V2VisualArtifactClearReceipt::default());
        };
        Ok(clear_persistent(&root))
    }

    fn insert_memory(
        &self,
        memory: &mut MemoryState,
        key: String,
        frames: Arc<[VisualFeatureFrame]>,
        resident_bytes: usize,
    ) -> bool {
        if self.max_memory_entries == 0 || resident_bytes > self.max_memory_bytes {
            return false;
        }
        if let Some(replaced) = memory.entries.remove(&key) {
            memory.resident_bytes = memory
                .resident_bytes
                .saturating_sub(replaced.resident_bytes);
        }
        let mut evicted_any = false;
        while !memory.entries.is_empty()
            && (memory.entries.len() >= self.max_memory_entries
                || memory.resident_bytes.saturating_add(resident_bytes) > self.max_memory_bytes)
        {
            let Some(lru_key) = memory
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(evicted) = memory.entries.remove(&lru_key) {
                memory.resident_bytes =
                    memory.resident_bytes.saturating_sub(evicted.resident_bytes);
                evicted_any = true;
            }
        }
        memory.access_clock = memory.access_clock.saturating_add(1);
        let last_access = memory.access_clock;
        memory.resident_bytes = memory.resident_bytes.saturating_add(resident_bytes);
        memory.entries.insert(
            key,
            MemoryEntry {
                frames,
                resident_bytes,
                last_access,
            },
        );
        evicted_any
    }

    fn root(&self) -> Option<PathBuf> {
        match &self.persistent_root {
            #[cfg(test)]
            PersistentRoot::Explicit(root) => root.clone(),
            PersistentRoot::Environment => persistent_root_from_environment(),
        }
    }

    fn write_persistent(
        &self,
        key: &V2VisualArtifactKey,
        frames: &[VisualFeatureFrame],
    ) -> Result<(), String> {
        let Some(root) = self.root() else {
            return Err("当前环境没有可用的本地应用数据目录。".to_string());
        };
        write_persistent_at(&root, key, frames)
    }

    fn load_persistent(&self, key: &V2VisualArtifactKey) -> Option<Arc<[VisualFeatureFrame]>> {
        let root = self.root()?;
        load_persistent_at(&root, key)
    }
}

fn persistent_root_from_environment() -> Option<PathBuf> {
    crate::storage::feature_root("C137_V2_VISUAL_CACHE_DIR", PERSISTENT_DIRECTORY)
}

fn validate_frames(frames: &[VisualFeatureFrame]) -> Result<(), String> {
    if frames.is_empty() || frames.len() > ALIGNMENT_V2_VISUAL_MAX_FRAMES {
        return Err("磁盘视觉摘要帧数超出硬边界。".to_string());
    }
    if frames
        .windows(2)
        .any(|pair| pair[0].time_ms >= pair[1].time_ms)
    {
        return Err("磁盘视觉摘要时间戳不是严格递增。".to_string());
    }
    let covered_ms = frames
        .last()
        .expect("non-empty visual artifact")
        .time_ms
        .saturating_sub(frames[0].time_ms);
    if covered_ms
        > ALIGNMENT_V2_VISUAL_MAX_DURATION_MS
            .saturating_add(ALIGNMENT_V2_VISUAL_MAX_SAMPLE_INTERVAL_MS)
    {
        return Err("磁盘视觉摘要覆盖时长超出硬边界。".to_string());
    }
    if frames.iter().any(|frame| {
        frame.values.len() != ALIGNMENT_V2_VISUAL_FEATURE_VALUE_COUNT
            || frame
                .values
                .iter()
                .any(|value| !value.is_finite() || value.abs() > 32.0)
    }) {
        return Err("磁盘视觉摘要包含无效特征向量。".to_string());
    }
    Ok(())
}

fn cache_key_digest(key: &V2VisualArtifactKey) -> String {
    Sha256::digest(key.0.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn payload_digest(cache_key_digest: &str, frames: &[VisualFeatureFrame]) -> Result<String, String> {
    let frame_count =
        u64::try_from(frames.len()).map_err(|_| "磁盘视觉摘要帧数无法表示。".to_string())?;
    let mut digest = Sha256::new();
    digest.update(cache_key_digest.as_bytes());
    digest.update([0]);
    digest.update(ALIGNMENT_V2_VISUAL_FEATURE_VERSION.as_bytes());
    digest.update([0]);
    digest.update(frame_count.to_le_bytes());
    for frame in frames {
        digest.update(frame.time_ms.to_le_bytes());
        let value_count = u64::try_from(frame.values.len())
            .map_err(|_| "磁盘视觉摘要特征维度无法表示。".to_string())?;
        digest.update(value_count.to_le_bytes());
        for value in &frame.values {
            let canonical = (value * 1_000_000_000.0).round() as i64;
            digest.update(canonical.to_le_bytes());
        }
    }
    Ok(format!(
        "sha256:{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn persistent_path(root: &Path, cache_key_digest: &str) -> PathBuf {
    root.join(format!("{cache_key_digest}.json"))
}

fn write_persistent_at(
    root: &Path,
    key: &V2VisualArtifactKey,
    frames: &[VisualFeatureFrame],
) -> Result<(), String> {
    validate_frames(frames)?;
    fs::create_dir_all(root).map_err(|_| "无法创建磁盘视觉摘要目录。".to_string())?;
    let key_digest = cache_key_digest(key);
    let envelope = PersistentVisualEnvelopeRef {
        schema_version: PERSISTENT_SCHEMA_VERSION,
        payload_digest: payload_digest(&key_digest, frames)?,
        last_access_ms: current_time_ms(),
        payload: PersistentVisualPayloadRef {
            cache_key_digest: &key_digest,
            feature_version: ALIGNMENT_V2_VISUAL_FEATURE_VERSION,
            frames,
        },
    };
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|_| "磁盘视觉摘要 envelope 无法序列化。".to_string())?;
    if bytes.len() as u64 > PERSISTENT_MAX_FILE_BYTES {
        return Err("磁盘视觉摘要文件超过单文件硬上限。".to_string());
    }
    let destination = persistent_path(root, &key_digest);
    let temporary = root.join(format!(
        ".{key_digest}.{}.{}.tmp",
        std::process::id(),
        current_time_ms()
    ));
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建磁盘视觉摘要临时文件。".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "无法完整写入磁盘视觉摘要临时文件。".to_string())?;
        file.sync_all()
            .map_err(|_| "无法同步磁盘视觉摘要临时文件。".to_string())?;
        replace_persistent_v2_coarse_cache_file(&temporary, &destination)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    prune_persistent(root);
    Ok(())
}

fn load_persistent_at(root: &Path, key: &V2VisualArtifactKey) -> Option<Arc<[VisualFeatureFrame]>> {
    let expected_key_digest = cache_key_digest(key);
    let path = persistent_path(root, &expected_key_digest);
    let load_result = (|| -> Result<PersistentVisualEnvelope, String> {
        let metadata = fs::metadata(&path).map_err(|_| "磁盘视觉摘要不存在。".to_string())?;
        if metadata.len() == 0 || metadata.len() > PERSISTENT_MAX_FILE_BYTES {
            return Err("磁盘视觉摘要文件大小无效。".to_string());
        }
        let bytes = fs::read(&path).map_err(|_| "磁盘视觉摘要无法读取。".to_string())?;
        let envelope = serde_json::from_slice::<PersistentVisualEnvelope>(&bytes)
            .map_err(|_| "磁盘视觉摘要 JSON 无效。".to_string())?;
        if envelope.schema_version != PERSISTENT_SCHEMA_VERSION {
            return Err("磁盘视觉摘要 schema 版本不受支持。".to_string());
        }
        if envelope.payload.cache_key_digest != expected_key_digest {
            return Err("磁盘视觉摘要 cache key 摘要不匹配。".to_string());
        }
        if envelope.payload.feature_version != ALIGNMENT_V2_VISUAL_FEATURE_VERSION {
            return Err("磁盘视觉摘要算法版本不匹配。".to_string());
        }
        validate_frames(&envelope.payload.frames)?;
        if envelope.payload_digest
            != payload_digest(&expected_key_digest, &envelope.payload.frames)?
        {
            return Err("磁盘视觉摘要 payload 摘要校验失败。".to_string());
        }
        let _ = envelope.last_access_ms;
        Ok(envelope)
    })();
    match load_result {
        Ok(envelope) => {
            let frames = envelope.payload.frames;
            let _ = write_persistent_at(root, key, &frames);
            Some(Arc::from(frames))
        }
        Err(_) => {
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
            None
        }
    }
}

fn prune_persistent(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut artifacts = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !is_digest_json(&path) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                path,
                metadata.len(),
                metadata.modified().unwrap_or(UNIX_EPOCH),
            ))
        })
        .collect::<Vec<_>>();
    artifacts.sort_by_key(|(_, _, modified)| *modified);
    let mut total_bytes = artifacts
        .iter()
        .fold(0_u64, |total, (_, bytes, _)| total.saturating_add(*bytes));
    let mut remaining_entries = artifacts.len();
    for (path, bytes, _) in artifacts {
        if remaining_entries <= PERSISTENT_MAX_ENTRIES && total_bytes <= PERSISTENT_MAX_TOTAL_BYTES
        {
            break;
        }
        if fs::remove_file(path).is_ok() {
            remaining_entries = remaining_entries.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(bytes);
        }
    }
}

fn persistent_stats(root: &Path) -> PersistentStats {
    let Ok(entries) = fs::read_dir(root) else {
        return PersistentStats::default();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| is_digest_json(&entry.path()))
        .fold(PersistentStats::default(), |mut total, entry| {
            if let Ok(metadata) = entry.metadata() {
                total.entries = total.entries.saturating_add(1);
                total.bytes = total.bytes.saturating_add(metadata.len());
            }
            total
        })
}

fn clear_persistent(root: &Path) -> V2VisualArtifactClearReceipt {
    let Ok(entries) = fs::read_dir(root) else {
        return V2VisualArtifactClearReceipt::default();
    };
    let mut receipt = V2VisualArtifactClearReceipt::default();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !is_digest_json(&path) {
            continue;
        }
        let bytes = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        if fs::remove_file(path).is_ok() {
            receipt.removed_files = receipt.removed_files.saturating_add(1);
            receipt.removed_bytes = receipt.removed_bytes.saturating_add(bytes);
        }
    }
    receipt
}

fn is_digest_json(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("json")
        && path
            .file_stem()
            .and_then(|value| value.to_str())
            .is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
}

fn resident_bytes(cache_key: &str, frames: &[VisualFeatureFrame]) -> usize {
    cache_key
        .len()
        .saturating_add(frames.len().saturating_mul(size_of::<VisualFeatureFrame>()))
        .saturating_add(frames.iter().fold(0usize, |total, frame| {
            total.saturating_add(frame.values.len().saturating_mul(size_of::<f64>()))
        }))
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{V2VisualArtifactKey, V2VisualArtifactStore};
    use crate::audio_alignment::{
        benchmark_telemetry::{
            self, AlignmentBenchmarkCacheCounts, AlignmentBenchmarkRunTelemetry,
        },
        VisualFeatureFrame,
    };
    use std::{fs, sync::Arc, time::Instant};

    fn frame(time_ms: u64) -> VisualFeatureFrame {
        VisualFeatureFrame {
            time_ms,
            values: vec![0.0; 147],
        }
    }

    #[test]
    fn publish_and_memory_hit_share_one_immutable_frame_allocation() {
        let store = V2VisualArtifactStore::isolated(None, 2, usize::MAX);
        let key = V2VisualArtifactKey("visual-test-key".to_string());

        let published = store
            .publish(key.clone(), vec![frame(0), frame(1_000)])
            .unwrap();
        let cached = store.lookup(&key).unwrap().expect("memory hit");

        assert!(!published.cache_hit());
        assert!(cached.cache_hit());
        assert!(Arc::ptr_eq(&published.frames, &cached.frames));
    }

    #[test]
    fn lru_and_byte_budget_evict_oldest_while_clear_advances_generation() {
        let one_artifact_bytes = super::resident_bytes("a", &[frame(0)]);
        let store = V2VisualArtifactStore::isolated(None, 3, one_artifact_bytes * 2);
        let a = V2VisualArtifactKey("a".to_string());
        let b = V2VisualArtifactKey("b".to_string());
        let c = V2VisualArtifactKey("c".to_string());

        let first_generation = store.generation().unwrap();
        store.publish(a.clone(), vec![frame(0)]).unwrap();
        store.publish(b.clone(), vec![frame(0)]).unwrap();
        assert!(
            store.lookup(&a).unwrap().is_some(),
            "touch a so b becomes LRU"
        );
        store.publish(c.clone(), vec![frame(0)]).unwrap();

        assert!(store.lookup(&a).unwrap().is_some());
        assert!(store.lookup(&b).unwrap().is_none());
        assert!(store.lookup(&c).unwrap().is_some());

        store.clear_memory().unwrap();
        assert!(store.lookup(&a).unwrap().is_none());
        store.publish(a, vec![frame(0)]).unwrap();
        assert_eq!(store.generation().unwrap(), first_generation + 1);
    }

    #[test]
    fn persistent_round_trip_is_path_free_atomic_and_rejects_tampering() {
        let root = std::env::temp_dir().join(format!(
            "v2-visual-artifact-store-{}-{}",
            std::process::id(),
            super::current_time_ms()
        ));
        let store = V2VisualArtifactStore::isolated(Some(root.clone()), 2, usize::MAX);
        let key = V2VisualArtifactKey(
            r"visual-v1|content=sha256:secret-content|logicalPath=C:\private\episode.mkv"
                .to_string(),
        );

        store
            .publish(key.clone(), vec![frame(1_000), frame(6_000)])
            .unwrap();
        store.clear_memory().unwrap();

        let files = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(
            files.len(),
            1,
            "atomic publish must leave no temporary file"
        );
        let stored = fs::read_to_string(&files[0]).unwrap();
        assert!(!stored.contains(r"C:\private"));
        assert!(!stored.contains("secret-content"));
        let loaded = store.lookup(&key).unwrap().expect("persistent hit");
        assert_eq!(loaded.frames().len(), 2);
        assert_eq!(loaded.frames()[0].time_ms, 1_000);

        store.clear_memory().unwrap();
        let mut tampered = serde_json::from_str::<serde_json::Value>(&stored).unwrap();
        tampered["payload"]["frames"][0]["values"][0] = serde_json::json!(0.25);
        fs::write(&files[0], serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(store.lookup(&key).unwrap().is_none());
        assert!(
            !files[0].exists(),
            "tampered artifact must be quarantined by deletion"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn telemetry_keeps_one_event_per_lookup_publish_and_eviction() {
        let store = V2VisualArtifactStore::isolated(None, 1, usize::MAX);
        let a = V2VisualArtifactKey("a".to_string());
        let b = V2VisualArtifactKey("b".to_string());
        let telemetry = Arc::new(AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            20,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        ));
        telemetry.mark_started().unwrap();

        benchmark_telemetry::with_active(telemetry.clone(), || {
            assert!(store.lookup(&a).unwrap().is_none());
            store.publish(a.clone(), vec![frame(0)]).unwrap();
            assert!(store.lookup(&a).unwrap().is_some());
            store.publish(b, vec![frame(0)]).unwrap();
        });

        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.cache.visual_features.misses, 1);
        assert_eq!(snapshot.cache.visual_features.hits, 1);
        assert_eq!(snapshot.cache.visual_features.writes, 2);
        assert_eq!(snapshot.cache.visual_features.evictions, 1);
    }

    #[test]
    fn status_and_clear_hide_storage_and_preserve_unrelated_files() {
        let root = std::env::temp_dir().join(format!(
            "v2-visual-artifact-clear-{}-{}",
            std::process::id(),
            super::current_time_ms()
        ));
        let store = V2VisualArtifactStore::isolated(Some(root.clone()), 2, usize::MAX);
        let key = V2VisualArtifactKey("clear-key".to_string());
        store.publish(key, vec![frame(0)]).unwrap();
        fs::write(root.join("unrelated.txt"), b"keep").unwrap();

        let before = store.status().unwrap();
        assert_eq!(before.memory_entries, 1);
        assert_eq!(before.persistent_entries, 1);
        assert!(before.persistent_bytes > 0);
        assert_eq!(before.max_persistent_entries, 64);
        assert_eq!(before.max_persistent_bytes, 512 * 1024 * 1024);
        assert_eq!(
            before.directory.as_deref(),
            Some(root.to_string_lossy().as_ref())
        );

        let receipt = store.clear_all().unwrap();
        assert_eq!(receipt.removed_files, 1);
        assert!(receipt.removed_bytes > 0);
        assert!(root.join("unrelated.txt").is_file());
        let after = store.status().unwrap();
        assert_eq!(after.memory_entries, 0);
        assert_eq!(after.persistent_entries, 0);

        fs::remove_dir_all(root).unwrap();
    }
}
