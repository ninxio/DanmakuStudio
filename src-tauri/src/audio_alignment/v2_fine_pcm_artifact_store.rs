use super::{
    benchmark_telemetry::{self, BenchmarkCacheEvent, BenchmarkCacheKind},
    v2_audio_artifact_store::{
        cache_key_digest, replace_persistent_v2_coarse_cache_file as replace_file_atomically,
    },
    ALIGNMENT_V2_FINE_WINDOW_DECODE_TOLERANCE_MS, ALIGNMENT_V2_SAMPLE_RATE,
};
use crate::alignment_v2::PresentationRangeMs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const ARTIFACT_VERSION: &str = "pcm-s16le-mono-16k-window-v2";
const PERSISTENT_SCHEMA_VERSION: u8 = 1;
const PERSISTENT_MAX_METADATA_BYTES: u64 = 64 * 1024;
const PERSISTENT_MAX_PCM_BYTES: u64 = 768 * 1024 * 1024;
const PERSISTENT_MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const PERSISTENT_MAX_ENTRIES: usize = 64;
const PERSISTENT_DIRECTORY: &str = "alignment-v2-fine-pcm-cache-v1";

#[derive(Debug, Clone, Copy)]
pub(super) struct V2FinePcmTimelineIdentity {
    pub(super) presentation_origin_ms: i64,
    pub(super) first_decoded_pts_ms: Option<i64>,
    pub(super) pts_discontinuity_count: u64,
    pub(super) max_pts_gap_ms: Option<u64>,
    pub(super) skip_samples: u64,
    pub(super) discard_padding: u64,
    pub(super) normalized_pcm_origin_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct V2FinePcmArtifactKey(String);

impl V2FinePcmArtifactKey {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn current(
        pcm_decode_identity: &str,
        window: PresentationRangeMs,
        media_bounds: PresentationRangeMs,
        stream_identity: &str,
        timeline: V2FinePcmTimelineIdentity,
        content_identity: &str,
        toolchain_identity: &str,
    ) -> Self {
        Self(format!(
            "artifact={ARTIFACT_VERSION}|sampleRate={ALIGNMENT_V2_SAMPLE_RATE}|pcmDecode={pcm_decode_identity}|window={}:{}|mediaBounds={}:{}|presentationOrigin={}|stream={stream_identity}|firstDecodedPts={:?}|ptsDiscontinuities={}|maxPtsGap={:?}|skipSamples={}|discardPadding={}|normalizedPcmOrigin={}|{content_identity}|{toolchain_identity}",
            window.start_ms,
            window.end_ms,
            media_bounds.start_ms,
            media_bounds.end_ms,
            timeline.presentation_origin_ms,
            timeline.first_decoded_pts_ms,
            timeline.pts_discontinuity_count,
            timeline.max_pts_gap_ms,
            timeline.skip_samples,
            timeline.discard_padding,
            timeline.normalized_pcm_origin_ms,
        ))
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(test)]
    fn test(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

#[derive(Debug, Clone)]
pub(super) struct V2FinePcmArtifactHandle {
    pcm: Arc<Vec<i16>>,
}

impl V2FinePcmArtifactHandle {
    fn from_owned(pcm: Vec<i16>) -> Self {
        Self { pcm: Arc::new(pcm) }
    }

    pub(super) fn samples(&self) -> &[i16] {
        self.pcm.as_slice()
    }

    pub(super) fn into_shared_pcm(self) -> Arc<Vec<i16>> {
        self.pcm
    }
}

pub(super) struct V2FinePcmArtifactHitCandidate {
    artifact: V2FinePcmArtifactHandle,
}

impl V2FinePcmArtifactHitCandidate {
    pub(super) fn confirm(self) -> V2FinePcmArtifactHandle {
        benchmark_telemetry::cache_event(
            BenchmarkCacheKind::AudioFeatures,
            BenchmarkCacheEvent::Hit,
        );
        self.artifact
    }
}

pub(super) enum V2FinePcmArtifactLookup {
    Hit(V2FinePcmArtifactHitCandidate),
    Miss,
}

#[derive(Debug)]
pub(super) struct V2FinePcmArtifactPublishReceipt {
    pub(super) artifact: V2FinePcmArtifactHandle,
    pub(super) persistence_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct V2FinePcmArtifactStoreStatus {
    pub(super) persistent_entries: usize,
    pub(super) persistent_bytes: u64,
    pub(super) max_persistent_entries: usize,
    pub(super) max_persistent_bytes: u64,
    pub(super) directory: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct V2FinePcmArtifactClearReceipt {
    pub(super) removed_files: usize,
    pub(super) removed_bytes: u64,
}

#[derive(Default)]
struct StoreState {
    generation: u64,
    #[cfg(test)]
    fail_after_pcm_replace: bool,
}

enum PersistentRoot {
    Environment,
    #[cfg(test)]
    Explicit(Option<PathBuf>),
}

pub(super) struct V2FinePcmArtifactStore {
    state: Mutex<StoreState>,
    persistent_root: PersistentRoot,
    max_persistent_entries: usize,
    max_persistent_bytes: u64,
}

static V2_FINE_PCM_ARTIFACT_STORE: OnceLock<V2FinePcmArtifactStore> = OnceLock::new();

pub(super) fn v2_fine_pcm_artifact_store() -> &'static V2FinePcmArtifactStore {
    V2_FINE_PCM_ARTIFACT_STORE.get_or_init(V2FinePcmArtifactStore::process_local)
}

impl V2FinePcmArtifactStore {
    fn process_local() -> Self {
        Self {
            state: Mutex::new(StoreState::default()),
            persistent_root: PersistentRoot::Environment,
            max_persistent_entries: PERSISTENT_MAX_ENTRIES,
            max_persistent_bytes: PERSISTENT_MAX_TOTAL_BYTES,
        }
    }

    #[cfg(test)]
    fn isolated(root: Option<PathBuf>, max_entries: usize, max_bytes: u64) -> Self {
        Self {
            state: Mutex::new(StoreState::default()),
            persistent_root: PersistentRoot::Explicit(root),
            max_persistent_entries: max_entries,
            max_persistent_bytes: max_bytes,
        }
    }

    pub(super) fn lookup(
        &self,
        key: &V2FinePcmArtifactKey,
        window: PresentationRangeMs,
    ) -> V2FinePcmArtifactLookup {
        let artifact = self.state.lock().ok().and_then(|_state| {
            let root = self.root()?;
            let _ = cleanup_residuals(&root);
            load_persistent_at(&root, key, window)
        });
        match artifact {
            Some(artifact) => {
                V2FinePcmArtifactLookup::Hit(V2FinePcmArtifactHitCandidate { artifact })
            }
            None => {
                benchmark_telemetry::cache_event(
                    BenchmarkCacheKind::AudioFeatures,
                    BenchmarkCacheEvent::Miss,
                );
                V2FinePcmArtifactLookup::Miss
            }
        }
    }

    pub(super) fn publish(
        &self,
        key: V2FinePcmArtifactKey,
        window: PresentationRangeMs,
        pcm: Vec<i16>,
    ) -> V2FinePcmArtifactPublishReceipt {
        let artifact = V2FinePcmArtifactHandle::from_owned(pcm);
        let persistence = match self.state.lock() {
            Ok(mut state) => {
                #[cfg(not(test))]
                let _ = &mut state;
                match self.root() {
                    Some(root) => {
                        #[cfg(test)]
                        let fail_after_pcm_replace = {
                            let fail = state.fail_after_pcm_replace;
                            state.fail_after_pcm_replace = false;
                            fail
                        };
                        #[cfg(not(test))]
                        let fail_after_pcm_replace = false;
                        write_persistent_at(
                            &root,
                            &key,
                            window,
                            artifact.samples(),
                            self.max_persistent_entries,
                            self.max_persistent_bytes,
                            fail_after_pcm_replace,
                        )
                    }
                    None => Err("当前环境没有可用的本地应用数据目录。".to_string()),
                }
            }
            Err(_) => Err("磁盘 fine PCM 制品状态锁已损坏。".to_string()),
        };
        let persistence_error = match persistence {
            Ok(eviction_count) => {
                benchmark_telemetry::cache_event(
                    BenchmarkCacheKind::AudioFeatures,
                    BenchmarkCacheEvent::Write,
                );
                record_evictions(eviction_count);
                None
            }
            Err(error) => Some(error),
        };
        V2FinePcmArtifactPublishReceipt {
            artifact,
            persistence_error,
        }
    }

    pub(super) fn status(&self) -> Result<V2FinePcmArtifactStoreStatus, String> {
        let _state = self
            .state
            .lock()
            .map_err(|_| "磁盘 fine PCM 制品状态锁已损坏。".to_string())?;
        let root = self.root();
        let persistent = root
            .as_deref()
            .map(|root| {
                let _ = cleanup_residuals(root);
                persistent_stats(root)
            })
            .unwrap_or_default();
        Ok(V2FinePcmArtifactStoreStatus {
            persistent_entries: persistent.entries,
            persistent_bytes: persistent.bytes,
            max_persistent_entries: self.max_persistent_entries,
            max_persistent_bytes: self.max_persistent_bytes,
            directory: root.map(|path| path.to_string_lossy().into_owned()),
        })
    }

    pub(super) fn clear_all(&self) -> Result<V2FinePcmArtifactClearReceipt, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "磁盘 fine PCM 制品状态锁已损坏。".to_string())?;
        state.generation = state.generation.saturating_add(1);
        let Some(root) = self.root() else {
            return Ok(V2FinePcmArtifactClearReceipt::default());
        };
        Ok(clear_persistent(&root))
    }

    fn root(&self) -> Option<PathBuf> {
        match &self.persistent_root {
            #[cfg(test)]
            PersistentRoot::Explicit(root) => root.clone(),
            PersistentRoot::Environment => persistent_root_from_environment(),
        }
    }

    #[cfg(test)]
    fn generation(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.generation)
            .unwrap_or_default()
    }

