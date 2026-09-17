use super::{
    benchmark_telemetry::{self, BenchmarkCacheEvent, BenchmarkCacheKind},
    ALIGNMENT_V2_COARSE_MAX_LANDMARKS, ALIGNMENT_V2_SPECTRAL_BIN_COUNT, AUDIO_ALIGNMENT_CANCELLED,
};
use crate::alignment_v2::{
    CoarseSpectralFingerprintFrame, FineFeatureFrame, PresentationRangeMs,
    SpectralBackendExecution, SpectralLandmark,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    mem::size_of,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const COARSE_ARTIFACT_VERSION: &str =
    "spectral-landmark-coarse-fingerprint-energy-s16le-16k-hop50-v3";
const LEGACY_POLICY_CACHE_ENGINE_VERSION: &str = "alignment-v2.3-rust";
const LEGACY_POLICY_CACHE_FEATURE_VERSION: &str =
    "pcm-s16le-16k-pts-streaming-cuda-affine-window-version-reuse-frontier-v23";
const MAX_MEMORY_BYTES: usize = 768 * 1024 * 1024;
const PERSISTENT_SCHEMA_VERSION: u8 = 2;
const PERSISTENT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const PERSISTENT_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const PERSISTENT_MAX_ENTRIES: usize = 128;
const PERSISTENT_DIRECTORY: &str = "alignment-v2-coarse-cache-v2";
const PERSISTENT_MAX_COARSE_FRAMES: usize = 200_000;
const PERSISTENT_MAX_BACKEND_FIELD_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy)]
pub(super) struct V2AudioArtifactTimelineIdentity {
    pub(super) presentation_origin_ms: i64,
    pub(super) stream_pts_offset_ms: i64,
    pub(super) first_decoded_pts_ms: Option<i64>,
    pub(super) pts_discontinuity_count: u64,
    pub(super) max_pts_gap_ms: Option<u64>,
    pub(super) skip_samples: u64,
    pub(super) discard_padding: u64,
    pub(super) normalized_pcm_origin_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct V2AudioArtifactKey(String);

impl V2AudioArtifactKey {
    pub(super) fn current(
        extraction_identity: &str,
        pcm_decode_identity: &str,
        timeline: V2AudioArtifactTimelineIdentity,
        artifact_kind: &str,
        spectral_backend_id: &str,
    ) -> Self {
        Self(format!(
            "coarseArtifactVersion={COARSE_ARTIFACT_VERSION}|artifact={artifact_kind}|spectralBackend={spectral_backend_id}|pcmDecode={pcm_decode_identity}|ptsOrigin={}|streamPtsOffset={}|firstDecodedPts={:?}|ptsDiscontinuities={}|maxPtsGap={:?}|skipSamples={}|discardPadding={}|normalizedPcmOrigin={}|{extraction_identity}",
            timeline.presentation_origin_ms,
            timeline.stream_pts_offset_ms,
            timeline.first_decoded_pts_ms,
            timeline.pts_discontinuity_count,
            timeline.max_pts_gap_ms,
            timeline.skip_samples,
            timeline.discard_padding,
            timeline.normalized_pcm_origin_ms,
        ))
    }

    pub(super) fn legacy_policy_bound(
        extraction_identity: &str,
        timeline: V2AudioArtifactTimelineIdentity,
        artifact_kind: &str,
        spectral_backend_id: &str,
        requested_backend: &str,
    ) -> Self {
        Self(format!(
            "engine={LEGACY_POLICY_CACHE_ENGINE_VERSION}|feature={LEGACY_POLICY_CACHE_FEATURE_VERSION}|artifact={artifact_kind}|requestedSpectralBackend={requested_backend}|spectralBackend={spectral_backend_id}|ptsOrigin={}|streamPtsOffset={}|firstDecodedPts={:?}|ptsDiscontinuities={}|maxPtsGap={:?}|skipSamples={}|discardPadding={}|normalizedPcmOrigin={}|{extraction_identity}",
            timeline.presentation_origin_ms,
            timeline.stream_pts_offset_ms,
            timeline.first_decoded_pts_ms,
            timeline.pts_discontinuity_count,
            timeline.max_pts_gap_ms,
            timeline.skip_samples,
            timeline.discard_padding,
            timeline.normalized_pcm_origin_ms,
        ))
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(test)]
    pub(super) fn contains(&self, needle: &str) -> bool {
        self.0.contains(needle)
    }

