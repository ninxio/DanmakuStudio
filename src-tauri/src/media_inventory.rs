use crate::{
    media_probe::{
        MediaInventoryMetadataProbe, MediaInventoryMetadataProbeError,
        MediaInventoryMetadataProbeErrorKind, MediaInventoryProbeCompleteness as ProbeCompleteness,
        MediaInventoryProbeMetadata,
    },
    physical_file::{PhysicalFileObjectKey, PinnedPhysicalFile},
    process_supervision::process_supervision_cleanup_faulted,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const MEDIA_INVENTORY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaInventoryRequest {
    pub schema_version: u32,
    pub items: Vec<MediaInventoryRequestItem>,
    #[serde(default)]
    pub ffprobe_path: Option<String>,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub preferred_languages: Vec<String>,
    #[serde(default)]
    pub cache_policy: MediaInventoryCachePolicy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaInventoryRequestItem {
    pub item_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryCachePolicy {
    #[default]
    ReuseFresh,
    Refresh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryJobStatus {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl MediaInventoryJobStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryItemStatus {
    Queued,
    Probing,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryJobCounts {
    pub total: u32,
    pub queued: u32,
    pub probing: u32,
    pub ready: u32,
    pub failed: u32,
    pub cancelled: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryJobSnapshot {
    pub schema_version: u32,
    pub job_id: String,
    pub status: MediaInventoryJobStatus,
    pub sequence: u64,
    pub cancel_requested: bool,
    pub counts: MediaInventoryJobCounts,
    pub items: Vec<MediaInventoryItemSnapshot>,
    pub terminal_error: Option<MediaInventoryTerminalError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryItemSnapshot {
    pub ordinal: u32,
    pub item_id: String,
    pub status: MediaInventoryItemStatus,
    pub result: Option<MediaInventoryItemResult>,
    pub error: Option<MediaInventoryItemError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryItemResult {
    pub inventory_revision: String,
    pub duration_ms: Option<u64>,
    pub audio_tracks: Vec<MediaInventoryAudioTrack>,
    pub recommendation: MediaInventoryRecommendation,
    pub probe_completeness: MediaInventoryProbeCompleteness,
    pub cache_state: MediaInventoryCacheState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryAudioTrack {
    #[serde(rename = "index")]
    pub stream_index: u32,
    #[serde(rename = "codec")]
    pub codec_name: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub channel_layout: Option<String>,
    pub duration_ms: Option<u64>,
    pub dispositions: MediaInventoryAudioDispositions,
    pub recommendation_rank: u32,
    pub reason_codes: Vec<MediaInventoryRecommendationReasonCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryAudioDispositions {
    #[serde(rename = "default")]
    pub is_default: bool,
    #[serde(rename = "original")]
    pub is_original: bool,
    #[serde(rename = "dub")]
    pub is_dub: bool,
    #[serde(rename = "commentary")]
    pub is_commentary: bool,
    #[serde(rename = "descriptions")]
    pub is_descriptions: bool,
    #[serde(rename = "visualImpaired")]
    pub is_visual_impaired: bool,
    #[serde(rename = "hearingImpaired")]
    pub is_hearing_impaired: bool,
    #[serde(rename = "cleanEffects")]
    pub is_clean_effects: bool,
    #[serde(rename = "karaoke")]
    pub is_karaoke: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryRecommendation {
    pub state: MediaInventoryRecommendationState,
    pub stream_index: Option<u32>,
    pub reason_codes: Vec<MediaInventoryRecommendationReasonCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryRecommendationState {
    Recommended,
    NeedsChoice,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryRecommendationReasonCode {
    OnlyNonSpecialTrack,
    PreferredLanguage,
    OriginalDisposition,
    DefaultDispositionHint,
    TechnicalTieBreak,
    CommentaryDisposition,
    CommentaryTitleHint,
    DescriptionsDisposition,
    VisualImpairedDisposition,
    HearingImpairedDisposition,
    AuxiliaryDisposition,
    MetadataIncomplete,
    EquivalentCandidate,
    AllTracksSpecialPurpose,
    NoAudioTrack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryProbeCompleteness {
    Complete,
    Partial,
    FallbackRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryCacheState {
    Fresh,
    Stale,
    Miss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryItemErrorCode {
    InvalidPath,
    FileNotFound,
    FileUnreadable,
    UnsupportedSource,
    FfprobeUnavailable,
    ProbeTimeout,
    ProbeOutputLimit,
    ProbeFailed,
    InvalidProbeOutput,
    MetadataIncomplete,
    MediaChanged,
    ProcessCleanupFault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryItemError {
    pub code: MediaInventoryItemErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryTerminalErrorCode {
    ProcessCleanupFault,
    InternalInvariant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryTerminalError {
    pub code: MediaInventoryTerminalErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaInventoryCommandErrorCode {
    InvalidRequest,
    InventoryBusy,
    JobNotFound,
    JobCapacityReached,
    ProcessCleanupFault,
    InternalInvariant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventoryCommandError {
    pub code: MediaInventoryCommandErrorCode,
    pub message: String,
}

trait PreparedMediaInventoryProbe: Send + Sync {
    fn tool_stamp(&self) -> u64;

    fn probe(
        &self,
        path: &Path,
        cancel_flag: &AtomicBool,
    ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError>;
}

trait MediaInventoryProbeFactory: Send + Sync {
    fn prepare(
        &self,
        ffprobe_path: Option<&str>,
        ffmpeg_path: Option<&str>,
    ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError>;
}

struct ProductionMediaInventoryProbeFactory;

impl MediaInventoryProbeFactory for ProductionMediaInventoryProbeFactory {
    fn prepare(
        &self,
        ffprobe_path: Option<&str>,
        ffmpeg_path: Option<&str>,
    ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
        MediaInventoryMetadataProbe::prepare(ffprobe_path, ffmpeg_path)
            .map(|probe| Arc::new(probe) as Arc<dyn PreparedMediaInventoryProbe>)
            .map_err(map_probe_prepare_error)
    }
}

impl PreparedMediaInventoryProbe for MediaInventoryMetadataProbe {
    fn tool_stamp(&self) -> u64 {
        MediaInventoryMetadataProbe::tool_stamp(self)
    }

    fn probe(
        &self,
        path: &Path,
        cancel_flag: &AtomicBool,
    ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError> {
        MediaInventoryMetadataProbe::probe(self, path, cancel_flag).map_err(map_probe_error)
    }
}

#[derive(Debug, Clone, Copy)]
struct MediaInventoryRuntimeLimits {
    worker_limit: usize,
    cache_entry_limit: usize,
    cache_payload_limit: usize,
    terminal_job_limit: usize,
}

impl MediaInventoryRuntimeLimits {
    fn production() -> Self {
        let available = thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        Self {
            worker_limit: available.clamp(1, 4),
            cache_entry_limit: 512,
            cache_payload_limit: 16 * 1024 * 1024,
            terminal_job_limit: 32,
        }
    }

    #[cfg(test)]
    fn for_tests(
        worker_limit: usize,
        cache_entry_limit: usize,
        cache_payload_limit: usize,
    ) -> Self {
        Self {
            worker_limit: worker_limit.clamp(1, 4),
            cache_entry_limit,
            cache_payload_limit,
            terminal_job_limit: 32,
        }
    }
}

#[derive(Clone)]
struct MediaInventoryRuntime {
    shared: Arc<Mutex<MediaInventoryRuntimeState>>,
    probe_factory: Arc<dyn MediaInventoryProbeFactory>,
    limits: MediaInventoryRuntimeLimits,
    #[cfg(test)]
    failure_publish_barrier: Option<MediaInventoryFailurePublishBarrier>,
}

#[cfg(test)]
#[derive(Clone)]
struct MediaInventoryFailurePublishBarrier {
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
}

#[cfg(test)]
impl MediaInventoryFailurePublishBarrier {
    fn pause(&self) {
        self.entered.wait();
        self.release.wait();
    }
}

struct MediaInventoryRuntimeState {
    next_job_sequence: u64,
    active_job_id: Option<String>,
    jobs: HashMap<String, MediaInventoryJobEntry>,
    terminal_order: VecDeque<String>,
    cache: MediaInventoryMetadataCache,
}

struct MediaInventoryJobEntry {
    snapshot: MediaInventoryJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum MediaInventoryPhysicalSubject {
    #[cfg(windows)]
    WindowsObject(PhysicalFileObjectKey),
    #[cfg(not(windows))]
    CanonicalPath(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MediaInventoryCacheKey {
    schema_version: u32,
    subject: MediaInventoryPhysicalSubject,
    size_bytes: u64,
    modified_nanos: u128,
    tool_stamp: u64,
}

struct PreparedPhysicalInput {
    probe_path: PathBuf,
    cache_key: MediaInventoryCacheKey,
    #[cfg(windows)]
    pin: Arc<PinnedPhysicalFile>,
}

struct MediaInventoryWorkGroup {
    input: Arc<PreparedPhysicalInput>,
    ordinals: Vec<usize>,
}

struct MediaInventoryMetadataCacheEntry {
    metadata: MediaInventoryProbeMetadata,
    estimated_payload_bytes: usize,
}

struct MediaInventoryMetadataCache {
    entries: HashMap<MediaInventoryCacheKey, MediaInventoryMetadataCacheEntry>,
    lru: VecDeque<MediaInventoryCacheKey>,
    payload_bytes: usize,
    entry_limit: usize,
    payload_limit: usize,
}

impl MediaInventoryMetadataCache {
    fn new(entry_limit: usize, payload_limit: usize) -> Self {
        Self {
            entries: HashMap::new(),
            lru: VecDeque::new(),
            payload_bytes: 0,
            entry_limit,
            payload_limit,
        }
    }

    fn lookup(
        &mut self,
        key: &MediaInventoryCacheKey,
        policy: MediaInventoryCachePolicy,
    ) -> (
        Option<MediaInventoryProbeMetadata>,
        MediaInventoryCacheState,
    ) {
        if policy == MediaInventoryCachePolicy::ReuseFresh {
            if let Some(metadata) = self.entries.get(key).map(|entry| entry.metadata.clone()) {
                self.touch(key);
                return (Some(metadata), MediaInventoryCacheState::Fresh);
            }
        }
        let had_same_subject = self
            .entries
            .keys()
            .any(|existing| existing.subject == key.subject);
        let state = if had_same_subject {
            MediaInventoryCacheState::Stale
        } else {
            MediaInventoryCacheState::Miss
        };
        self.remove_subject(&key.subject);
        (None, state)
    }

    fn insert(&mut self, key: MediaInventoryCacheKey, metadata: MediaInventoryProbeMetadata) {
        self.remove_subject(&key.subject);
        let estimated_payload_bytes = estimate_metadata_payload_bytes(&metadata);
        if self.entry_limit == 0 || estimated_payload_bytes > self.payload_limit {
            return;
        }
        self.payload_bytes = self.payload_bytes.saturating_add(estimated_payload_bytes);
        self.lru.push_back(key.clone());
        self.entries.insert(
            key,
            MediaInventoryMetadataCacheEntry {
                metadata,
                estimated_payload_bytes,
            },
        );
        while self.entries.len() > self.entry_limit || self.payload_bytes > self.payload_limit {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            self.remove_key(&oldest);
        }
    }

    fn touch(&mut self, key: &MediaInventoryCacheKey) {
        if let Some(position) = self.lru.iter().position(|candidate| candidate == key) {
            self.lru.remove(position);
        }
        self.lru.push_back(key.clone());
    }

    fn remove_subject(&mut self, subject: &MediaInventoryPhysicalSubject) {
        let keys = self
            .entries
            .keys()
            .filter(|key| &key.subject == subject)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.remove_key(&key);
        }
    }

    fn remove_key(&mut self, key: &MediaInventoryCacheKey) {
        if let Some(entry) = self.entries.remove(key) {
            self.payload_bytes = self
                .payload_bytes
                .saturating_sub(entry.estimated_payload_bytes);
        }
        if let Some(position) = self.lru.iter().position(|candidate| candidate == key) {
            self.lru.remove(position);
        }
    }
}

impl MediaInventoryRuntime {
    fn production() -> Self {
        Self::with_dependencies(
            Arc::new(ProductionMediaInventoryProbeFactory),
            MediaInventoryRuntimeLimits::production(),
        )
    }

    fn with_dependencies(
        probe_factory: Arc<dyn MediaInventoryProbeFactory>,
        limits: MediaInventoryRuntimeLimits,
    ) -> Self {
        Self {
            shared: Arc::new(Mutex::new(MediaInventoryRuntimeState {
                next_job_sequence: 0,
                active_job_id: None,
                jobs: HashMap::new(),
                terminal_order: VecDeque::new(),
                cache: MediaInventoryMetadataCache::new(
                    limits.cache_entry_limit,
                    limits.cache_payload_limit,
                ),
            })),
            probe_factory,
            limits,
            #[cfg(test)]
            failure_publish_barrier: None,
        }
    }

    #[cfg(test)]
    fn with_failure_publish_barrier(
        mut self,
        barrier: MediaInventoryFailurePublishBarrier,
    ) -> Self {
        self.failure_publish_barrier = Some(barrier);
        self
    }

    #[cfg(test)]
    fn new_for_test() -> Self {
        Self::production()
    }

    fn start_job(
        &self,
        request: MediaInventoryRequest,
    ) -> Result<MediaInventoryJobSnapshot, MediaInventoryCommandError> {
        let request = normalize_media_inventory_request(request)?;
        if process_supervision_cleanup_faulted() {
            return Err(command_error(
                MediaInventoryCommandErrorCode::ProcessCleanupFault,
                "媒体清单进程监督处于 fail-closed 状态。",
            ));
        }
        let (job_id, started) = {
            let mut state = self.lock_for_command()?;
            if let Some(active_job_id) = state.active_job_id.as_ref() {
                if state
                    .jobs
                    .get(active_job_id)
                    .is_some_and(|entry| !entry.snapshot.status.is_terminal())
                {
                    return Err(command_error(
                        MediaInventoryCommandErrorCode::InventoryBusy,
                        "已有媒体清单任务正在运行。",
                    ));
                }
            }
            state.active_job_id = None;
            state.next_job_sequence = state.next_job_sequence.checked_add(1).ok_or_else(|| {
                command_error(
                    MediaInventoryCommandErrorCode::JobCapacityReached,
                    "媒体清单任务编号已达到安全上限。",
                )
            })?;
            let epoch_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            let job_id = format!("media-inventory-{epoch_ms}-{}", state.next_job_sequence);
            let items = request
                .items
                .iter()
                .enumerate()
                .map(|(ordinal, item)| MediaInventoryItemSnapshot {
                    ordinal: u32::try_from(ordinal).unwrap_or(u32::MAX),
                    item_id: item.item_id.clone(),
                    status: MediaInventoryItemStatus::Queued,
                    result: None,
                    error: None,
                })
                .collect::<Vec<_>>();
            let snapshot = MediaInventoryJobSnapshot {
                schema_version: MEDIA_INVENTORY_SCHEMA_VERSION,
                job_id: job_id.clone(),
                status: MediaInventoryJobStatus::Queued,
                sequence: 1,
                cancel_requested: false,
                counts: counts_for_items(&items),
                items,
                terminal_error: None,
            };
            state.active_job_id = Some(job_id.clone());
            state.jobs.insert(
                job_id.clone(),
                MediaInventoryJobEntry {
                    snapshot: snapshot.clone(),
                    cancel_flag: Arc::new(AtomicBool::new(false)),
                    stop_flag: Arc::new(AtomicBool::new(false)),
                },
            );
            (job_id, snapshot)
        };

        let runtime = self.clone();
        let worker_job_id = job_id.clone();
        if thread::Builder::new()
            .name(format!("media-inventory-{worker_job_id}"))
            .spawn(move || runtime.run_registered_job(worker_job_id, request))
            .is_err()
        {
            self.finish_job(
                &job_id,
                Some(terminal_error(
                    MediaInventoryTerminalErrorCode::InternalInvariant,
                    "无法启动媒体清单后台任务。",
                )),
            );
            return self.get_job(&job_id);
        }
        Ok(started)
    }

    fn get_job(
        &self,
        job_id: &str,
    ) -> Result<MediaInventoryJobSnapshot, MediaInventoryCommandError> {
        let state = self.lock_for_command()?;
        state
            .jobs
            .get(job_id)
            .map(|entry| entry.snapshot.clone())
            .ok_or_else(|| {
                command_error(
                    MediaInventoryCommandErrorCode::JobNotFound,
                    "媒体清单任务不存在或已过期。",
                )
            })
    }

    fn cancel_job(
        &self,
        job_id: &str,
    ) -> Result<MediaInventoryJobSnapshot, MediaInventoryCommandError> {
        let mut state = self.lock_for_command()?;
        let entry = state.jobs.get_mut(job_id).ok_or_else(|| {
            command_error(
                MediaInventoryCommandErrorCode::JobNotFound,
                "媒体清单任务不存在或已过期。",
            )
        })?;
        if entry.snapshot.status.is_terminal() || entry.snapshot.cancel_requested {
            return Ok(entry.snapshot.clone());
        }
        entry.snapshot.cancel_requested = true;
        entry.cancel_flag.store(true, Ordering::Release);
        entry.stop_flag.store(true, Ordering::Release);
        bump_snapshot(&mut entry.snapshot);
        Ok(entry.snapshot.clone())
    }

    fn lock_for_command(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, MediaInventoryRuntimeState>, MediaInventoryCommandError>
    {
        self.shared.lock().map_err(|_| {
            command_error(
                MediaInventoryCommandErrorCode::InternalInvariant,
                "媒体清单内部状态不可用。",
            )
        })
    }

    fn lock_internal(&self) -> std::sync::MutexGuard<'_, MediaInventoryRuntimeState> {
        self.shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn run_registered_job(&self, job_id: String, request: MediaInventoryRequest) {
        let execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.execute_job(&job_id, request)
        }));
        let fatal = match execution {
            Ok(fatal) => fatal,
            Err(_) => Some(terminal_error(
                MediaInventoryTerminalErrorCode::InternalInvariant,
                "媒体清单后台任务异常退出。",
            )),
        };
        self.finish_job(&job_id, fatal);
    }

    fn execute_job(
        &self,
        job_id: &str,
        request: MediaInventoryRequest,
    ) -> Option<MediaInventoryTerminalError> {
        let (cancel_flag, stop_flag) = {
            let mut state = self.lock_internal();
            let entry = state.jobs.get_mut(job_id)?;
            if entry.snapshot.cancel_requested {
                return None;
            }
            entry.snapshot.status = MediaInventoryJobStatus::Running;
            bump_snapshot(&mut entry.snapshot);
            (Arc::clone(&entry.cancel_flag), Arc::clone(&entry.stop_flag))
        };

        let probe = match self.probe_factory.prepare(
            request.ffprobe_path.as_deref(),
            request.ffmpeg_path.as_deref(),
        ) {
            Ok(probe) => probe,
            Err(error) if error.code == MediaInventoryItemErrorCode::ProcessCleanupFault => {
                return Some(terminal_error(
                    MediaInventoryTerminalErrorCode::ProcessCleanupFault,
                    "媒体清单进程监督处于 fail-closed 状态。",
                ));
            }
            Err(error) => {
                self.fail_all_queued(job_id, error);
                return None;
            }
        };

        let mut groups = Vec::<MediaInventoryWorkGroup>::new();
        let mut group_by_subject = HashMap::<MediaInventoryPhysicalSubject, usize>::new();
        for (ordinal, item) in request.items.iter().enumerate() {
            if stop_flag.load(Ordering::Acquire) {
                break;
            }
            match prepare_physical_input(&item.path, probe.tool_stamp()) {
                Ok(input) => {
                    if let Some(group_index) =
                        group_by_subject.get(&input.cache_key.subject).copied()
                    {
                        if groups[group_index].input.cache_key != input.cache_key {
                            self.publish_item_failed(
                                job_id,
                                ordinal,
                                item_error(
                                    MediaInventoryItemErrorCode::MediaChanged,
                                    "同一物理媒体在清单准备期间发生变化。",
                                ),
                            );
                        } else {
                            groups[group_index].ordinals.push(ordinal);
                        }
                    } else {
                        let group_index = groups.len();
                        group_by_subject.insert(input.cache_key.subject.clone(), group_index);
                        groups.push(MediaInventoryWorkGroup {
                            input: Arc::new(input),
                            ordinals: vec![ordinal],
                        });
                    }
                }
                Err(error) => self.publish_item_failed(job_id, ordinal, error),
            }
        }

        if groups.is_empty() || stop_flag.load(Ordering::Acquire) {
            return None;
        }
        let queue = Arc::new(Mutex::new(VecDeque::from(groups)));
        let fatal = Arc::new(Mutex::new(None::<MediaInventoryTerminalError>));
        let preferred_languages = Arc::new(request.preferred_languages);
        let worker_count = self
            .limits
            .worker_limit
            .min(
                queue
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .len(),
            )
            .max(1);
        let mut handles = Vec::with_capacity(worker_count);
        for worker_index in 0..worker_count {
            let runtime = self.clone();
            let queue = Arc::clone(&queue);
            let worker_fatal = Arc::clone(&fatal);
            let probe = Arc::clone(&probe);
            let worker_stop_flag = Arc::clone(&stop_flag);
            let cancel_flag = Arc::clone(&cancel_flag);
            let preferred_languages = Arc::clone(&preferred_languages);
            let worker_job_id = job_id.to_string();
            match thread::Builder::new()
                .name(format!("media-inventory-worker-{worker_index}"))
                .spawn(move || {
                    runtime.worker_loop(
                        &worker_job_id,
                        queue,
                        probe,
                        cancel_flag,
                        worker_stop_flag,
                        worker_fatal,
                        preferred_languages,
                        request.cache_policy,
                    )
                }) {
                Ok(handle) => handles.push(handle),
                Err(_) => {
                    stop_flag.store(true, Ordering::Release);
                    record_terminal_error(
                        &fatal,
                        terminal_error(
                            MediaInventoryTerminalErrorCode::InternalInvariant,
                            "无法启动媒体清单并发 worker。",
                        ),
                    );
                    break;
                }
            }
        }
        for handle in handles {
            if handle.join().is_err() {
                stop_flag.store(true, Ordering::Release);
                record_terminal_error(
                    &fatal,
                    terminal_error(
                        MediaInventoryTerminalErrorCode::InternalInvariant,
                        "媒体清单 worker 异常退出。",
                    ),
                );
            }
        }
        let terminal = fatal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        terminal
    }

    #[allow(clippy::too_many_arguments)]
    fn worker_loop(
        &self,
        job_id: &str,
        queue: Arc<Mutex<VecDeque<MediaInventoryWorkGroup>>>,
        probe: Arc<dyn PreparedMediaInventoryProbe>,
        cancel_flag: Arc<AtomicBool>,
        stop_flag: Arc<AtomicBool>,
        fatal: Arc<Mutex<Option<MediaInventoryTerminalError>>>,
        preferred_languages: Arc<Vec<String>>,
        cache_policy: MediaInventoryCachePolicy,
    ) {
        loop {
            if stop_flag.load(Ordering::Acquire) {
                return;
            }
            let group = queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front();
            let Some(group) = group else {
                return;
            };
            if !self.mark_group_probing(job_id, &group.ordinals) {
                continue;
            }
            let (cached, cache_state) = self.cache_lookup(&group.input.cache_key, cache_policy);
            let metadata = match cached {
                Some(metadata) => metadata,
                None => match probe.probe(&group.input.probe_path, &stop_flag) {
                    Ok(metadata) => {
                        if let Err(error) = verify_physical_input(&group.input) {
                            self.publish_group_failed(job_id, &group.ordinals, error);
                            continue;
                        }
                        self.cache_insert(group.input.cache_key.clone(), metadata.clone());
                        metadata
                    }
                    Err(error)
                        if error.code == MediaInventoryItemErrorCode::ProcessCleanupFault =>
                    {
                        stop_flag.store(true, Ordering::Release);
                        record_terminal_error(
                            &fatal,
                            terminal_error(
                                MediaInventoryTerminalErrorCode::ProcessCleanupFault,
                                "媒体清单 FFprobe 进程树未能可信收尾。",
                            ),
                        );
                        return;
                    }
                    Err(_error) if stop_flag.load(Ordering::Acquire) => {
                        self.publish_group_cancelled(job_id, &group.ordinals);
                        return;
                    }
                    Err(error) => {
                        #[cfg(test)]
                        if let Some(barrier) = &self.failure_publish_barrier {
                            barrier.pause();
                        }
                        self.publish_group_failed(job_id, &group.ordinals, error);
                        continue;
                    }
                },
            };
            if cancel_flag.load(Ordering::Acquire) || stop_flag.load(Ordering::Acquire) {
                self.publish_group_cancelled(job_id, &group.ordinals);
                continue;
            }
            let result = build_item_result(
                &metadata,
                &group.input.cache_key,
                cache_state,
                &preferred_languages,
            );
            self.publish_group_ready(job_id, &group.ordinals, result);
        }
    }

    fn cache_lookup(
        &self,
        key: &MediaInventoryCacheKey,
        policy: MediaInventoryCachePolicy,
    ) -> (
        Option<MediaInventoryProbeMetadata>,
        MediaInventoryCacheState,
    ) {
        self.lock_internal().cache.lookup(key, policy)
    }

    fn cache_insert(&self, key: MediaInventoryCacheKey, metadata: MediaInventoryProbeMetadata) {
        self.lock_internal().cache.insert(key, metadata);
    }

    fn mark_group_probing(&self, job_id: &str, ordinals: &[usize]) -> bool {
        let mut state = self.lock_internal();
        let Some(entry) = state.jobs.get_mut(job_id) else {
            return false;
        };
        if entry.snapshot.status != MediaInventoryJobStatus::Running
            || entry.snapshot.cancel_requested
        {
            return false;
        }
        if ordinals.iter().any(|ordinal| {
            entry
                .snapshot
                .items
                .get(*ordinal)
                .is_none_or(|item| item.status != MediaInventoryItemStatus::Queued)
        }) {
            return false;
        }
        for ordinal in ordinals {
            entry.snapshot.items[*ordinal].status = MediaInventoryItemStatus::Probing;
        }
        bump_snapshot(&mut entry.snapshot);
        true
    }

    fn publish_group_ready(
        &self,
        job_id: &str,
        ordinals: &[usize],
        result: MediaInventoryItemResult,
    ) {
        let mut state = self.lock_internal();
        let Some(entry) = state.jobs.get_mut(job_id) else {
            return;
        };
        if entry.snapshot.cancel_requested {
            for ordinal in ordinals {
                if let Some(item) = entry.snapshot.items.get_mut(*ordinal) {
                    if item.status == MediaInventoryItemStatus::Probing {
                        item.status = MediaInventoryItemStatus::Cancelled;
                    }
                }
            }
        } else {
            for ordinal in ordinals {
                if let Some(item) = entry.snapshot.items.get_mut(*ordinal) {
                    if item.status == MediaInventoryItemStatus::Probing {
                        item.status = MediaInventoryItemStatus::Ready;
                        item.result = Some(result.clone());
                        item.error = None;
                    }
                }
            }
        }
        bump_snapshot(&mut entry.snapshot);
    }

    fn publish_group_failed(
        &self,
        job_id: &str,
        ordinals: &[usize],
        error: MediaInventoryItemError,
    ) {
        let mut state = self.lock_internal();
        let Some(entry) = state.jobs.get_mut(job_id) else {
            return;
        };
        let cancel_requested = entry.snapshot.cancel_requested;
        for ordinal in ordinals {
            if let Some(item) = entry.snapshot.items.get_mut(*ordinal) {
                if matches!(
                    item.status,
                    MediaInventoryItemStatus::Queued | MediaInventoryItemStatus::Probing
                ) {
                    item.status = if cancel_requested {
                        MediaInventoryItemStatus::Cancelled
                    } else {
                        MediaInventoryItemStatus::Failed
                    };
                    item.result = None;
                    item.error = if cancel_requested {
                        None
                    } else {
                        Some(error.clone())
                    };
                }
            }
        }
        bump_snapshot(&mut entry.snapshot);
    }

    fn publish_item_failed(&self, job_id: &str, ordinal: usize, error: MediaInventoryItemError) {
        self.publish_group_failed(job_id, &[ordinal], error);
    }

    fn publish_group_cancelled(&self, job_id: &str, ordinals: &[usize]) {
        let mut state = self.lock_internal();
        let Some(entry) = state.jobs.get_mut(job_id) else {
            return;
        };
        for ordinal in ordinals {
            if let Some(item) = entry.snapshot.items.get_mut(*ordinal) {
                if matches!(
                    item.status,
                    MediaInventoryItemStatus::Queued | MediaInventoryItemStatus::Probing
                ) {
                    item.status = MediaInventoryItemStatus::Cancelled;
                    item.result = None;
                    item.error = None;
                }
            }
        }
        bump_snapshot(&mut entry.snapshot);
    }

    fn fail_all_queued(&self, job_id: &str, error: MediaInventoryItemError) {
        let mut state = self.lock_internal();
        let Some(entry) = state.jobs.get_mut(job_id) else {
            return;
        };
        let cancel_requested = entry.snapshot.cancel_requested;
        for item in &mut entry.snapshot.items {
            if matches!(
                item.status,
                MediaInventoryItemStatus::Queued | MediaInventoryItemStatus::Probing
            ) {
                item.status = if cancel_requested {
                    MediaInventoryItemStatus::Cancelled
                } else {
                    MediaInventoryItemStatus::Failed
                };
                item.result = None;
                item.error = if cancel_requested {
                    None
                } else {
                    Some(error.clone())
                };
            }
        }
        bump_snapshot(&mut entry.snapshot);
    }

    fn finish_job(&self, job_id: &str, mut fatal: Option<MediaInventoryTerminalError>) {
        let mut state = self.lock_internal();
        let Some(entry) = state.jobs.get_mut(job_id) else {
            return;
        };
        if entry.snapshot.status.is_terminal() {
            return;
        }
        if fatal.is_none()
            && !entry.snapshot.cancel_requested
            && entry.snapshot.items.iter().any(|item| {
                matches!(
                    item.status,
                    MediaInventoryItemStatus::Queued | MediaInventoryItemStatus::Probing
                )
            })
        {
            fatal = Some(terminal_error(
                MediaInventoryTerminalErrorCode::InternalInvariant,
                "媒体清单任务结束时仍有未裁决素材项。",
            ));
        }
        if fatal.is_some() || entry.snapshot.cancel_requested {
            for item in &mut entry.snapshot.items {
                if matches!(
                    item.status,
                    MediaInventoryItemStatus::Queued | MediaInventoryItemStatus::Probing
                ) {
                    item.status = MediaInventoryItemStatus::Cancelled;
                    item.result = None;
                    item.error = None;
                }
            }
        }
        entry.snapshot.status = if fatal.is_some() {
            MediaInventoryJobStatus::Failed
        } else if entry.snapshot.cancel_requested {
            MediaInventoryJobStatus::Cancelled
        } else {
            MediaInventoryJobStatus::Completed
        };
        entry.snapshot.terminal_error = fatal;
        bump_snapshot(&mut entry.snapshot);

        if state.active_job_id.as_deref() == Some(job_id) {
            state.active_job_id = None;
        }
        state.terminal_order.push_back(job_id.to_string());
        while state.terminal_order.len() > self.limits.terminal_job_limit {
            let Some(expired) = state.terminal_order.pop_front() else {
                break;
            };
            if expired != job_id {
                state.jobs.remove(&expired);
            }
        }
    }
}

static MEDIA_INVENTORY_RUNTIME: OnceLock<MediaInventoryRuntime> = OnceLock::new();

fn global_media_inventory_runtime() -> &'static MediaInventoryRuntime {
    MEDIA_INVENTORY_RUNTIME.get_or_init(MediaInventoryRuntime::production)
}

#[tauri::command]
pub fn start_media_inventory_job(
    request: MediaInventoryRequest,
) -> Result<MediaInventoryJobSnapshot, MediaInventoryCommandError> {
    global_media_inventory_runtime().start_job(request)
}

#[tauri::command]
pub fn get_media_inventory_job(
    job_id: String,
) -> Result<MediaInventoryJobSnapshot, MediaInventoryCommandError> {
    global_media_inventory_runtime().get_job(job_id.trim())
}

#[tauri::command]
pub fn cancel_media_inventory_job(
    job_id: String,
) -> Result<MediaInventoryJobSnapshot, MediaInventoryCommandError> {
    global_media_inventory_runtime().cancel_job(job_id.trim())
}

fn normalize_media_inventory_request(
    mut request: MediaInventoryRequest,
) -> Result<MediaInventoryRequest, MediaInventoryCommandError> {
    if request.schema_version != MEDIA_INVENTORY_SCHEMA_VERSION {
        return Err(command_error(
            MediaInventoryCommandErrorCode::InvalidRequest,
            "媒体清单请求 schemaVersion 必须为 1。",
        ));
    }
    if request.items.is_empty() || request.items.len() > 256 {
        return Err(command_error(
            MediaInventoryCommandErrorCode::InvalidRequest,
            "媒体清单必须包含 1 到 256 个素材项。",
        ));
    }
    let mut item_ids = HashSet::with_capacity(request.items.len());
    for item in &mut request.items {
        item.item_id = item.item_id.trim().to_string();
        if item.item_id.is_empty()
            || item.item_id.len() > 128
            || !item_ids.insert(item.item_id.clone())
        {
            return Err(command_error(
                MediaInventoryCommandErrorCode::InvalidRequest,
                "媒体清单 itemId 必须唯一、非空且不超过 128 bytes。",
            ));
        }
        item.path = item.path.trim().to_string();
    }
    if request.preferred_languages.len() > 8 {
        return Err(command_error(
            MediaInventoryCommandErrorCode::InvalidRequest,
            "媒体清单 preferredLanguages 最多包含 8 项。",
        ));
    }
    let mut languages = HashSet::new();
    request.preferred_languages = request
        .preferred_languages
        .into_iter()
        .map(|language| language.trim().to_ascii_lowercase())
        .map(|language| {
            if language.is_empty() || language.len() > 35 {
                Err(command_error(
                    MediaInventoryCommandErrorCode::InvalidRequest,
                    "音轨语言标签必须非空且不超过 35 bytes。",
                ))
            } else {
                Ok(language)
            }
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|language| languages.insert(language.clone()))
        .collect();
    request.ffprobe_path = normalized_optional_request_text(request.ffprobe_path);
    request.ffmpeg_path = normalized_optional_request_text(request.ffmpeg_path);
    Ok(request)
}

fn normalized_optional_request_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn counts_for_items(items: &[MediaInventoryItemSnapshot]) -> MediaInventoryJobCounts {
    let mut counts = MediaInventoryJobCounts {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        queued: 0,
        probing: 0,
        ready: 0,
        failed: 0,
        cancelled: 0,
    };
    for item in items {
        match item.status {
            MediaInventoryItemStatus::Queued => counts.queued += 1,
            MediaInventoryItemStatus::Probing => counts.probing += 1,
            MediaInventoryItemStatus::Ready => counts.ready += 1,
            MediaInventoryItemStatus::Failed => counts.failed += 1,
            MediaInventoryItemStatus::Cancelled => counts.cancelled += 1,
        }
    }
    counts
}

fn bump_snapshot(snapshot: &mut MediaInventoryJobSnapshot) {
    snapshot.sequence = snapshot.sequence.saturating_add(1);
    snapshot.counts = counts_for_items(&snapshot.items);
}

fn command_error(
    code: MediaInventoryCommandErrorCode,
    message: impl Into<String>,
) -> MediaInventoryCommandError {
    MediaInventoryCommandError {
        code,
        message: message.into(),
    }
}

fn item_error(
    code: MediaInventoryItemErrorCode,
    message: impl Into<String>,
) -> MediaInventoryItemError {
    MediaInventoryItemError {
        code,
        message: message.into(),
    }
}

fn terminal_error(
    code: MediaInventoryTerminalErrorCode,
    message: impl Into<String>,
) -> MediaInventoryTerminalError {
    MediaInventoryTerminalError {
        code,
        message: message.into(),
    }
}

fn map_probe_prepare_error(error: MediaInventoryMetadataProbeError) -> MediaInventoryItemError {
    map_probe_error(error)
}

fn map_probe_error(error: MediaInventoryMetadataProbeError) -> MediaInventoryItemError {
    let code = match error.kind() {
        MediaInventoryMetadataProbeErrorKind::FfprobeUnavailable => {
            MediaInventoryItemErrorCode::FfprobeUnavailable
        }
        MediaInventoryMetadataProbeErrorKind::ProbeTimeout => {
            MediaInventoryItemErrorCode::ProbeTimeout
        }
        MediaInventoryMetadataProbeErrorKind::ProbeOutputLimit => {
            MediaInventoryItemErrorCode::ProbeOutputLimit
        }
        MediaInventoryMetadataProbeErrorKind::ProbeFailed
        | MediaInventoryMetadataProbeErrorKind::Cancelled => {
            MediaInventoryItemErrorCode::ProbeFailed
        }
        MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput => {
            MediaInventoryItemErrorCode::InvalidProbeOutput
        }
        MediaInventoryMetadataProbeErrorKind::MetadataIncomplete => {
            MediaInventoryItemErrorCode::MetadataIncomplete
        }
        MediaInventoryMetadataProbeErrorKind::ProcessCleanupFault => {
            MediaInventoryItemErrorCode::ProcessCleanupFault
        }
    };
    item_error(code, error.to_string())
}

fn prepare_physical_input(
    requested_path: &str,
    tool_stamp: u64,
) -> Result<PreparedPhysicalInput, MediaInventoryItemError> {
    if requested_path.is_empty() {
        return Err(item_error(
            MediaInventoryItemErrorCode::InvalidPath,
            "媒体路径不能为空。",
        ));
    }
    if requested_path.contains("://") {
        return Err(item_error(
            MediaInventoryItemErrorCode::UnsupportedSource,
            "媒体清单只接受用户导入的本地文件。",
        ));
    }
    crate::local_media_path::ensure_local_media_path(requested_path).map_err(|message| {
        item_error(MediaInventoryItemErrorCode::UnsupportedSource, message)
    })?;
    let logical_path = Path::new(requested_path);
    let initial_metadata = fs::metadata(logical_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            item_error(
                MediaInventoryItemErrorCode::FileNotFound,
                "媒体文件不存在。",
            )
        } else {
            item_error(
                MediaInventoryItemErrorCode::FileUnreadable,
                "媒体文件不可读取。",
            )
        }
    })?;
    if !initial_metadata.is_file() {
        return Err(item_error(
            MediaInventoryItemErrorCode::InvalidPath,
            "媒体路径不是本地普通文件。",
        ));
    }

    #[cfg(windows)]
    {
        let pin = PinnedPhysicalFile::open(logical_path).map_err(map_physical_pin_error)?;
        let metadata = fs::metadata(pin.handle_final_path()).map_err(|_| {
            item_error(
                MediaInventoryItemErrorCode::FileUnreadable,
                "无法读取已固定媒体的 metadata。",
            )
        })?;
        Ok(PreparedPhysicalInput {
            probe_path: pin.handle_final_path().to_path_buf(),
            cache_key: MediaInventoryCacheKey {
                schema_version: MEDIA_INVENTORY_SCHEMA_VERSION,
                subject: MediaInventoryPhysicalSubject::WindowsObject(pin.object_key()),
                size_bytes: metadata.len(),
                modified_nanos: modified_nanos(&metadata)?,
                tool_stamp,
            },
            pin,
        })
    }

    #[cfg(not(windows))]
    {
        let canonical = fs::canonicalize(logical_path).map_err(|_| {
            item_error(
                MediaInventoryItemErrorCode::FileUnreadable,
                "无法规范化媒体路径。",
            )
        })?;
        let metadata = fs::metadata(&canonical).map_err(|_| {
            item_error(
                MediaInventoryItemErrorCode::FileUnreadable,
                "无法读取媒体 metadata。",
            )
        })?;
        Ok(PreparedPhysicalInput {
            probe_path: canonical.clone(),
            cache_key: MediaInventoryCacheKey {
                schema_version: MEDIA_INVENTORY_SCHEMA_VERSION,
                subject: MediaInventoryPhysicalSubject::CanonicalPath(canonical),
                size_bytes: metadata.len(),
                modified_nanos: modified_nanos(&metadata)?,
                tool_stamp,
            },
        })
    }
}

#[cfg(windows)]
fn map_physical_pin_error(error: String) -> MediaInventoryItemError {
    if error.contains("physical-file-changed") {
        item_error(
            MediaInventoryItemErrorCode::MediaChanged,
            "媒体文件已变化。",
        )
    } else {
        item_error(
            MediaInventoryItemErrorCode::FileUnreadable,
            "无法固定媒体文件以进行安全探测。",
        )
    }
}

fn modified_nanos(metadata: &fs::Metadata) -> Result<u128, MediaInventoryItemError> {
    metadata
        .modified()
        .map_err(|_| {
            item_error(
                MediaInventoryItemErrorCode::FileUnreadable,
                "无法读取媒体修改时间。",
            )
        })?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|_| {
            item_error(
                MediaInventoryItemErrorCode::FileUnreadable,
                "媒体修改时间无效。",
            )
        })
}

fn verify_physical_input(input: &PreparedPhysicalInput) -> Result<(), MediaInventoryItemError> {
    #[cfg(windows)]
    input.pin.verify_handle_and_path().map_err(|_| {
        item_error(
            MediaInventoryItemErrorCode::MediaChanged,
            "媒体文件在清单探测期间发生变化。",
        )
    })?;
    let metadata = fs::metadata(&input.probe_path).map_err(|_| {
        item_error(
            MediaInventoryItemErrorCode::MediaChanged,
            "媒体文件在清单探测后不可读取。",
        )
    })?;
    if metadata.len() != input.cache_key.size_bytes
        || modified_nanos(&metadata)? != input.cache_key.modified_nanos
    {
        return Err(item_error(
            MediaInventoryItemErrorCode::MediaChanged,
            "媒体文件在清单探测期间发生变化。",
        ));
    }
    Ok(())
}

fn build_item_result(
    metadata: &MediaInventoryProbeMetadata,
    key: &MediaInventoryCacheKey,
    cache_state: MediaInventoryCacheState,
    preferred_languages: &[String],
) -> MediaInventoryItemResult {
    let (audio_tracks, recommendation) = recommend_audio_tracks(metadata, preferred_languages);
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    MediaInventoryItemResult {
        inventory_revision: format!("inventory-v1:{:016x}", hasher.finish()),
        duration_ms: metadata.duration_ms,
        audio_tracks,
        recommendation,
        probe_completeness: match metadata.completeness {
            ProbeCompleteness::Complete => MediaInventoryProbeCompleteness::Complete,
            ProbeCompleteness::Partial => MediaInventoryProbeCompleteness::Partial,
            ProbeCompleteness::FallbackRequired => {
                MediaInventoryProbeCompleteness::FallbackRequired
            }
        },
        cache_state,
    }
}

struct RankedAudioTrack {
    track: MediaInventoryAudioTrack,
    special: bool,
    language_rank: Option<usize>,
    original: bool,
    default: bool,
}

fn recommend_audio_tracks(
    metadata: &MediaInventoryProbeMetadata,
    preferred_languages: &[String],
) -> (Vec<MediaInventoryAudioTrack>, MediaInventoryRecommendation) {
    if metadata.audio_streams.is_empty() {
        let mut reason_codes = vec![MediaInventoryRecommendationReasonCode::NoAudioTrack];
        if metadata.completeness == ProbeCompleteness::Partial {
            reason_codes.push(MediaInventoryRecommendationReasonCode::MetadataIncomplete);
        }
        return (
            Vec::new(),
            MediaInventoryRecommendation {
                state: MediaInventoryRecommendationState::Unavailable,
                stream_index: None,
                reason_codes,
            },
        );
    }

    let non_special_count = metadata
        .audio_streams
        .iter()
        .filter(|stream| !is_special_purpose_stream(stream))
        .count();
    let mut ranked = metadata
        .audio_streams
        .iter()
        .map(|stream| {
            let language_rank = stream.language.as_deref().and_then(|language| {
                preferred_languages
                    .iter()
                    .position(|preferred| preferred.eq_ignore_ascii_case(language))
            });
            let special = is_special_purpose_stream(stream);
            let mut reason_codes = Vec::new();
            if non_special_count == 1 && !special {
                reason_codes.push(MediaInventoryRecommendationReasonCode::OnlyNonSpecialTrack);
            }
            if language_rank.is_some() {
                reason_codes.push(MediaInventoryRecommendationReasonCode::PreferredLanguage);
            }
            if stream.dispositions.is_original {
                reason_codes.push(MediaInventoryRecommendationReasonCode::OriginalDisposition);
            }
            if stream.dispositions.is_default {
                reason_codes.push(MediaInventoryRecommendationReasonCode::DefaultDispositionHint);
            }
            if stream.dispositions.is_commentary {
                reason_codes.push(MediaInventoryRecommendationReasonCode::CommentaryDisposition);
            }
            if stream.commentary_title_hint {
                reason_codes.push(MediaInventoryRecommendationReasonCode::CommentaryTitleHint);
            }
            if stream.dispositions.is_descriptions {
                reason_codes.push(MediaInventoryRecommendationReasonCode::DescriptionsDisposition);
            }
            if stream.dispositions.is_visual_impaired {
                reason_codes
                    .push(MediaInventoryRecommendationReasonCode::VisualImpairedDisposition);
            }
            if stream.dispositions.is_hearing_impaired {
                reason_codes
                    .push(MediaInventoryRecommendationReasonCode::HearingImpairedDisposition);
            }
            if stream.dispositions.is_clean_effects || stream.dispositions.is_karaoke {
                reason_codes.push(MediaInventoryRecommendationReasonCode::AuxiliaryDisposition);
            }
            if metadata.completeness == ProbeCompleteness::Partial
                || stream.codec_name.is_none()
                || stream.sample_rate.is_none()
                || stream.channels.is_none()
            {
                reason_codes.push(MediaInventoryRecommendationReasonCode::MetadataIncomplete);
            }
            RankedAudioTrack {
                track: MediaInventoryAudioTrack {
                    stream_index: stream.stream_index,
                    codec_name: stream.codec_name.clone(),
                    language: stream.language.clone(),
                    title: stream.title.clone(),
                    sample_rate: stream.sample_rate,
                    channels: stream.channels,
                    channel_layout: stream.channel_layout.clone(),
                    duration_ms: stream.duration_ms,
                    dispositions: MediaInventoryAudioDispositions {
                        is_default: stream.dispositions.is_default,
                        is_original: stream.dispositions.is_original,
                        is_dub: stream.dispositions.is_dub,
                        is_commentary: stream.dispositions.is_commentary,
                        is_descriptions: stream.dispositions.is_descriptions,
                        is_visual_impaired: stream.dispositions.is_visual_impaired,
                        is_hearing_impaired: stream.dispositions.is_hearing_impaired,
                        is_clean_effects: stream.dispositions.is_clean_effects,
                        is_karaoke: stream.dispositions.is_karaoke,
                    },
                    recommendation_rank: 0,
                    reason_codes,
                },
                special,
                language_rank,
                original: stream.dispositions.is_original,
                default: stream.dispositions.is_default,
            }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        (
            left.special,
            left.language_rank.unwrap_or(usize::MAX),
            !left.original,
            !left.default,
            std::cmp::Reverse(left.track.channels.unwrap_or(0)),
            std::cmp::Reverse(left.track.sample_rate.unwrap_or(0)),
            left.track.stream_index,
        )
            .cmp(&(
                right.special,
                right.language_rank.unwrap_or(usize::MAX),
                !right.original,
                !right.default,
                std::cmp::Reverse(right.track.channels.unwrap_or(0)),
                std::cmp::Reverse(right.track.sample_rate.unwrap_or(0)),
                right.track.stream_index,
            ))
    });
    for index in 0..ranked.len() {
        let has_semantic_peer = ranked.iter().enumerate().any(|(other_index, other)| {
            index != other_index
                && ranked[index].special == other.special
                && ranked[index].language_rank == other.language_rank
                && ranked[index].original == other.original
                && ranked[index].default == other.default
        });
        if has_semantic_peer {
            ranked[index]
                .track
                .reason_codes
                .push(MediaInventoryRecommendationReasonCode::TechnicalTieBreak);
        }
        ranked[index].track.recommendation_rank = u32::try_from(index + 1).unwrap_or(u32::MAX);
    }

    let eligible = ranked
        .iter()
        .filter(|candidate| non_special_count == 0 || !candidate.special)
        .collect::<Vec<_>>();
    let metadata_incomplete = metadata.completeness == ProbeCompleteness::Partial;
    let recommendation = if metadata_incomplete {
        MediaInventoryRecommendation {
            state: MediaInventoryRecommendationState::NeedsChoice,
            stream_index: None,
            reason_codes: vec![MediaInventoryRecommendationReasonCode::MetadataIncomplete],
        }
    } else if non_special_count == 0 {
        let reasons = vec![MediaInventoryRecommendationReasonCode::AllTracksSpecialPurpose];
        MediaInventoryRecommendation {
            state: MediaInventoryRecommendationState::NeedsChoice,
            stream_index: None,
            reason_codes: reasons,
        }
    } else {
        let winner = eligible[0];
        let uniquely_strong = eligible.len() == 1
            || eligible.get(1).is_some_and(|runner_up| {
                (winner.language_rank, winner.original)
                    != (runner_up.language_rank, runner_up.original)
                    && (winner.language_rank.is_some() || winner.original)
            });
        if uniquely_strong {
            let mut reasons = Vec::new();
            if non_special_count == 1 {
                reasons.push(MediaInventoryRecommendationReasonCode::OnlyNonSpecialTrack);
            }
            if winner.language_rank.is_some() {
                reasons.push(MediaInventoryRecommendationReasonCode::PreferredLanguage);
            }
            if winner.original {
                reasons.push(MediaInventoryRecommendationReasonCode::OriginalDisposition);
            }
            MediaInventoryRecommendation {
                state: MediaInventoryRecommendationState::Recommended,
                stream_index: Some(winner.track.stream_index),
                reason_codes: reasons,
            }
        } else {
            let reasons = vec![MediaInventoryRecommendationReasonCode::EquivalentCandidate];
            MediaInventoryRecommendation {
                state: MediaInventoryRecommendationState::NeedsChoice,
                stream_index: None,
                reason_codes: reasons,
            }
        }
    };
    let mut audio_tracks = ranked
        .into_iter()
        .map(|candidate| candidate.track)
        .collect::<Vec<_>>();
    audio_tracks.sort_by_key(|track| track.stream_index);
    (audio_tracks, recommendation)
}

fn is_special_purpose_stream(
    stream: &crate::media_probe::MediaInventoryAudioStreamMetadata,
) -> bool {
    stream.dispositions.is_commentary
        || stream.commentary_title_hint
        || stream.dispositions.is_descriptions
        || stream.dispositions.is_visual_impaired
        || stream.dispositions.is_hearing_impaired
        || stream.dispositions.is_clean_effects
        || stream.dispositions.is_karaoke
}

fn estimate_metadata_payload_bytes(metadata: &MediaInventoryProbeMetadata) -> usize {
    let mut bytes = std::mem::size_of::<MediaInventoryProbeMetadata>();
    for stream in &metadata.audio_streams {
        bytes = bytes
            .saturating_add(std::mem::size_of_val(stream))
            .saturating_add(stream.codec_name.as_ref().map(String::len).unwrap_or(0))
            .saturating_add(stream.channel_layout.as_ref().map(String::len).unwrap_or(0))
            .saturating_add(stream.language.as_ref().map(String::len).unwrap_or(0))
            .saturating_add(stream.title.as_ref().map(String::len).unwrap_or(0));
    }
    bytes
}

fn record_terminal_error(
    slot: &Mutex<Option<MediaInventoryTerminalError>>,
    error: MediaInventoryTerminalError,
) {
    let mut slot = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if slot.is_none() {
        *slot = Some(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_probe::{
        MediaInventoryAudioDispositions as ProbeDispositions, MediaInventoryAudioStreamMetadata,
        MediaInventoryProbeCompleteness as ProbeCompleteness, MediaInventoryProbeMetadata,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    struct FixedProbeFactory {
        metadata: MediaInventoryProbeMetadata,
        probe_count: Arc<AtomicUsize>,
    }

    #[test]
    fn unc_inventory_input_is_rejected_before_metadata_lookup() {
        let error = prepare_physical_input(r"\\untrusted.invalid\share\video.mkv", 0)
            .err().expect("UNC must be rejected before probing");
        assert!(matches!(error.code, MediaInventoryItemErrorCode::UnsupportedSource));
        assert!(error.message.contains("网络共享"));
    }

    impl FixedProbeFactory {
        fn new(metadata: MediaInventoryProbeMetadata) -> Self {
            Self {
                metadata,
                probe_count: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl MediaInventoryProbeFactory for FixedProbeFactory {
        fn prepare(
            &self,
            _ffprobe_path: Option<&str>,
            _ffmpeg_path: Option<&str>,
        ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
            Ok(Arc::new(FixedPreparedProbe {
                metadata: self.metadata.clone(),
                probe_count: Arc::clone(&self.probe_count),
            }))
        }
    }

    struct FixedPreparedProbe {
        metadata: MediaInventoryProbeMetadata,
        probe_count: Arc<AtomicUsize>,
    }

    impl PreparedMediaInventoryProbe for FixedPreparedProbe {
        fn tool_stamp(&self) -> u64 {
            7
        }

        fn probe(
            &self,
            _path: &Path,
            _cancel_flag: &AtomicBool,
        ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError> {
            self.probe_count.fetch_add(1, Ordering::AcqRel);
            Ok(self.metadata.clone())
        }
    }

    struct BlockingProbeFactory {
        entered: Arc<AtomicUsize>,
        active: Arc<AtomicUsize>,
        error_code: MediaInventoryItemErrorCode,
    }

    impl BlockingProbeFactory {
        fn new(_metadata: MediaInventoryProbeMetadata) -> Self {
            Self {
                entered: Arc::new(AtomicUsize::new(0)),
                active: Arc::new(AtomicUsize::new(0)),
                error_code: MediaInventoryItemErrorCode::ProbeFailed,
            }
        }

        fn cleanup_fault() -> Self {
            Self {
                entered: Arc::new(AtomicUsize::new(0)),
                active: Arc::new(AtomicUsize::new(0)),
                error_code: MediaInventoryItemErrorCode::ProcessCleanupFault,
            }
        }
    }

    impl MediaInventoryProbeFactory for BlockingProbeFactory {
        fn prepare(
            &self,
            _ffprobe_path: Option<&str>,
            _ffmpeg_path: Option<&str>,
        ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
            Ok(Arc::new(BlockingPreparedProbe {
                entered: Arc::clone(&self.entered),
                active: Arc::clone(&self.active),
                error_code: self.error_code,
            }))
        }
    }

    struct BlockingPreparedProbe {
        entered: Arc<AtomicUsize>,
        active: Arc<AtomicUsize>,
        error_code: MediaInventoryItemErrorCode,
    }

    impl PreparedMediaInventoryProbe for BlockingPreparedProbe {
        fn tool_stamp(&self) -> u64 {
            11
        }

        fn probe(
            &self,
            _path: &Path,
            cancel_flag: &AtomicBool,
        ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError> {
            self.entered.fetch_add(1, Ordering::AcqRel);
            self.active.fetch_add(1, Ordering::AcqRel);
            while !cancel_flag.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(2));
            }
            self.active.fetch_sub(1, Ordering::AcqRel);
            Err(item_error(
                self.error_code,
                "受控探测在取消后返回测试错误。",
            ))
        }
    }

    struct BlockingPrepareFailureFactory {
        entered: Arc<AtomicBool>,
        release: Arc<AtomicBool>,
    }

    impl BlockingPrepareFailureFactory {
        fn new() -> Self {
            Self {
                entered: Arc::new(AtomicBool::new(false)),
                release: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    impl MediaInventoryProbeFactory for BlockingPrepareFailureFactory {
        fn prepare(
            &self,
            _ffprobe_path: Option<&str>,
            _ffmpeg_path: Option<&str>,
        ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
            self.entered.store(true, Ordering::Release);
            while !self.release.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(2));
            }
            Err(item_error(
                MediaInventoryItemErrorCode::ProbeFailed,
                "受控 prepare 失败。",
            ))
        }
    }

    struct ConcurrentProbeFactory {
        metadata: MediaInventoryProbeMetadata,
        probe_count: Arc<AtomicUsize>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
        delay: Duration,
    }

    impl ConcurrentProbeFactory {
        fn new(metadata: MediaInventoryProbeMetadata, delay: Duration) -> Self {
            Self {
                metadata,
                probe_count: Arc::new(AtomicUsize::new(0)),
                active: Arc::new(AtomicUsize::new(0)),
                max_active: Arc::new(AtomicUsize::new(0)),
                delay,
            }
        }
    }

    impl MediaInventoryProbeFactory for ConcurrentProbeFactory {
        fn prepare(
            &self,
            _ffprobe_path: Option<&str>,
            _ffmpeg_path: Option<&str>,
        ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
            Ok(Arc::new(ConcurrentPreparedProbe {
                metadata: self.metadata.clone(),
                probe_count: Arc::clone(&self.probe_count),
                active: Arc::clone(&self.active),
                max_active: Arc::clone(&self.max_active),
                delay: self.delay,
            }))
        }
    }

    struct ConcurrentPreparedProbe {
        metadata: MediaInventoryProbeMetadata,
        probe_count: Arc<AtomicUsize>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
        delay: Duration,
    }

    impl PreparedMediaInventoryProbe for ConcurrentPreparedProbe {
        fn tool_stamp(&self) -> u64 {
            13
        }

        fn probe(
            &self,
            _path: &Path,
            cancel_flag: &AtomicBool,
        ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError> {
            if cancel_flag.load(Ordering::Acquire) {
                return Err(item_error(
                    MediaInventoryItemErrorCode::ProbeFailed,
                    "探测已取消。",
                ));
            }
            self.probe_count.fetch_add(1, Ordering::AcqRel);
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.max_active.fetch_max(active, Ordering::AcqRel);
            thread::sleep(self.delay);
            self.active.fetch_sub(1, Ordering::AcqRel);
            Ok(self.metadata.clone())
        }
    }

    struct FlakyProbeFactory {
        metadata: MediaInventoryProbeMetadata,
        fail: Arc<AtomicBool>,
        probe_count: Arc<AtomicUsize>,
    }

    impl FlakyProbeFactory {
        fn new(metadata: MediaInventoryProbeMetadata) -> Self {
            Self {
                metadata,
                fail: Arc::new(AtomicBool::new(false)),
                probe_count: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl MediaInventoryProbeFactory for FlakyProbeFactory {
        fn prepare(
            &self,
            _ffprobe_path: Option<&str>,
            _ffmpeg_path: Option<&str>,
        ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
            Ok(Arc::new(FlakyPreparedProbe {
                metadata: self.metadata.clone(),
                fail: Arc::clone(&self.fail),
                probe_count: Arc::clone(&self.probe_count),
            }))
        }
    }

    struct FlakyPreparedProbe {
        metadata: MediaInventoryProbeMetadata,
        fail: Arc<AtomicBool>,
        probe_count: Arc<AtomicUsize>,
    }

    impl PreparedMediaInventoryProbe for FlakyPreparedProbe {
        fn tool_stamp(&self) -> u64 {
            17
        }

        fn probe(
            &self,
            _path: &Path,
            _cancel_flag: &AtomicBool,
        ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError> {
            self.probe_count.fetch_add(1, Ordering::AcqRel);
            if self.fail.load(Ordering::Acquire) {
                Err(item_error(
                    MediaInventoryItemErrorCode::ProbeFailed,
                    "测试探测失败；路径已隐藏。",
                ))
            } else {
                Ok(self.metadata.clone())
            }
        }
    }

    #[derive(Default)]
    struct ProductionProbeObservation {
        probe_count: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
        elapsed_ms: Mutex<Vec<u64>>,
    }

    struct ObservedProductionProbeFactory {
        observation: Arc<ProductionProbeObservation>,
    }

    impl MediaInventoryProbeFactory for ObservedProductionProbeFactory {
        fn prepare(
            &self,
            ffprobe_path: Option<&str>,
            ffmpeg_path: Option<&str>,
        ) -> Result<Arc<dyn PreparedMediaInventoryProbe>, MediaInventoryItemError> {
            let probe = MediaInventoryMetadataProbe::prepare(ffprobe_path, ffmpeg_path)
                .map_err(map_probe_error)?;
            Ok(Arc::new(ObservedProductionPreparedProbe {
                probe,
                observation: Arc::clone(&self.observation),
            }))
        }
    }

    struct ObservedProductionPreparedProbe {
        probe: MediaInventoryMetadataProbe,
        observation: Arc<ProductionProbeObservation>,
    }

    impl PreparedMediaInventoryProbe for ObservedProductionPreparedProbe {
        fn tool_stamp(&self) -> u64 {
            self.probe.tool_stamp()
        }

        fn probe(
            &self,
            path: &Path,
            cancel_flag: &AtomicBool,
        ) -> Result<MediaInventoryProbeMetadata, MediaInventoryItemError> {
            self.observation.probe_count.fetch_add(1, Ordering::AcqRel);
            let active = self.observation.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.observation
                .max_active
                .fetch_max(active, Ordering::AcqRel);
            let started = Instant::now();
            let result = self.probe.probe(path, cancel_flag).map_err(map_probe_error);
            self.observation.active.fetch_sub(1, Ordering::AcqRel);
            self.observation
                .elapsed_ms
                .lock()
                .unwrap()
                .push(started.elapsed().as_millis() as u64);
            result
        }
    }

    struct TempMediaFile {
        path: PathBuf,
    }

    impl TempMediaFile {
        fn new(label: &str, bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "media-inventory-{label}-{}-{}.mkv",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::write(&path, bytes).expect("write media fixture");
            Self { path }
        }
    }

    impl Drop for TempMediaFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    fn one_track_metadata() -> MediaInventoryProbeMetadata {
        MediaInventoryProbeMetadata {
            duration_ms: Some(20_000),
            audio_streams: vec![MediaInventoryAudioStreamMetadata {
                stream_index: 1,
                codec_name: Some("aac".to_string()),
                duration_ms: Some(20_000),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: Some("stereo".to_string()),
                language: Some("jpn".to_string()),
                title: Some("Main".to_string()),
                dispositions: ProbeDispositions {
                    is_default: true,
                    is_original: true,
                    is_dub: false,
                    is_commentary: false,
                    is_descriptions: false,
                    is_visual_impaired: false,
                    is_hearing_impaired: false,
                    is_clean_effects: false,
                    is_karaoke: false,
                },
                commentary_title_hint: false,
            }],
            completeness: ProbeCompleteness::Complete,
        }
    }

    fn request_for(path: &Path) -> MediaInventoryRequest {
        MediaInventoryRequest {
            schema_version: 1,
            items: vec![MediaInventoryRequestItem {
                item_id: "target-1".to_string(),
                path: path.to_string_lossy().into_owned(),
            }],
            ffprobe_path: None,
            ffmpeg_path: None,
            preferred_languages: vec!["jpn".to_string()],
            cache_policy: MediaInventoryCachePolicy::ReuseFresh,
        }
    }

    fn request_for_paths(
        paths: &[PathBuf],
        preferred_languages: &[&str],
        cache_policy: MediaInventoryCachePolicy,
    ) -> MediaInventoryRequest {
        MediaInventoryRequest {
            schema_version: 1,
            items: paths
                .iter()
                .enumerate()
                .map(|(index, path)| MediaInventoryRequestItem {
                    item_id: format!("item-{index}"),
                    path: path.to_string_lossy().into_owned(),
                })
                .collect(),
            ffprobe_path: None,
            ffmpeg_path: None,
            preferred_languages: preferred_languages
                .iter()
                .map(|language| (*language).to_string())
                .collect(),
            cache_policy,
        }
    }

    fn wait_for_terminal(
        runtime: &MediaInventoryRuntime,
        job_id: &str,
    ) -> MediaInventoryJobSnapshot {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = runtime.get_job(job_id).expect("get inventory job");
            if snapshot.status.is_terminal() {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "inventory job did not finish");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn registry_job_completes_one_item_with_an_explainable_recommendation() {
        let media = TempMediaFile::new("single", b"metadata fixture");
        let factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let started = runtime
            .start_job(request_for(&media.path))
            .expect("start job");
        assert_eq!(started.status, MediaInventoryJobStatus::Queued);
        let terminal = wait_for_terminal(&runtime, &started.job_id);

        assert_eq!(terminal.status, MediaInventoryJobStatus::Completed);
        assert_eq!(terminal.counts.ready, 1);
        let result = terminal.items[0].result.as_ref().expect("ready result");
        assert_eq!(result.cache_state, MediaInventoryCacheState::Miss);
        assert_eq!(
            result.recommendation,
            MediaInventoryRecommendation {
                state: MediaInventoryRecommendationState::Recommended,
                stream_index: Some(1),
                reason_codes: vec![
                    MediaInventoryRecommendationReasonCode::OnlyNonSpecialTrack,
                    MediaInventoryRecommendationReasonCode::PreferredLanguage,
                    MediaInventoryRecommendationReasonCode::OriginalDisposition,
                ],
            }
        );
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 1);
    }

    #[test]
    fn default_and_technical_ordering_never_create_false_automatic_confidence() {
        let media = TempMediaFile::new("weak-evidence", b"two audio tracks");
        let mut metadata = one_track_metadata();
        metadata.audio_streams[0].dispositions.is_original = false;
        metadata
            .audio_streams
            .push(MediaInventoryAudioStreamMetadata {
                stream_index: 2,
                codec_name: Some("flac".to_string()),
                duration_ms: Some(20_000),
                sample_rate: Some(96_000),
                channels: Some(6),
                channel_layout: Some("5.1".to_string()),
                language: Some("eng".to_string()),
                title: Some("Second".to_string()),
                dispositions: ProbeDispositions {
                    is_default: false,
                    is_original: false,
                    is_dub: false,
                    is_commentary: false,
                    is_descriptions: false,
                    is_visual_impaired: false,
                    is_hearing_impaired: false,
                    is_clean_effects: false,
                    is_karaoke: false,
                },
                commentary_title_hint: false,
            });
        let runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(FixedProbeFactory::new(metadata)),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );
        let mut request = request_for(&media.path);
        request.preferred_languages.clear();

        let started = runtime.start_job(request).unwrap();
        let result = wait_for_terminal(&runtime, &started.job_id).items[0]
            .result
            .clone()
            .unwrap();

        assert_eq!(
            result.recommendation.state,
            MediaInventoryRecommendationState::NeedsChoice
        );
        assert_eq!(result.recommendation.stream_index, None);
        assert_eq!(
            result.recommendation.reason_codes,
            vec![MediaInventoryRecommendationReasonCode::EquivalentCandidate]
        );
        assert_eq!(result.audio_tracks[0].stream_index, 1);
        assert!(result.audio_tracks[0]
            .reason_codes
            .contains(&MediaInventoryRecommendationReasonCode::DefaultDispositionHint));
    }

    #[test]
    fn commentary_and_accessibility_tracks_are_retained_but_ranked_below_main_audio() {
        let media = TempMediaFile::new("special-tracks", b"special audio tracks");
        let mut metadata = one_track_metadata();
        metadata.audio_streams[0].stream_index = 3;
        metadata.audio_streams[0].dispositions.is_default = false;
        metadata.audio_streams[0].dispositions.is_original = false;
        metadata
            .audio_streams
            .push(MediaInventoryAudioStreamMetadata {
                stream_index: 1,
                codec_name: Some("aac".to_string()),
                duration_ms: Some(20_000),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: Some("stereo".to_string()),
                language: Some("jpn".to_string()),
                title: Some("Director Commentary".to_string()),
                dispositions: ProbeDispositions {
                    is_default: true,
                    is_original: false,
                    is_dub: false,
                    is_commentary: true,
                    is_descriptions: false,
                    is_visual_impaired: false,
                    is_hearing_impaired: false,
                    is_clean_effects: false,
                    is_karaoke: false,
                },
                commentary_title_hint: true,
            });
        metadata
            .audio_streams
            .push(MediaInventoryAudioStreamMetadata {
                stream_index: 2,
                codec_name: Some("aac".to_string()),
                duration_ms: Some(20_000),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: Some("stereo".to_string()),
                language: Some("jpn".to_string()),
                title: Some("Audio Description".to_string()),
                dispositions: ProbeDispositions {
                    is_default: false,
                    is_original: false,
                    is_dub: false,
                    is_commentary: false,
                    is_descriptions: true,
                    is_visual_impaired: true,
                    is_hearing_impaired: false,
                    is_clean_effects: false,
                    is_karaoke: false,
                },
                commentary_title_hint: false,
            });
        let runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(FixedProbeFactory::new(metadata)),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let started = runtime.start_job(request_for(&media.path)).unwrap();
        let result = wait_for_terminal(&runtime, &started.job_id).items[0]
            .result
            .clone()
            .unwrap();

        assert_eq!(result.audio_tracks.len(), 3);
        assert_eq!(
            result
                .audio_tracks
                .iter()
                .map(|track| track.stream_index)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(
            result
                .audio_tracks
                .iter()
                .map(|track| track.recommendation_rank)
                .collect::<Vec<_>>(),
            vec![2, 3, 1]
        );
        assert_eq!(result.recommendation.stream_index, Some(3));
        assert!(result.audio_tracks[0]
            .reason_codes
            .contains(&MediaInventoryRecommendationReasonCode::CommentaryDisposition));
        assert!(result.audio_tracks[1]
            .reason_codes
            .contains(&MediaInventoryRecommendationReasonCode::DescriptionsDisposition));
    }

    #[test]
    fn one_bad_path_does_not_fail_other_inventory_items_or_disclose_paths() {
        let media = TempMediaFile::new("good-item", b"good media");
        let missing = media.path.with_file_name("sensitive-missing-name.mkv");
        let runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(FixedProbeFactory::new(one_track_metadata())),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let started = runtime
            .start_job(request_for_paths(
                &[media.path.clone(), missing.clone()],
                &["jpn"],
                MediaInventoryCachePolicy::ReuseFresh,
            ))
            .unwrap();
        let terminal = wait_for_terminal(&runtime, &started.job_id);

        assert_eq!(terminal.status, MediaInventoryJobStatus::Completed);
        assert_eq!(terminal.counts.ready, 1);
        assert_eq!(terminal.counts.failed, 1);
        assert_eq!(
            terminal.items[1].error.as_ref().unwrap().code,
            MediaInventoryItemErrorCode::FileNotFound
        );
        let serialized = serde_json::to_string(&terminal).unwrap();
        assert!(!serialized.contains("sensitive-missing-name"));
        assert!(!serialized.contains(&media.path.to_string_lossy().into_owned()));
    }

    #[test]
    fn single_active_and_cancel_are_monotonic_idempotent_and_wait_for_probe_exit() {
        let media = TempMediaFile::new("cancel", b"blocking probe");
        let factory = Arc::new(BlockingProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let started = runtime.start_job(request_for(&media.path)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while factory.entered.load(Ordering::Acquire) == 0 {
            assert!(Instant::now() < deadline, "blocking probe did not start");
            thread::sleep(Duration::from_millis(2));
        }
        let busy = runtime.start_job(request_for(&media.path)).unwrap_err();
        assert_eq!(busy.code, MediaInventoryCommandErrorCode::InventoryBusy);

        let first_cancel = runtime.cancel_job(&started.job_id).unwrap();
        assert!(first_cancel.cancel_requested);
        let repeated_cancel = runtime.cancel_job(&started.job_id).unwrap();
        assert_eq!(repeated_cancel.sequence, first_cancel.sequence);

        let terminal = wait_for_terminal(&runtime, &started.job_id);
        assert_eq!(terminal.status, MediaInventoryJobStatus::Cancelled);
        assert_eq!(terminal.counts.cancelled, 1);
        assert_eq!(factory.active.load(Ordering::Acquire), 0);
        let terminal_cancel = runtime.cancel_job(&started.job_id).unwrap();
        assert_eq!(terminal_cancel, terminal);
    }

    #[test]
    fn accepted_cancel_cannot_hide_an_active_probe_cleanup_fault() {
        let media = TempMediaFile::new("cancel-cleanup-fault", b"blocking cleanup fault");
        let factory = Arc::new(BlockingProbeFactory::cleanup_fault());
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(1, 512, 16 * 1024 * 1024),
        );

        let started = runtime.start_job(request_for(&media.path)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while factory.entered.load(Ordering::Acquire) == 0 {
            assert!(
                Instant::now() < deadline,
                "cleanup-fault probe did not start"
            );
            thread::sleep(Duration::from_millis(2));
        }
        let accepted = runtime.cancel_job(&started.job_id).unwrap();
        assert!(accepted.cancel_requested);

        let terminal = wait_for_terminal(&runtime, &started.job_id);
        assert_eq!(terminal.status, MediaInventoryJobStatus::Failed);
        assert_eq!(
            terminal.terminal_error.as_ref().map(|error| error.code),
            Some(MediaInventoryTerminalErrorCode::ProcessCleanupFault)
        );
        assert_eq!(
            terminal.items[0].status,
            MediaInventoryItemStatus::Cancelled
        );
        assert_eq!(factory.active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn accepted_cancel_wins_over_a_late_ordinary_prepare_failure() {
        let media = TempMediaFile::new("cancel-prepare-race", b"prepare barrier");
        let factory = Arc::new(BlockingPrepareFailureFactory::new());
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(1, 512, 16 * 1024 * 1024),
        );

        let started = runtime.start_job(request_for(&media.path)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !factory.entered.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "prepare barrier was not entered");
            thread::sleep(Duration::from_millis(2));
        }
        runtime.cancel_job(&started.job_id).unwrap();
        factory.release.store(true, Ordering::Release);

        let terminal = wait_for_terminal(&runtime, &started.job_id);
        assert_eq!(terminal.status, MediaInventoryJobStatus::Cancelled);
        assert_eq!(
            terminal.items[0].status,
            MediaInventoryItemStatus::Cancelled
        );
        assert_eq!(terminal.items[0].error, None);
    }

    #[test]
    fn accepted_cancel_wins_when_an_ordinary_group_failure_is_waiting_to_publish() {
        let media = TempMediaFile::new("cancel-group-race", b"group failure barrier");
        let factory = Arc::new(FlakyProbeFactory::new(one_track_metadata()));
        factory.fail.store(true, Ordering::Release);
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory,
            MediaInventoryRuntimeLimits::for_tests(1, 512, 16 * 1024 * 1024),
        )
        .with_failure_publish_barrier(MediaInventoryFailurePublishBarrier {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });

        let started = runtime.start_job(request_for(&media.path)).unwrap();
        entered.wait();
        runtime.cancel_job(&started.job_id).unwrap();
        release.wait();

        let terminal = wait_for_terminal(&runtime, &started.job_id);
        assert_eq!(terminal.status, MediaInventoryJobStatus::Cancelled);
        assert_eq!(
            terminal.items[0].status,
            MediaInventoryItemStatus::Cancelled
        );
        assert_eq!(terminal.items[0].error, None);
    }

    #[test]
    fn worker_pool_never_exceeds_four_concurrent_probes() {
        let files = (0..12)
            .map(|index| TempMediaFile::new(&format!("concurrency-{index}"), &[index as u8]))
            .collect::<Vec<_>>();
        let paths = files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        let factory = Arc::new(ConcurrentProbeFactory::new(
            one_track_metadata(),
            Duration::from_millis(30),
        ));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let started = runtime
            .start_job(request_for_paths(
                &paths,
                &[],
                MediaInventoryCachePolicy::ReuseFresh,
            ))
            .unwrap();
        let terminal = wait_for_terminal(&runtime, &started.job_id);

        assert_eq!(terminal.counts.ready, 12);
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 12);
        let max_active = factory.max_active.load(Ordering::Acquire);
        assert!(max_active > 1, "worker pool never ran concurrently");
        assert!(max_active <= 4, "observed {max_active} concurrent probes");
    }

    #[cfg(windows)]
    #[test]
    fn hard_link_aliases_are_probed_once_and_fanned_out() {
        let original = TempMediaFile::new("hardlink-original", b"one physical object");
        let hard_link = original.path.with_file_name(format!(
            "media-inventory-hardlink-alias-{}-{}.mkv",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::hard_link(&original.path, &hard_link).expect("create hard link alias");
        let factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let started = runtime
            .start_job(request_for_paths(
                &[original.path.clone(), hard_link.clone()],
                &["jpn"],
                MediaInventoryCachePolicy::ReuseFresh,
            ))
            .unwrap();
        let terminal = wait_for_terminal(&runtime, &started.job_id);

        assert_eq!(terminal.counts.ready, 2);
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 1);
        assert_eq!(
            terminal.items[0]
                .result
                .as_ref()
                .unwrap()
                .inventory_revision,
            terminal.items[1]
                .result
                .as_ref()
                .unwrap()
                .inventory_revision
        );
        fs::remove_file(hard_link).expect("remove hard link fixture");
    }

    #[test]
    fn fresh_and_stale_cache_states_reprobe_only_when_identity_stamp_changes() {
        let media = TempMediaFile::new("cache", b"first payload");
        let factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );

        let cold = runtime.start_job(request_for(&media.path)).unwrap();
        let cold = wait_for_terminal(&runtime, &cold.job_id);
        assert_eq!(
            cold.items[0].result.as_ref().unwrap().cache_state,
            MediaInventoryCacheState::Miss
        );
        let hot = runtime.start_job(request_for(&media.path)).unwrap();
        let hot = wait_for_terminal(&runtime, &hot.job_id);
        assert_eq!(
            hot.items[0].result.as_ref().unwrap().cache_state,
            MediaInventoryCacheState::Fresh
        );
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 1);

        fs::write(&media.path, b"second payload is a different size").expect("mutate fixture");
        let stale = runtime.start_job(request_for(&media.path)).unwrap();
        let stale = wait_for_terminal(&runtime, &stale.job_id);
        assert_eq!(
            stale.items[0].result.as_ref().unwrap().cache_state,
            MediaInventoryCacheState::Stale
        );
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 2);

        let mut refresh_request = request_for(&media.path);
        refresh_request.cache_policy = MediaInventoryCachePolicy::Refresh;
        let refreshed = runtime.start_job(refresh_request).unwrap();
        let refreshed = wait_for_terminal(&runtime, &refreshed.job_id);
        assert_eq!(
            refreshed.items[0].result.as_ref().unwrap().cache_state,
            MediaInventoryCacheState::Stale
        );
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 3);
    }

    #[test]
    fn cache_enforces_both_entry_and_payload_limits() {
        let first = TempMediaFile::new("lru-first", b"first");
        let second = TempMediaFile::new("lru-second", b"second");
        let factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(2, 1, 16 * 1024 * 1024),
        );
        for path in [&first.path, &second.path, &first.path] {
            let started = runtime.start_job(request_for(path)).unwrap();
            assert_eq!(
                wait_for_terminal(&runtime, &started.job_id).items[0]
                    .result
                    .as_ref()
                    .unwrap()
                    .cache_state,
                MediaInventoryCacheState::Miss
            );
        }
        assert_eq!(factory.probe_count.load(Ordering::Acquire), 3);

        let tiny_factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let tiny_runtime = MediaInventoryRuntime::with_dependencies(
            tiny_factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(2, 512, 1),
        );
        for _ in 0..2 {
            let started = tiny_runtime.start_job(request_for(&first.path)).unwrap();
            assert_eq!(
                wait_for_terminal(&tiny_runtime, &started.job_id).items[0]
                    .result
                    .as_ref()
                    .unwrap()
                    .cache_state,
                MediaInventoryCacheState::Miss
            );
        }
        assert_eq!(tiny_factory.probe_count.load(Ordering::Acquire), 2);
    }

    #[test]
    fn request_bounds_accept_one_four_and_256_but_reject_257_and_duplicate_ids() {
        let media = TempMediaFile::new("request-bounds", b"same physical file");
        let factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory,
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );
        for item_count in [1usize, 4, 256] {
            let paths = vec![media.path.clone(); item_count];
            let started = runtime
                .start_job(request_for_paths(
                    &paths,
                    &[],
                    MediaInventoryCachePolicy::ReuseFresh,
                ))
                .expect("accepted request size");
            let terminal = wait_for_terminal(&runtime, &started.job_id);
            assert_eq!(terminal.items.len(), item_count);
            assert_eq!(terminal.counts.ready as usize, item_count);
        }

        let too_many = vec![media.path.clone(); 257];
        let error = runtime
            .start_job(request_for_paths(
                &too_many,
                &[],
                MediaInventoryCachePolicy::ReuseFresh,
            ))
            .unwrap_err();
        assert_eq!(error.code, MediaInventoryCommandErrorCode::InvalidRequest);

        let mut duplicate = request_for_paths(
            &[media.path.clone(), media.path.clone()],
            &[],
            MediaInventoryCachePolicy::ReuseFresh,
        );
        duplicate.items[1].item_id = duplicate.items[0].item_id.clone();
        let error = runtime.start_job(duplicate).unwrap_err();
        assert_eq!(error.code, MediaInventoryCommandErrorCode::InvalidRequest);
    }

    #[test]
    fn stale_probe_failure_never_falls_back_to_cached_metadata() {
        let media = TempMediaFile::new("stale-failure", b"original");
        let factory = Arc::new(FlakyProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory.clone(),
            MediaInventoryRuntimeLimits::for_tests(4, 512, 16 * 1024 * 1024),
        );
        let initial = runtime.start_job(request_for(&media.path)).unwrap();
        assert_eq!(wait_for_terminal(&runtime, &initial.job_id).counts.ready, 1);

        fs::write(&media.path, b"changed and longer payload").expect("mutate stale fixture");
        factory.fail.store(true, Ordering::Release);
        let failed = runtime.start_job(request_for(&media.path)).unwrap();
        let failed = wait_for_terminal(&runtime, &failed.job_id);

        assert_eq!(failed.status, MediaInventoryJobStatus::Completed);
        assert_eq!(failed.counts.failed, 1);
        assert!(failed.items[0].result.is_none());
        assert_eq!(
            failed.items[0].error.as_ref().unwrap().code,
            MediaInventoryItemErrorCode::ProbeFailed
        );
    }

    #[test]
    fn terminal_retention_evicts_only_the_oldest_completed_jobs() {
        let media = TempMediaFile::new("retention", b"retention fixture");
        let factory = Arc::new(FixedProbeFactory::new(one_track_metadata()));
        let runtime = MediaInventoryRuntime::with_dependencies(
            factory,
            MediaInventoryRuntimeLimits {
                worker_limit: 2,
                cache_entry_limit: 512,
                cache_payload_limit: 16 * 1024 * 1024,
                terminal_job_limit: 2,
            },
        );
        let mut job_ids = Vec::new();
        for _ in 0..3 {
            let started = runtime.start_job(request_for(&media.path)).unwrap();
            wait_for_terminal(&runtime, &started.job_id);
            job_ids.push(started.job_id);
        }

        assert_eq!(
            runtime.get_job(&job_ids[0]).unwrap_err().code,
            MediaInventoryCommandErrorCode::JobNotFound
        );
        assert!(runtime.get_job(&job_ids[1]).is_ok());
        assert!(runtime.get_job(&job_ids[2]).is_ok());
    }

    #[test]
    fn no_audio_and_all_special_audio_remain_fail_closed_for_recommendation() {
        let no_audio_media = TempMediaFile::new("no-audio", b"no audio");
        let mut no_audio = one_track_metadata();
        no_audio.audio_streams.clear();
        let no_audio_runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(FixedProbeFactory::new(no_audio)),
            MediaInventoryRuntimeLimits::for_tests(2, 512, 16 * 1024 * 1024),
        );
        let started = no_audio_runtime
            .start_job(request_for(&no_audio_media.path))
            .unwrap();
        let result = wait_for_terminal(&no_audio_runtime, &started.job_id).items[0]
            .result
            .clone()
            .unwrap();
        assert_eq!(
            result.recommendation.state,
            MediaInventoryRecommendationState::Unavailable
        );
        assert_eq!(
            result.recommendation.reason_codes,
            vec![MediaInventoryRecommendationReasonCode::NoAudioTrack]
        );

        let special_media = TempMediaFile::new("all-special", b"all special");
        let mut all_special = one_track_metadata();
        all_special.audio_streams[0].dispositions.is_commentary = true;
        let special_runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(FixedProbeFactory::new(all_special)),
            MediaInventoryRuntimeLimits::for_tests(2, 512, 16 * 1024 * 1024),
        );
        let started = special_runtime
            .start_job(request_for(&special_media.path))
            .unwrap();
        let result = wait_for_terminal(&special_runtime, &started.job_id).items[0]
            .result
            .clone()
            .unwrap();
        assert_eq!(
            result.recommendation.state,
            MediaInventoryRecommendationState::NeedsChoice
        );
        assert_eq!(result.recommendation.stream_index, None);
        assert_eq!(
            result.recommendation.reason_codes,
            vec![MediaInventoryRecommendationReasonCode::AllTracksSpecialPurpose]
        );
    }

    #[test]
    fn partial_probe_never_auto_recommends_even_a_single_visible_main_track() {
        let media = TempMediaFile::new("partial-metadata", b"partial metadata");
        let mut partial = one_track_metadata();
        partial.completeness = ProbeCompleteness::Partial;
        let runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(FixedProbeFactory::new(partial)),
            MediaInventoryRuntimeLimits::for_tests(2, 512, 16 * 1024 * 1024),
        );

        let started = runtime.start_job(request_for(&media.path)).unwrap();
        let result = wait_for_terminal(&runtime, &started.job_id).items[0]
            .result
            .clone()
            .unwrap();

        assert_eq!(
            result.recommendation.state,
            MediaInventoryRecommendationState::NeedsChoice
        );
        assert_eq!(result.recommendation.stream_index, None);
        assert_eq!(
            result.recommendation.reason_codes,
            vec![MediaInventoryRecommendationReasonCode::MetadataIncomplete]
        );
    }

    #[test]
    fn request_and_command_error_json_are_strict_camel_case_objects() {
        let request: MediaInventoryRequest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "items": [{"itemId": "one", "path": "episode.mkv"}],
            "ffprobePath": null,
            "ffmpegPath": null,
            "preferredLanguages": ["jpn"],
            "cachePolicy": "reuseFresh"
        }))
        .unwrap();
        assert_eq!(request.items[0].item_id, "one");
        assert!(
            serde_json::from_value::<MediaInventoryRequest>(serde_json::json!({
                "schemaVersion": 1,
                "items": [{"itemId": "one", "path": "episode.mkv"}],
                "unexpected": true
            }))
            .is_err()
        );

        assert_eq!(
            serde_json::to_value(command_error(
                MediaInventoryCommandErrorCode::InventoryBusy,
                "已有任务。"
            ))
            .unwrap(),
            serde_json::json!({"code": "inventoryBusy", "message": "已有任务。"})
        );
    }

    #[test]
    fn ready_snapshot_serialization_is_exact_and_path_free() {
        let snapshot = MediaInventoryJobSnapshot {
            schema_version: 1,
            job_id: "media-inventory-1".to_string(),
            status: MediaInventoryJobStatus::Completed,
            sequence: 4,
            cancel_requested: false,
            counts: MediaInventoryJobCounts {
                total: 1,
                queued: 0,
                probing: 0,
                ready: 1,
                failed: 0,
                cancelled: 0,
            },
            items: vec![MediaInventoryItemSnapshot {
                ordinal: 0,
                item_id: "target-1".to_string(),
                status: MediaInventoryItemStatus::Ready,
                result: Some(MediaInventoryItemResult {
                    inventory_revision: "inventory-v1:0000000000000007".to_string(),
                    duration_ms: Some(12_500),
                    audio_tracks: vec![MediaInventoryAudioTrack {
                        stream_index: 7,
                        codec_name: Some("aac".to_string()),
                        language: Some("eng".to_string()),
                        title: Some("Main".to_string()),
                        sample_rate: Some(48_000),
                        channels: Some(2),
                        channel_layout: Some("stereo".to_string()),
                        duration_ms: Some(12_345),
                        dispositions: MediaInventoryAudioDispositions {
                            is_default: true,
                            is_original: true,
                            is_dub: false,
                            is_commentary: false,
                            is_descriptions: false,
                            is_visual_impaired: false,
                            is_hearing_impaired: false,
                            is_clean_effects: false,
                            is_karaoke: false,
                        },
                        recommendation_rank: 1,
                        reason_codes: vec![
                            MediaInventoryRecommendationReasonCode::OnlyNonSpecialTrack,
                            MediaInventoryRecommendationReasonCode::OriginalDisposition,
                            MediaInventoryRecommendationReasonCode::DefaultDispositionHint,
                        ],
                    }],
                    recommendation: MediaInventoryRecommendation {
                        state: MediaInventoryRecommendationState::Recommended,
                        stream_index: Some(7),
                        reason_codes: vec![
                            MediaInventoryRecommendationReasonCode::OnlyNonSpecialTrack,
                            MediaInventoryRecommendationReasonCode::OriginalDisposition,
                        ],
                    },
                    probe_completeness: MediaInventoryProbeCompleteness::Complete,
                    cache_state: MediaInventoryCacheState::Miss,
                }),
                error: None,
            }],
            terminal_error: None,
        };

        let serialized = serde_json::to_value(snapshot).expect("serialize inventory snapshot");
        assert_eq!(
            serialized,
            serde_json::json!({
                "schemaVersion": 1,
                "jobId": "media-inventory-1",
                "status": "completed",
                "sequence": 4,
                "cancelRequested": false,
                "counts": {
                    "total": 1,
                    "queued": 0,
                    "probing": 0,
                    "ready": 1,
                    "failed": 0,
                    "cancelled": 0
                },
                "items": [{
                    "ordinal": 0,
                    "itemId": "target-1",
                    "status": "ready",
                    "result": {
                        "inventoryRevision": "inventory-v1:0000000000000007",
                        "durationMs": 12500,
                        "audioTracks": [{
                            "index": 7,
                            "codec": "aac",
                            "language": "eng",
                            "title": "Main",
                            "sampleRate": 48000,
                            "channels": 2,
                            "channelLayout": "stereo",
                            "durationMs": 12345,
                            "dispositions": {
                                "default": true,
                                "original": true,
                                "dub": false,
                                "commentary": false,
                                "descriptions": false,
                                "visualImpaired": false,
                                "hearingImpaired": false,
                                "cleanEffects": false,
                                "karaoke": false
                            },
                            "recommendationRank": 1,
                            "reasonCodes": [
                                "onlyNonSpecialTrack",
                                "originalDisposition",
                                "defaultDispositionHint"
                            ]
                        }],
                        "recommendation": {
                            "state": "recommended",
                            "streamIndex": 7,
                            "reasonCodes": [
                                "onlyNonSpecialTrack",
                                "originalDisposition"
                            ]
                        },
                        "probeCompleteness": "complete",
                        "cacheState": "miss"
                    },
                    "error": null
                }],
                "terminalError": null
            })
        );
        let serialized_text = serialized.to_string();
        for forbidden in ["path", "contentIdentity", "provenance", "digest"] {
            assert!(!serialized_text.contains(forbidden));
        }
    }

    #[test]
    fn start_rejects_an_empty_batch_with_a_structured_error() {
        let runtime = MediaInventoryRuntime::new_for_test();
        let error = runtime
            .start_job(MediaInventoryRequest {
                schema_version: MEDIA_INVENTORY_SCHEMA_VERSION,
                items: Vec::new(),
                ffprobe_path: None,
                ffmpeg_path: None,
                preferred_languages: Vec::new(),
                cache_policy: MediaInventoryCachePolicy::ReuseFresh,
            })
            .expect_err("empty inventory request must fail");

        assert_eq!(error.code, MediaInventoryCommandErrorCode::InvalidRequest);
        assert_eq!(error.message, "媒体清单必须包含 1 到 256 个素材项。");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires installed ffmpeg/ffprobe and records the CP2 performance baseline"]
    fn generated_container_cold_hot_and_physical_dedupe_performance_baseline() {
        let ffmpeg = crate::process_supervision::resolve_supervised_executable("ffmpeg")
            .unwrap_or_else(|_| panic!("CP2 performance test requires an installed ffmpeg"));
        let ffprobe = crate::process_supervision::resolve_supervised_executable("ffprobe")
            .unwrap_or_else(|_| panic!("CP2 performance test requires an installed ffprobe"));
        let fixtures = (0..24)
            .map(|index| {
                let fixture = TempMediaFile::new(&format!("perf-{index}"), b"");
                let source = format!(
                    "sine=frequency={}:sample_rate=48000:duration=0.15",
                    300 + index * 11
                );
                let status = Command::new(&ffmpeg)
                    .args([
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                    ])
                    .arg(source)
                    .args(["-c:a", "pcm_s16le"])
                    .arg(&fixture.path)
                    .status()
                    .expect("generate performance container");
                assert!(status.success(), "ffmpeg fixture generation failed");
                fixture
            })
            .collect::<Vec<_>>();
        let paths = fixtures
            .iter()
            .map(|fixture| fixture.path.clone())
            .collect::<Vec<_>>();
        let ffprobe_path = ffprobe.to_string_lossy().into_owned();
        let request = || {
            let mut request = request_for_paths(
                &paths,
                &["jpn", "eng"],
                MediaInventoryCachePolicy::ReuseFresh,
            );
            request.ffprobe_path = Some(ffprobe_path.clone());
            request
        };

        let mut cold_wall_ms = Vec::new();
        let mut cold_first_ready_ms = Vec::new();
        let mut cold_probe_ms = Vec::new();
        let mut observed_max_active = 0usize;
        for _ in 0..5 {
            let observation = Arc::new(ProductionProbeObservation::default());
            let runtime = MediaInventoryRuntime::with_dependencies(
                Arc::new(ObservedProductionProbeFactory {
                    observation: Arc::clone(&observation),
                }),
                MediaInventoryRuntimeLimits::production(),
            );
            let (wall_ms, first_ready_ms, terminal) = run_timed_inventory_job(&runtime, request());
            assert_eq!(terminal.counts.ready, 24);
            assert_eq!(observation.probe_count.load(Ordering::Acquire), 24);
            observed_max_active =
                observed_max_active.max(observation.max_active.load(Ordering::Acquire));
            cold_wall_ms.push(wall_ms);
            cold_first_ready_ms.push(first_ready_ms);
            cold_probe_ms.extend(observation.elapsed_ms.lock().unwrap().iter().copied());
        }

        let hot_observation = Arc::new(ProductionProbeObservation::default());
        let hot_runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(ObservedProductionProbeFactory {
                observation: Arc::clone(&hot_observation),
            }),
            MediaInventoryRuntimeLimits::production(),
        );
        let (_, _, warm) = run_timed_inventory_job(&hot_runtime, request());
        assert_eq!(warm.counts.ready, 24);
        assert_eq!(hot_observation.probe_count.load(Ordering::Acquire), 24);
        let mut hot_wall_ms = Vec::new();
        let mut hot_first_ready_ms = Vec::new();
        for _ in 0..5 {
            let (wall_ms, first_ready_ms, terminal) =
                run_timed_inventory_job(&hot_runtime, request());
            assert_eq!(terminal.counts.ready, 24);
            assert!(terminal.items.iter().all(|item| {
                item.result
                    .as_ref()
                    .is_some_and(|result| result.cache_state == MediaInventoryCacheState::Fresh)
            }));
            hot_wall_ms.push(wall_ms);
            hot_first_ready_ms.push(first_ready_ms);
        }
        assert_eq!(
            hot_observation.probe_count.load(Ordering::Acquire),
            24,
            "hot runs must spawn zero additional probes"
        );

        let mut aliases = Vec::new();
        for (index, original) in paths.iter().take(6).enumerate() {
            let alias = original.with_file_name(format!(
                "media-inventory-perf-hardlink-{index}-{}-{}.mkv",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::hard_link(original, &alias).expect("create performance hardlink");
            aliases.push(alias);
        }
        let mut dedupe_paths = paths.iter().take(6).cloned().collect::<Vec<_>>();
        dedupe_paths.extend(aliases.iter().cloned());
        let dedupe_observation = Arc::new(ProductionProbeObservation::default());
        let dedupe_runtime = MediaInventoryRuntime::with_dependencies(
            Arc::new(ObservedProductionProbeFactory {
                observation: Arc::clone(&dedupe_observation),
            }),
            MediaInventoryRuntimeLimits::production(),
        );
        let mut dedupe_request =
            request_for_paths(&dedupe_paths, &[], MediaInventoryCachePolicy::ReuseFresh);
        dedupe_request.ffprobe_path = Some(ffprobe_path);
        let (_, _, dedupe_terminal) = run_timed_inventory_job(&dedupe_runtime, dedupe_request);
        assert_eq!(dedupe_terminal.counts.ready, 12);
        assert_eq!(dedupe_observation.probe_count.load(Ordering::Acquire), 6);
        for alias in aliases {
            fs::remove_file(alias).expect("remove performance hardlink");
        }

        let cold_median = percentile(&cold_wall_ms, 50);
        let hot_median = percentile(&hot_wall_ms, 50);
        assert!(hot_median <= 250, "hot median was {hot_median} ms");
        assert!(
            hot_median.saturating_mul(5) <= cold_median,
            "hot median {hot_median} ms exceeded 20% of cold median {cold_median} ms"
        );
        assert!(observed_max_active <= 4);
        println!(
            "CP2_PERF coldWallMs={cold_wall_ms:?} coldFirstReadyMs={cold_first_ready_ms:?} hotWallMs={hot_wall_ms:?} hotFirstReadyMs={hot_first_ready_ms:?} perItemP50Ms={} perItemP95Ms={} coldSpawnEach=24 hotAdditionalSpawn=0 dedupeSpawn=6 maxInFlight={observed_max_active}",
            percentile(&cold_probe_ms, 50),
            percentile(&cold_probe_ms, 95)
        );
    }

    #[cfg(windows)]
    fn run_timed_inventory_job(
        runtime: &MediaInventoryRuntime,
        request: MediaInventoryRequest,
    ) -> (u64, u64, MediaInventoryJobSnapshot) {
        let started_at = Instant::now();
        let started = runtime.start_job(request).expect("start timed inventory");
        let mut first_ready_ms = None;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let snapshot = runtime
                .get_job(&started.job_id)
                .expect("poll timed inventory");
            if first_ready_ms.is_none() && snapshot.counts.ready > 0 {
                first_ready_ms = Some(started_at.elapsed().as_millis() as u64);
            }
            if snapshot.status.is_terminal() {
                let wall_ms = started_at.elapsed().as_millis() as u64;
                return (wall_ms, first_ready_ms.unwrap_or(wall_ms), snapshot);
            }
            assert!(
                Instant::now() < deadline,
                "timed inventory exceeded 30 seconds"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn percentile(values: &[u64], percentile: usize) -> u64 {
        assert!(!values.is_empty());
        let mut sorted = values.to_vec();
        sorted.sort_unstable();
        let index = (sorted.len() - 1).saturating_mul(percentile).div_ceil(100);
        sorted[index.min(sorted.len() - 1)]
    }
}