    #[cfg(test)]
    fn fail_next_publish_after_pcm_replace(&self) {
        self.state.lock().unwrap().fail_after_pcm_replace = true;
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentPayload {
    cache_key_digest: String,
    artifact_version: String,
    presentation_start_ms: i64,
    presentation_end_ms: i64,
    sample_rate: u32,
    sample_count: u64,
    pcm_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentEnvelope {
    schema_version: u8,
    payload_digest: String,
    last_access_ms: u64,
    payload: PersistentPayload,
}

#[derive(Debug, Clone, Copy, Default)]
struct PersistentStats {
    entries: usize,
    bytes: u64,
}

fn persistent_root_from_environment() -> Option<PathBuf> {
    crate::storage::feature_root("C137_V2_FINE_PCM_CACHE_DIR", PERSISTENT_DIRECTORY)
}

fn artifact_paths(root: &Path, cache_key_digest: &str) -> (PathBuf, PathBuf) {
    (
        root.join(format!("{cache_key_digest}.json")),
        root.join(format!("{cache_key_digest}.pcm")),
    )
}

#[allow(clippy::too_many_arguments)]
fn write_persistent_at(
    root: &Path,
    key: &V2FinePcmArtifactKey,
    window: PresentationRangeMs,
    pcm: &[i16],
    max_entries: usize,
    max_bytes: u64,
    fail_after_pcm_replace: bool,
) -> Result<usize, String> {
    fs::create_dir_all(root).map_err(|_| "无法创建磁盘 fine PCM 目录。".to_string())?;
    let _ = cleanup_residuals(root);
    let key_digest = cache_key_digest(key.as_str());
    let payload = PersistentPayload {
        cache_key_digest: key_digest.clone(),
        artifact_version: ARTIFACT_VERSION.to_string(),
        presentation_start_ms: window.start_ms,
        presentation_end_ms: window.end_ms,
        sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
        sample_count: u64::try_from(pcm.len())
            .map_err(|_| "fine PCM 样本数无法表示。".to_string())?,
        pcm_digest: pcm_digest(pcm),
    };
    validate_payload(&key_digest, window, &payload)?;
    let envelope = PersistentEnvelope {
        schema_version: PERSISTENT_SCHEMA_VERSION,
        payload_digest: payload_digest(&payload)?,
        last_access_ms: current_time_ms(),
        payload,
    };
    let metadata_bytes = serde_json::to_vec(&envelope)
        .map_err(|_| "磁盘 fine PCM envelope 无法序列化。".to_string())?;
    if metadata_bytes.len() as u64 > PERSISTENT_MAX_METADATA_BYTES {
        return Err("磁盘 fine PCM 元数据超过硬上限。".to_string());
    }

    let (metadata_path, pcm_path) = artifact_paths(root, &key_digest);
    let nonce = current_time_ms();
    let temporary_pcm = root.join(format!(
        ".{key_digest}.{}.{nonce}.pcm.tmp",
        std::process::id()
    ));
    let temporary_metadata = root.join(format!(
        ".{key_digest}.{}.{nonce}.json.tmp",
        std::process::id()
    ));
    let write_result = (|| {
        let mut pcm_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_pcm)
            .map_err(|_| "无法创建磁盘 fine PCM 临时文件。".to_string())?;
        for chunk in pcm.chunks(32 * 1024) {
            let mut bytes = Vec::with_capacity(chunk.len() * 2);
            for sample in chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            pcm_file
                .write_all(&bytes)
                .map_err(|_| "无法完整写入磁盘 fine PCM 临时文件。".to_string())?;
        }
        pcm_file
            .sync_all()
            .map_err(|_| "无法同步磁盘 fine PCM 临时文件。".to_string())?;
        replace_file_atomically(&temporary_pcm, &pcm_path)?;
        if fail_after_pcm_replace {
            return Err("测试注入：fine PCM 元数据提交前失败。".to_string());
        }

        let mut metadata_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_metadata)
            .map_err(|_| "无法创建磁盘 fine PCM 元数据临时文件。".to_string())?;
        metadata_file
            .write_all(&metadata_bytes)
            .map_err(|_| "无法完整写入磁盘 fine PCM 元数据。".to_string())?;
        metadata_file
            .sync_all()
            .map_err(|_| "无法同步磁盘 fine PCM 元数据。".to_string())?;
        replace_file_atomically(&temporary_metadata, &metadata_path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_pcm);
        let _ = fs::remove_file(&temporary_metadata);
        let _ = fs::remove_file(&metadata_path);
        let _ = fs::remove_file(&pcm_path);
    }
    write_result?;
    Ok(prune_persistent(root, max_entries, max_bytes))
}

fn load_persistent_at(
    root: &Path,
    key: &V2FinePcmArtifactKey,
    window: PresentationRangeMs,
) -> Option<V2FinePcmArtifactHandle> {
    let key_digest = cache_key_digest(key.as_str());
    let (metadata_path, pcm_path) = artifact_paths(root, &key_digest);
    let load_result = (|| -> Result<(Vec<i16>, PersistentEnvelope), String> {
        let metadata =
            fs::metadata(&metadata_path).map_err(|_| "磁盘 fine PCM 元数据不存在。".to_string())?;
        if metadata.len() == 0 || metadata.len() > PERSISTENT_MAX_METADATA_BYTES {
            return Err("磁盘 fine PCM 元数据大小无效。".to_string());
        }
        let bytes =
            fs::read(&metadata_path).map_err(|_| "磁盘 fine PCM 元数据无法读取。".to_string())?;
        let mut envelope = serde_json::from_slice::<PersistentEnvelope>(&bytes)
            .map_err(|_| "磁盘 fine PCM 元数据 JSON 无效。".to_string())?;
        if envelope.schema_version != PERSISTENT_SCHEMA_VERSION {
            return Err("磁盘 fine PCM schema 版本不受支持。".to_string());
        }
        validate_payload(&key_digest, window, &envelope.payload)?;
        if envelope.payload_digest != payload_digest(&envelope.payload)? {
            return Err("磁盘 fine PCM payload 摘要校验失败。".to_string());
        }
        let pcm_metadata =
            fs::metadata(&pcm_path).map_err(|_| "磁盘 fine PCM 数据文件不存在。".to_string())?;
        let expected_bytes = envelope.payload.sample_count.saturating_mul(2);
        if pcm_metadata.len() != expected_bytes || pcm_metadata.len() > PERSISTENT_MAX_PCM_BYTES {
            return Err("磁盘 fine PCM 数据文件大小不匹配。".to_string());
        }
        let sample_count = usize::try_from(envelope.payload.sample_count)
            .map_err(|_| "磁盘 fine PCM 样本数无法装入内存。".to_string())?;
        let mut pcm = Vec::new();
        pcm.try_reserve_exact(sample_count)
            .map_err(|_| "blocked:resource-limit：无法为磁盘 fine PCM 保留内存。".to_string())?;
        let mut file =
            File::open(&pcm_path).map_err(|_| "磁盘 fine PCM 数据文件无法打开。".to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut pending_low_byte = None;
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|_| "磁盘 fine PCM 数据文件读取失败。".to_string())?;
            if read == 0 {
                break;
            }
            let bytes = &buffer[..read];
            digest.update(bytes);
            let mut index = 0;
            if let Some(low) = pending_low_byte.take() {
                pcm.push(i16::from_le_bytes([low, bytes[0]]));
                index = 1;
            }
            while index + 1 < bytes.len() {
                pcm.push(i16::from_le_bytes([bytes[index], bytes[index + 1]]));
                index += 2;
            }
            if index < bytes.len() {
                pending_low_byte = Some(bytes[index]);
            }
        }
        if pending_low_byte.is_some() || pcm.len() != sample_count {
            return Err("磁盘 fine PCM 数据文件包含不完整样本。".to_string());
        }
        let actual_digest = prefixed_sha256(digest.finalize());
        if actual_digest != envelope.payload.pcm_digest {
            return Err("磁盘 fine PCM 内容摘要校验失败。".to_string());
        }
        envelope.last_access_ms = current_time_ms();
        Ok((pcm, envelope))
    })();
    match load_result {
        Ok((pcm, envelope)) => {
            touch_metadata(root, &key_digest, &metadata_path, &envelope);
            Some(V2FinePcmArtifactHandle::from_owned(pcm))
        }
        Err(_) => {
            let _ = fs::remove_file(metadata_path);
            let _ = fs::remove_file(pcm_path);
            None
        }
    }
}

fn touch_metadata(
    root: &Path,
    key_digest: &str,
    metadata_path: &Path,
    envelope: &PersistentEnvelope,
) {
    let Ok(bytes) = serde_json::to_vec(envelope) else {
        return;
    };
    if bytes.len() as u64 > PERSISTENT_MAX_METADATA_BYTES {
        return;
    }
    let temporary = root.join(format!(
        ".{key_digest}.{}.{}.touch.tmp",
        std::process::id(),
        current_time_ms()
    ));
    let touched = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建磁盘 fine PCM touch 临时文件。".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "无法写入磁盘 fine PCM touch 临时文件。".to_string())?;
        file.sync_all()
            .map_err(|_| "无法同步磁盘 fine PCM touch 临时文件。".to_string())?;
        replace_file_atomically(&temporary, metadata_path)
    })();
    let _ = fs::remove_file(temporary);
    let _ = touched;
}