    #[cfg(test)]
    pub(super) fn test(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

#[derive(Debug, Clone)]
pub(super) struct V2AudioArtifactHandle {
    pub(super) pcm: Option<Arc<Vec<i16>>>,
    pub(super) landmarks: Arc<Vec<SpectralLandmark>>,
    pub(super) coarse_fingerprint: Arc<Vec<CoarseSpectralFingerprintFrame>>,
    pub(super) fine_features: Option<Arc<Vec<FineFeatureFrame>>>,
    pub(super) spectral_backend: SpectralBackendExecution,
    pub(super) presentation_bounds: PresentationRangeMs,
}

impl V2AudioArtifactHandle {
    pub(super) fn payload_bytes(&self) -> usize {
        let pcm_bytes = self
            .pcm
            .as_ref()
            .map(|pcm| pcm.capacity().saturating_mul(size_of::<i16>()))
            .unwrap_or(0);
        let landmark_bytes = self
            .landmarks
            .capacity()
            .saturating_mul(size_of::<SpectralLandmark>());
        let coarse_fingerprint_bytes = self
            .coarse_fingerprint
            .capacity()
            .saturating_mul(size_of::<CoarseSpectralFingerprintFrame>());
        let fine_bytes = self
            .fine_features
            .as_ref()
            .map(|frames| {
                frames
                    .capacity()
                    .saturating_mul(size_of::<FineFeatureFrame>())
                    .saturating_add(frames.iter().fold(0_usize, |total, frame| {
                        total.saturating_add(
                            frame.values.capacity().saturating_mul(size_of::<f32>()),
                        )
                    }))
            })
            .unwrap_or(0);
        pcm_bytes
            .saturating_add(landmark_bytes)
            .saturating_add(coarse_fingerprint_bytes)
            .saturating_add(fine_bytes)
            .saturating_add(self.spectral_backend.backend_id.len())
            .saturating_add(self.spectral_backend.requested_backend.len())
            .saturating_add(self.spectral_backend.backend_detail.len())
            .saturating_add(
                self.spectral_backend
                    .fallback_reason
                    .as_ref()
                    .map(String::len)
                    .unwrap_or(0),
            )
    }
}

pub(super) struct V2AudioArtifactHitCandidate {
    artifact: V2AudioArtifactHandle,
}

impl V2AudioArtifactHitCandidate {
    pub(super) fn artifact(&self) -> &V2AudioArtifactHandle {
        &self.artifact
    }

    pub(super) fn confirm(self) -> V2AudioArtifactHandle {
        benchmark_telemetry::cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Hit);
        self.artifact
    }
}

pub(super) enum V2AudioArtifactLookup {
    Hit(V2AudioArtifactHitCandidate),
    Miss,
}

#[derive(Debug)]
pub(super) enum V2AudioArtifactPlan {
    Hit {
        key: V2AudioArtifactKey,
        artifact: V2AudioArtifactHandle,
    },
    Miss {
        key: V2AudioArtifactKey,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum V2AudioArtifactPlanMismatch {
    Hit,
    Miss,
}

impl V2AudioArtifactPlan {
    pub(super) fn resolve(
        self,
        expected_key: &V2AudioArtifactKey,
    ) -> Result<V2AudioArtifactLookup, V2AudioArtifactPlanMismatch> {
        match self {
            Self::Hit { key, artifact } => {
                if key != *expected_key {
                    return Err(V2AudioArtifactPlanMismatch::Hit);
                }
                Ok(V2AudioArtifactLookup::Hit(V2AudioArtifactHitCandidate {
                    artifact,
                }))
            }
            Self::Miss { key } => {
                if key != *expected_key {
                    return Err(V2AudioArtifactPlanMismatch::Miss);
                }
                benchmark_telemetry::cache_event(
                    BenchmarkCacheKind::V2Landmarks,
                    BenchmarkCacheEvent::Miss,
                );
                Ok(V2AudioArtifactLookup::Miss)
            }
        }
    }
}

#[derive(Debug, Clone)]
struct MemoryEntry {
    artifact: V2AudioArtifactHandle,
    resident_bytes: usize,
    last_access: u64,
}

#[derive(Debug, Default)]
struct MemoryState {
    entries: HashMap<String, MemoryEntry>,
    resident_bytes: usize,
    access_clock: u64,
    generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MemoryInsertReceipt {
    stored: bool,
    new_entry: bool,
    eviction_count: usize,
}

enum PersistentRoot {
    Environment,
    #[cfg(test)]
    Explicit(Option<PathBuf>),
}

#[derive(Debug, Clone)]
pub(super) struct V2AudioArtifactStoreStatus {
    pub(super) memory_entries: usize,
    pub(super) persistent_entries: usize,
    pub(super) persistent_bytes: u64,
    pub(super) max_persistent_entries: usize,
    pub(super) max_persistent_bytes: u64,
    pub(super) directory: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct V2AudioArtifactClearReceipt {
    pub(super) removed_files: usize,
    pub(super) removed_bytes: u64,
}

#[derive(Debug, Clone)]
pub(super) struct V2AudioArtifactPublishReceipt {
    pub(super) persistent_stored: bool,
    pub(super) persistence_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct PersistentStats {
    entries: usize,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentBackendRef<'a> {
    backend_id: &'a str,
    requested_backend: &'a str,
    backend_detail: &'a str,
    fallback_reason: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentPayloadRef<'a> {
    cache_key_digest: &'a str,
    presentation_start_ms: i64,
    presentation_end_ms: i64,
    spectral_backend: PersistentBackendRef<'a>,
    landmarks: &'a [SpectralLandmark],
    coarse_fingerprint: &'a [CoarseSpectralFingerprintFrame],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentEnvelopeRef<'a> {
    schema_version: u8,
    payload_digest: String,
    last_access_ms: u64,
    payload: PersistentPayloadRef<'a>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentBackend {
    backend_id: String,
    requested_backend: String,
    backend_detail: String,
    fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentPayload {
    cache_key_digest: String,
    presentation_start_ms: i64,
    presentation_end_ms: i64,
    spectral_backend: PersistentBackend,
    landmarks: Vec<SpectralLandmark>,
    coarse_fingerprint: Vec<CoarseSpectralFingerprintFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentEnvelope {
    schema_version: u8,
    payload_digest: String,
    last_access_ms: u64,
    payload: PersistentPayload,
}

pub(super) struct V2AudioArtifactStore {
    memory: Mutex<MemoryState>,
    persistent_root: PersistentRoot,
    max_memory_bytes: usize,
}

static V2_AUDIO_ARTIFACT_STORE: OnceLock<V2AudioArtifactStore> = OnceLock::new();

pub(super) fn v2_audio_artifact_store() -> &'static V2AudioArtifactStore {
    V2_AUDIO_ARTIFACT_STORE.get_or_init(V2AudioArtifactStore::process_local)
}

impl V2AudioArtifactStore {
    fn process_local() -> Self {
        Self {
            memory: Mutex::new(MemoryState::default()),
            persistent_root: PersistentRoot::Environment,
            max_memory_bytes: MAX_MEMORY_BYTES,
        }
    }

    #[cfg(test)]
    pub(super) fn isolated(persistent_root: Option<PathBuf>, max_memory_bytes: usize) -> Self {
        Self {
            memory: Mutex::new(MemoryState::default()),
            persistent_root: PersistentRoot::Explicit(persistent_root),
            max_memory_bytes,
        }
    }

    pub(super) fn plan_memory(
        &self,
        keys: &[V2AudioArtifactKey],
    ) -> Result<Vec<V2AudioArtifactPlan>, String> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
        Ok(keys
            .iter()
            .map(|key| match memory_lookup(&mut memory, key) {
                Some(artifact) => V2AudioArtifactPlan::Hit {
                    key: key.clone(),
                    artifact,
                },
                None => V2AudioArtifactPlan::Miss { key: key.clone() },
            })
            .collect())
    }

    pub(super) fn begin_memory_lookup(
        &self,
        key: &V2AudioArtifactKey,
    ) -> Result<V2AudioArtifactLookup, String> {
        let artifact = {
            let mut memory = self
                .memory
                .lock()
                .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
            memory_lookup(&mut memory, key)
        };
        match artifact {
            Some(artifact) => Ok(V2AudioArtifactLookup::Hit(V2AudioArtifactHitCandidate {
                artifact,
            })),
            None => {
                benchmark_telemetry::cache_event(
                    BenchmarkCacheKind::V2Landmarks,
                    BenchmarkCacheEvent::Miss,
                );
                Ok(V2AudioArtifactLookup::Miss)
            }
        }
    }

    pub(super) fn load_persistent(
        &self,
        key: &V2AudioArtifactKey,
    ) -> Option<V2AudioArtifactHandle> {
        let root = self.root()?;
        load_persistent_at(&root, key)
    }

    pub(super) fn admit_persistent_hit(
        &self,
        key: V2AudioArtifactKey,
        artifact: V2AudioArtifactHandle,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let insertion = self.insert_memory(key, artifact, cancel_flag)?;
        record_evictions(insertion.eviction_count);
        benchmark_telemetry::cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Hit);
        Ok(())
    }

    pub(super) fn admit_migrated_hit(
        &self,
        key: V2AudioArtifactKey,
        artifact: V2AudioArtifactHandle,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let _ = self.write_persistent(&key, &artifact);
        self.admit_persistent_hit(key, artifact, cancel_flag)
    }

    pub(super) fn publish_extracted(
        &self,
        key: V2AudioArtifactKey,
        artifact: V2AudioArtifactHandle,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<V2AudioArtifactPublishReceipt, String> {
        let (persistent_stored, persistence_error) = match self.write_persistent(&key, &artifact) {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error)),
        };
        let insertion = self.insert_memory(key, artifact, cancel_flag)?;
        record_evictions(insertion.eviction_count);
        if insertion.stored && insertion.new_entry {
            benchmark_telemetry::cache_event(
                BenchmarkCacheKind::V2Landmarks,
                BenchmarkCacheEvent::Write,
            );
        }
        Ok(V2AudioArtifactPublishReceipt {
            persistent_stored,
            persistence_error,
        })
    }

    pub(super) fn enrich_memory(
        &self,
        key: V2AudioArtifactKey,
        artifact: V2AudioArtifactHandle,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let insertion = self.insert_memory(key, artifact, cancel_flag)?;
        record_evictions(insertion.eviction_count);
        if insertion.stored && insertion.new_entry {
            benchmark_telemetry::cache_event(
                BenchmarkCacheKind::V2Landmarks,
                BenchmarkCacheEvent::Write,
            );
        }
        Ok(())
    }

    pub(super) fn clear_memory(&self) -> Result<(), String> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
        memory.entries.clear();
        memory.resident_bytes = 0;
        memory.access_clock = 0;
        memory.generation = memory.generation.saturating_add(1);
        Ok(())
    }

    pub(super) fn memory_entry_count(&self) -> Result<usize, String> {
        self.memory
            .lock()
            .map(|memory| memory.entries.len())
            .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())
    }

    #[cfg(test)]
    fn generation(&self) -> Result<u64, String> {
        self.memory
            .lock()
            .map(|memory| memory.generation)
            .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())
    }

    pub(super) fn status(&self) -> Result<V2AudioArtifactStoreStatus, String> {
        let root = self.root();
        let persistent = root.as_deref().map(persistent_stats).unwrap_or_default();
        Ok(V2AudioArtifactStoreStatus {
            memory_entries: self.memory_entry_count()?,
            persistent_entries: persistent.entries,
            persistent_bytes: persistent.bytes,
            max_persistent_entries: PERSISTENT_MAX_ENTRIES,
            max_persistent_bytes: PERSISTENT_MAX_TOTAL_BYTES,
            directory: root.map(|path| path.to_string_lossy().into_owned()),
        })
    }

    pub(super) fn clear_all(&self) -> Result<V2AudioArtifactClearReceipt, String> {
        self.clear_memory()?;
        let Some(root) = self.root() else {
            return Ok(V2AudioArtifactClearReceipt::default());
        };
        Ok(clear_persistent(&root))
    }

    fn insert_memory(
        &self,
        key: V2AudioArtifactKey,
        artifact: V2AudioArtifactHandle,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<MemoryInsertReceipt, String> {
        check_cancelled(cancel_flag)?;
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
        check_cancelled(cancel_flag)?;
        let previous = memory.entries.remove(key.as_str());
        let new_entry = previous.is_none();
        if let Some(previous) = previous {
            memory.resident_bytes = memory
                .resident_bytes
                .saturating_sub(previous.resident_bytes);
        }

        let resident_bytes = resident_bytes(&key, &artifact);
        if resident_bytes > self.max_memory_bytes {
            return Ok(MemoryInsertReceipt {
                stored: false,
                new_entry,
                eviction_count: 0,
            });
        }

        let mut eviction_count = 0;
        while memory.resident_bytes.saturating_add(resident_bytes) > self.max_memory_bytes {
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
                eviction_count += 1;
            }
        }

        memory.access_clock = memory.access_clock.saturating_add(1);
        let last_access = memory.access_clock;
        memory.resident_bytes = memory.resident_bytes.saturating_add(resident_bytes);
        memory.entries.insert(
            key.0,
            MemoryEntry {
                artifact,
                resident_bytes,
                last_access,
            },
        );
        Ok(MemoryInsertReceipt {
            stored: true,
            new_entry,
            eviction_count,
        })
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
        key: &V2AudioArtifactKey,
        artifact: &V2AudioArtifactHandle,
    ) -> Result<(), String> {
        let Some(root) = self.root() else {
            return Err("当前环境没有可用的本地应用数据目录。".to_string());
        };
        write_persistent_at(&root, key, artifact)
    }
}

fn memory_lookup(
    memory: &mut MemoryState,
    key: &V2AudioArtifactKey,
) -> Option<V2AudioArtifactHandle> {
    memory.access_clock = memory.access_clock.saturating_add(1);
    let access = memory.access_clock;
    let entry = memory.entries.get_mut(key.as_str())?;
    entry.last_access = access;
    Some(entry.artifact.clone())
}

fn record_evictions(count: usize) {
    for _ in 0..count {
        benchmark_telemetry::cache_event(
            BenchmarkCacheKind::V2Landmarks,
            BenchmarkCacheEvent::Eviction,
        );
    }
}

fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(AUDIO_ALIGNMENT_CANCELLED.to_string());
    }
    Ok(())
}

fn resident_bytes(key: &V2AudioArtifactKey, artifact: &V2AudioArtifactHandle) -> usize {
    artifact
        .payload_bytes()
        .saturating_add(key.as_str().len())
        .saturating_add(size_of::<MemoryEntry>())
}

fn persistent_root_from_environment() -> Option<PathBuf> {
    crate::storage::feature_root("C137_V2_COARSE_CACHE_DIR", PERSISTENT_DIRECTORY)
}

pub(super) fn cache_key_digest(cache_key: &str) -> String {
    Sha256::digest(cache_key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn persistent_path(root: &Path, cache_key_digest: &str) -> PathBuf {
    root.join(format!("{cache_key_digest}.json"))
}

fn payload_ref<'a>(
    cache_key_digest: &'a str,
    artifact: &'a V2AudioArtifactHandle,
) -> PersistentPayloadRef<'a> {
    PersistentPayloadRef {
        cache_key_digest,
        presentation_start_ms: artifact.presentation_bounds.start_ms,
        presentation_end_ms: artifact.presentation_bounds.end_ms,
        spectral_backend: PersistentBackendRef {
            backend_id: &artifact.spectral_backend.backend_id,
            requested_backend: &artifact.spectral_backend.requested_backend,
            backend_detail: &artifact.spectral_backend.backend_detail,
            fallback_reason: artifact.spectral_backend.fallback_reason.as_deref(),
        },
        landmarks: &artifact.landmarks,
        coarse_fingerprint: &artifact.coarse_fingerprint,
    }
}

fn payload_digest<T: Serialize>(payload: &T) -> Result<String, String> {
    let bytes =
        serde_json::to_vec(payload).map_err(|_| "磁盘粗索引 payload 无法序列化。".to_string())?;
    Ok(format!(
        "sha256:{}",
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn validate_persistent_payload(
    expected_cache_key_digest: &str,
    payload: &PersistentPayload,
) -> Result<(), String> {
    validate_persistent_fields(
        expected_cache_key_digest,
        &payload.cache_key_digest,
        payload.presentation_start_ms,
        payload.presentation_end_ms,
        &payload.spectral_backend.backend_id,
        &payload.spectral_backend.requested_backend,
        &payload.spectral_backend.backend_detail,
        payload.spectral_backend.fallback_reason.as_deref(),
        &payload.landmarks,
        &payload.coarse_fingerprint,
    )
}

fn validate_artifact(
    expected_cache_key_digest: &str,
    artifact: &V2AudioArtifactHandle,
) -> Result<(), String> {
    validate_persistent_fields(
        expected_cache_key_digest,
        expected_cache_key_digest,
        artifact.presentation_bounds.start_ms,
        artifact.presentation_bounds.end_ms,
        &artifact.spectral_backend.backend_id,
        &artifact.spectral_backend.requested_backend,
        &artifact.spectral_backend.backend_detail,
        artifact.spectral_backend.fallback_reason.as_deref(),
        &artifact.landmarks,
        &artifact.coarse_fingerprint,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_persistent_fields(
    expected_cache_key_digest: &str,
    actual_cache_key_digest: &str,
    presentation_start_ms: i64,
    presentation_end_ms: i64,
    backend_id: &str,
    requested_backend: &str,
    backend_detail: &str,
    fallback_reason: Option<&str>,
    landmarks: &[SpectralLandmark],
    coarse_fingerprint: &[CoarseSpectralFingerprintFrame],
) -> Result<(), String> {
    if actual_cache_key_digest != expected_cache_key_digest {
        return Err("磁盘粗索引 cache key 摘要不匹配。".to_string());
    }
    if presentation_end_ms <= presentation_start_ms {
        return Err("磁盘粗索引展示时间范围无效。".to_string());
    }
    if landmarks.is_empty() || landmarks.len() > ALIGNMENT_V2_COARSE_MAX_LANDMARKS {
        return Err("磁盘粗索引 landmark 数量超出硬边界。".to_string());
    }
    if coarse_fingerprint.is_empty()
        || coarse_fingerprint.len() > PERSISTENT_MAX_COARSE_FRAMES
        || coarse_fingerprint.windows(2).any(|pair| {
            pair[0].time_ms >= pair[1].time_ms
                || pair[0].active_ratio_milli > 1_000
                || pair[1].active_ratio_milli > 1_000
                || pair[0].log_rms_milli > 12_000
                || pair[1].log_rms_milli > 12_000
        })
        || coarse_fingerprint.iter().any(|frame| {
            frame.time_ms < presentation_start_ms
                || frame.time_ms > presentation_end_ms
                || frame.active_ratio_milli > 1_000
                || frame.log_rms_milli > 12_000
        })
    {
        return Err("磁盘粗索引 coarse fingerprint 无效。".to_string());
    }
    for landmark in landmarks {
        let anchor_bin = landmark.hash >> 16;
        let target_bin = (landmark.hash >> 8) & 0xff;
        if anchor_bin >= ALIGNMENT_V2_SPECTRAL_BIN_COUNT as u64
            || target_bin >= ALIGNMENT_V2_SPECTRAL_BIN_COUNT as u64
            || landmark.time_ms < presentation_start_ms
            || landmark.time_ms > presentation_end_ms
        {
            return Err("磁盘粗索引包含越界 landmark。".to_string());
        }
    }
    if landmarks.windows(2).any(|pair| {
        let left = &pair[0];
        let right = &pair[1];
        left.time_ms > right.time_ms
            || (left.time_ms == right.time_ms && left.hash > right.hash)
            || (left.time_ms == right.time_ms
                && left.hash == right.hash
                && left.strength_milli < right.strength_milli)
    }) {
        return Err("磁盘粗索引 landmark 未按规范顺序保存。".to_string());
    }
    for value in [backend_id, requested_backend, backend_detail] {
        if value.is_empty() || value.len() > PERSISTENT_MAX_BACKEND_FIELD_BYTES {
            return Err("磁盘粗索引声谱后端字段无效。".to_string());
        }
    }
    if fallback_reason.is_some_and(|value| value.len() > PERSISTENT_MAX_BACKEND_FIELD_BYTES) {
        return Err("磁盘粗索引声谱回退字段过长。".to_string());
    }
    Ok(())
}

fn artifact_from_persistent_payload(payload: PersistentPayload) -> V2AudioArtifactHandle {
    V2AudioArtifactHandle {
        pcm: None,
        landmarks: Arc::new(payload.landmarks),
        coarse_fingerprint: Arc::new(payload.coarse_fingerprint),
        fine_features: None,
        spectral_backend: SpectralBackendExecution {
            backend_id: payload.spectral_backend.backend_id,
            requested_backend: payload.spectral_backend.requested_backend,
            backend_detail: payload.spectral_backend.backend_detail,
            fallback_reason: payload.spectral_backend.fallback_reason,
        },
        presentation_bounds: PresentationRangeMs {
            start_ms: payload.presentation_start_ms,
            end_ms: payload.presentation_end_ms,
        },
    }
}

fn write_persistent_at(
    root: &Path,
    key: &V2AudioArtifactKey,
    artifact: &V2AudioArtifactHandle,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "无法创建磁盘粗索引目录。".to_string())?;
    let key_digest = cache_key_digest(key.as_str());
    validate_artifact(&key_digest, artifact)?;
    let payload = payload_ref(&key_digest, artifact);
    let envelope = PersistentEnvelopeRef {
        schema_version: PERSISTENT_SCHEMA_VERSION,
        payload_digest: payload_digest(&payload)?,
        last_access_ms: current_time_ms(),
        payload,
    };
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|_| "磁盘粗索引 envelope 无法序列化。".to_string())?;
    if bytes.len() as u64 > PERSISTENT_MAX_FILE_BYTES {
        return Err("磁盘粗索引文件超过单文件硬上限。".to_string());
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
            .map_err(|_| "无法创建磁盘粗索引临时文件。".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "无法完整写入磁盘粗索引临时文件。".to_string())?;
        file.sync_all()
            .map_err(|_| "无法同步磁盘粗索引临时文件。".to_string())?;
        replace_persistent_v2_coarse_cache_file(&temporary, &destination)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    prune_persistent(root);
    Ok(())
}

fn load_persistent_at(root: &Path, key: &V2AudioArtifactKey) -> Option<V2AudioArtifactHandle> {
    let expected_key_digest = cache_key_digest(key.as_str());
    let path = persistent_path(root, &expected_key_digest);
    let load_result = (|| -> Result<V2AudioArtifactHandle, String> {
        let metadata = fs::metadata(&path).map_err(|_| "磁盘粗索引不存在。".to_string())?;
        if metadata.len() == 0 || metadata.len() > PERSISTENT_MAX_FILE_BYTES {
            return Err("磁盘粗索引文件大小无效。".to_string());
        }
        let bytes = fs::read(&path).map_err(|_| "磁盘粗索引无法读取。".to_string())?;
        let mut envelope = serde_json::from_slice::<PersistentEnvelope>(&bytes)
            .map_err(|_| "磁盘粗索引 JSON 无效。".to_string())?;
        if envelope.schema_version != PERSISTENT_SCHEMA_VERSION {
            return Err("磁盘粗索引 schema 版本不受支持。".to_string());
        }
        validate_persistent_payload(&expected_key_digest, &envelope.payload)?;
        if envelope.payload_digest != payload_digest(&envelope.payload)? {
            return Err("磁盘粗索引 payload 摘要校验失败。".to_string());
        }
        envelope.last_access_ms = current_time_ms();
        Ok(artifact_from_persistent_payload(envelope.payload))
    })();
    match load_result {
        Ok(artifact) => {
            let _ = write_persistent_at(root, key, &artifact);
            Some(artifact)
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

fn clear_persistent(root: &Path) -> V2AudioArtifactClearReceipt {
    let Ok(entries) = fs::read_dir(root) else {
        return V2AudioArtifactClearReceipt::default();
    };
    let mut receipt = V2AudioArtifactClearReceipt::default();
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

pub(super) fn replace_persistent_v2_coarse_cache_file(
    temporary_path: &Path,
    destination_path: &Path,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let temporary = temporary_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = destination_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: both UTF-16 buffers are NUL-terminated and remain alive for the call.
        let moved = unsafe {
            MoveFileExW(
                temporary.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err("磁盘粗索引无法原子替换目标文件。".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(temporary_path, destination_path)
            .map_err(|_| "磁盘粗索引无法原子替换目标文件。".to_string())
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
        cache_key_digest, persistent_path, V2AudioArtifactHandle, V2AudioArtifactKey,
        V2AudioArtifactLookup, V2AudioArtifactStore,
    };
    use crate::{
        alignment_v2::{
            CoarseSpectralFingerprintFrame, FineFeatureFrame, PresentationRangeMs,
            SpectralBackendExecution, SpectralLandmark, STREAMING_CPU_SPECTRAL_BACKEND_ID,
        },
        audio_alignment::benchmark_telemetry::{
            self, AlignmentBenchmarkCacheCounts, AlignmentBenchmarkRunTelemetry,
        },
    };
    use std::{fs, sync::Arc, time::Instant};

    fn artifact(marker: u64) -> V2AudioArtifactHandle {
        V2AudioArtifactHandle {
            pcm: Some(Arc::new(vec![marker as i16; 512])),
            landmarks: Arc::new(vec![SpectralLandmark {
                hash: marker,
                time_ms: marker as i64,
                strength_milli: 1_000,
            }]),
            coarse_fingerprint: Arc::new(vec![CoarseSpectralFingerprintFrame {
                time_ms: marker as i64,
                values: [10; 12],
                active_ratio_milli: 1_000,
                log_rms_milli: 8_000,
            }]),
            fine_features: Some(Arc::new(vec![FineFeatureFrame {
                time_ms: marker as i64,
                presentation_time_ms: marker as i64,
                values: vec![0.1; 14],
            }])),
            spectral_backend: SpectralBackendExecution {
                backend_id: STREAMING_CPU_SPECTRAL_BACKEND_ID.to_string(),
                requested_backend: "cpu".to_string(),
                backend_detail: "test streaming CPU".to_string(),
                fallback_reason: None,
            },
            presentation_bounds: PresentationRangeMs {
                start_ms: 0,
                end_ms: 10_000,
            },
        }
    }

    #[test]
    fn publish_and_memory_hit_share_every_immutable_allocation() {
        let store = V2AudioArtifactStore::isolated(None, usize::MAX);
        let key = V2AudioArtifactKey::test("shared");
        let published = artifact(1);
        let pcm = Arc::clone(published.pcm.as_ref().unwrap());
        let landmarks = Arc::clone(&published.landmarks);
        let coarse = Arc::clone(&published.coarse_fingerprint);
        let fine = Arc::clone(published.fine_features.as_ref().unwrap());

        store
            .publish_extracted(key.clone(), published, None)
            .unwrap();
        let V2AudioArtifactLookup::Hit(candidate) = store.begin_memory_lookup(&key).unwrap() else {
            panic!("published artifact must be a memory hit");
        };
        let hit = candidate.confirm();

        assert!(Arc::ptr_eq(hit.pcm.as_ref().unwrap(), &pcm));
        assert!(Arc::ptr_eq(&hit.landmarks, &landmarks));
        assert!(Arc::ptr_eq(&hit.coarse_fingerprint, &coarse));
        assert!(Arc::ptr_eq(hit.fine_features.as_ref().unwrap(), &fine));
    }

    #[test]
    fn lru_byte_budget_and_clear_generation_are_store_owned() {
        let one_artifact_bytes =
            super::resident_bytes(&V2AudioArtifactKey::test("a"), &artifact(1));
        let store = V2AudioArtifactStore::isolated(None, one_artifact_bytes * 2);
        let a = V2AudioArtifactKey::test("a");
        let b = V2AudioArtifactKey::test("b");
        let c = V2AudioArtifactKey::test("c");
        let generation = store.generation().unwrap();

        store
            .publish_extracted(a.clone(), artifact(1), None)
            .unwrap();
        store
            .publish_extracted(b.clone(), artifact(2), None)
            .unwrap();
        let V2AudioArtifactLookup::Hit(hit) = store.begin_memory_lookup(&a).unwrap() else {
            panic!("a must be present");
        };
        let _ = hit.confirm();
        store
            .publish_extracted(c.clone(), artifact(3), None)
            .unwrap();

        assert!(matches!(
            store.begin_memory_lookup(&b).unwrap(),
            V2AudioArtifactLookup::Miss
        ));
        assert_eq!(store.memory_entry_count().unwrap(), 2);
        store.clear_memory().unwrap();
        assert_eq!(store.memory_entry_count().unwrap(), 0);
        assert_eq!(store.generation().unwrap(), generation + 1);
    }

    #[test]
    fn planned_hit_survives_eviction_with_the_same_shared_allocation() {
        let store = V2AudioArtifactStore::isolated(None, usize::MAX);
        let key = V2AudioArtifactKey::test("planned");
        let original = artifact(4);
        let landmarks = Arc::clone(&original.landmarks);
        store
            .publish_extracted(key.clone(), original, None)
            .unwrap();
        let plan = store
            .plan_memory(std::slice::from_ref(&key))
            .unwrap()
            .pop()
            .unwrap();
        store.clear_memory().unwrap();

        let V2AudioArtifactLookup::Hit(candidate) = plan.resolve(&key).unwrap() else {
            panic!("planned hit must remain consumable");
        };
        let hit = candidate.confirm();
        assert!(Arc::ptr_eq(&hit.landmarks, &landmarks));
        assert_eq!(store.memory_entry_count().unwrap(), 0);
    }

    #[test]
    fn persistent_round_trip_is_path_free_atomic_and_rejects_tampering() {
        let root = std::env::temp_dir().join(format!(
            "v2-audio-artifact-store-{}-{}",
            std::process::id(),
            super::current_time_ms()
        ));
        let store = V2AudioArtifactStore::isolated(Some(root.clone()), usize::MAX);
        let key = V2AudioArtifactKey::test(
            r"engine=v2|content=sha256:secret-content|logicalPath=C:\private\episode.mkv",
        );
        let source = artifact(5);

        let receipt = store
            .publish_extracted(key.clone(), source.clone(), None)
            .unwrap();
        assert!(receipt.persistent_stored);
        assert!(receipt.persistence_error.is_none());
        store.clear_memory().unwrap();

        let path = persistent_path(&root, &cache_key_digest(key.as_str()));
        let stored = fs::read_to_string(&path).unwrap();
        assert!(!stored.contains(r"C:\private"));
        assert!(!stored.contains("secret-content"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let loaded = store.load_persistent(&key).expect("persistent hit");
        assert_eq!(loaded.landmarks.as_ref(), source.landmarks.as_ref());
        assert_eq!(
            loaded.coarse_fingerprint.as_ref(),
            source.coarse_fingerprint.as_ref()
        );
        assert!(loaded.pcm.is_none());
        assert!(loaded.fine_features.is_none());

        let mut tampered = serde_json::from_str::<serde_json::Value>(&stored).unwrap();
        tampered["payload"]["landmarks"][0]["strengthMilli"] = serde_json::json!(999);
        fs::write(&path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(store.load_persistent(&key).is_none());
        assert!(!path.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn telemetry_keeps_existing_hit_miss_write_and_eviction_meaning() {
        let one_artifact_bytes =
            super::resident_bytes(&V2AudioArtifactKey::test("a"), &artifact(1));
        let store = V2AudioArtifactStore::isolated(None, one_artifact_bytes);
        let a = V2AudioArtifactKey::test("a");
        let b = V2AudioArtifactKey::test("b");
        let missing = V2AudioArtifactKey::test("missing");
        let telemetry = Arc::new(AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            20,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        ));
        telemetry.mark_started().unwrap();

        benchmark_telemetry::with_active(telemetry.clone(), || {
            assert!(matches!(
                store.begin_memory_lookup(&missing).unwrap(),
                V2AudioArtifactLookup::Miss
            ));
            store
                .publish_extracted(a.clone(), artifact(1), None)
                .unwrap();
            let V2AudioArtifactLookup::Hit(hit) = store.begin_memory_lookup(&a).unwrap() else {
                panic!("a must be a hit");
            };
            let _ = hit.confirm();
            store.publish_extracted(b, artifact(2), None).unwrap();
        });

        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.cache.landmarks.misses, 1);
        assert_eq!(snapshot.cache.landmarks.hits, 1);
        assert_eq!(snapshot.cache.landmarks.writes, 2);
        assert_eq!(snapshot.cache.landmarks.evictions, 1);
    }
}