fn payload_digest(payload: &PersistentPayload) -> Result<String, String> {
    let bytes = serde_json::to_vec(payload)
        .map_err(|_| "磁盘 fine PCM payload 无法序列化。".to_string())?;
    Ok(prefixed_sha256(Sha256::digest(bytes)))
}

fn pcm_digest(pcm: &[i16]) -> String {
    let mut digest = Sha256::new();
    for chunk in pcm.chunks(32 * 1024) {
        let mut bytes = Vec::with_capacity(chunk.len() * 2);
        for sample in chunk {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        digest.update(bytes);
    }
    prefixed_sha256(digest.finalize())
}

fn prefixed_sha256(bytes: impl AsRef<[u8]>) -> String {
    format!(
        "sha256:{}",
        bytes
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn validate_payload(
    expected_key_digest: &str,
    expected_window: PresentationRangeMs,
    payload: &PersistentPayload,
) -> Result<(), String> {
    if payload.cache_key_digest != expected_key_digest {
        return Err("磁盘 fine PCM cache key 摘要不匹配。".to_string());
    }
    if payload.artifact_version != ARTIFACT_VERSION
        || payload.sample_rate != ALIGNMENT_V2_SAMPLE_RATE
    {
        return Err("磁盘 fine PCM 提取器版本或采样率不匹配。".to_string());
    }
    if payload.presentation_start_ms != expected_window.start_ms
        || payload.presentation_end_ms != expected_window.end_ms
        || payload.presentation_end_ms <= payload.presentation_start_ms
    {
        return Err("磁盘 fine PCM 展示时间窗口不匹配。".to_string());
    }
    let expected_bytes = payload
        .sample_count
        .checked_mul(2)
        .ok_or_else(|| "磁盘 fine PCM 样本大小溢出。".to_string())?;
    if payload.sample_count == 0 || expected_bytes > PERSISTENT_MAX_PCM_BYTES {
        return Err("磁盘 fine PCM 样本数超出硬边界。".to_string());
    }
    let requested_duration_ms = range_duration_ms(expected_window)?;
    let maximum_samples =
        (u128::from(requested_duration_ms) * u128::from(ALIGNMENT_V2_SAMPLE_RATE)).div_ceil(1_000);
    if u128::from(payload.sample_count) > maximum_samples {
        return Err("磁盘 fine PCM 样本数超过请求窗口。".to_string());
    }
    let actual_duration_ms = payload
        .sample_count
        .saturating_mul(1_000)
        .checked_div(u64::from(ALIGNMENT_V2_SAMPLE_RATE))
        .unwrap_or(0);
    if actual_duration_ms.saturating_add(ALIGNMENT_V2_FINE_WINDOW_DECODE_TOLERANCE_MS)
        < requested_duration_ms
    {
        return Err("磁盘 fine PCM 未完整覆盖请求窗口。".to_string());
    }
    if !is_prefixed_sha256(&payload.pcm_digest) {
        return Err("磁盘 fine PCM 内容摘要格式无效。".to_string());
    }
    Ok(())
}

fn range_duration_ms(range: PresentationRangeMs) -> Result<u64, String> {
    let duration = range
        .end_ms
        .checked_sub(range.start_ms)
        .ok_or_else(|| "blocked:resource-limit：精解码窗口时长溢出。".to_string())?;
    u64::try_from(duration)
        .map_err(|_| "blocked:resource-limit：精解码窗口必须是正毫秒区间。".to_string())
        .and_then(|duration| {
            if duration == 0 {
                Err("blocked:resource-limit：精解码窗口不能为空。".to_string())
            } else {
                Ok(duration)
            }
        })
}

fn prune_persistent(root: &Path, max_entries: usize, max_bytes: u64) -> usize {
    let _ = cleanup_residuals(root);
    let mut artifacts = persistent_artifacts(root);
    artifacts.sort_by_key(|artifact| artifact.modified);
    let mut total_bytes = artifacts.iter().fold(0_u64, |total, artifact| {
        total.saturating_add(artifact.bytes)
    });
    let mut remaining_entries = artifacts.len();
    let mut evictions = 0usize;
    for artifact in artifacts {
        if remaining_entries <= max_entries && total_bytes <= max_bytes {
            break;
        }
        let metadata_removed = fs::remove_file(artifact.metadata_path).is_ok();
        let pcm_removed = fs::remove_file(artifact.pcm_path).is_ok();
        if metadata_removed || pcm_removed {
            remaining_entries = remaining_entries.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(artifact.bytes);
            evictions = evictions.saturating_add(1);
        }
    }
    evictions
}

struct PersistentArtifactFiles {
    metadata_path: PathBuf,
    pcm_path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

fn persistent_artifacts(root: &Path) -> Vec<PersistentArtifactFiles> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata_path = entry.path();
            let digest = digest_for_extension(&metadata_path, "json")?;
            let (_, pcm_path) = artifact_paths(root, &digest);
            let metadata = entry.metadata().ok()?;
            let pcm_metadata = fs::metadata(&pcm_path).ok()?;
            Some(PersistentArtifactFiles {
                metadata_path,
                pcm_path,
                bytes: metadata.len().saturating_add(pcm_metadata.len()),
                modified: metadata.modified().unwrap_or(UNIX_EPOCH),
            })
        })
        .collect()
}

fn persistent_stats(root: &Path) -> PersistentStats {
    persistent_artifacts(root).into_iter().fold(
        PersistentStats::default(),
        |mut total, artifact| {
            total.entries = total.entries.saturating_add(1);
            total.bytes = total.bytes.saturating_add(artifact.bytes);
            total
        },
    )
}

fn cleanup_residuals(root: &Path) -> V2FinePcmArtifactClearReceipt {
    let Ok(entries) = fs::read_dir(root) else {
        return V2FinePcmArtifactClearReceipt::default();
    };
    let mut receipt = V2FinePcmArtifactClearReceipt::default();
    let mut json_digests = HashSet::<String>::new();
    let mut pcm_digests = HashSet::<String>::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if is_recognized_temporary_file(&path) {
            remove_file_with_receipt(&path, &mut receipt);
            continue;
        }
        if let Some(digest) = digest_for_extension(&path, "json") {
            json_digests.insert(digest);
        } else if let Some(digest) = digest_for_extension(&path, "pcm") {
            pcm_digests.insert(digest);
        }
    }
    for digest in json_digests.union(&pcm_digests) {
        if json_digests.contains(digest) && pcm_digests.contains(digest) {
            continue;
        }
        let (metadata_path, pcm_path) = artifact_paths(root, digest);
        remove_file_with_receipt(&metadata_path, &mut receipt);
        remove_file_with_receipt(&pcm_path, &mut receipt);
    }
    receipt
}

fn clear_persistent(root: &Path) -> V2FinePcmArtifactClearReceipt {
    let mut receipt = cleanup_residuals(root);
    let Ok(entries) = fs::read_dir(root) else {
        return receipt;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if digest_for_extension(&path, "json").is_some()
            || digest_for_extension(&path, "pcm").is_some()
            || is_recognized_temporary_file(&path)
        {
            remove_file_with_receipt(&path, &mut receipt);
        }
    }
    receipt
}

fn remove_file_with_receipt(path: &Path, receipt: &mut V2FinePcmArtifactClearReceipt) {
    let bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if fs::remove_file(path).is_ok() {
        receipt.removed_files = receipt.removed_files.saturating_add(1);
        receipt.removed_bytes = receipt.removed_bytes.saturating_add(bytes);
    }
}

fn digest_for_extension(path: &Path, extension: &str) -> Option<String> {
    if path.extension().and_then(|value| value.to_str()) != Some(extension) {
        return None;
    }
    let digest = path.file_stem()?.to_str()?;
    is_digest(digest).then(|| digest.to_string())
}

fn is_recognized_temporary_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let Some(rest) = file_name.strip_prefix('.') else {
        return false;
    };
    let Some(digest) = rest.split('.').next() else {
        return false;
    };
    is_digest(digest)
        && (file_name.ends_with(".pcm.tmp")
            || file_name.ends_with(".json.tmp")
            || file_name.ends_with(".touch.tmp"))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_prefixed_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(is_digest)
}

fn record_evictions(count: usize) {
    for _ in 0..count {
        benchmark_telemetry::cache_event(
            BenchmarkCacheKind::AudioFeatures,
            BenchmarkCacheEvent::Eviction,
        );
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        artifact_paths, cache_key_digest, payload_digest, pcm_digest, v2_fine_pcm_artifact_store,
        PersistentPayload, V2FinePcmArtifactKey, V2FinePcmArtifactLookup, V2FinePcmArtifactStore,
        V2FinePcmTimelineIdentity, ARTIFACT_VERSION, PERSISTENT_SCHEMA_VERSION,
    };
    use crate::{
        alignment_v2::PresentationRangeMs,
        audio_alignment::benchmark_telemetry::{
            self, AlignmentBenchmarkCacheCounts, AlignmentBenchmarkRunTelemetry,
        },
    };
    use serde_json::json;
    use std::{
        fs,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::Instant,
    };

    static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_root(label: &str) -> std::path::PathBuf {
        let sequence = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "v2-fine-pcm-{label}-{}-{sequence}",
            std::process::id()
        ))
    }

    fn window(start_ms: i64) -> PresentationRangeMs {
        PresentationRangeMs {
            start_ms,
            end_ms: start_ms + 100,
        }
    }

    fn pcm(seed: i16) -> Vec<i16> {
        (0..1_600)
            .map(|index| seed.wrapping_add(index as i16))
            .collect()
    }

    fn isolated(root: std::path::PathBuf, max_entries: usize) -> V2FinePcmArtifactStore {
        V2FinePcmArtifactStore::isolated(Some(root), max_entries, u64::MAX)
    }

    #[test]
    fn failed_second_commit_never_exposes_or_leaves_half_published_pair() {
        let root = test_root("atomic");
        let store = isolated(root.clone(), 64);
        let pcm = pcm(7);
        let allocation = pcm.as_ptr();
        store.fail_next_publish_after_pcm_replace();

        let receipt = store.publish(
            V2FinePcmArtifactKey::test("atomic-key"),
            window(20_000),
            pcm,
        );

        assert_eq!(receipt.artifact.samples().as_ptr(), allocation);
        assert!(receipt.persistence_error.is_some());
        assert!(
            fs::read_dir(&root)
                .map(|entries| entries.count() == 0)
                .unwrap_or(true),
            "failed publication must remove final and temporary halves"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn round_trip_is_path_free_and_tamper_or_range_mismatch_quarantines_both_files() {
        let root = test_root("tamper");
        let store = isolated(root.clone(), 64);
        let key = V2FinePcmArtifactKey::test(
            r"fine-pcm-v1|content=sha256:secret-content|logicalPath=C:\private\episode.mkv",
        );
        let expected = pcm(11);
        let receipt = store.publish(key.clone(), window(20_000), expected.clone());
        assert!(receipt.persistence_error.is_none());
        let digest = cache_key_digest(key.as_str());
        let (metadata_path, pcm_path) = artifact_paths(&root, &digest);
        let stored_text = fs::read_to_string(&metadata_path).unwrap();
        assert!(!stored_text.contains(r"C:\private"));
        assert!(!stored_text.contains("secret-content"));

        let V2FinePcmArtifactLookup::Hit(hit) = store.lookup(&key, window(20_000)) else {
            panic!("valid pair must load");
        };
        assert_eq!(hit.confirm().samples(), expected.as_slice());

        let mut bytes = fs::read(&pcm_path).unwrap();
        bytes[100] ^= 0xff;
        fs::write(&pcm_path, bytes).unwrap();
        assert!(matches!(
            store.lookup(&key, window(20_000)),
            V2FinePcmArtifactLookup::Miss
        ));
        assert!(!metadata_path.exists());
        assert!(!pcm_path.exists());

        let receipt = store.publish(key.clone(), window(20_000), expected);
        assert!(receipt.persistence_error.is_none());
        let mut truncated = fs::read(&pcm_path).unwrap();
        truncated.pop();
        fs::write(&pcm_path, truncated).unwrap();
        assert!(matches!(
            store.lookup(&key, window(20_000)),
            V2FinePcmArtifactLookup::Miss
        ));
        assert!(!metadata_path.exists());
        assert!(!pcm_path.exists());

        let receipt = store.publish(key.clone(), window(20_000), pcm(11));
        assert!(receipt.persistence_error.is_none());
        assert!(matches!(
            store.lookup(&key, window(21_000)),
            V2FinePcmArtifactLookup::Miss
        ));
        assert!(!metadata_path.exists());
        assert!(!pcm_path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn status_cleans_only_recognized_half_commits_and_temporary_files() {
        let root = test_root("residuals");
        fs::create_dir_all(&root).unwrap();
        let orphan_json = "a".repeat(64);
        let orphan_pcm = "b".repeat(64);
        let temporary = "c".repeat(64);
        fs::write(root.join(format!("{orphan_json}.json")), b"metadata").unwrap();
        fs::write(root.join(format!("{orphan_pcm}.pcm")), b"pcm").unwrap();
        fs::write(root.join(format!(".{temporary}.1.2.pcm.tmp")), b"temporary").unwrap();
        fs::write(root.join("notes.json"), b"keep").unwrap();
        fs::write(root.join(format!(".{temporary}.tmp")), b"keep").unwrap();
        let store = isolated(root.clone(), 64);

        let status = store.status().unwrap();

        assert_eq!(status.persistent_entries, 0);
        assert!(!root.join(format!("{orphan_json}.json")).exists());
        assert!(!root.join(format!("{orphan_pcm}.pcm")).exists());
        assert!(!root.join(format!(".{temporary}.1.2.pcm.tmp")).exists());
        assert!(root.join("notes.json").exists());
        assert!(root.join(format!(".{temporary}.tmp")).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clear_advances_generation_and_preserves_unrelated_files() {
        let root = test_root("generation");
        let store = isolated(root.clone(), 64);
        let first_generation = store.generation();
        let receipt = store.publish(
            V2FinePcmArtifactKey::test("generation-key"),
            window(0),
            pcm(17),
        );
        assert!(receipt.persistence_error.is_none());
        fs::write(root.join("notes.json"), b"keep").unwrap();
        assert_eq!(store.status().unwrap().persistent_entries, 1);

        let removed = store.clear_all().unwrap();

        assert_eq!(removed.removed_files, 2);
        assert!(removed.removed_bytes > 0);
        assert_eq!(store.generation(), first_generation + 1);
        assert_eq!(store.status().unwrap().persistent_entries, 0);
        assert!(root.join("notes.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn telemetry_counts_one_logical_artifact_per_hit_miss_write_and_retention_eviction() {
        let root = test_root("telemetry");
        let store = isolated(root.clone(), 1);
        let a = V2FinePcmArtifactKey::test("a");
        let b = V2FinePcmArtifactKey::test("b");
        let missing = V2FinePcmArtifactKey::test("missing");
        let telemetry = Arc::new(AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            20,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        ));
        telemetry.mark_started().unwrap();

        benchmark_telemetry::with_active(telemetry.clone(), || {
            assert!(matches!(
                store.lookup(&missing, window(0)),
                V2FinePcmArtifactLookup::Miss
            ));
            assert!(store
                .publish(a.clone(), window(0), pcm(1))
                .persistence_error
                .is_none());
            let V2FinePcmArtifactLookup::Hit(hit) = store.lookup(&a, window(0)) else {
                panic!("a must be a hit");
            };
            let _ = hit.confirm();
            assert!(store
                .publish(b, window(100), pcm(2))
                .persistence_error
                .is_none());
        });

        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.cache.audio_features.misses, 1);
        assert_eq!(snapshot.cache.audio_features.hits, 1);
        assert_eq!(snapshot.cache.audio_features.writes, 2);
        assert_eq!(snapshot.cache.audio_features.evictions, 1);
        assert_eq!(store.status().unwrap().persistent_entries, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_schema_v1_json_and_pcm_bytes_remain_loadable() {
        let root = test_root("legacy-v1");
        fs::create_dir_all(&root).unwrap();
        let store = isolated(root.clone(), 64);
        let key = V2FinePcmArtifactKey::test("legacy-v1-key");
        let key_digest = cache_key_digest(key.as_str());
        let expected = pcm(23);
        let payload = PersistentPayload {
            cache_key_digest: key_digest.clone(),
            artifact_version: ARTIFACT_VERSION.to_string(),
            presentation_start_ms: 10_000,
            presentation_end_ms: 10_100,
            sample_rate: 16_000,
            sample_count: 1_600,
            pcm_digest: pcm_digest(&expected),
        };
        let old_envelope = json!({
            "schemaVersion": PERSISTENT_SCHEMA_VERSION,
            "payloadDigest": payload_digest(&payload).unwrap(),
            "lastAccessMs": 123_u64,
            "payload": {
                "cacheKeyDigest": payload.cache_key_digest,
                "artifactVersion": payload.artifact_version,
                "presentationStartMs": payload.presentation_start_ms,
                "presentationEndMs": payload.presentation_end_ms,
                "sampleRate": payload.sample_rate,
                "sampleCount": payload.sample_count,
                "pcmDigest": payload.pcm_digest,
            }
        });
        let (metadata_path, pcm_path) = artifact_paths(&root, &key_digest);
        fs::write(&metadata_path, serde_json::to_vec(&old_envelope).unwrap()).unwrap();
        let pcm_bytes = expected
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        fs::write(&pcm_path, pcm_bytes).unwrap();

        let V2FinePcmArtifactLookup::Hit(hit) = store.lookup(&key, window(10_000)) else {
            panic!("schema v1 pair must remain compatible");
        };
        assert_eq!(hit.confirm().samples(), expected.as_slice());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_key_bytes_keep_the_frozen_window_identity_contract() {
        let key = V2FinePcmArtifactKey::current(
            "decode-v1",
            PresentationRangeMs {
                start_ms: 20,
                end_ms: 40,
            },
            PresentationRangeMs {
                start_ms: 10,
                end_ms: 50,
            },
            r#"{"streamIndex":2}"#,
            V2FinePcmTimelineIdentity {
                presentation_origin_ms: 10,
                first_decoded_pts_ms: Some(11),
                pts_discontinuity_count: 2,
                max_pts_gap_ms: Some(12),
                skip_samples: 13,
                discard_padding: 14,
                normalized_pcm_origin_ms: 15,
            },
            "content=sha256:abc",
            "tool=sha256:def",
        );
        assert_eq!(
            key.as_str(),
            r#"artifact=pcm-s16le-mono-16k-window-v2|sampleRate=16000|pcmDecode=decode-v1|window=20:40|mediaBounds=10:50|presentationOrigin=10|stream={"streamIndex":2}|firstDecodedPts=Some(11)|ptsDiscontinuities=2|maxPtsGap=Some(12)|skipSamples=13|discardPadding=14|normalizedPcmOrigin=15|content=sha256:abc|tool=sha256:def"#
        );
    }

    #[test]
    fn process_store_interface_is_available_without_exposing_storage_state() {
        let status = v2_fine_pcm_artifact_store().status().unwrap();
        assert_eq!(status.max_persistent_entries, 64);
        assert_eq!(status.max_persistent_bytes, 1024 * 1024 * 1024);
    }
}
