//! Alignment V2 的纯算法核心。
//!
//! 本模块不读取媒体文件、不依赖 Tauri，也不修改项目状态。调用方负责把媒体解码为 PCM
//! 或细粒度特征，并根据真实素材基准决定是否采用结果。本模块的测试只验证合成信号下的
//! 数学性质，不代表真实媒体已经达到产品精度门槛。

use crate::cuda_fft_backend::{
    probe_cuda_fft_capability, CudaFftBatchErrorCode, CudaFftR2c512Session, CUDA_FFT_BACKEND_ID,
    CUDA_FFT_BINS_PER_FRAME, CUDA_FFT_DEFAULT_BATCH_FRAMES, CUDA_FFT_FRAME_LEN,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BinaryHeap, HashMap, HashSet, VecDeque},
    sync::atomic::{AtomicBool, Ordering},
};

const SPECTRAL_BIN_COUNT: usize = 48;
const FINE_SPECTRAL_BAND_COUNT: usize = 12;
const LANDMARK_DELTA_QUANTUM_MS: i64 = 50;
const LANDMARK_DELTA_MASK: u64 = 0xff;
pub const AFFINE_COARSE_MAX_MODEL_SEEDS: usize = 768;
const MAX_MODEL_SEEDS: usize = AFFINE_COARSE_MAX_MODEL_SEEDS;
const MAX_OBSERVATIONS: usize = 40_000;
pub(crate) const AFFINE_HOLDOUT_TIME_BLOCK_MS: i64 = 1_000;
// Long-form media can contain only a few dozen collision-resistant landmark correspondences over
// thousands of one-second blocks. A 32-block cap frequently sampled no true correspondence at
// all, then exposed only distant same-hash collisions as "held-out anchors". Keep the pre-fit,
// deterministic 20% partition but allow enough uniformly distributed blocks to intersect sparse
// real support on media up to roughly 90 minutes.
const MAX_AFFINE_HOLDOUT_TIME_BLOCKS: usize = 1_024;
const AFFINE_HOLDOUT_CONSENSUS_TIME_BUCKET_MS: i64 = 5_000;
const AFFINE_HOLDOUT_CONSENSUS_TIME_RADIUS_BUCKETS: i64 = 2;
const AFFINE_HOLDOUT_CONSENSUS_OFFSET_QUANTUM_MS: i64 = 250;
const AFFINE_HOLDOUT_CONSENSUS_EVIDENCE_TIME_QUANTUM_MS: i64 = 1_000;
const AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT: usize = 3;
const MAX_STREAMING_HASH_OCCURRENCES_PER_FAMILY: usize = 16_384;
const MAX_STREAMING_RETAINED_LANDMARKS: usize = 262_144;
const MAX_STREAMING_WINDOW_SAMPLES: usize = 65_536;
const MAX_STREAMING_PENDING_ANCHOR_FRAMES: usize = 4_096;
const COST_INFINITY: i64 = i64::MAX / 16;
const STATE_MATCHED: u8 = 0;
const STATE_SOURCE_ONLY: u8 = 1;
const STATE_TARGET_ONLY: u8 = 2;
const STATE_NONE: u8 = u8::MAX;
const EDIT_DP_NORM_CANCEL_INTERVAL: usize = 256;
const EDIT_DP_WIDE_LOOP_CANCEL_INTERVAL: usize = 4_096;
// A single 50 ms log-spectrum frame is not distinctive enough for television dialogue: unrelated
// frames can retain a high cosine similarity because every log-energy band is positive. Average
// the diagonal cost over a 250 ms context (the current frame plus two neighbours on each side).
// This keeps edit-boundary uncertainty local to 100 ms while preventing an accidental cheap frame
// from certifying a long false match.
const EDIT_DP_CONTEXT_RADIUS_FRAMES: usize = 2;
const ALIGNMENT_V2_CANCELLED: &str = "Alignment V2 算法已取消。";
pub const CPU_SPECTRAL_BACKEND_ID: &str = "cpu-radix2-f64-r2c-512-v1";
pub const STREAMING_CPU_SPECTRAL_BACKEND_ID: &str = "cpu-streaming-radix2-f64-r2c-512-v1";
pub const STREAMING_HYBRID_SPECTRAL_BACKEND_ID: &str =
    "cuda-cufft-r2c-512+cpu-streaming-radix2-f64-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpectralBackendPreference {
    Auto,
    Cpu,
    Cuda,
}

impl SpectralBackendPreference {
    fn label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
        }
    }
}

/// A resolved backend request is created before cache lookup. `planned_backend_id` is safe to
/// use for that lookup; the extraction result still reports the backend that actually completed
/// the work, so an auto-mode CUDA runtime failure can publish only under the CPU cache key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpectralBackendRequest {
    preference: SpectralBackendPreference,
    pub planned_backend_id: String,
    pub requested_backend: String,
    pub backend_detail: String,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpectralBackendExecution {
    pub backend_id: String,
    pub requested_backend: String,
    pub backend_detail: String,
    pub fallback_reason: Option<String>,
}

/// Resolves the process-level production policy without claiming that a transform has run.
/// Tests default to CPU for determinism. Production defaults to auto and uses CUDA only after a
/// real context + cuFFT smoke transform succeeds. Explicit CUDA is fail-closed.
pub fn resolve_spectral_backend_request() -> Result<SpectralBackendRequest, String> {
    let preference = spectral_backend_preference_from_environment()?;
    resolve_spectral_backend_preference(preference)
}

fn spectral_backend_preference_from_environment() -> Result<SpectralBackendPreference, String> {
    if std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1") {
        return Ok(SpectralBackendPreference::Cuda);
    }
    if let Ok(value) = std::env::var("C137_SPECTRAL_BACKEND") {
        return match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(SpectralBackendPreference::Auto),
            "cpu" => Ok(SpectralBackendPreference::Cpu),
            "cuda" => Ok(SpectralBackendPreference::Cuda),
            _ => Err(format!(
                "blocked:spectral-backend-config：C137_SPECTRAL_BACKEND 仅支持 auto、cpu 或 cuda，当前值为 {value:?}。"
            )),
        };
    }
    if cfg!(test) {
        Ok(SpectralBackendPreference::Cpu)
    } else {
        Ok(SpectralBackendPreference::Auto)
    }
}

pub fn resolve_spectral_backend_preference(
    preference: SpectralBackendPreference,
) -> Result<SpectralBackendRequest, String> {
    match preference {
        SpectralBackendPreference::Cpu => Ok(SpectralBackendRequest {
            preference,
            planned_backend_id: CPU_SPECTRAL_BACKEND_ID.to_string(),
            requested_backend: preference.label().to_string(),
            backend_detail: "CPU radix-2 f64 FFT".to_string(),
            fallback_reason: None,
        }),
        SpectralBackendPreference::Auto | SpectralBackendPreference::Cuda => {
            let capability = probe_cuda_fft_capability(0);
            if capability.available {
                Ok(SpectralBackendRequest {
                    preference,
                    planned_backend_id: CUDA_FFT_BACKEND_ID.to_string(),
                    requested_backend: preference.label().to_string(),
                    backend_detail: format!(
                        "CUDA/cuFFT device #0 {}; bindings={}; driverLibrary={}; cufftLibrary={}; driverRuntime={}; cufftRuntime={}",
                        capability
                            .selected_device_name
                            .as_deref()
                            .unwrap_or("未命名 NVIDIA GPU"),
                        capability.bindings_version,
                        capability.driver_library_name.as_deref().unwrap_or("unknown"),
                        capability.cufft_library_name.as_deref().unwrap_or("unknown"),
                        capability
                            .driver_runtime_version
                            .map_or_else(|| "unknown".to_string(), |version| version.to_string()),
                        capability
                            .cufft_runtime_version
                            .map_or_else(|| "unknown".to_string(), |version| version.to_string())
                    ),
                    fallback_reason: None,
                })
            } else if preference == SpectralBackendPreference::Cuda {
                Err(format!(
                    "blocked:cuda-fft-unavailable：已强制 CUDA 声谱后端，但能力探测失败：{}",
                    capability.reason
                ))
            } else {
                Ok(SpectralBackendRequest {
                    preference,
                    planned_backend_id: CPU_SPECTRAL_BACKEND_ID.to_string(),
                    requested_backend: preference.label().to_string(),
                    backend_detail: "CPU radix-2 f64 FFT".to_string(),
                    fallback_reason: Some(format!(
                        "CUDA 能力探测未就绪，自动回退 CPU：{}",
                        capability.reason
                    )),
                })
            }
        }
    }
}

/// Lock bounded fine extraction to the backend identity that completed coarse extraction.
///
/// A coarse CUDA result makes fine CUDA mandatory, so a later runtime fault is fail-closed instead
/// of producing a mixed coarse/fine artifact. CPU and hybrid streaming results lock fine work to
/// CPU. The original request label and fallback reason remain visible in the fine execution
/// identity for diagnostics and receipt binding.
pub fn lock_fine_spectral_backend_request(
    coarse_execution: &SpectralBackendExecution,
) -> Result<SpectralBackendRequest, String> {
    let (preference, planned_backend_id, backend_detail) = match coarse_execution.backend_id.as_str()
    {
        CUDA_FFT_BACKEND_ID => (
            SpectralBackendPreference::Cuda,
            CUDA_FFT_BACKEND_ID.to_string(),
            coarse_execution.backend_detail.clone(),
        ),
        CPU_SPECTRAL_BACKEND_ID
        | STREAMING_CPU_SPECTRAL_BACKEND_ID
        | STREAMING_HYBRID_SPECTRAL_BACKEND_ID => (
            SpectralBackendPreference::Cpu,
            CPU_SPECTRAL_BACKEND_ID.to_string(),
            format!(
                "CPU radix-2 f64 FFT; fineBackendLock=cpu-after-coarse; coarseBackend={}; coarseDetail={}",
                coarse_execution.backend_id, coarse_execution.backend_detail
            ),
        ),
        backend_id => {
            return Err(format!(
                "blocked:spectral-backend-continuity：无法从未知 coarse 声谱后端 {backend_id:?} 锁定 fine 后端。"
            ));
        }
    };
    Ok(SpectralBackendRequest {
        preference,
        planned_backend_id,
        requested_backend: coarse_execution.requested_backend.clone(),
        backend_detail,
        fallback_reason: coarse_execution.fallback_reason.clone(),
    })
}

#[cfg(test)]
thread_local! {
    static TEST_SPECTRUM_CALCULATION_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn check_algorithm_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(ALIGNMENT_V2_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandmarkConfig {
    pub sample_rate: u32,
    pub presentation_offset_ms: i64,
    pub window_ms: u32,
    pub hop_ms: u32,
    pub silence_rms: f64,
    pub min_peak_ratio: f64,
    pub max_peaks_per_frame: usize,
    pub fanout: usize,
    pub min_pair_delta_ms: i64,
    pub max_pair_delta_ms: i64,
    pub max_hash_occurrences: usize,
}

impl Default for LandmarkConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            presentation_offset_ms: 0,
            window_ms: 40,
            hop_ms: 25,
            silence_rms: 0.008,
            min_peak_ratio: 2.25,
            max_peaks_per_frame: 4,
            fanout: 5,
            min_pair_delta_ms: 75,
            max_pair_delta_ms: 1_000,
            max_hash_occurrences: 48,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralLandmark {
    pub hash: u64,
    pub time_ms: i64,
    pub strength_milli: u32,
}

pub const COARSE_SPECTRAL_FINGERPRINT_BANDS: usize = 12;
const COARSE_SPECTRAL_FINGERPRINT_INTERVAL_MS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoarseSpectralFingerprintFrame {
    pub time_ms: i64,
    pub values: [u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    pub active_ratio_milli: u16,
    #[serde(default)]
    pub log_rms_milli: u16,
}

#[derive(Debug, Clone)]
struct SpectralPeak {
    bin: usize,
    magnitude: f64,
}

#[derive(Debug)]
struct StreamingSpectralFrame {
    frame_index: usize,
    spectrum: Vec<f64>,
    active: bool,
    rms: f64,
}

#[derive(Debug)]
struct StreamingAnchorPeak {
    bin: usize,
    magnitude: f64,
    emitted: usize,
}

#[derive(Debug)]
struct StreamingAnchorFrame {
    time_ms: i64,
    peaks: Vec<StreamingAnchorPeak>,
}

struct StreamingCudaBatch {
    session: CudaFftR2c512Session,
    input_frames: Vec<f32>,
    source_frames: Vec<i16>,
    frame_indices: Vec<usize>,
    frame_rms: Vec<f64>,
    completed_frame_count: usize,
}

enum StreamingSpectralProcessor {
    Cpu,
    Cuda(StreamingCudaBatch),
}

impl std::fmt::Debug for StreamingSpectralProcessor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cpu => formatter.write_str("Cpu"),
            Self::Cuda(batch) => formatter
                .debug_struct("Cuda")
                .field("pending_frames", &batch.frame_indices.len())
                .field("completed_frame_count", &batch.completed_frame_count)
                .finish(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingLandmarkExtraction {
    pub index: MediaCoarseIndexResult,
    pub coarse_fingerprint: Vec<CoarseSpectralFingerprintFrame>,
    pub spectral_backend: SpectralBackendExecution,
}

#[derive(Debug)]
struct CoarseFamilySample {
    seen: u64,
    retained: BinaryHeap<RankedLandmark>,
}

#[derive(Debug)]
struct RankedLandmark {
    priority: u64,
    ordinal: u64,
    landmark: SpectralLandmark,
}

impl PartialEq for RankedLandmark {
    fn eq(&self, other: &Self) -> bool {
        (self.priority, self.ordinal) == (other.priority, other.ordinal)
    }
}

impl Eq for RankedLandmark {}

impl PartialOrd for RankedLandmark {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for RankedLandmark {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.priority, self.ordinal).cmp(&(other.priority, other.ordinal))
    }
}

/// `MediaCoarseIndex` 的确定性、有界 common-family 抑制结果。
///
/// 当 `capped_family_count == 0` 时，结果与 one-shot extractor 逐项等价。一个 family
/// 超过 `max_hash_occurrences` 后，流式索引保留确定性 priority 最小的 M 个真实候选；
/// 因而每个超限 family 的输出数仍严格等于 M、不会合成候选，且与 one-shot 均匀抽样
/// 的对称差严格不超过 `2 * M`。该退化规范换取与媒体时长无关的常量内存。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaCoarseIndexResult {
    pub landmarks: Vec<SpectralLandmark>,
    pub observed_landmark_count: u64,
    pub retained_landmark_count: usize,
    pub capped_family_count: usize,
    pub exact_one_shot_equivalent: bool,
    pub max_symmetric_difference_per_capped_family: usize,
}

/// 按 landmark family 建立的有界粗索引。合法 landmark 只有 48×48 个 family，
/// 每个 family 最多驻留 `max_hash_occurrences` 个候选。
#[derive(Debug)]
pub struct MediaCoarseIndex {
    max_hash_occurrences: usize,
    observed_landmark_count: u64,
    retained_landmark_count: usize,
    families: HashMap<u64, CoarseFamilySample>,
}

impl MediaCoarseIndex {
    pub fn new(max_hash_occurrences: usize) -> Result<Self, String> {
        if !(1..=MAX_STREAMING_HASH_OCCURRENCES_PER_FAMILY).contains(&max_hash_occurrences) {
            return Err(format!(
                "MediaCoarseIndex 的 family 保留上限必须位于 1–{MAX_STREAMING_HASH_OCCURRENCES_PER_FAMILY}。"
            ));
        }
        Ok(Self {
            max_hash_occurrences,
            observed_landmark_count: 0,
            retained_landmark_count: 0,
            families: HashMap::new(),
        })
    }

    pub fn push(&mut self, landmark: SpectralLandmark) -> Result<(), String> {
        validate_streaming_landmark_hash(landmark.hash)?;
        self.observed_landmark_count = self
            .observed_landmark_count
            .checked_add(1)
            .ok_or_else(|| "MediaCoarseIndex landmark 计数溢出。".to_string())?;
        let family = landmark_family(landmark.hash);
        if !self.families.contains_key(&family) {
            self.families
                .try_reserve(1)
                .map_err(|error| format!("MediaCoarseIndex 无法为新 family 保留内存：{error}"))?;
            self.families.insert(
                family,
                CoarseFamilySample {
                    seen: 0,
                    retained: BinaryHeap::new(),
                },
            );
        }
        let sample = self
            .families
            .get_mut(&family)
            .ok_or_else(|| "MediaCoarseIndex family 创建后丢失。".to_string())?;
        let ordinal = sample.seen;
        sample.seen = sample
            .seen
            .checked_add(1)
            .ok_or_else(|| "MediaCoarseIndex family 计数溢出。".to_string())?;
        let ranked = RankedLandmark {
            priority: streaming_landmark_priority(family, ordinal),
            ordinal,
            landmark,
        };
        if sample.retained.len() < self.max_hash_occurrences {
            if self.retained_landmark_count >= MAX_STREAMING_RETAINED_LANDMARKS {
                return Err(format!(
                    "MediaCoarseIndex 驻留 landmark 超过全局上限 {MAX_STREAMING_RETAINED_LANDMARKS}。"
                ));
            }
            sample
                .retained
                .try_reserve(1)
                .map_err(|error| format!("MediaCoarseIndex 无法为 landmark 保留内存：{error}"))?;
            sample.retained.push(ranked);
            self.retained_landmark_count = self
                .retained_landmark_count
                .checked_add(1)
                .ok_or_else(|| "MediaCoarseIndex 驻留 landmark 计数溢出。".to_string())?;
            return Ok(());
        }
        if sample
            .retained
            .peek()
            .is_some_and(|largest| ranked < *largest)
        {
            let _ = sample.retained.pop();
            sample.retained.push(ranked);
        }
        Ok(())
    }

    pub fn finish(self) -> Result<MediaCoarseIndexResult, String> {
        let capped_family_count = self
            .families
            .values()
            .filter(|sample| sample.seen > self.max_hash_occurrences as u64)
            .count();
        let mut landmarks = Vec::new();
        landmarks
            .try_reserve_exact(self.retained_landmark_count)
            .map_err(|error| format!("MediaCoarseIndex 无法为结果保留内存：{error}"))?;
        for sample in self.families.into_values() {
            landmarks.extend(
                sample
                    .retained
                    .into_vec()
                    .into_iter()
                    .map(|item| item.landmark),
            );
        }
        sort_landmarks_canonically(&mut landmarks);
        Ok(MediaCoarseIndexResult {
            retained_landmark_count: landmarks.len(),
            landmarks,
            observed_landmark_count: self.observed_landmark_count,
            capped_family_count,
            exact_one_shot_equivalent: capped_family_count == 0,
            max_symmetric_difference_per_capped_family: if capped_family_count == 0 {
                0
            } else {
                self.max_hash_occurrences.saturating_mul(2)
            },
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn retained_landmark_count(&self) -> usize {
        self.retained_landmark_count
    }
}

/// 流式 extractor 当前驻留状态，供长媒体调用方和测试验证内存边界。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct StreamingLandmarkStateUsage {
    pub stft_tail_samples: usize,
    pub pending_spectral_frames: usize,
    pub pending_cuda_input_samples: usize,
    pub temporal_spectrum_count: usize,
    pub pending_anchor_frames: usize,
    pub pending_anchor_peaks: usize,
    pub coarse_family_count: usize,
    pub retained_coarse_landmarks: usize,
}

/// 真正增量的 landmark extractor：PCM chunk 不需要与 STFT window/hop 对齐。
///
/// 状态只保留不足一个 window 的 PCM tail、temporal local maximum 所需的前一帧谱、
/// `max_pair_delta_ms` 窗口内尚未完成 fanout 的 anchors，以及有界 `MediaCoarseIndex`。
#[derive(Debug)]
pub struct StreamingLandmarkExtractor {
    config: LandmarkConfig,
    window_samples: usize,
    hop_samples: usize,
    stft_tail: Vec<i16>,
    next_frame_index: usize,
    previous_spectrum: Option<Vec<f64>>,
    pending_frame: Option<StreamingSpectralFrame>,
    pending_anchors: VecDeque<StreamingAnchorFrame>,
    coarse_index: MediaCoarseIndex,
    coarse_fingerprint: Vec<CoarseSpectralFingerprintFrame>,
    coarse_fingerprint_band_sums: [f64; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    coarse_fingerprint_log_rms_sum: f64,
    coarse_fingerprint_frame_count: usize,
    coarse_fingerprint_active_count: usize,
    coarse_fingerprint_first_time_ms: Option<i64>,
    spectral_processor: StreamingSpectralProcessor,
    spectral_backend: SpectralBackendExecution,
}

impl StreamingLandmarkExtractor {
    #[cfg(test)]
    pub fn new(config: LandmarkConfig) -> Result<Self, String> {
        let cpu_request = resolve_spectral_backend_preference(SpectralBackendPreference::Cpu)?;
        Self::new_with_backend_request(config, &cpu_request)
    }

    pub fn new_with_backend_request(
        config: LandmarkConfig,
        backend_request: &SpectralBackendRequest,
    ) -> Result<Self, String> {
        validate_landmark_config(&config)?;
        let window_samples = milliseconds_to_samples(config.window_ms as i64, config.sample_rate)?;
        let hop_samples = milliseconds_to_samples(config.hop_ms as i64, config.sample_rate)?;
        if window_samples < 8 || hop_samples == 0 || window_samples < hop_samples {
            return Err("StreamingLandmarkExtractor 的 STFT 网格无效。".to_string());
        }
        if window_samples > MAX_STREAMING_WINDOW_SAMPLES {
            return Err(format!(
                "StreamingLandmarkExtractor 的 STFT window 超过 {MAX_STREAMING_WINDOW_SAMPLES} 个样本的驻留上限。"
            ));
        }
        let max_pending_anchor_frames = usize::try_from(config.max_pair_delta_ms)
            .map_err(|_| "StreamingLandmarkExtractor 配对窗口无法表示。".to_string())?
            .div_ceil(config.hop_ms as usize)
            .checked_add(2)
            .ok_or_else(|| "StreamingLandmarkExtractor pending anchor 上限溢出。".to_string())?;
        if max_pending_anchor_frames > MAX_STREAMING_PENDING_ANCHOR_FRAMES {
            return Err(format!(
                "StreamingLandmarkExtractor pending anchor frame 上限超过 {MAX_STREAMING_PENDING_ANCHOR_FRAMES}。"
            ));
        }
        let coarse_index = MediaCoarseIndex::new(config.max_hash_occurrences)?;
        let mut stft_tail = Vec::new();
        stft_tail
            .try_reserve_exact(window_samples)
            .map_err(|error| {
                format!("StreamingLandmarkExtractor 无法为 STFT tail 保留内存：{error}")
            })?;
        let (spectral_processor, spectral_backend) =
            create_streaming_spectral_processor(&config, window_samples, backend_request)?;
        Ok(Self {
            config,
            window_samples,
            hop_samples,
            stft_tail,
            next_frame_index: 0,
            previous_spectrum: None,
            pending_frame: None,
            pending_anchors: VecDeque::new(),
            coarse_index,
            coarse_fingerprint: Vec::new(),
            coarse_fingerprint_band_sums: [0.0; COARSE_SPECTRAL_FINGERPRINT_BANDS],
            coarse_fingerprint_log_rms_sum: 0.0,
            coarse_fingerprint_frame_count: 0,
            coarse_fingerprint_active_count: 0,
            coarse_fingerprint_first_time_ms: None,
            spectral_processor,
            spectral_backend,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn push_pcm(&mut self, pcm: &[i16]) -> Result<(), String> {
        self.push_pcm_with_cancel(pcm, None)
    }

    pub fn push_pcm_with_cancel(
        &mut self,
        pcm: &[i16],
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        check_algorithm_cancelled(cancel_flag)?;
        let mut offset = 0usize;
        let mut processed_frames = 0usize;
        while offset < pcm.len() {
            let needed = self.window_samples.saturating_sub(self.stft_tail.len());
            let take = needed.min(pcm.len() - offset);
            self.stft_tail
                .extend_from_slice(&pcm[offset..offset + take]);
            offset += take;
            if self.stft_tail.len() == self.window_samples {
                self.process_complete_stft_frame(cancel_flag)?;
                self.stft_tail.drain(..self.hop_samples);
                processed_frames += 1;
                if processed_frames.is_multiple_of(64) {
                    check_algorithm_cancelled(cancel_flag)?;
                }
            }
        }
        check_algorithm_cancelled(cancel_flag)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn finish(self) -> Result<MediaCoarseIndexResult, String> {
        self.finish_with_cancel(None)
    }

    pub fn finish_with_cancel(
        self,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<MediaCoarseIndexResult, String> {
        self.finish_with_backend_and_cancel(cancel_flag)
            .map(|extraction| extraction.index)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn finish_with_backend(self) -> Result<StreamingLandmarkExtraction, String> {
        self.finish_with_backend_and_cancel(None)
    }

    pub fn finish_with_backend_and_cancel(
        mut self,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<StreamingLandmarkExtraction, String> {
        check_algorithm_cancelled(cancel_flag)?;
        self.flush_pending_cuda_batch(cancel_flag)?;
        if let Some(pending) = self.pending_frame.take() {
            let peaks = extract_spectral_peaks(
                &pending.spectrum,
                pending.active,
                self.previous_spectrum.as_deref(),
                None,
                &self.config,
            );
            self.consume_finalized_peaks(pending.frame_index, peaks)?;
        }
        self.flush_coarse_fingerprint_frame()?;
        check_algorithm_cancelled(cancel_flag)?;
        Ok(StreamingLandmarkExtraction {
            index: self.coarse_index.finish()?,
            coarse_fingerprint: self.coarse_fingerprint,
            spectral_backend: self.spectral_backend,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn spectral_backend(&self) -> &SpectralBackendExecution {
        &self.spectral_backend
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn state_usage(&self) -> StreamingLandmarkStateUsage {
        let (pending_spectral_frames, pending_cuda_input_samples) = match &self.spectral_processor {
            StreamingSpectralProcessor::Cpu => (0, 0),
            StreamingSpectralProcessor::Cuda(batch) => {
                (batch.frame_indices.len(), batch.input_frames.len())
            }
        };
        StreamingLandmarkStateUsage {
            stft_tail_samples: self.stft_tail.len(),
            pending_spectral_frames,
            pending_cuda_input_samples,
            temporal_spectrum_count: usize::from(self.previous_spectrum.is_some())
                + usize::from(self.pending_frame.is_some()),
            pending_anchor_frames: self.pending_anchors.len(),
            pending_anchor_peaks: self
                .pending_anchors
                .iter()
                .map(|frame| frame.peaks.len())
                .sum(),
            coarse_family_count: self.coarse_index.families.len(),
            retained_coarse_landmarks: self.coarse_index.retained_landmark_count(),
        }
    }

    fn process_complete_stft_frame(
        &mut self,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let frame_index = self.next_frame_index;
        self.next_frame_index = self
            .next_frame_index
            .checked_add(1)
            .ok_or_else(|| "StreamingLandmarkExtractor frame 计数溢出。".to_string())?;
        match &mut self.spectral_processor {
            StreamingSpectralProcessor::Cpu => {
                let rms = normalized_rms(&self.stft_tail);
                let current = StreamingSpectralFrame {
                    frame_index,
                    spectrum: calculate_spectrum(&self.stft_tail, self.config.sample_rate),
                    active: rms >= self.config.silence_rms,
                    rms,
                };
                self.consume_spectral_frame(current)?;
            }
            StreamingSpectralProcessor::Cuda(batch) => {
                enqueue_streaming_cuda_frame(
                    batch,
                    &self.stft_tail,
                    frame_index,
                    self.config.sample_rate,
                )?;
                if batch.frame_indices.len() >= CUDA_FFT_DEFAULT_BATCH_FRAMES {
                    self.flush_pending_cuda_batch(cancel_flag)?;
                }
            }
        }
        Ok(())
    }

    fn consume_spectral_frame(&mut self, current: StreamingSpectralFrame) -> Result<(), String> {
        self.consume_coarse_fingerprint_spectrum(&current)?;
        if let Some(pending) = self.pending_frame.take() {
            let peaks = extract_spectral_peaks(
                &pending.spectrum,
                pending.active,
                self.previous_spectrum.as_deref(),
                Some(&current.spectrum),
                &self.config,
            );
            self.consume_finalized_peaks(pending.frame_index, peaks)?;
            self.previous_spectrum = Some(pending.spectrum);
        }
        self.pending_frame = Some(current);
        Ok(())
    }

    fn consume_coarse_fingerprint_spectrum(
        &mut self,
        frame: &StreamingSpectralFrame,
    ) -> Result<(), String> {
        let frame_time_ms = landmark_frame_time_ms(
            frame.frame_index,
            self.hop_samples,
            self.window_samples,
            &self.config,
        )?;
        if self.coarse_fingerprint_first_time_ms.is_none() {
            self.coarse_fingerprint_first_time_ms = Some(frame_time_ms);
        }
        self.coarse_fingerprint_frame_count = self.coarse_fingerprint_frame_count.saturating_add(1);
        self.coarse_fingerprint_log_rms_sum += quantize_log_rms_milli(frame.rms) as f64;
        if frame.active && !frame.spectrum.is_empty() {
            let mut band_values = [0.0_f64; COARSE_SPECTRAL_FINGERPRINT_BANDS];
            for (index, magnitude) in frame.spectrum.iter().copied().enumerate() {
                let band =
                    index.saturating_mul(COARSE_SPECTRAL_FINGERPRINT_BANDS) / frame.spectrum.len();
                let band = band.min(COARSE_SPECTRAL_FINGERPRINT_BANDS - 1);
                band_values[band] += magnitude.max(0.0).ln_1p();
            }
            let total = band_values.iter().sum::<f64>();
            if total > f64::EPSILON {
                for (destination, value) in self
                    .coarse_fingerprint_band_sums
                    .iter_mut()
                    .zip(band_values)
                {
                    *destination += value / total;
                }
                self.coarse_fingerprint_active_count =
                    self.coarse_fingerprint_active_count.saturating_add(1);
            }
        }
        let frames_per_output = COARSE_SPECTRAL_FINGERPRINT_INTERVAL_MS
            .div_ceil(self.config.hop_ms as usize)
            .max(1);
        if self.coarse_fingerprint_frame_count >= frames_per_output {
            self.flush_coarse_fingerprint_frame()?;
        }
        Ok(())
    }

    fn flush_coarse_fingerprint_frame(&mut self) -> Result<(), String> {
        if self.coarse_fingerprint_frame_count == 0 {
            return Ok(());
        }
        let mut values = [0_u8; COARSE_SPECTRAL_FINGERPRINT_BANDS];
        if self.coarse_fingerprint_active_count > 0 {
            let total = self.coarse_fingerprint_band_sums.iter().sum::<f64>();
            if total > f64::EPSILON {
                for (destination, value) in values.iter_mut().zip(self.coarse_fingerprint_band_sums)
                {
                    *destination = (value / total * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        let active_ratio_milli = self
            .coarse_fingerprint_active_count
            .saturating_mul(1_000)
            .checked_div(self.coarse_fingerprint_frame_count)
            .unwrap_or(0)
            .min(1_000) as u16;
        let log_rms_milli = (self.coarse_fingerprint_log_rms_sum
            / self.coarse_fingerprint_frame_count as f64)
            .round()
            .clamp(0.0, 12_000.0) as u16;
        let interval_ms = i64::try_from(
            self.coarse_fingerprint_frame_count
                .saturating_sub(1)
                .saturating_mul(self.config.hop_ms as usize)
                / 2,
        )
        .map_err(|_| "StreamingLandmarkExtractor 粗声谱指纹时间无法表示。".to_string())?;
        self.coarse_fingerprint
            .push(CoarseSpectralFingerprintFrame {
                time_ms: self
                    .coarse_fingerprint_first_time_ms
                    .unwrap_or(self.config.presentation_offset_ms)
                    .saturating_add(interval_ms),
                values,
                active_ratio_milli,
                log_rms_milli,
            });
        self.coarse_fingerprint_band_sums = [0.0; COARSE_SPECTRAL_FINGERPRINT_BANDS];
        self.coarse_fingerprint_log_rms_sum = 0.0;
        self.coarse_fingerprint_frame_count = 0;
        self.coarse_fingerprint_active_count = 0;
        self.coarse_fingerprint_first_time_ms = None;
        Ok(())
    }

    fn flush_pending_cuda_batch(&mut self, cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
        check_algorithm_cancelled(cancel_flag)?;
        let forced_cuda = self.spectral_backend.requested_backend == "cuda";
        let sample_rate = self.config.sample_rate;
        let silence_rms = self.config.silence_rms;
        let window_samples = self.window_samples;
        let local_cancellation = AtomicBool::new(false);
        let cancellation = cancel_flag.unwrap_or(&local_cancellation);

        enum FlushOutcome {
            Nothing,
            Cuda(Vec<StreamingSpectralFrame>),
            CpuFallback {
                frames: Vec<StreamingSpectralFrame>,
                completed_cuda_frames: usize,
                reason: String,
            },
        }

        let outcome = match &mut self.spectral_processor {
            StreamingSpectralProcessor::Cpu => FlushOutcome::Nothing,
            StreamingSpectralProcessor::Cuda(batch) if batch.frame_indices.is_empty() => {
                FlushOutcome::Nothing
            }
            StreamingSpectralProcessor::Cuda(batch) => {
                let transform = batch
                    .session
                    .transform_batch(&batch.input_frames, cancellation);
                match transform {
                    Ok(output)
                        if output.frame_count == batch.frame_indices.len()
                            && output.bins_per_frame == CUDA_FFT_BINS_PER_FRAME =>
                    {
                        let decimation = spectral_decimation(sample_rate);
                        let selected_bins =
                            spectral_fft_bins(sample_rate, decimation, CUDA_FFT_FRAME_LEN);
                        let mut frames = Vec::new();
                        frames
                            .try_reserve_exact(batch.frame_indices.len())
                            .map_err(|error| {
                                format!("Streaming CUDA 声谱结果内存预留失败：{error}")
                            })?;
                        for (batch_index, frame_index) in
                            batch.frame_indices.iter().copied().enumerate()
                        {
                            if batch_index.is_multiple_of(64) {
                                check_algorithm_cancelled(cancel_flag)?;
                            }
                            let output_offset = batch_index * output.bins_per_frame;
                            let spectrum = selected_bins
                                .iter()
                                .map(|bin| {
                                    let value = output.spectra[output_offset + *bin];
                                    f64::from(value.real).hypot(f64::from(value.imaginary))
                                })
                                .collect();
                            frames.push(StreamingSpectralFrame {
                                frame_index,
                                spectrum,
                                active: batch.frame_rms[batch_index] >= silence_rms,
                                rms: batch.frame_rms[batch_index],
                            });
                        }
                        batch.completed_frame_count = batch
                            .completed_frame_count
                            .checked_add(batch.frame_indices.len())
                            .ok_or_else(|| "Streaming CUDA 已完成 frame 计数溢出。".to_string())?;
                        batch.input_frames.clear();
                        batch.source_frames.clear();
                        batch.frame_indices.clear();
                        batch.frame_rms.clear();
                        FlushOutcome::Cuda(frames)
                    }
                    Ok(_) if forced_cuda => {
                        return Err(
                            "blocked:cuda-fft-runtime：已强制 CUDA 流式声谱后端，但批次输出形状与请求不一致。"
                                .to_string(),
                        );
                    }
                    Err(error) if error.code == CudaFftBatchErrorCode::Cancelled => {
                        return Err(ALIGNMENT_V2_CANCELLED.to_string());
                    }
                    Err(error) if forced_cuda => {
                        return Err(format!(
                            "blocked:cuda-fft-runtime：已强制 CUDA 流式声谱后端，但批量 FFT 失败：{:?}: {}",
                            error.code, error.message
                        ));
                    }
                    transform_result => {
                        let reason = match transform_result {
                            Ok(_) => "CUDA 流式批次输出形状与请求不一致".to_string(),
                            Err(error) => format!("{:?}: {}", error.code, error.message),
                        };
                        let mut frames = Vec::new();
                        frames
                            .try_reserve_exact(batch.frame_indices.len())
                            .map_err(|error| {
                                format!("Streaming CPU 回退结果内存预留失败：{error}")
                            })?;
                        for (batch_index, (frame_index, frame)) in batch
                            .frame_indices
                            .iter()
                            .copied()
                            .zip(batch.source_frames.chunks_exact(window_samples))
                            .enumerate()
                        {
                            if batch_index.is_multiple_of(64) {
                                check_algorithm_cancelled(cancel_flag)?;
                            }
                            frames.push(StreamingSpectralFrame {
                                frame_index,
                                spectrum: calculate_spectrum(frame, sample_rate),
                                active: batch.frame_rms[batch_index] >= silence_rms,
                                rms: batch.frame_rms[batch_index],
                            });
                        }
                        FlushOutcome::CpuFallback {
                            frames,
                            completed_cuda_frames: batch.completed_frame_count,
                            reason,
                        }
                    }
                }
            }
        };

        let frames = match outcome {
            FlushOutcome::Nothing => return Ok(()),
            FlushOutcome::Cuda(frames) => frames,
            FlushOutcome::CpuFallback {
                frames,
                completed_cuda_frames,
                reason,
            } => {
                self.spectral_processor = StreamingSpectralProcessor::Cpu;
                apply_streaming_cuda_fallback_identity(
                    &mut self.spectral_backend,
                    completed_cuda_frames,
                    &reason,
                );
                frames
            }
        };
        for frame in frames {
            self.consume_spectral_frame(frame)?;
        }
        check_algorithm_cancelled(cancel_flag)
    }

    fn consume_finalized_peaks(
        &mut self,
        frame_index: usize,
        peaks: Vec<SpectralPeak>,
    ) -> Result<(), String> {
        let target_time_ms = landmark_frame_time_ms(
            frame_index,
            self.hop_samples,
            self.window_samples,
            &self.config,
        )?;
        for anchor_frame in &mut self.pending_anchors {
            let delta_ms = target_time_ms
                .checked_sub(anchor_frame.time_ms)
                .ok_or_else(|| "StreamingLandmarkExtractor 时间差溢出。".to_string())?;
            if delta_ms < self.config.min_pair_delta_ms || delta_ms > self.config.max_pair_delta_ms
            {
                continue;
            }
            for anchor in &mut anchor_frame.peaks {
                if anchor.emitted >= self.config.fanout {
                    continue;
                }
                for target in &peaks {
                    self.coarse_index.push(SpectralLandmark {
                        hash: create_landmark_hash(anchor.bin, target.bin, delta_ms),
                        time_ms: anchor_frame.time_ms,
                        strength_milli: peak_strength_milli(anchor.magnitude, target.magnitude),
                    })?;
                    anchor.emitted += 1;
                    if anchor.emitted >= self.config.fanout {
                        break;
                    }
                }
            }
        }
        while self.pending_anchors.front().is_some_and(|anchor_frame| {
            target_time_ms.saturating_sub(anchor_frame.time_ms) >= self.config.max_pair_delta_ms
                || anchor_frame
                    .peaks
                    .iter()
                    .all(|peak| peak.emitted >= self.config.fanout)
        }) {
            self.pending_anchors.pop_front();
        }
        if !peaks.is_empty() {
            self.pending_anchors.push_back(StreamingAnchorFrame {
                time_ms: target_time_ms,
                peaks: peaks
                    .into_iter()
                    .map(|peak| StreamingAnchorPeak {
                        bin: peak.bin,
                        magnitude: peak.magnitude,
                        emitted: 0,
                    })
                    .collect(),
            });
        }
        Ok(())
    }
}

fn apply_streaming_cuda_fallback_identity(
    spectral_backend: &mut SpectralBackendExecution,
    completed_cuda_frames: usize,
    reason: &str,
) {
    if completed_cuda_frames > 0 {
        let cuda_runtime_detail = spectral_backend.backend_detail.clone();
        spectral_backend.backend_id = STREAMING_HYBRID_SPECTRAL_BACKEND_ID.to_string();
        spectral_backend.backend_detail = format!(
            "{cuda_runtime_detail}; execution=hybrid-cuda-then-cpu-streaming; completedCudaFrames={completed_cuda_frames}; cpuBackend={STREAMING_CPU_SPECTRAL_BACKEND_ID}"
        );
    } else {
        spectral_backend.backend_id = STREAMING_CPU_SPECTRAL_BACKEND_ID.to_string();
        spectral_backend.backend_detail = "CPU 流式 radix-2 f64 FFT".to_string();
    }
    spectral_backend.fallback_reason = Some(format!(
        "CUDA 流式批量 FFT 运行失败，后续批次显式回退 CPU：{reason}"
    ));
}

fn create_streaming_spectral_processor(
    config: &LandmarkConfig,
    window_samples: usize,
    backend_request: &SpectralBackendRequest,
) -> Result<(StreamingSpectralProcessor, SpectralBackendExecution), String> {
    if backend_request.planned_backend_id != CUDA_FFT_BACKEND_ID {
        return Ok((
            StreamingSpectralProcessor::Cpu,
            SpectralBackendExecution {
                backend_id: STREAMING_CPU_SPECTRAL_BACKEND_ID.to_string(),
                requested_backend: backend_request.requested_backend.clone(),
                backend_detail: "CPU 流式 radix-2 f64 FFT".to_string(),
                fallback_reason: backend_request.fallback_reason.clone(),
            },
        ));
    }

    let decimation = spectral_decimation(config.sample_rate);
    let decimated_len = window_samples.div_ceil(decimation);
    let fft_len = decimated_len.max(8).next_power_of_two();
    if fft_len != CUDA_FFT_FRAME_LEN {
        let reason = format!(
            "当前流式声谱网格需要 {fft_len} 点 FFT，CUDA 后端只实现 {CUDA_FFT_FRAME_LEN} 点 R2C"
        );
        return streaming_cuda_initialization_fallback(backend_request, reason);
    }

    let session = match CudaFftR2c512Session::new(0) {
        Ok(session) => session,
        Err(error) => {
            return streaming_cuda_initialization_fallback(
                backend_request,
                format!("{:?}: {}", error.code, error.message),
            );
        }
    };
    let frame_capacity = CUDA_FFT_DEFAULT_BATCH_FRAMES;
    let input_capacity = frame_capacity
        .checked_mul(CUDA_FFT_FRAME_LEN)
        .ok_or_else(|| "Streaming CUDA 输入批次容量溢出。".to_string())?;
    let source_capacity = frame_capacity
        .checked_mul(window_samples)
        .ok_or_else(|| "Streaming CUDA 原始 frame 批次容量溢出。".to_string())?;
    let mut input_frames = Vec::new();
    input_frames
        .try_reserve_exact(input_capacity)
        .map_err(|error| format!("Streaming CUDA 输入批次内存预留失败：{error}"))?;
    let mut source_frames = Vec::new();
    source_frames
        .try_reserve_exact(source_capacity)
        .map_err(|error| format!("Streaming CUDA 原始 frame 批次内存预留失败：{error}"))?;
    let mut frame_indices = Vec::new();
    frame_indices
        .try_reserve_exact(frame_capacity)
        .map_err(|error| format!("Streaming CUDA frame 索引内存预留失败：{error}"))?;
    let mut frame_rms = Vec::new();
    frame_rms
        .try_reserve_exact(frame_capacity)
        .map_err(|error| format!("Streaming CUDA RMS 内存预留失败：{error}"))?;
    Ok((
        StreamingSpectralProcessor::Cuda(StreamingCudaBatch {
            session,
            input_frames,
            source_frames,
            frame_indices,
            frame_rms,
            completed_frame_count: 0,
        }),
        SpectralBackendExecution {
            backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: backend_request.requested_backend.clone(),
            backend_detail: format!(
                "{}（跨 PCM chunk 流式批次）",
                backend_request.backend_detail
            ),
            fallback_reason: backend_request.fallback_reason.clone(),
        },
    ))
}

fn streaming_cuda_initialization_fallback(
    backend_request: &SpectralBackendRequest,
    reason: String,
) -> Result<(StreamingSpectralProcessor, SpectralBackendExecution), String> {
    if backend_request.preference == SpectralBackendPreference::Cuda {
        return Err(format!(
            "blocked:cuda-fft-runtime：已强制 CUDA 流式声谱后端，但初始化失败：{reason}"
        ));
    }
    Ok((
        StreamingSpectralProcessor::Cpu,
        SpectralBackendExecution {
            backend_id: STREAMING_CPU_SPECTRAL_BACKEND_ID.to_string(),
            requested_backend: backend_request.requested_backend.clone(),
            backend_detail: "CPU 流式 radix-2 f64 FFT".to_string(),
            fallback_reason: Some(format!("CUDA 流式声谱初始化失败，显式回退 CPU：{reason}")),
        },
    ))
}

fn enqueue_streaming_cuda_frame(
    batch: &mut StreamingCudaBatch,
    frame: &[i16],
    frame_index: usize,
    sample_rate: u32,
) -> Result<(), String> {
    if batch.frame_indices.len() >= CUDA_FFT_DEFAULT_BATCH_FRAMES {
        return Err("Streaming CUDA 批次已满但尚未提交。".to_string());
    }
    let decimation = spectral_decimation(sample_rate);
    let decimated_len = frame.len().div_ceil(decimation);
    let fft_len = decimated_len.max(8).next_power_of_two();
    if fft_len != CUDA_FFT_FRAME_LEN {
        return Err(format!(
            "Streaming CUDA frame 需要 {fft_len} 点 FFT，与 {CUDA_FFT_FRAME_LEN} 点会话不一致。"
        ));
    }
    let input_start = batch.input_frames.len();
    batch
        .input_frames
        .resize(input_start + CUDA_FFT_FRAME_LEN, 0.0);
    let denominator = decimated_len.saturating_sub(1).max(1) as f64;
    for (index, sample) in frame.iter().step_by(decimation).enumerate() {
        let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / denominator).cos();
        batch.input_frames[input_start + index] =
            (*sample as f64 / i16::MAX as f64 * window) as f32;
    }
    batch.source_frames.extend_from_slice(frame);
    batch.frame_indices.push(frame_index);
    batch.frame_rms.push(normalized_rms(frame));
    Ok(())
}

#[cfg(test)]
#[derive(Debug)]
struct LandmarkSpectralAnalysis {
    spectra: Vec<Vec<f64>>,
    active_frames: Vec<bool>,
    fine_features: Vec<FineFeatureFrame>,
    window_samples: usize,
    hop_samples: usize,
}

/// 从单声道 PCM i16 提取局部声谱峰值对。hash 的低 8 位是粗时间差桶，其余位是
/// 两个频率 bin；匹配时允许相邻时间差桶，从而给轻微速度差保留候选。
#[cfg(test)]
pub fn extract_landmarks(
    pcm: &[i16],
    config: &LandmarkConfig,
) -> Result<Vec<SpectralLandmark>, String> {
    extract_landmarks_with_cancel(pcm, config, None)
}

#[cfg(test)]
pub fn extract_landmarks_with_cancel(
    pcm: &[i16],
    config: &LandmarkConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<SpectralLandmark>, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_landmark_config(config)?;
    let Some(analysis) = analyze_landmark_spectral_frames(pcm, config, None, cancel_flag)? else {
        return Ok(Vec::new());
    };
    extract_landmarks_from_spectral_analysis(&analysis, config, cancel_flag)
}

#[cfg(test)]
fn analyze_landmark_spectral_frames(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: Option<&FineFeatureConfig>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Option<LandmarkSpectralAnalysis>, String> {
    let backend_request = resolve_spectral_backend_request()?;
    analyze_landmark_spectral_frames_with_backend(
        pcm,
        landmark_config,
        fine_config,
        cancel_flag,
        &backend_request,
    )
    .map(|(analysis, _)| analysis)
}

#[cfg(test)]
fn analyze_landmark_spectral_frames_with_backend(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: Option<&FineFeatureConfig>,
    cancel_flag: Option<&AtomicBool>,
    backend_request: &SpectralBackendRequest,
) -> Result<(Option<LandmarkSpectralAnalysis>, SpectralBackendExecution), String> {
    let window_samples = milliseconds_to_samples(
        landmark_config.window_ms as i64,
        landmark_config.sample_rate,
    )?;
    let hop_samples =
        milliseconds_to_samples(landmark_config.hop_ms as i64, landmark_config.sample_rate)?;
    if pcm.len() < window_samples || window_samples < 8 || hop_samples == 0 {
        return Ok((
            None,
            SpectralBackendExecution {
                backend_id: backend_request.planned_backend_id.clone(),
                requested_backend: backend_request.requested_backend.clone(),
                backend_detail: backend_request.backend_detail.clone(),
                fallback_reason: backend_request.fallback_reason.clone(),
            },
        ));
    }

    let frame_count = 1 + (pcm.len() - window_samples) / hop_samples;
    if backend_request.planned_backend_id == CUDA_FFT_BACKEND_ID {
        match analyze_landmark_spectral_frames_cuda(
            pcm,
            landmark_config,
            fine_config,
            cancel_flag,
            window_samples,
            hop_samples,
            frame_count,
        ) {
            Ok(analysis) => {
                return Ok((
                    Some(analysis),
                    SpectralBackendExecution {
                        backend_id: CUDA_FFT_BACKEND_ID.to_string(),
                        requested_backend: backend_request.requested_backend.clone(),
                        backend_detail: backend_request.backend_detail.clone(),
                        fallback_reason: backend_request.fallback_reason.clone(),
                    },
                ));
            }
            Err(CudaSpectralAnalysisError::Cancelled) => {
                return Err(ALIGNMENT_V2_CANCELLED.to_string());
            }
            Err(error) if backend_request.preference == SpectralBackendPreference::Cuda => {
                return Err(format!(
                    "blocked:cuda-fft-runtime：已强制 CUDA 声谱后端，但批量 FFT 失败：{}",
                    error.message()
                ));
            }
            Err(error) => {
                let fallback_reason = format!(
                    "CUDA 批量 FFT 运行失败，本次制品按 CPU 身份重算：{}",
                    error.message()
                );
                let analysis = analyze_landmark_spectral_frames_cpu(
                    pcm,
                    landmark_config,
                    fine_config,
                    cancel_flag,
                    window_samples,
                    hop_samples,
                    frame_count,
                )?;
                return Ok((
                    Some(analysis),
                    SpectralBackendExecution {
                        backend_id: CPU_SPECTRAL_BACKEND_ID.to_string(),
                        requested_backend: backend_request.requested_backend.clone(),
                        backend_detail: "CPU radix-2 f64 FFT".to_string(),
                        fallback_reason: Some(fallback_reason),
                    },
                ));
            }
        }
    }

    let analysis = analyze_landmark_spectral_frames_cpu(
        pcm,
        landmark_config,
        fine_config,
        cancel_flag,
        window_samples,
        hop_samples,
        frame_count,
    )?;
    Ok((
        Some(analysis),
        SpectralBackendExecution {
            backend_id: CPU_SPECTRAL_BACKEND_ID.to_string(),
            requested_backend: backend_request.requested_backend.clone(),
            backend_detail: backend_request.backend_detail.clone(),
            fallback_reason: backend_request.fallback_reason.clone(),
        },
    ))
}

#[cfg(test)]
fn analyze_landmark_spectral_frames_cpu(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: Option<&FineFeatureConfig>,
    cancel_flag: Option<&AtomicBool>,
    window_samples: usize,
    hop_samples: usize,
    frame_count: usize,
) -> Result<LandmarkSpectralAnalysis, String> {
    let mut spectra = Vec::with_capacity(frame_count);
    let mut active_frames = Vec::with_capacity(frame_count);
    let mut fine_features = Vec::with_capacity(if fine_config.is_some() {
        frame_count
    } else {
        0
    });
    for frame_index in 0..frame_count {
        if frame_index % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let start = frame_index * hop_samples;
        let frame = &pcm[start..start + window_samples];
        let rms = normalized_rms(frame);
        let spectrum = calculate_spectrum(frame, landmark_config.sample_rate);
        active_frames.push(rms >= landmark_config.silence_rms);
        if let Some(fine_config) = fine_config {
            fine_features.push(create_fine_feature_frame(
                frame,
                &spectrum,
                rms,
                start,
                window_samples,
                fine_config,
            ));
        }
        spectra.push(spectrum);
    }
    Ok(LandmarkSpectralAnalysis {
        spectra,
        active_frames,
        fine_features,
        window_samples,
        hop_samples,
    })
}

#[derive(Debug)]
enum CudaSpectralAnalysisError {
    Unsupported(String),
    Cancelled,
    Runtime(String),
}

impl CudaSpectralAnalysisError {
    fn message(&self) -> &str {
        match self {
            Self::Unsupported(message) | Self::Runtime(message) => message,
            Self::Cancelled => "Alignment V2 算法已取消。",
        }
    }
}

/// CUDA fine-only extraction keeps only the final fine frames plus one bounded FFT batch.
/// Unlike landmark analysis it never retains a media-duration-sized `Vec<Vec<f64>>` of spectra.
fn extract_fine_features_cuda_bounded(
    pcm: &[i16],
    config: &FineFeatureConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<FineFeatureFrame>, CudaSpectralAnalysisError> {
    let window_samples = milliseconds_to_samples(config.window_ms as i64, config.sample_rate)
        .map_err(CudaSpectralAnalysisError::Runtime)?;
    let hop_samples = milliseconds_to_samples(config.hop_ms as i64, config.sample_rate)
        .map_err(CudaSpectralAnalysisError::Runtime)?;
    if pcm.len() < window_samples || window_samples < 8 || hop_samples == 0 {
        return Ok(Vec::new());
    }
    let frame_count = 1 + (pcm.len() - window_samples) / hop_samples;
    let decimation = spectral_decimation(config.sample_rate);
    let decimated_len = window_samples.div_ceil(decimation);
    let fft_len = decimated_len.max(8).next_power_of_two();
    if fft_len != CUDA_FFT_FRAME_LEN {
        return Err(CudaSpectralAnalysisError::Unsupported(format!(
            "当前 fine 声谱网格需要 {fft_len} 点 FFT，CUDA 后端只实现 {CUDA_FFT_FRAME_LEN} 点 R2C"
        )));
    }
    let mut fine_features = Vec::new();
    fine_features
        .try_reserve_exact(frame_count)
        .map_err(|error| {
            CudaSpectralAnalysisError::Runtime(format!(
                "CUDA fine feature 结果内存预留失败：{error}"
            ))
        })?;
    let denominator = decimated_len.saturating_sub(1).max(1) as f64;
    let local_cancellation = AtomicBool::new(false);
    let cancellation = cancel_flag.unwrap_or(&local_cancellation);
    let mut cuda_session = CudaFftR2c512Session::new(0).map_err(|error| {
        if error.code == CudaFftBatchErrorCode::Cancelled {
            CudaSpectralAnalysisError::Cancelled
        } else {
            CudaSpectralAnalysisError::Runtime(format!("{:?}: {}", error.code, error.message))
        }
    })?;
    let selected_bins = spectral_fft_bins(config.sample_rate, decimation, fft_len);

    for batch_start in (0..frame_count).step_by(CUDA_FFT_DEFAULT_BATCH_FRAMES) {
        check_algorithm_cancelled(cancel_flag).map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
        let batch_frame_count = (frame_count - batch_start).min(CUDA_FFT_DEFAULT_BATCH_FRAMES);
        let input_len = batch_frame_count
            .checked_mul(CUDA_FFT_FRAME_LEN)
            .ok_or_else(|| {
                CudaSpectralAnalysisError::Runtime("CUDA fine FFT 批次输入长度溢出。".to_string())
            })?;
        let mut input_frames = Vec::new();
        input_frames.try_reserve_exact(input_len).map_err(|error| {
            CudaSpectralAnalysisError::Runtime(format!(
                "CUDA fine FFT 批次输入内存预留失败：{error}"
            ))
        })?;
        input_frames.resize(input_len, 0.0f32);
        let mut batch_rms = Vec::new();
        batch_rms
            .try_reserve_exact(batch_frame_count)
            .map_err(|error| {
                CudaSpectralAnalysisError::Runtime(format!(
                    "CUDA fine FFT 批次 RMS 内存预留失败：{error}"
                ))
            })?;
        for batch_index in 0..batch_frame_count {
            if batch_index.is_multiple_of(64) {
                check_algorithm_cancelled(cancel_flag)
                    .map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
            }
            let frame_index = batch_start + batch_index;
            let start = frame_index * hop_samples;
            let frame = &pcm[start..start + window_samples];
            batch_rms.push(normalized_rms(frame));
            let input_offset = batch_index * CUDA_FFT_FRAME_LEN;
            for (index, sample) in frame.iter().step_by(decimation).enumerate() {
                let window =
                    0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / denominator).cos();
                input_frames[input_offset + index] =
                    (*sample as f64 / i16::MAX as f64 * window) as f32;
            }
        }
        let output = cuda_session
            .transform_batch(&input_frames, cancellation)
            .map_err(|error| {
                if error.code == CudaFftBatchErrorCode::Cancelled {
                    CudaSpectralAnalysisError::Cancelled
                } else {
                    CudaSpectralAnalysisError::Runtime(format!(
                        "{:?}: {}",
                        error.code, error.message
                    ))
                }
            })?;
        check_algorithm_cancelled(cancel_flag).map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
        if output.frame_count != batch_frame_count
            || output.bins_per_frame != CUDA_FFT_BINS_PER_FRAME
        {
            return Err(CudaSpectralAnalysisError::Runtime(
                "CUDA fine FFT 批次输出形状与请求不一致。".to_string(),
            ));
        }
        for (batch_index, rms) in batch_rms.iter().copied().enumerate() {
            if batch_index.is_multiple_of(64) {
                check_algorithm_cancelled(cancel_flag)
                    .map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
            }
            let frame_index = batch_start + batch_index;
            let start = frame_index * hop_samples;
            let frame = &pcm[start..start + window_samples];
            let output_offset = batch_index * output.bins_per_frame;
            let spectrum = selected_bins
                .iter()
                .map(|bin| {
                    let value = output.spectra[output_offset + *bin];
                    f64::from(value.real).hypot(f64::from(value.imaginary))
                })
                .collect::<Vec<_>>();
            fine_features.push(create_fine_feature_frame(
                frame,
                &spectrum,
                rms,
                start,
                window_samples,
                config,
            ));
        }
    }
    Ok(fine_features)
}

#[cfg(test)]
fn analyze_landmark_spectral_frames_cuda(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: Option<&FineFeatureConfig>,
    cancel_flag: Option<&AtomicBool>,
    window_samples: usize,
    hop_samples: usize,
    frame_count: usize,
) -> Result<LandmarkSpectralAnalysis, CudaSpectralAnalysisError> {
    let decimation = spectral_decimation(landmark_config.sample_rate);
    let decimated_len = window_samples.div_ceil(decimation);
    let fft_len = decimated_len.max(8).next_power_of_two();
    if fft_len != CUDA_FFT_FRAME_LEN {
        return Err(CudaSpectralAnalysisError::Unsupported(format!(
            "当前声谱网格需要 {fft_len} 点 FFT，CUDA 后端只实现 {CUDA_FFT_FRAME_LEN} 点 R2C"
        )));
    }
    let mut active_frames = Vec::new();
    active_frames
        .try_reserve_exact(frame_count)
        .map_err(|error| {
            CudaSpectralAnalysisError::Runtime(format!(
                "CUDA 声谱 active frame 内存预留失败：{error}"
            ))
        })?;
    let mut spectra = Vec::new();
    spectra.try_reserve_exact(frame_count).map_err(|error| {
        CudaSpectralAnalysisError::Runtime(format!("CUDA 声谱输出内存预留失败：{error}"))
    })?;
    let mut fine_features = Vec::with_capacity(if fine_config.is_some() {
        frame_count
    } else {
        0
    });
    let denominator = decimated_len.saturating_sub(1).max(1) as f64;
    let local_cancellation = AtomicBool::new(false);
    let cancellation = cancel_flag.unwrap_or(&local_cancellation);
    let mut cuda_session = CudaFftR2c512Session::new(0).map_err(|error| {
        if error.code == CudaFftBatchErrorCode::Cancelled {
            CudaSpectralAnalysisError::Cancelled
        } else {
            CudaSpectralAnalysisError::Runtime(format!("{:?}: {}", error.code, error.message))
        }
    })?;
    let selected_bins = spectral_fft_bins(landmark_config.sample_rate, decimation, fft_len);
    // Build, transform and immediately reduce one bounded GPU batch. This keeps temporary host
    // memory independent of media duration: at most 4096 * 512 f32 input plus
    // 4096 * 257 complex output are resident before the 48-bin spectra are retained.
    for batch_start in (0..frame_count).step_by(CUDA_FFT_DEFAULT_BATCH_FRAMES) {
        check_algorithm_cancelled(cancel_flag).map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
        let batch_frame_count = (frame_count - batch_start).min(CUDA_FFT_DEFAULT_BATCH_FRAMES);
        let input_len = batch_frame_count
            .checked_mul(CUDA_FFT_FRAME_LEN)
            .ok_or_else(|| {
                CudaSpectralAnalysisError::Runtime("CUDA FFT 批次输入长度溢出".to_string())
            })?;
        let mut input_frames = Vec::new();
        input_frames.try_reserve_exact(input_len).map_err(|error| {
            CudaSpectralAnalysisError::Runtime(format!("CUDA FFT 批次输入内存预留失败：{error}"))
        })?;
        input_frames.resize(input_len, 0.0f32);
        let mut batch_rms = Vec::new();
        batch_rms
            .try_reserve_exact(batch_frame_count)
            .map_err(|error| {
                CudaSpectralAnalysisError::Runtime(format!(
                    "CUDA 声谱批次 RMS 内存预留失败：{error}"
                ))
            })?;
        for batch_index in 0..batch_frame_count {
            if batch_index.is_multiple_of(64) {
                check_algorithm_cancelled(cancel_flag)
                    .map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
            }
            let frame_index = batch_start + batch_index;
            let start = frame_index * hop_samples;
            let frame = &pcm[start..start + window_samples];
            let rms = normalized_rms(frame);
            batch_rms.push(rms);
            active_frames.push(rms >= landmark_config.silence_rms);
            let input_offset = batch_index * CUDA_FFT_FRAME_LEN;
            for (index, sample) in frame.iter().step_by(decimation).enumerate() {
                let window =
                    0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / denominator).cos();
                input_frames[input_offset + index] =
                    (*sample as f64 / i16::MAX as f64 * window) as f32;
            }
        }
        let output = cuda_session
            .transform_batch(&input_frames, cancellation)
            .map_err(|error| {
                if error.code == CudaFftBatchErrorCode::Cancelled {
                    CudaSpectralAnalysisError::Cancelled
                } else {
                    CudaSpectralAnalysisError::Runtime(format!(
                        "{:?}: {}",
                        error.code, error.message
                    ))
                }
            })?;
        check_algorithm_cancelled(cancel_flag).map_err(|_| CudaSpectralAnalysisError::Cancelled)?;
        if output.frame_count != batch_frame_count
            || output.bins_per_frame != CUDA_FFT_BINS_PER_FRAME
        {
            return Err(CudaSpectralAnalysisError::Runtime(
                "CUDA FFT 批次输出形状与请求不一致".to_string(),
            ));
        }
        for (batch_index, rms) in batch_rms.iter().copied().enumerate() {
            let frame_index = batch_start + batch_index;
            let output_offset = batch_index * output.bins_per_frame;
            let spectrum = selected_bins
                .iter()
                .map(|bin| {
                    let value = output.spectra[output_offset + *bin];
                    f64::from(value.real).hypot(f64::from(value.imaginary))
                })
                .collect::<Vec<_>>();
            if let Some(fine_config) = fine_config {
                let start = frame_index * hop_samples;
                let frame = &pcm[start..start + window_samples];
                fine_features.push(create_fine_feature_frame(
                    frame,
                    &spectrum,
                    rms,
                    start,
                    window_samples,
                    fine_config,
                ));
            }
            spectra.push(spectrum);
        }
    }
    Ok(LandmarkSpectralAnalysis {
        spectra,
        active_frames,
        fine_features,
        window_samples,
        hop_samples,
    })
}

#[cfg(test)]
fn extract_landmarks_from_spectral_analysis(
    analysis: &LandmarkSpectralAnalysis,
    config: &LandmarkConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<SpectralLandmark>, String> {
    let frame_count = analysis.spectra.len();

    let mut peaks_by_frame = vec![Vec::<SpectralPeak>::new(); frame_count];
    for (frame_index, frame_peaks) in peaks_by_frame.iter_mut().enumerate() {
        if frame_index % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        *frame_peaks = extract_spectral_peaks(
            &analysis.spectra[frame_index],
            analysis.active_frames[frame_index],
            frame_index
                .checked_sub(1)
                .map(|index| analysis.spectra[index].as_slice()),
            analysis.spectra.get(frame_index + 1).map(Vec::as_slice),
            config,
        );
    }

    let frame_times = (0..frame_count)
        .map(|frame_index| {
            landmark_frame_time_ms(
                frame_index,
                analysis.hop_samples,
                analysis.window_samples,
                config,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut landmarks = Vec::new();
    for anchor_frame in 0..frame_count {
        if anchor_frame % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        for anchor in &peaks_by_frame[anchor_frame] {
            let mut emitted = 0usize;
            for (target_frame, target_peaks) in
                peaks_by_frame.iter().enumerate().skip(anchor_frame + 1)
            {
                let delta_ms = frame_times[target_frame] - frame_times[anchor_frame];
                if delta_ms < config.min_pair_delta_ms {
                    continue;
                }
                if delta_ms > config.max_pair_delta_ms {
                    break;
                }
                for target in target_peaks {
                    landmarks.push(SpectralLandmark {
                        hash: create_landmark_hash(anchor.bin, target.bin, delta_ms),
                        time_ms: frame_times[anchor_frame],
                        strength_milli: peak_strength_milli(anchor.magnitude, target.magnitude),
                    });
                    emitted += 1;
                    if emitted >= config.fanout {
                        break;
                    }
                }
                if emitted >= config.fanout {
                    break;
                }
            }
        }
    }

    suppress_common_landmarks(&mut landmarks, config.max_hash_occurrences);
    check_algorithm_cancelled(cancel_flag)?;
    sort_landmarks_canonically(&mut landmarks);
    Ok(landmarks)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffineMatchConfig {
    pub min_scale: f64,
    pub max_scale: f64,
    pub residual_tolerance_ms: i64,
    pub min_inliers: usize,
    pub top_k: usize,
    pub max_occurrences_per_hash: usize,
}

impl Default for AffineMatchConfig {
    fn default() -> Self {
        Self {
            min_scale: 0.94,
            max_scale: 1.06,
            residual_tolerance_ms: 90,
            min_inliers: 4,
            top_k: 5,
            max_occurrences_per_hash: 64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffineAnchorEvidence {
    pub source_time_ms: i64,
    pub target_time_ms: i64,
    pub residual_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffineHypothesis {
    pub scale: f64,
    pub offset_ms: i64,
    pub inlier_count: usize,
    pub unique_source_count: usize,
    pub unique_source_coverage: f64,
    pub unique_target_count: usize,
    pub unique_target_coverage: f64,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub p50_residual_ms: i64,
    pub p95_residual_ms: i64,
    pub max_residual_ms: i64,
    pub training_anchors: Vec<AffineAnchorEvidence>,
    pub held_out_anchors: Vec<AffineAnchorEvidence>,
    pub held_out_within_tolerance_count: usize,
}

/// Anchor-free affine model produced by the complete deterministic seed universe.
///
/// This type is deliberately coarse-only: it contains every scalar needed for candidate
/// ranking and bounded fine-window planning, but it does not retain training or held-out
/// anchors for every fitted seed. Call [`materialize_affine_hypothesis_with_cancel`] with the
/// original landmark inputs and config before publishing detailed evidence or entering fine.
#[derive(Debug, Clone, PartialEq)]
pub struct CoarseAffineHypothesis {
    pub scale: f64,
    pub offset_ms: i64,
    pub inlier_count: usize,
    pub unique_source_count: usize,
    pub unique_source_coverage: f64,
    pub unique_target_count: usize,
    pub unique_target_coverage: f64,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub p50_residual_ms: i64,
    pub p95_residual_ms: i64,
    pub max_residual_ms: i64,
    // Training residuals were originally measured against the unrounded least-squares offset.
    // Preserve that exact value privately so later materialization remains bit-for-bit compatible
    // with the legacy Top-K result without exposing it as a second public timeline coordinate.
    fitted_offset_ms: f64,
}

impl CoarseAffineHypothesis {
    /// Returns an anchor-free compatibility view for coarse scoring and fine-window planning.
    ///
    /// The empty anchor vectors are intentional. This view must not be published as evidence or
    /// passed into fine alignment; retain this [`CoarseAffineHypothesis`] and call
    /// [`materialize_affine_hypothesis_with_cancel`] with the original landmarks and config first.
    pub fn to_anchor_free_affine_hypothesis(&self) -> AffineHypothesis {
        self.materialize(Vec::new(), Vec::new(), 0)
    }

    fn materialize(
        &self,
        training_anchors: Vec<AffineAnchorEvidence>,
        held_out_anchors: Vec<AffineAnchorEvidence>,
        held_out_within_tolerance_count: usize,
    ) -> AffineHypothesis {
        AffineHypothesis {
            scale: self.scale,
            offset_ms: self.offset_ms,
            inlier_count: self.inlier_count,
            unique_source_count: self.unique_source_count,
            unique_source_coverage: self.unique_source_coverage,
            unique_target_count: self.unique_target_count,
            unique_target_coverage: self.unique_target_coverage,
            source_start_ms: self.source_start_ms,
            source_end_ms: self.source_end_ms,
            p50_residual_ms: self.p50_residual_ms,
            p95_residual_ms: self.p95_residual_ms,
            max_residual_ms: self.max_residual_ms,
            training_anchors,
            held_out_anchors,
            held_out_within_tolerance_count,
        }
    }
}

// Production callers use this axis-safe contract to bind windowed FFmpeg PCM back to the
// absolute presentation timeline. It must remain independent of FFmpeg seek coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresentationRangeMs {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AffineFineWindowRequest {
    pub source_bounds: PresentationRangeMs,
    pub target_bounds: PresentationRangeMs,
    pub target_query: PresentationRangeMs,
    pub source_guard_ms: i64,
    pub target_guard_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AffineFineDecodeWindows {
    pub source: PresentationRangeMs,
    pub target: PresentationRangeMs,
}

/// Derives bounded absolute-presentation decode windows from a coarse affine hypothesis.
///
/// Alignment V2 models `target_ms = scale * source_ms + offset_ms`. Fine alignment must cover
/// the requested target interval and inverse-project that whole interval onto the source axis;
/// using only the coarse inlier support would silently miss source-only or target-only edits at
/// the episode edges. The source window is also the union of that inverse projection and the
/// complete coarse inlier support. This prevents a source-only insertion between two landmark
/// regions (for example a 45 s reference-side advertisement) from being clipped merely because
/// it is wider than the nominal guard. The returned ranges remain on the original absolute
/// presentation axes.
pub fn derive_affine_fine_decode_windows(
    hypothesis: &AffineHypothesis,
    request: &AffineFineWindowRequest,
) -> Result<AffineFineDecodeWindows, String> {
    validate_presentation_range(request.source_bounds, "来源媒体边界")?;
    validate_presentation_range(request.target_bounds, "目标媒体边界")?;
    validate_presentation_range(request.target_query, "目标候选区间")?;
    if request.source_guard_ms < 0 || request.target_guard_ms < 0 {
        return Err("精解码窗口 guard 必须是非负整数毫秒。".to_string());
    }
    if !hypothesis.scale.is_finite() || hypothesis.scale <= 0.0 {
        return Err("粗定位 affine scale 必须是有限正数。".to_string());
    }

    let query_start = request
        .target_query
        .start_ms
        .max(request.target_bounds.start_ms);
    let query_end = request
        .target_query
        .end_ms
        .min(request.target_bounds.end_ms);
    if query_end <= query_start {
        return Err("目标候选区间与目标媒体展示边界没有交集。".to_string());
    }
    let target_start = query_start
        .saturating_sub(request.target_guard_ms)
        .max(request.target_bounds.start_ms);
    let target_end = query_end
        .saturating_add(request.target_guard_ms)
        .min(request.target_bounds.end_ms);

    let inverse =
        |target_ms: i64| (target_ms as f64 - hypothesis.offset_ms as f64) / hypothesis.scale;
    let projected_start = inverse(target_start);
    let projected_end = inverse(target_end);
    if !projected_start.is_finite() || !projected_end.is_finite() {
        return Err("粗定位 affine 反投影产生了非有限时间。".to_string());
    }
    let projected_source_start = f64_milliseconds_to_i64(
        projected_start.min(projected_end) - request.source_guard_ms as f64,
        f64::floor,
    )?;
    let projected_source_end = f64_milliseconds_to_i64(
        projected_start.max(projected_end) + request.source_guard_ms as f64,
        f64::ceil,
    )?;
    let support_start = hypothesis
        .source_start_ms
        .min(hypothesis.source_end_ms)
        .saturating_sub(request.source_guard_ms);
    let support_end = hypothesis
        .source_start_ms
        .max(hypothesis.source_end_ms)
        .saturating_add(request.source_guard_ms);
    let source_start = projected_source_start
        .min(support_start)
        .max(request.source_bounds.start_ms);
    let source_end = projected_source_end
        .max(support_end)
        .min(request.source_bounds.end_ms);
    if source_end <= source_start {
        return Err("反投影来源窗口与来源媒体展示边界没有交集。".to_string());
    }

    Ok(AffineFineDecodeWindows {
        source: PresentationRangeMs {
            start_ms: source_start,
            end_ms: source_end,
        },
        target: PresentationRangeMs {
            start_ms: target_start,
            end_ms: target_end,
        },
    })
}

fn validate_presentation_range(range: PresentationRangeMs, label: &str) -> Result<(), String> {
    if range.end_ms <= range.start_ms {
        return Err(format!("{label}必须是非空半开毫秒区间。"));
    }
    Ok(())
}

fn f64_milliseconds_to_i64(value: f64, round: fn(f64) -> f64) -> Result<i64, String> {
    let rounded = round(value);
    if !rounded.is_finite() || rounded < i64::MIN as f64 || rounded > i64::MAX as f64 {
        return Err("精解码窗口毫秒值超出 i64 范围。".to_string());
    }
    Ok(rounded as i64)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Retained as the compatibility payload for legacy Top-K callers and tests.
pub struct AffineMatchResult {
    pub hypotheses: Vec<AffineHypothesis>,
    pub observation_count: usize,
    pub source_landmark_count: usize,
    pub target_landmark_count: usize,
    pub top1_top2_margin: f64,
}

/// Complete anchor-free result for the bounded deterministic affine seed universe.
///
/// Unlike [`AffineMatchResult`], this result never applies `AffineMatchConfig::top_k`; every
/// successfully fitted and deduplicated model from at most
/// [`AFFINE_COARSE_MAX_MODEL_SEEDS`] seeds is returned in canonical ranking order.
#[derive(Debug, Clone, PartialEq)]
pub struct AffineCoarseUniverseResult {
    pub hypotheses: Vec<CoarseAffineHypothesis>,
    pub seed_count: usize,
    pub observation_count: usize,
    pub source_landmark_count: usize,
    pub target_landmark_count: usize,
    pub top1_top2_margin: f64,
}

#[derive(Debug, Clone)]
struct LandmarkObservation {
    source_index: usize,
    target_index: usize,
    source_time_ms: i64,
    target_time_ms: i64,
}

#[derive(Debug, Clone)]
struct ModelInlier {
    source_index: usize,
    target_index: usize,
    source_time_ms: i64,
    target_time_ms: i64,
    residual_ms: i64,
}

#[derive(Debug)]
struct AffineMatchPartition {
    observations: Vec<LandmarkObservation>,
    fitting_observations: Vec<LandmarkObservation>,
    held_out_time_blocks: HashSet<i64>,
}

/// 通过 hash 倒排表建立候选，再用确定性模型采样和稳健重拟合输出 Top-K 仿射假设。
#[cfg(test)]
pub fn match_landmarks_affine(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
) -> Result<AffineMatchResult, String> {
    match_landmarks_affine_with_cancel(source, target, config, None)
}

#[allow(dead_code)] // Release uses the exhaustive coarse API; keep legacy Top-K behavior callable.
pub fn match_landmarks_affine_with_cancel(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineMatchResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_affine_config(config)?;
    let partition = prepare_affine_match_partition(source, target, config, cancel_flag)?;
    let coarse =
        fit_affine_coarse_universe(&partition, source.len(), target.len(), config, cancel_flag)?;
    let mut hypotheses = Vec::with_capacity(coarse.hypotheses.len().min(config.top_k));
    for coarse_hypothesis in coarse.hypotheses.iter().take(config.top_k) {
        hypotheses.push(materialize_affine_hypothesis_from_partition(
            &partition,
            source.len(),
            target.len(),
            config,
            coarse_hypothesis,
            cancel_flag,
        )?);
    }
    let top1_top2_margin = calculate_hypothesis_margin(&hypotheses, config);
    Ok(AffineMatchResult {
        hypotheses,
        observation_count: coarse.observation_count,
        source_landmark_count: source.len(),
        target_landmark_count: target.len(),
        top1_top2_margin,
    })
}

/// Fits the complete deterministic affine seed universe without retaining anchor vectors.
#[allow(dead_code)] // Convenience wrapper retained for non-cancellable callers.
pub fn match_landmarks_affine_coarse_universe(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
) -> Result<AffineCoarseUniverseResult, String> {
    match_landmarks_affine_coarse_universe_with_cancel(source, target, config, None)
}

/// Cancellation-aware form of [`match_landmarks_affine_coarse_universe`].
pub fn match_landmarks_affine_coarse_universe_with_cancel(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineCoarseUniverseResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_affine_config(config)?;
    let partition = prepare_affine_match_partition(source, target, config, cancel_flag)?;
    fit_affine_coarse_universe(&partition, source.len(), target.len(), config, cancel_flag)
}

/// Deterministically reconstructs full training and held-out evidence for one coarse hypothesis.
#[allow(dead_code)] // Convenience wrapper retained for non-cancellable callers.
pub fn materialize_affine_hypothesis(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    hypothesis: &CoarseAffineHypothesis,
) -> Result<AffineHypothesis, String> {
    materialize_affine_hypothesis_with_cancel(source, target, config, hypothesis, None)
}

/// Cancellation-aware form of [`materialize_affine_hypothesis`].
pub fn materialize_affine_hypothesis_with_cancel(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    hypothesis: &CoarseAffineHypothesis,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineHypothesis, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_affine_config(config)?;
    let partition = prepare_affine_match_partition(source, target, config, cancel_flag)?;
    materialize_affine_hypothesis_from_partition(
        &partition,
        source.len(),
        target.len(),
        config,
        hypothesis,
        cancel_flag,
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FineFeatureConfig {
    pub sample_rate: u32,
    pub presentation_offset_ms: i64,
    pub window_ms: u32,
    pub hop_ms: u32,
}

impl Default for FineFeatureConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            presentation_offset_ms: 0,
            window_ms: 50,
            hop_ms: 50,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FineFeatureFrame {
    /// Coordinate used by the edit lattice. Ordinary frames keep this equal to
    /// `presentation_time_ms`; a coarse-affine warped search sequence uses the shared
    /// content-time coordinate here.
    pub time_ms: i64,
    /// Original media presentation coordinate. Traceback and TimeMap spans must always use
    /// this value so a warped lattice cannot erase real speed drift.
    pub presentation_time_ms: i64,
    pub values: Vec<f32>,
}

/// Fine-only feature extraction together with the spectral backend that actually completed it.
///
/// This is intentionally separate from the test-only shared landmark/fine extraction:
/// bounded fine windows
/// do not need to retain or rank landmark families, but they still share the production
/// CPU/CUDA spectral grid and its failover identity.
#[derive(Debug, Clone, PartialEq)]
pub struct FineFeatureExtraction {
    pub fine_features: Vec<FineFeatureFrame>,
    pub spectral_backend: SpectralBackendExecution,
}

/// Landmark 与细粒度特征共享同一组声谱帧的纯算法结果。
///
/// 调用方只有在两套配置使用相同 sample rate、window 和 hop 时才能共享遍历；两者的
/// presentation offset 可以不同，并会分别写入各自输出的时间戳。
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub struct LandmarkFineFeatureBundle {
    pub landmarks: Vec<SpectralLandmark>,
    pub fine_features: Vec<FineFeatureFrame>,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub struct LandmarkFineFeatureExtraction {
    pub bundle: LandmarkFineFeatureBundle,
    pub spectral_backend: SpectralBackendExecution,
}

#[cfg(test)]
pub fn extract_landmarks_and_fine_features(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: &FineFeatureConfig,
) -> Result<LandmarkFineFeatureBundle, String> {
    extract_landmarks_and_fine_features_with_cancel(pcm, landmark_config, fine_config, None)
}

/// 在一次声谱 FFT 遍历中同时生成 landmark 与细粒度特征。峰值跨帧判定、common-family
/// 抑制和最终排序仍复用独立 landmark 路径，因此结果与两个独立入口逐项等价。
#[cfg(test)]
pub fn extract_landmarks_and_fine_features_with_cancel(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: &FineFeatureConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<LandmarkFineFeatureBundle, String> {
    let backend_request = resolve_spectral_backend_request()?;
    extract_landmarks_and_fine_features_with_backend_request(
        pcm,
        landmark_config,
        fine_config,
        cancel_flag,
        &backend_request,
    )
    .map(|extraction| extraction.bundle)
}

#[cfg(test)]
pub fn extract_landmarks_and_fine_features_with_backend_request(
    pcm: &[i16],
    landmark_config: &LandmarkConfig,
    fine_config: &FineFeatureConfig,
    cancel_flag: Option<&AtomicBool>,
    backend_request: &SpectralBackendRequest,
) -> Result<LandmarkFineFeatureExtraction, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_landmark_config(landmark_config)?;
    validate_fine_feature_config(fine_config)?;
    validate_shared_spectral_grid(landmark_config, fine_config)?;
    let (analysis, spectral_backend) = analyze_landmark_spectral_frames_with_backend(
        pcm,
        landmark_config,
        Some(fine_config),
        cancel_flag,
        backend_request,
    )?;
    let Some(analysis) = analysis else {
        return Ok(LandmarkFineFeatureExtraction {
            bundle: LandmarkFineFeatureBundle {
                landmarks: Vec::new(),
                fine_features: Vec::new(),
            },
            spectral_backend,
        });
    };
    let landmarks =
        extract_landmarks_from_spectral_analysis(&analysis, landmark_config, cancel_flag)?;
    check_algorithm_cancelled(cancel_flag)?;
    Ok(LandmarkFineFeatureExtraction {
        bundle: LandmarkFineFeatureBundle {
            landmarks,
            fine_features: analysis.fine_features,
        },
        spectral_backend,
    })
}

/// Extract a bounded fine-feature window with an already resolved production backend request.
///
/// CUDA requests reuse the same bounded batched cuFFT implementation as shared landmark/fine
/// extraction. In auto mode any CUDA runtime failure discards the partial analysis and recomputes
/// the complete window on CPU; an explicitly forced CUDA request remains fail-closed. Each CUDA
/// batch is reduced directly into final fine frames, so the function never extracts landmarks or
/// retains a media-duration-sized spectrum matrix.
pub fn extract_fine_features_with_backend_request(
    pcm: &[i16],
    config: &FineFeatureConfig,
    cancel_flag: Option<&AtomicBool>,
    backend_request: &SpectralBackendRequest,
) -> Result<FineFeatureExtraction, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_fine_feature_config(config)?;
    if backend_request.planned_backend_id == CUDA_FFT_BACKEND_ID {
        match extract_fine_features_cuda_bounded(pcm, config, cancel_flag) {
            Ok(fine_features) => {
                return Ok(FineFeatureExtraction {
                    fine_features,
                    spectral_backend: SpectralBackendExecution {
                        backend_id: CUDA_FFT_BACKEND_ID.to_string(),
                        requested_backend: backend_request.requested_backend.clone(),
                        backend_detail: backend_request.backend_detail.clone(),
                        fallback_reason: backend_request.fallback_reason.clone(),
                    },
                });
            }
            Err(CudaSpectralAnalysisError::Cancelled) => {
                return Err(ALIGNMENT_V2_CANCELLED.to_string());
            }
            Err(error) if backend_request.preference == SpectralBackendPreference::Cuda => {
                return Err(format!(
                    "blocked:cuda-fft-runtime：已锁定 CUDA fine 声谱后端，但有界批量 FFT 失败：{}",
                    error.message()
                ));
            }
            Err(error) => {
                let fine_features = extract_fine_features_with_cancel(pcm, config, cancel_flag)?;
                return Ok(FineFeatureExtraction {
                    fine_features,
                    spectral_backend: SpectralBackendExecution {
                        backend_id: CPU_SPECTRAL_BACKEND_ID.to_string(),
                        requested_backend: backend_request.requested_backend.clone(),
                        backend_detail: "CPU radix-2 f64 FFT".to_string(),
                        fallback_reason: Some(format!(
                            "CUDA 有界 fine 批量 FFT 运行失败，本次完整窗口按 CPU 身份重算：{}",
                            error.message()
                        )),
                    },
                });
            }
        }
    }

    let fine_features = extract_fine_features_with_cancel(pcm, config, cancel_flag)?;
    Ok(FineFeatureExtraction {
        fine_features,
        spectral_backend: SpectralBackendExecution {
            backend_id: CPU_SPECTRAL_BACKEND_ID.to_string(),
            requested_backend: backend_request.requested_backend.clone(),
            backend_detail: backend_request.backend_detail.clone(),
            fallback_reason: backend_request.fallback_reason.clone(),
        },
    })
}

/// 从同一份 16-bit PCM 生成细粒度、定长、归一化声谱特征。生产调用方可将 hop
/// 设为 20–50ms；时间戳始终位于媒体 presentation timeline。
#[cfg(test)]
pub fn extract_fine_features(
    pcm: &[i16],
    config: &FineFeatureConfig,
) -> Result<Vec<FineFeatureFrame>, String> {
    extract_fine_features_with_cancel(pcm, config, None)
}

pub fn extract_fine_features_with_cancel(
    pcm: &[i16],
    config: &FineFeatureConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<FineFeatureFrame>, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_fine_feature_config(config)?;
    let window_samples = milliseconds_to_samples(config.window_ms as i64, config.sample_rate)?;
    let hop_samples = milliseconds_to_samples(config.hop_ms as i64, config.sample_rate)?;
    if pcm.len() < window_samples || window_samples < 8 || hop_samples == 0 {
        return Ok(Vec::new());
    }
    let frame_count = 1 + (pcm.len() - window_samples) / hop_samples;
    let mut frames = Vec::with_capacity(frame_count);
    for frame_index in 0..frame_count {
        if frame_index % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let start = frame_index * hop_samples;
        let frame = &pcm[start..start + window_samples];
        let spectrum = calculate_spectrum(frame, config.sample_rate);
        let rms = normalized_rms(frame);
        frames.push(create_fine_feature_frame(
            frame,
            &spectrum,
            rms,
            start,
            window_samples,
            config,
        ));
    }
    Ok(frames)
}

fn create_fine_feature_frame(
    frame: &[i16],
    spectrum: &[f64],
    rms: f64,
    start: usize,
    window_samples: usize,
    config: &FineFeatureConfig,
) -> FineFeatureFrame {
    let mut values = Vec::with_capacity(FINE_SPECTRAL_BAND_COUNT + 2);
    values.push((((rms + 1.0e-6).log10() + 6.0).clamp(0.0, 6.0) / 6.0) as f32);
    let zero_crossings = frame
        .windows(2)
        .filter(|pair| (pair[0] >= 0) != (pair[1] >= 0))
        .count();
    values.push((zero_crossings as f64 / frame.len().max(1) as f64) as f32);
    for band in 0..FINE_SPECTRAL_BAND_COUNT {
        let start_bin = band * SPECTRAL_BIN_COUNT / FINE_SPECTRAL_BAND_COUNT;
        let end_bin = (band + 1) * SPECTRAL_BIN_COUNT / FINE_SPECTRAL_BAND_COUNT;
        let energy = spectrum[start_bin..end_bin].iter().sum::<f64>();
        values.push((energy + 1.0).ln() as f32);
    }
    let norm = values
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm > f64::EPSILON {
        for value in &mut values {
            *value = (f64::from(*value) / norm) as f32;
        }
    }
    let presentation_time_ms = config.presentation_offset_ms
        + samples_to_milliseconds(start + window_samples / 2, config.sample_rate);
    FineFeatureFrame {
        time_ms: presentation_time_ms,
        presentation_time_ms,
        values,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditAlignmentMode {
    Global,
    SemiGlobal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAlignmentConfig {
    pub mode: EditAlignmentMode,
    pub band_radius_ms: i64,
    pub max_dp_cells: usize,
    pub gap_open_cost: i64,
    pub gap_extend_cost: i64,
    pub ambiguous_match_cost: i64,
}

impl Default for EditAlignmentConfig {
    fn default() -> Self {
        Self {
            mode: EditAlignmentMode::Global,
            band_radius_ms: 2_000,
            max_dp_cells: 4_000_000,
            gap_open_cost: 300,
            gap_extend_cost: 60,
            ambiguous_match_cost: 700,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EditPathKind {
    #[serde(rename = "M")]
    Matched,
    #[serde(rename = "sourceOnly")]
    SourceOnly,
    #[serde(rename = "targetOnly")]
    TargetOnly,
    #[serde(rename = "ambiguous")]
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPathStep {
    pub kind: EditPathKind,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub target_start_ms: i64,
    pub target_end_ms: i64,
    pub local_cost: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTimeSpan {
    pub kind: EditPathKind,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub target_start_ms: i64,
    pub target_end_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAlignmentResult {
    pub total_cost: i64,
    pub path: Vec<EditPathStep>,
    pub spans: Vec<EditTimeSpan>,
    pub matched_step_count: usize,
    pub ambiguous_step_count: usize,
}

/// 在粗仿射附近执行三状态 affine-gap DP。SemiGlobal 模式要求完整消费 source，
/// 但允许 target 的前后缀不进入路径；Global 模式显式保留两侧全部 gap。
#[cfg(test)]
pub fn align_features_edit_aware(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    config: &EditAlignmentConfig,
) -> Result<EditAlignmentResult, String> {
    align_features_edit_aware_with_cancel(source, target, coarse, config, None)
}

pub fn align_features_edit_aware_with_cancel(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    config: &EditAlignmentConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<EditAlignmentResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_feature_sequences(source, target)?;
    validate_edit_config(config)?;
    if source.is_empty() || target.is_empty() {
        return Err("细粒度对齐要求来源与目标特征都非空。".to_string());
    }

    let source_len = source.len();
    let target_len = target.len();
    let width = target_len + 1;
    let cell_count = (source_len + 1)
        .checked_mul(width)
        .ok_or_else(|| "细粒度 DP 尺寸溢出。".to_string())?;
    if cell_count > config.max_dp_cells {
        return Err(format!(
            "细粒度 DP 需要 {cell_count} 个索引单元，超过 maxDpCells={}；请先分块或提高特征 hop。",
            config.max_dp_cells
        ));
    }
    let mut matched_parents = vec![STATE_NONE; cell_count];
    let mut source_only_parents = vec![STATE_NONE; cell_count];
    let mut target_only_parents = vec![STATE_NONE; cell_count];
    let mut previous_matched = vec![COST_INFINITY; width];
    let mut previous_source_only = vec![COST_INFINITY; width];
    let mut previous_target_only = vec![COST_INFINITY; width];
    let mut current_matched = vec![COST_INFINITY; width];
    let mut current_source_only = vec![COST_INFINITY; width];
    let mut current_target_only = vec![COST_INFINITY; width];
    previous_matched[0] = 0;

    if config.mode == EditAlignmentMode::SemiGlobal {
        for cost in previous_matched.iter_mut().take(target_len + 1).skip(1) {
            *cost = 0;
        }
    } else {
        for (target_index, target_cost) in previous_target_only
            .iter_mut()
            .enumerate()
            .take(target_len + 1)
            .skip(1)
        {
            *target_cost = config.gap_open_cost
                + config.gap_extend_cost * (target_index.saturating_sub(1) as i64);
            target_only_parents[target_index] = if target_index == 1 {
                STATE_MATCHED
            } else {
                STATE_TARGET_ONLY
            };
        }
    }
    for source_index in 1..=source_len {
        if source_index % 8 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let index = source_index * width;
        source_only_parents[index] = if source_index == 1 {
            STATE_MATCHED
        } else {
            STATE_SOURCE_ONLY
        };
    }

    let source_norms = precompute_feature_norms(source, cancel_flag)?;
    let target_norms = precompute_feature_norms(target, cancel_flag)?;

    for source_index in 1..=source_len {
        if source_index % 8 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        current_matched.fill(COST_INFINITY);
        current_source_only.fill(COST_INFINITY);
        current_target_only.fill(COST_INFINITY);
        current_source_only[0] =
            config.gap_open_cost + config.gap_extend_cost * (source_index.saturating_sub(1) as i64);
        let (target_start, target_end) = target_band_range(
            target,
            coarse.scale * source[source_index - 1].time_ms as f64 + coarse.offset_ms as f64,
            config.band_radius_ms,
        );
        for target_index in target_start..target_end {
            if target_index.is_multiple_of(EDIT_DP_WIDE_LOOP_CANCEL_INTERVAL) {
                check_algorithm_cancelled(cancel_flag)?;
            }
            if !is_inside_affine_band(
                &source[source_index - 1],
                &target[target_index - 1],
                coarse,
                config.band_radius_ms,
            ) {
                continue;
            }
            let index = source_index * width + target_index;
            let feature_cost = feature_distance_cost_with_norms(
                &source[source_index - 1].values,
                &target[target_index - 1].values,
                source_norms[source_index - 1],
                target_norms[target_index - 1],
            );
            let (matched_parent, matched_base) = select_min_state(
                previous_matched[target_index - 1],
                previous_source_only[target_index - 1],
                previous_target_only[target_index - 1],
            );
            current_matched[target_index] = add_cost(matched_base, feature_cost);
            matched_parents[index] = matched_parent;

            let source_candidates = [
                (
                    STATE_MATCHED,
                    add_cost(previous_matched[target_index], config.gap_open_cost),
                ),
                (
                    STATE_SOURCE_ONLY,
                    add_cost(previous_source_only[target_index], config.gap_extend_cost),
                ),
                (
                    STATE_TARGET_ONLY,
                    add_cost(previous_target_only[target_index], config.gap_open_cost),
                ),
            ];
            let (source_parent, source_cost) = select_min_candidate(&source_candidates);
            current_source_only[target_index] = source_cost;
            source_only_parents[index] = source_parent;

            let target_candidates = [
                (
                    STATE_MATCHED,
                    add_cost(current_matched[target_index - 1], config.gap_open_cost),
                ),
                (
                    STATE_SOURCE_ONLY,
                    add_cost(current_source_only[target_index - 1], config.gap_open_cost),
                ),
                (
                    STATE_TARGET_ONLY,
                    add_cost(
                        current_target_only[target_index - 1],
                        config.gap_extend_cost,
                    ),
                ),
            ];
            let (target_parent, target_cost) = select_min_candidate(&target_candidates);
            current_target_only[target_index] = target_cost;
            target_only_parents[index] = target_parent;
        }
        std::mem::swap(&mut previous_matched, &mut current_matched);
        std::mem::swap(&mut previous_source_only, &mut current_source_only);
        std::mem::swap(&mut previous_target_only, &mut current_target_only);
    }

    let (mut source_index, mut target_index, mut state, total_cost) =
        select_alignment_endpoint_from_final_row(
            source_len,
            target_len,
            config.mode,
            &previous_matched,
            &previous_source_only,
            &previous_target_only,
            cancel_flag,
        )?;
    let source_bounds = create_frame_boundaries(source)?;
    let target_bounds = create_frame_boundaries(target)?;
    let mut reversed_path = Vec::new();
    let mut backtrack_steps = 0usize;
    while source_index > 0 || (config.mode == EditAlignmentMode::Global && target_index > 0) {
        if backtrack_steps.is_multiple_of(256) {
            check_algorithm_cancelled(cancel_flag)?;
        }
        backtrack_steps = backtrack_steps.saturating_add(1);
        let index = source_index * width + target_index;
        match state {
            STATE_MATCHED if source_index > 0 && target_index > 0 => {
                let local_cost = feature_context_distance_cost_with_norms(
                    source,
                    target,
                    source_index - 1,
                    target_index - 1,
                    &source_norms,
                    &target_norms,
                );
                let kind = if local_cost >= config.ambiguous_match_cost {
                    EditPathKind::Ambiguous
                } else {
                    EditPathKind::Matched
                };
                reversed_path.push(EditPathStep {
                    kind,
                    source_start_ms: source_bounds[source_index - 1],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index - 1],
                    target_end_ms: target_bounds[target_index],
                    local_cost,
                });
                state = matched_parents[index];
                source_index -= 1;
                target_index -= 1;
            }
            STATE_SOURCE_ONLY if source_index > 0 => {
                reversed_path.push(EditPathStep {
                    kind: EditPathKind::SourceOnly,
                    source_start_ms: source_bounds[source_index - 1],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index],
                    target_end_ms: target_bounds[target_index],
                    local_cost: config.gap_extend_cost,
                });
                state = source_only_parents[index];
                source_index -= 1;
            }
            STATE_TARGET_ONLY if target_index > 0 => {
                reversed_path.push(EditPathStep {
                    kind: EditPathKind::TargetOnly,
                    source_start_ms: source_bounds[source_index],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index - 1],
                    target_end_ms: target_bounds[target_index],
                    local_cost: config.gap_extend_cost,
                });
                state = target_only_parents[index];
                target_index -= 1;
            }
            _ if config.mode == EditAlignmentMode::SemiGlobal && source_index == 0 => break,
            _ => return Err("细粒度 DP 回溯遇到不可达状态。".to_string()),
        }
    }
    reversed_path.reverse();
    let path = collapse_opposite_gap_runs(reversed_path);
    let spans = merge_path_to_spans(&path);
    validate_monotonic_spans(&spans)?;
    let matched_step_count = path
        .iter()
        .filter(|step| step.kind == EditPathKind::Matched)
        .count();
    let ambiguous_step_count = path
        .iter()
        .filter(|step| step.kind == EditPathKind::Ambiguous)
        .count();
    // Cancellation can arrive while the completed path is being collapsed or validated. Do not
    // publish a seemingly successful fine result after the caller has cancelled the job.
    check_algorithm_cancelled(cancel_flag)?;
    Ok(EditAlignmentResult {
        total_cost,
        matched_step_count,
        ambiguous_step_count,
        path,
        spans,
    })
}

#[cfg(test)]
fn align_features_edit_aware_full_matrix_reference(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    config: &EditAlignmentConfig,
) -> Result<EditAlignmentResult, String> {
    validate_feature_sequences(source, target)?;
    validate_edit_config(config)?;
    if source.is_empty() || target.is_empty() {
        return Err("细粒度对齐要求来源与目标特征都非空。".to_string());
    }

    let source_len = source.len();
    let target_len = target.len();
    let width = target_len + 1;
    let cell_count = (source_len + 1)
        .checked_mul(width)
        .ok_or_else(|| "细粒度 DP 尺寸溢出。".to_string())?;
    if cell_count > config.max_dp_cells {
        return Err(format!(
            "细粒度 DP 需要 {cell_count} 个索引单元，超过 maxDpCells={}；请先分块或提高特征 hop。",
            config.max_dp_cells
        ));
    }
    let mut matched_costs = vec![COST_INFINITY; cell_count];
    let mut source_only_costs = vec![COST_INFINITY; cell_count];
    let mut target_only_costs = vec![COST_INFINITY; cell_count];
    let mut matched_parents = vec![STATE_NONE; cell_count];
    let mut source_only_parents = vec![STATE_NONE; cell_count];
    let mut target_only_parents = vec![STATE_NONE; cell_count];
    matched_costs[0] = 0;

    if config.mode == EditAlignmentMode::SemiGlobal {
        for cost in matched_costs.iter_mut().take(target_len + 1).skip(1) {
            *cost = 0;
        }
    } else {
        for target_index in 1..=target_len {
            let index = target_index;
            target_only_costs[index] = config.gap_open_cost
                + config.gap_extend_cost * (target_index.saturating_sub(1) as i64);
            target_only_parents[index] = if target_index == 1 {
                STATE_MATCHED
            } else {
                STATE_TARGET_ONLY
            };
        }
    }
    for source_index in 1..=source_len {
        let index = source_index * width;
        source_only_costs[index] =
            config.gap_open_cost + config.gap_extend_cost * (source_index.saturating_sub(1) as i64);
        source_only_parents[index] = if source_index == 1 {
            STATE_MATCHED
        } else {
            STATE_SOURCE_ONLY
        };
    }

    let source_norms = precompute_feature_norms(source, None)?;
    let target_norms = precompute_feature_norms(target, None)?;

    for source_index in 1..=source_len {
        let (target_start, target_end) = target_band_range(
            target,
            coarse.scale * source[source_index - 1].time_ms as f64 + coarse.offset_ms as f64,
            config.band_radius_ms,
        );
        for target_index in target_start..target_end {
            if !is_inside_affine_band(
                &source[source_index - 1],
                &target[target_index - 1],
                coarse,
                config.band_radius_ms,
            ) {
                continue;
            }
            let index = source_index * width + target_index;
            let diagonal = (source_index - 1) * width + target_index - 1;
            let feature_cost = feature_distance_cost(
                &source[source_index - 1].values,
                &target[target_index - 1].values,
            );
            let (matched_parent, matched_base) = select_min_state(
                matched_costs[diagonal],
                source_only_costs[diagonal],
                target_only_costs[diagonal],
            );
            matched_costs[index] = add_cost(matched_base, feature_cost);
            matched_parents[index] = matched_parent;

            let above = (source_index - 1) * width + target_index;
            let source_candidates = [
                (
                    STATE_MATCHED,
                    add_cost(matched_costs[above], config.gap_open_cost),
                ),
                (
                    STATE_SOURCE_ONLY,
                    add_cost(source_only_costs[above], config.gap_extend_cost),
                ),
                (
                    STATE_TARGET_ONLY,
                    add_cost(target_only_costs[above], config.gap_open_cost),
                ),
            ];
            let (source_parent, source_cost) = select_min_candidate(&source_candidates);
            source_only_costs[index] = source_cost;
            source_only_parents[index] = source_parent;

            let left = source_index * width + target_index - 1;
            let target_candidates = [
                (
                    STATE_MATCHED,
                    add_cost(matched_costs[left], config.gap_open_cost),
                ),
                (
                    STATE_SOURCE_ONLY,
                    add_cost(source_only_costs[left], config.gap_open_cost),
                ),
                (
                    STATE_TARGET_ONLY,
                    add_cost(target_only_costs[left], config.gap_extend_cost),
                ),
            ];
            let (target_parent, target_cost) = select_min_candidate(&target_candidates);
            target_only_costs[index] = target_cost;
            target_only_parents[index] = target_parent;
        }
    }

    let (mut source_index, mut target_index, mut state, total_cost) = select_alignment_endpoint(
        source_len,
        target_len,
        width,
        config.mode,
        &matched_costs,
        &source_only_costs,
        &target_only_costs,
    )?;
    let source_bounds = create_frame_boundaries(source)?;
    let target_bounds = create_frame_boundaries(target)?;
    let mut reversed_path = Vec::new();
    while source_index > 0 || (config.mode == EditAlignmentMode::Global && target_index > 0) {
        let index = source_index * width + target_index;
        match state {
            STATE_MATCHED if source_index > 0 && target_index > 0 => {
                let local_cost = feature_context_distance_cost_with_norms(
                    source,
                    target,
                    source_index - 1,
                    target_index - 1,
                    &source_norms,
                    &target_norms,
                );
                let kind = if local_cost >= config.ambiguous_match_cost {
                    EditPathKind::Ambiguous
                } else {
                    EditPathKind::Matched
                };
                reversed_path.push(EditPathStep {
                    kind,
                    source_start_ms: source_bounds[source_index - 1],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index - 1],
                    target_end_ms: target_bounds[target_index],
                    local_cost,
                });
                state = matched_parents[index];
                source_index -= 1;
                target_index -= 1;
            }
            STATE_SOURCE_ONLY if source_index > 0 => {
                reversed_path.push(EditPathStep {
                    kind: EditPathKind::SourceOnly,
                    source_start_ms: source_bounds[source_index - 1],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index],
                    target_end_ms: target_bounds[target_index],
                    local_cost: config.gap_extend_cost,
                });
                state = source_only_parents[index];
                source_index -= 1;
            }
            STATE_TARGET_ONLY if target_index > 0 => {
                reversed_path.push(EditPathStep {
                    kind: EditPathKind::TargetOnly,
                    source_start_ms: source_bounds[source_index],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index - 1],
                    target_end_ms: target_bounds[target_index],
                    local_cost: config.gap_extend_cost,
                });
                state = target_only_parents[index];
                target_index -= 1;
            }
            _ if config.mode == EditAlignmentMode::SemiGlobal && source_index == 0 => break,
            _ => return Err("细粒度 DP 回溯遇到不可达状态。".to_string()),
        }
    }
    reversed_path.reverse();
    let path = collapse_opposite_gap_runs(reversed_path);
    let spans = merge_path_to_spans(&path);
    validate_monotonic_spans(&spans)?;
    Ok(EditAlignmentResult {
        total_cost,
        matched_step_count: path
            .iter()
            .filter(|step| step.kind == EditPathKind::Matched)
            .count(),
        ambiguous_step_count: path
            .iter()
            .filter(|step| step.kind == EditPathKind::Ambiguous)
            .count(),
        path,
        spans,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryRefinementConfig {
    pub sample_rate: u32,
    pub source_presentation_offset_ms: i64,
    pub target_presentation_offset_ms: i64,
    pub search_radius_ms: i64,
    pub search_step_ms: i64,
    pub window_ms: i64,
    pub score_tolerance: f64,
    pub min_correlation: f64,
    pub min_alternative_margin: f64,
    pub max_uncertainty_ms: i64,
}

impl Default for BoundaryRefinementConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            source_presentation_offset_ms: 0,
            target_presentation_offset_ms: 0,
            search_radius_ms: 500,
            search_step_ms: 1,
            window_ms: 400,
            score_tolerance: 0.01,
            min_correlation: 0.55,
            min_alternative_margin: 0.01,
            max_uncertainty_ms: 120,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryRefinementResult {
    pub source_boundary_ms: i64,
    pub coarse_target_boundary_ms: i64,
    pub refined_target_boundary_ms: i64,
    pub shift_ms: i64,
    pub uncertainty_start_ms: i64,
    pub uncertainty_end_ms: i64,
    pub uncertainty_ms: i64,
    pub best_correlation: f64,
    pub alternative_margin: f64,
    pub ambiguous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoundaryContextSide {
    Before,
    After,
}

#[derive(Debug, Clone, Copy)]
enum BoundaryWindowMode {
    Centered,
    OneSided(BoundaryContextSide),
}

/// 在粗目标边界附近按整数毫秒搜索归一化互相关峰。该实现与 GCC-PHAT 的目标相同：
/// 估计局部相对时延；它不凭单侧相关峰推断删减的语义类型。
#[cfg(test)]
pub fn refine_boundary_by_correlation(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    config: &BoundaryRefinementConfig,
) -> Result<BoundaryRefinementResult, String> {
    refine_boundary_by_correlation_with_cancel(
        source_pcm,
        target_pcm,
        source_boundary_ms,
        coarse_target_boundary_ms,
        config,
        None,
    )
}

pub fn refine_boundary_by_correlation_with_cancel(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    config: &BoundaryRefinementConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BoundaryRefinementResult, String> {
    refine_boundary_by_correlation_mode(
        source_pcm,
        target_pcm,
        source_boundary_ms,
        coarse_target_boundary_ms,
        config,
        BoundaryWindowMode::Centered,
        cancel_flag,
    )
}

/// Uses only the content immediately before or after a suspected edit boundary. A centered
/// window is invalid at sourceOnly/targetOnly edges because half of it belongs to content that
/// exists on only one axis. Callers can swap source/target to refine a source-axis boundary.
pub fn refine_boundary_by_one_sided_correlation_with_cancel(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    context_side: BoundaryContextSide,
    config: &BoundaryRefinementConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BoundaryRefinementResult, String> {
    refine_boundary_by_correlation_mode(
        source_pcm,
        target_pcm,
        source_boundary_ms,
        coarse_target_boundary_ms,
        config,
        BoundaryWindowMode::OneSided(context_side),
        cancel_flag,
    )
}

#[allow(clippy::too_many_arguments)]
fn refine_boundary_by_correlation_mode(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    config: &BoundaryRefinementConfig,
    window_mode: BoundaryWindowMode,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BoundaryRefinementResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_boundary_config(config)?;
    let window_samples = milliseconds_to_samples(config.window_ms, config.sample_rate)?;
    if window_samples < 8 {
        return Err("边界精修窗口过短。".to_string());
    }
    let source_center = timeline_ms_to_sample(
        source_boundary_ms,
        config.source_presentation_offset_ms,
        config.sample_rate,
    )?;
    let source_window = boundary_window(source_pcm, source_center, window_samples, window_mode)
        .ok_or_else(|| "来源粗边界附近没有完整相关窗口。".to_string())?;

    let mut candidates = Vec::new();
    let search_step_ms =
        usize::try_from(config.search_step_ms).map_err(|_| "边界精修搜索步长无效。".to_string())?;
    for shift_ms in (-config.search_radius_ms..=config.search_radius_ms).step_by(search_step_ms) {
        if shift_ms.rem_euclid(32) == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let target_time_ms = coarse_target_boundary_ms
            .checked_add(shift_ms)
            .ok_or_else(|| "目标边界毫秒溢出。".to_string())?;
        let target_center = timeline_ms_to_sample(
            target_time_ms,
            config.target_presentation_offset_ms,
            config.sample_rate,
        )?;
        let Some(target_window) =
            boundary_window(target_pcm, target_center, window_samples, window_mode)
        else {
            continue;
        };
        candidates.push((
            shift_ms,
            normalized_cross_correlation(source_window, target_window),
        ));
    }
    if candidates.is_empty() {
        return Err("目标粗边界搜索范围内没有完整相关窗口。".to_string());
    }
    candidates.sort_by_key(|item| item.0);
    let best_index = candidates
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.1
                .total_cmp(&right.1)
                .then_with(|| right.0.abs().cmp(&left.0.abs()))
                .then_with(|| right.0.cmp(&left.0))
        })
        .map(|(index, _)| index)
        .ok_or_else(|| "无法选择相关峰。".to_string())?;
    let (best_shift_ms, best_correlation) = candidates[best_index];
    let threshold = best_correlation - config.score_tolerance;
    let mut left = best_index;
    while left > 0 && candidates[left - 1].1 >= threshold {
        left -= 1;
    }
    let mut right = best_index;
    while right + 1 < candidates.len() && candidates[right + 1].1 >= threshold {
        right += 1;
    }
    // Adjacent integer shifts inside the same broad peak are the uncertainty interval, not
    // competing edit locations. Only a distinct peak outside that interval reduces the margin.
    let second_best = candidates
        .iter()
        .enumerate()
        .filter(|(index, _)| *index < left || *index > right)
        .map(|(_, item)| item.1)
        .max_by(f64::total_cmp)
        .unwrap_or(-1.0);
    let alternative_margin = (best_correlation - second_best).max(0.0);
    let uncertainty_ms = candidates[right].0 - candidates[left].0;
    let refined_target_boundary_ms = coarse_target_boundary_ms
        .checked_add(best_shift_ms)
        .ok_or_else(|| "精修目标边界毫秒溢出。".to_string())?;
    let uncertainty_start_ms = coarse_target_boundary_ms
        .checked_add(candidates[left].0)
        .ok_or_else(|| "边界不确定范围起点溢出。".to_string())?;
    let uncertainty_end_ms = coarse_target_boundary_ms
        .checked_add(candidates[right].0)
        .ok_or_else(|| "边界不确定范围终点溢出。".to_string())?;
    Ok(BoundaryRefinementResult {
        source_boundary_ms,
        coarse_target_boundary_ms,
        refined_target_boundary_ms,
        shift_ms: best_shift_ms,
        uncertainty_start_ms,
        uncertainty_end_ms,
        uncertainty_ms,
        best_correlation,
        alternative_margin,
        ambiguous: best_correlation < config.min_correlation
            || alternative_margin < config.min_alternative_margin
            || uncertainty_ms > config.max_uncertainty_ms,
    })
}

fn validate_landmark_config(config: &LandmarkConfig) -> Result<(), String> {
    if config.sample_rate < 1_000
        || !(20..=50).contains(&config.hop_ms)
        || config.window_ms < config.hop_ms
        || config.window_ms > 100
        || !config.silence_rms.is_finite()
        || !(0.0..1.0).contains(&config.silence_rms)
        || !config.min_peak_ratio.is_finite()
        || config.min_peak_ratio <= 1.0
        || config.max_peaks_per_frame == 0
        || config.fanout == 0
        || config.min_pair_delta_ms < config.hop_ms as i64
        || config.max_pair_delta_ms <= config.min_pair_delta_ms
        || config.max_hash_occurrences == 0
    {
        return Err(
            "LandmarkConfig 无效；hop 必须为 20–50ms，窗口、阈值和配对范围必须为正。".to_string(),
        );
    }
    Ok(())
}

fn validate_fine_feature_config(config: &FineFeatureConfig) -> Result<(), String> {
    if config.sample_rate < 1_000
        || !(20..=50).contains(&config.hop_ms)
        || config.window_ms < config.hop_ms
        || config.window_ms > 100
    {
        return Err(
            "FineFeatureConfig 无效；hop 必须为 20–50ms，窗口必须覆盖至少一个 hop。".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
fn validate_shared_spectral_grid(
    landmark_config: &LandmarkConfig,
    fine_config: &FineFeatureConfig,
) -> Result<(), String> {
    if landmark_config.sample_rate != fine_config.sample_rate
        || landmark_config.window_ms != fine_config.window_ms
        || landmark_config.hop_ms != fine_config.hop_ms
    {
        return Err(
            "共享声谱提取要求 landmark 与 fine feature 使用相同 sample rate、window 和 hop。"
                .to_string(),
        );
    }
    Ok(())
}

fn calculate_spectrum(frame: &[i16], sample_rate: u32) -> Vec<f64> {
    #[cfg(test)]
    TEST_SPECTRUM_CALCULATION_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    // 16 kHz 输入先做 2:1 抽取，再以 radix-2 FFT 复用一份窗谱。旧实现为每个
    // 频率桶各扫一遍窗口（48 次 Goertzel），长媒体会出现数十亿次样本迭代。
    let decimation = spectral_decimation(sample_rate);
    let decimated_len = frame.len().div_ceil(decimation);
    let fft_len = decimated_len.max(8).next_power_of_two();
    let mut spectrum = vec![(0.0f64, 0.0f64); fft_len];
    let denominator = decimated_len.saturating_sub(1).max(1) as f64;
    for (index, sample) in frame.iter().step_by(decimation).enumerate() {
        let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / denominator).cos();
        spectrum[index].0 = *sample as f64 / i16::MAX as f64 * window;
    }
    radix2_fft(&mut spectrum);

    spectral_fft_bins(sample_rate, decimation, fft_len)
        .into_iter()
        .map(|fft_bin| spectrum[fft_bin].0.hypot(spectrum[fft_bin].1))
        .collect()
}

fn spectral_decimation(sample_rate: u32) -> usize {
    if sample_rate >= 8_000 {
        2
    } else {
        1
    }
}

fn spectral_fft_bins(sample_rate: u32, decimation: usize, fft_len: usize) -> Vec<usize> {
    let effective_sample_rate = sample_rate as f64 / decimation as f64;
    let min_frequency = 80.0;
    let max_frequency = (effective_sample_rate * 0.45).min(3_600.0);
    (0..SPECTRAL_BIN_COUNT)
        .map(|bin| {
            let ratio = bin as f64 / (SPECTRAL_BIN_COUNT - 1) as f64;
            let frequency = min_frequency * (max_frequency / min_frequency).powf(ratio);
            ((frequency * fft_len as f64 / effective_sample_rate).round() as usize).min(fft_len / 2)
        })
        .collect()
}

fn radix2_fft(values: &mut [(f64, f64)]) {
    let length = values.len();
    let mut reversed = 0usize;
    for index in 1..length {
        let mut bit = length >> 1;
        while reversed & bit != 0 {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed ^= bit;
        if index < reversed {
            values.swap(index, reversed);
        }
    }

    let mut block_len = 2usize;
    while block_len <= length {
        let angle = -2.0 * std::f64::consts::PI / block_len as f64;
        let root = (angle.cos(), angle.sin());
        for block_start in (0..length).step_by(block_len) {
            let mut twiddle = (1.0, 0.0);
            for offset in 0..block_len / 2 {
                let even = values[block_start + offset];
                let odd = values[block_start + offset + block_len / 2];
                let rotated = (
                    odd.0 * twiddle.0 - odd.1 * twiddle.1,
                    odd.0 * twiddle.1 + odd.1 * twiddle.0,
                );
                values[block_start + offset] = (even.0 + rotated.0, even.1 + rotated.1);
                values[block_start + offset + block_len / 2] =
                    (even.0 - rotated.0, even.1 - rotated.1);
                twiddle = (
                    twiddle.0 * root.0 - twiddle.1 * root.1,
                    twiddle.0 * root.1 + twiddle.1 * root.0,
                );
            }
        }
        block_len *= 2;
    }
}

fn normalized_rms(frame: &[i16]) -> f64 {
    let square_sum = frame
        .iter()
        .map(|sample| {
            let value = *sample as f64 / i16::MAX as f64;
            value * value
        })
        .sum::<f64>();
    (square_sum / frame.len().max(1) as f64).sqrt()
}

fn quantize_log_rms_milli(rms: f64) -> u16 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0;
    }
    let dbfs = 20.0 * rms.clamp(1e-6, 1.0).log10();
    ((dbfs + 120.0) * 100.0).round().clamp(0.0, 12_000.0) as u16
}

fn extract_spectral_peaks(
    spectrum: &[f64],
    active: bool,
    previous_spectrum: Option<&[f64]>,
    next_spectrum: Option<&[f64]>,
    config: &LandmarkConfig,
) -> Vec<SpectralPeak> {
    if !active {
        return Vec::new();
    }
    let frame_mean = spectrum.iter().sum::<f64>() / spectrum.len().max(1) as f64;
    let mut peaks = Vec::new();
    for bin in 1..SPECTRAL_BIN_COUNT - 1 {
        let magnitude = spectrum[bin];
        let previous_time = previous_spectrum.map(|values| values[bin]).unwrap_or(0.0);
        let next_time = next_spectrum.map(|values| values[bin]).unwrap_or(0.0);
        if magnitude <= spectrum[bin - 1]
            || magnitude < spectrum[bin + 1]
            || magnitude < previous_time
            || magnitude <= next_time
            || magnitude < frame_mean * config.min_peak_ratio
        {
            continue;
        }
        peaks.push(SpectralPeak { bin, magnitude });
    }
    peaks.sort_by(|left, right| {
        right
            .magnitude
            .total_cmp(&left.magnitude)
            .then_with(|| left.bin.cmp(&right.bin))
    });
    peaks.truncate(config.max_peaks_per_frame);
    peaks
}

fn landmark_frame_time_ms(
    frame_index: usize,
    hop_samples: usize,
    window_samples: usize,
    config: &LandmarkConfig,
) -> Result<i64, String> {
    let center_sample = frame_index
        .checked_mul(hop_samples)
        .and_then(|start| start.checked_add(window_samples / 2))
        .ok_or_else(|| "landmark frame 样本位置溢出。".to_string())?;
    config
        .presentation_offset_ms
        .checked_add(samples_to_milliseconds(center_sample, config.sample_rate))
        .ok_or_else(|| "landmark presentation 时间溢出。".to_string())
}

fn validate_streaming_landmark_hash(hash: u64) -> Result<(), String> {
    let anchor_bin = hash >> 16;
    let target_bin = (hash >> 8) & 0xff;
    if anchor_bin >= SPECTRAL_BIN_COUNT as u64 || target_bin >= SPECTRAL_BIN_COUNT as u64 {
        return Err("MediaCoarseIndex 收到超出声谱 bin 范围的 landmark hash。".to_string());
    }
    Ok(())
}

fn streaming_landmark_priority(family: u64, ordinal: u64) -> u64 {
    // Sampling must depend only on the family-local ordinal. Absolute PTS, strength and the
    // delta bucket can all differ between two otherwise corresponding encodes; mixing any of
    // them here would make source and target retain unrelated repetitive landmarks.
    let mut value = family ^ ordinal.rotate_left(17);
    value = value.wrapping_add(0x9e3779b97f4a7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
    value ^ (value >> 31)
}

fn sort_landmarks_canonically(landmarks: &mut [SpectralLandmark]) {
    landmarks.sort_unstable_by(|left, right| {
        left.time_ms
            .cmp(&right.time_ms)
            .then_with(|| left.hash.cmp(&right.hash))
            .then_with(|| right.strength_milli.cmp(&left.strength_milli))
    });
}

fn create_landmark_hash(anchor_bin: usize, target_bin: usize, delta_ms: i64) -> u64 {
    let delta_bucket = ((delta_ms + LANDMARK_DELTA_QUANTUM_MS / 2) / LANDMARK_DELTA_QUANTUM_MS)
        .clamp(0, LANDMARK_DELTA_MASK as i64) as u64;
    ((anchor_bin as u64) << 16) | ((target_bin as u64) << 8) | delta_bucket
}

fn landmark_family(hash: u64) -> u64 {
    hash >> 8
}

fn landmark_delta_bucket(hash: u64) -> i64 {
    (hash & LANDMARK_DELTA_MASK) as i64
}

fn peak_strength_milli(left: f64, right: f64) -> u32 {
    ((left.min(right) + 1.0).ln() * 1_000.0)
        .round()
        .clamp(0.0, u32::MAX as f64) as u32
}

#[cfg(test)]
fn suppress_common_landmarks(landmarks: &mut Vec<SpectralLandmark>, max_occurrences: usize) {
    let mut by_family = HashMap::<u64, Vec<SpectralLandmark>>::new();
    for landmark in std::mem::take(landmarks) {
        by_family
            .entry(landmark_family(landmark.hash))
            .or_default()
            .push(landmark);
    }
    for mut family in by_family.into_values() {
        family.sort_by_key(|item| item.time_ms);
        if family.len() <= max_occurrences {
            landmarks.extend(family);
            continue;
        }
        // 常见频率对不再整族删除；按时间均匀保留上限个观测，使长片的后半段仍
        // 有机会进入仿射估计，同时限制重复片头造成的笛卡尔候选爆炸。
        for selected in 0..max_occurrences {
            let index = selected * family.len() / max_occurrences;
            landmarks.push(family[index].clone());
        }
    }
}

fn validate_affine_config(config: &AffineMatchConfig) -> Result<(), String> {
    if !config.min_scale.is_finite()
        || !config.max_scale.is_finite()
        || config.min_scale < 0.94
        || config.max_scale > 1.06
        || config.min_scale >= config.max_scale
        || config.residual_tolerance_ms <= 0
        || config.min_inliers < 2
        || config.top_k == 0
        || config.max_occurrences_per_hash == 0
    {
        return Err("AffineMatchConfig 无效；scale 必须限制在 0.94–1.06。".to_string());
    }
    Ok(())
}

fn create_landmark_observations(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<LandmarkObservation>, String> {
    let mut source_family_counts = HashMap::<u64, usize>::new();
    let mut target_by_family = HashMap::<u64, Vec<(usize, &SpectralLandmark)>>::new();
    for landmark in source {
        *source_family_counts
            .entry(landmark_family(landmark.hash))
            .or_default() += 1;
    }
    for (target_index, landmark) in target.iter().enumerate() {
        target_by_family
            .entry(landmark_family(landmark.hash))
            .or_default()
            .push((target_index, landmark));
    }

    let mut observations = Vec::new();
    let sampled_source_limit = (MAX_OBSERVATIONS / 8).max(1);
    let source_step = source.len().div_ceil(sampled_source_limit).max(1);
    for (source_index, source_landmark) in source.iter().enumerate().step_by(source_step) {
        if source_index % 256 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let family = landmark_family(source_landmark.hash);
        let Some(target_items) = target_by_family.get(&family) else {
            continue;
        };
        if source_family_counts.get(&family).copied().unwrap_or(0) > config.max_occurrences_per_hash
            || target_items.len() > config.max_occurrences_per_hash
        {
            continue;
        }
        let source_bucket = landmark_delta_bucket(source_landmark.hash);
        let target_step = target_items.len().div_ceil(8).max(1);
        for (target_index, target_landmark) in target_items.iter().step_by(target_step) {
            if source_bucket.abs_diff(landmark_delta_bucket(target_landmark.hash)) > 1 {
                continue;
            }
            observations.push(LandmarkObservation {
                source_index,
                target_index: *target_index,
                source_time_ms: source_landmark.time_ms,
                target_time_ms: target_landmark.time_ms,
            });
            if observations.len() >= MAX_OBSERVATIONS {
                return Ok(observations);
            }
        }
    }
    observations.sort_by(|left, right| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.target_time_ms.cmp(&right.target_time_ms))
            .then_with(|| left.source_index.cmp(&right.source_index))
    });
    Ok(observations)
}

fn create_model_seeds(
    observations: &[LandmarkObservation],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<(f64, f64)>, String> {
    let mut seeds = Vec::new();
    let single_step = (observations.len() / 96).max(1);
    for observation in observations.iter().step_by(single_step) {
        seeds.push((
            1.0,
            (observation.target_time_ms - observation.source_time_ms) as f64,
        ));
        if seeds.len() >= MAX_MODEL_SEEDS / 3 {
            break;
        }
    }
    let pair_step = (observations.len() / 48).max(1);
    'outer: for first_index in (0..observations.len()).step_by(pair_step) {
        check_algorithm_cancelled(cancel_flag)?;
        for second_index in (first_index + 1..observations.len()).step_by(pair_step) {
            let first = &observations[first_index];
            let second = &observations[second_index];
            let source_delta = second.source_time_ms - first.source_time_ms;
            let target_delta = second.target_time_ms - first.target_time_ms;
            if first.source_index == second.source_index || source_delta.abs() < 500 {
                continue;
            }
            let scale = target_delta as f64 / source_delta as f64;
            if scale < config.min_scale || scale > config.max_scale {
                continue;
            }
            let offset = first.target_time_ms as f64 - scale * first.source_time_ms as f64;
            seeds.push((scale, offset));
            if seeds.len() >= MAX_MODEL_SEEDS {
                break 'outer;
            }
        }
    }
    Ok(seeds)
}

fn prepare_affine_match_partition(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineMatchPartition, String> {
    check_algorithm_cancelled(cancel_flag)?;
    let observations = create_landmark_observations(source, target, config, cancel_flag)?;
    if observations.len() > MAX_OBSERVATIONS {
        return Err(format!(
            "仿射观测数 {} 超过硬上限 {MAX_OBSERVATIONS}。",
            observations.len()
        ));
    }
    let held_out_time_blocks =
        select_distributed_holdout_time_blocks(&observations, config.min_inliers);
    let training_observations = observations
        .iter()
        .filter(|item| {
            !held_out_time_blocks.contains(&affine_holdout_time_block(item.source_time_ms))
        })
        .cloned()
        .collect::<Vec<_>>();
    check_algorithm_cancelled(cancel_flag)?;
    let (fitting_observations, held_out_time_blocks) =
        if training_observations.len() >= config.min_inliers {
            (training_observations, held_out_time_blocks)
        } else {
            (observations.clone(), HashSet::new())
        };
    Ok(AffineMatchPartition {
        observations,
        fitting_observations,
        held_out_time_blocks,
    })
}

fn fit_affine_coarse_universe(
    partition: &AffineMatchPartition,
    unique_source_total: usize,
    unique_target_total: usize,
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineCoarseUniverseResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    if partition.observations.is_empty() || unique_source_total == 0 || unique_target_total == 0 {
        return Ok(AffineCoarseUniverseResult {
            hypotheses: Vec::new(),
            seed_count: 0,
            observation_count: partition.observations.len(),
            source_landmark_count: unique_source_total,
            target_landmark_count: unique_target_total,
            top1_top2_margin: 0.0,
        });
    }

    // The validation partition is fixed before seed generation. Every source landmark in a
    // selected time block stays together, so alternate frequencies from the same spectral frame
    // cannot leak into seeds, candidate ranking or least-squares refitting.
    let seeds = create_model_seeds(&partition.fitting_observations, config, cancel_flag)?;
    if seeds.len() > AFFINE_COARSE_MAX_MODEL_SEEDS {
        return Err(format!(
            "仿射模型 seed 数 {} 超过硬上限 {AFFINE_COARSE_MAX_MODEL_SEEDS}。",
            seeds.len()
        ));
    }
    let seed_count = seeds.len();
    let mut hypotheses = Vec::<CoarseAffineHypothesis>::with_capacity(seed_count);
    for (seed_index, (seed_scale, seed_offset)) in seeds.into_iter().enumerate() {
        if seed_index % 4 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        if let Some(hypothesis) = fit_coarse_hypothesis(
            &partition.fitting_observations,
            seed_scale,
            seed_offset,
            unique_source_total,
            unique_target_total,
            config,
        ) {
            if hypotheses.iter().any(|existing: &CoarseAffineHypothesis| {
                (existing.scale - hypothesis.scale).abs() < 0.000_5
                    && existing.offset_ms.abs_diff(hypothesis.offset_ms) < 40
            }) {
                continue;
            }
            if hypotheses.len() >= AFFINE_COARSE_MAX_MODEL_SEEDS {
                return Err(format!(
                    "去重仿射假设数超过硬上限 {AFFINE_COARSE_MAX_MODEL_SEEDS}。"
                ));
            }
            hypotheses.push(hypothesis);
        }
    }
    check_algorithm_cancelled(cancel_flag)?;
    hypotheses.sort_by(compare_coarse_hypotheses);
    let top1_top2_margin = calculate_coarse_hypothesis_margin(&hypotheses, config);
    Ok(AffineCoarseUniverseResult {
        hypotheses,
        seed_count,
        observation_count: partition.observations.len(),
        source_landmark_count: unique_source_total,
        target_landmark_count: unique_target_total,
        top1_top2_margin,
    })
}

fn fit_coarse_hypothesis(
    observations: &[LandmarkObservation],
    seed_scale: f64,
    seed_offset: f64,
    unique_source_total: usize,
    unique_target_total: usize,
    config: &AffineMatchConfig,
) -> Option<CoarseAffineHypothesis> {
    let mut scale = seed_scale;
    let mut offset = seed_offset;
    let mut inliers =
        select_unique_monotonic_inliers(observations, scale, offset, config.residual_tolerance_ms);
    for _ in 0..2 {
        if inliers.len() < config.min_inliers {
            return None;
        }
        let (next_scale, next_offset) = least_squares_affine(&inliers)?;
        if next_scale < config.min_scale || next_scale > config.max_scale {
            return None;
        }
        scale = next_scale;
        offset = next_offset;
        inliers = select_unique_monotonic_inliers(
            observations,
            scale,
            offset,
            config.residual_tolerance_ms,
        );
    }
    if inliers.len() < config.min_inliers {
        return None;
    }
    create_coarse_hypothesis_from_inliers(
        scale,
        offset,
        &inliers,
        unique_source_total,
        unique_target_total,
    )
}

fn materialize_affine_hypothesis_from_partition(
    partition: &AffineMatchPartition,
    unique_source_total: usize,
    unique_target_total: usize,
    config: &AffineMatchConfig,
    hypothesis: &CoarseAffineHypothesis,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineHypothesis, String> {
    check_algorithm_cancelled(cancel_flag)?;
    if !hypothesis.scale.is_finite()
        || !hypothesis.fitted_offset_ms.is_finite()
        || hypothesis.scale < config.min_scale
        || hypothesis.scale > config.max_scale
    {
        return Err("coarse affine hypothesis 含非有限或越界模型参数。".to_string());
    }
    let inliers = select_unique_monotonic_inliers(
        &partition.fitting_observations,
        hypothesis.scale,
        hypothesis.fitted_offset_ms,
        config.residual_tolerance_ms,
    );
    if inliers.len() < config.min_inliers {
        return Err(
            "coarse affine hypothesis 无法在原始 landmark 上重建最小训练内点。".to_string(),
        );
    }
    let rebuilt = create_coarse_hypothesis_from_inliers(
        hypothesis.scale,
        hypothesis.fitted_offset_ms,
        &inliers,
        unique_source_total,
        unique_target_total,
    )
    .ok_or_else(|| "coarse affine hypothesis 无法重建标量。".to_string())?;
    if rebuilt != *hypothesis {
        return Err(
            "coarse affine hypothesis 与当前 landmark/config 的确定性重建结果不一致。".to_string(),
        );
    }
    if inliers.len() > MAX_OBSERVATIONS {
        return Err(format!(
            "materialized training anchor 数超过硬上限 {MAX_OBSERVATIONS}。"
        ));
    }
    let training_anchors = inliers
        .iter()
        .map(|item| AffineAnchorEvidence {
            source_time_ms: item.source_time_ms,
            target_time_ms: item.target_time_ms,
            residual_ms: item.residual_ms,
        })
        .collect::<Vec<_>>();
    check_algorithm_cancelled(cancel_flag)?;
    let held_out_anchors = evaluate_affine_holdout(
        &partition.observations,
        &partition.held_out_time_blocks,
        hypothesis.scale,
        hypothesis.offset_ms as f64,
        config.residual_tolerance_ms,
    );
    if held_out_anchors.len() > MAX_OBSERVATIONS {
        return Err(format!(
            "materialized held-out anchor 数超过硬上限 {MAX_OBSERVATIONS}。"
        ));
    }
    let held_out_within_tolerance_count = held_out_anchors
        .iter()
        .filter(|item| item.residual_ms <= config.residual_tolerance_ms)
        .count();
    check_algorithm_cancelled(cancel_flag)?;
    Ok(hypothesis.materialize(
        training_anchors,
        held_out_anchors,
        held_out_within_tolerance_count,
    ))
}

fn create_coarse_hypothesis_from_inliers(
    scale: f64,
    fitted_offset_ms: f64,
    inliers: &[ModelInlier],
    unique_source_total: usize,
    unique_target_total: usize,
) -> Option<CoarseAffineHypothesis> {
    if inliers.is_empty() {
        return None;
    }
    let mut residuals = inliers
        .iter()
        .map(|item| item.residual_ms)
        .collect::<Vec<_>>();
    residuals.sort_unstable();
    Some(CoarseAffineHypothesis {
        scale,
        offset_ms: fitted_offset_ms.round() as i64,
        inlier_count: inliers.len(),
        unique_source_count: inliers.len(),
        unique_source_coverage: inliers.len() as f64 / unique_source_total.max(1) as f64,
        unique_target_count: inliers.len(),
        unique_target_coverage: inliers.len() as f64 / unique_target_total.max(1) as f64,
        source_start_ms: inliers.iter().map(|item| item.source_time_ms).min()?,
        source_end_ms: inliers.iter().map(|item| item.source_time_ms).max()?,
        p50_residual_ms: percentile(&residuals, 0.50),
        p95_residual_ms: percentile(&residuals, 0.95),
        max_residual_ms: *residuals.last().unwrap_or(&0),
        fitted_offset_ms,
    })
}

fn affine_holdout_time_block(source_time_ms: i64) -> i64 {
    source_time_ms.div_euclid(AFFINE_HOLDOUT_TIME_BLOCK_MS)
}

fn select_distributed_holdout_time_blocks(
    observations: &[LandmarkObservation],
    minimum_training_count: usize,
) -> HashSet<i64> {
    let mut source_indices = observations
        .iter()
        .map(|item| item.source_index)
        .collect::<HashSet<_>>();
    if source_indices.len().saturating_sub(minimum_training_count) < 2 {
        return HashSet::new();
    }

    let mut source_indices_by_block = HashMap::<i64, HashSet<usize>>::new();
    for observation in observations {
        source_indices_by_block
            .entry(affine_holdout_time_block(observation.source_time_ms))
            .or_default()
            .insert(observation.source_index);
    }
    let mut blocks = source_indices_by_block.keys().copied().collect::<Vec<_>>();
    blocks.sort_unstable();
    if blocks.len() < 3 {
        return HashSet::new();
    }

    let maximum_holdout_block_count = blocks
        .len()
        .saturating_sub(1)
        .min(MAX_AFFINE_HOLDOUT_TIME_BLOCKS);
    let holdout_block_count = blocks
        .len()
        .div_ceil(5)
        .max(2)
        .min(maximum_holdout_block_count);
    // One deterministic pseudo-random position per equal-width stratum preserves full-axis
    // coverage without sampling the same modulo-5 phase across the whole media. The former
    // midpoint sequence aliased with the 50 ms landmark cadence on real E01 and removed nearly
    // every sparse true correspondence from the fitting partition.
    let mut block_indices = (0..holdout_block_count)
        .map(|slot| {
            let start = slot * blocks.len() / holdout_block_count;
            let end = ((slot + 1) * blocks.len() / holdout_block_count).max(start + 1);
            let width = end.saturating_sub(start);
            let mut mixed = (slot as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15)
                ^ (blocks.len() as u64).rotate_left(17);
            mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            mixed ^= mixed >> 31;
            start + usize::try_from(mixed % width as u64).unwrap_or(0)
        })
        .collect::<Vec<_>>();
    block_indices.sort_unstable();
    block_indices.dedup();

    let mut selected_blocks = HashSet::new();
    for block_index in block_indices {
        let Some(block) = blocks.get(block_index).copied() else {
            continue;
        };
        let Some(block_source_indices) = source_indices_by_block.get(&block) else {
            continue;
        };
        let removed_source_count = block_source_indices
            .iter()
            .filter(|source_index| source_indices.remove(source_index))
            .count();
        if source_indices.len() < minimum_training_count {
            source_indices.extend(block_source_indices.iter().copied());
            debug_assert_eq!(removed_source_count, block_source_indices.len());
            continue;
        }
        selected_blocks.insert(block);
    }

    if selected_blocks.len() >= 2 {
        selected_blocks
    } else {
        HashSet::new()
    }
}

fn evaluate_affine_holdout(
    observations: &[LandmarkObservation],
    held_out_time_blocks: &HashSet<i64>,
    scale: f64,
    offset: f64,
    residual_tolerance_ms: i64,
) -> Vec<AffineAnchorEvidence> {
    #[derive(Debug)]
    struct HoldoutCandidate {
        source_index: usize,
        target_index: usize,
        source_time_ms: i64,
        signed_residual_ms: i64,
        anchor: AffineAnchorEvidence,
    }

    let candidates = observations
        .iter()
        .filter(|item| {
            held_out_time_blocks.contains(&affine_holdout_time_block(item.source_time_ms))
        })
        .map(|observation| {
            let signed_residual_ms = (observation.target_time_ms as f64
                - (scale * observation.source_time_ms as f64 + offset))
                .round() as i64;
            HoldoutCandidate {
                source_index: observation.source_index,
                target_index: observation.target_index,
                source_time_ms: observation.source_time_ms,
                signed_residual_ms,
                anchor: AffineAnchorEvidence {
                    source_time_ms: observation.source_time_ms,
                    target_time_ms: observation.target_time_ms,
                    residual_ms: signed_residual_ms.abs(),
                },
            }
        })
        .collect::<Vec<_>>();
    let mut support_cells =
        HashMap::<(i64, i64), (HashSet<usize>, HashSet<usize>, HashSet<i64>, HashSet<i64>)>::new();
    for candidate in &candidates {
        let time_bucket = candidate
            .source_time_ms
            .div_euclid(AFFINE_HOLDOUT_CONSENSUS_TIME_BUCKET_MS);
        let offset_bucket = candidate
            .signed_residual_ms
            .div_euclid(AFFINE_HOLDOUT_CONSENSUS_OFFSET_QUANTUM_MS);
        let cell = support_cells
            .entry((time_bucket, offset_bucket))
            .or_default();
        cell.0.insert(candidate.source_index);
        cell.1.insert(candidate.target_index);
        cell.2.insert(
            candidate
                .source_time_ms
                .div_euclid(AFFINE_HOLDOUT_CONSENSUS_EVIDENCE_TIME_QUANTUM_MS),
        );
        cell.3.insert(
            candidate
                .anchor
                .target_time_ms
                .div_euclid(AFFINE_HOLDOUT_CONSENSUS_EVIDENCE_TIME_QUANTUM_MS),
        );
    }

    let mut best_by_source = HashMap::<usize, AffineAnchorEvidence>::new();
    for candidate in candidates {
        let globally_consistent =
            candidate.anchor.residual_ms.unsigned_abs() <= residual_tolerance_ms.unsigned_abs();
        let locally_supported = if globally_consistent {
            true
        } else {
            let time_bucket = candidate
                .source_time_ms
                .div_euclid(AFFINE_HOLDOUT_CONSENSUS_TIME_BUCKET_MS);
            let offset_bucket = candidate
                .signed_residual_ms
                .div_euclid(AFFINE_HOLDOUT_CONSENSUS_OFFSET_QUANTUM_MS);
            let mut source_support = HashSet::<usize>::new();
            let mut target_support = HashSet::<usize>::new();
            let mut source_time_support = HashSet::<i64>::new();
            let mut target_time_support = HashSet::<i64>::new();
            'support: for adjacent_time in (time_bucket
                - AFFINE_HOLDOUT_CONSENSUS_TIME_RADIUS_BUCKETS)
                ..=(time_bucket + AFFINE_HOLDOUT_CONSENSUS_TIME_RADIUS_BUCKETS)
            {
                for adjacent_offset in (offset_bucket - 1)..=(offset_bucket + 1) {
                    if let Some((sources, targets, source_times, target_times)) =
                        support_cells.get(&(adjacent_time, adjacent_offset))
                    {
                        source_support.extend(sources);
                        target_support.extend(targets);
                        source_time_support.extend(source_times);
                        target_time_support.extend(target_times);
                        if source_support.len() >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                            && target_support.len() >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                            && source_time_support.len()
                                >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                            && target_time_support.len()
                                >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                        {
                            break 'support;
                        }
                    }
                }
            }
            source_support.len() >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                && target_support.len() >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                && source_time_support.len() >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
                && target_time_support.len() >= AFFINE_HOLDOUT_CONSENSUS_MIN_UNIQUE_SUPPORT
        };
        if !locally_supported {
            continue;
        }
        let replace = best_by_source
            .get(&candidate.source_index)
            .map(|current| {
                candidate.anchor.residual_ms < current.residual_ms
                    || (candidate.anchor.residual_ms == current.residual_ms
                        && candidate.anchor.target_time_ms < current.target_time_ms)
            })
            .unwrap_or(true);
        if replace {
            best_by_source.insert(candidate.source_index, candidate.anchor);
        }
    }
    let mut result = best_by_source.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.target_time_ms.cmp(&right.target_time_ms))
    });
    result
}

fn select_unique_monotonic_inliers(
    observations: &[LandmarkObservation],
    scale: f64,
    offset: f64,
    tolerance_ms: i64,
) -> Vec<ModelInlier> {
    let mut best_by_source = HashMap::<usize, ModelInlier>::new();
    for observation in observations {
        let predicted = scale * observation.source_time_ms as f64 + offset;
        let residual = (observation.target_time_ms as f64 - predicted)
            .abs()
            .round() as i64;
        if residual > tolerance_ms {
            continue;
        }
        let candidate = ModelInlier {
            source_index: observation.source_index,
            target_index: observation.target_index,
            source_time_ms: observation.source_time_ms,
            target_time_ms: observation.target_time_ms,
            residual_ms: residual,
        };
        let replace = best_by_source
            .get(&observation.source_index)
            .map(|current| {
                candidate.residual_ms < current.residual_ms
                    || (candidate.residual_ms == current.residual_ms
                        && candidate.target_time_ms < current.target_time_ms)
            })
            .unwrap_or(true);
        if replace {
            best_by_source.insert(observation.source_index, candidate);
        }
    }
    let mut candidates = best_by_source.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.source_index.cmp(&right.source_index))
    });
    let mut used_targets = HashSet::new();
    let mut monotonic = Vec::new();
    let mut previous_target_ms = i64::MIN;
    for candidate in candidates {
        if candidate.target_time_ms <= previous_target_ms
            || !used_targets.insert(candidate.target_index)
        {
            continue;
        }
        previous_target_ms = candidate.target_time_ms;
        monotonic.push(candidate);
    }
    monotonic
}

fn least_squares_affine(inliers: &[ModelInlier]) -> Option<(f64, f64)> {
    if inliers.len() < 2 {
        return None;
    }
    let source_mean = inliers
        .iter()
        .map(|item| item.source_time_ms as f64)
        .sum::<f64>()
        / inliers.len() as f64;
    let target_mean = inliers
        .iter()
        .map(|item| item.target_time_ms as f64)
        .sum::<f64>()
        / inliers.len() as f64;
    let numerator = inliers
        .iter()
        .map(|item| {
            (item.source_time_ms as f64 - source_mean) * (item.target_time_ms as f64 - target_mean)
        })
        .sum::<f64>();
    let denominator = inliers
        .iter()
        .map(|item| (item.source_time_ms as f64 - source_mean).powi(2))
        .sum::<f64>();
    if denominator <= f64::EPSILON {
        return None;
    }
    let scale = numerator / denominator;
    Some((scale, target_mean - scale * source_mean))
}

fn compare_coarse_hypotheses(
    left: &CoarseAffineHypothesis,
    right: &CoarseAffineHypothesis,
) -> std::cmp::Ordering {
    right
        .inlier_count
        .cmp(&left.inlier_count)
        .then_with(|| left.p95_residual_ms.cmp(&right.p95_residual_ms))
        .then_with(|| {
            right
                .unique_source_coverage
                .total_cmp(&left.unique_source_coverage)
        })
        .then_with(|| {
            right
                .unique_target_coverage
                .total_cmp(&left.unique_target_coverage)
        })
        .then_with(|| left.offset_ms.abs().cmp(&right.offset_ms.abs()))
        .then_with(|| left.scale.total_cmp(&right.scale))
}

#[allow(dead_code)] // Used by the retained legacy Top-K compatibility path.
fn calculate_hypothesis_margin(hypotheses: &[AffineHypothesis], config: &AffineMatchConfig) -> f64 {
    let Some(first) = hypotheses.first() else {
        return 0.0;
    };
    let score = |item: &AffineHypothesis| {
        item.inlier_count as f64
            - item.p95_residual_ms as f64 / (config.residual_tolerance_ms as f64 * 2.0)
    };
    let first_score = score(first).max(0.001);
    let second_score = hypotheses.get(1).map(score).unwrap_or(0.0);
    ((first_score - second_score) / first_score).clamp(0.0, 1.0)
}

fn calculate_coarse_hypothesis_margin(
    hypotheses: &[CoarseAffineHypothesis],
    config: &AffineMatchConfig,
) -> f64 {
    let Some(first) = hypotheses.first() else {
        return 0.0;
    };
    let score = |item: &CoarseAffineHypothesis| {
        item.inlier_count as f64
            - item.p95_residual_ms as f64 / (config.residual_tolerance_ms as f64 * 2.0)
    };
    let first_score = score(first).max(0.001);
    let second_score = hypotheses.get(1).map(score).unwrap_or(0.0);
    ((first_score - second_score) / first_score).clamp(0.0, 1.0)
}

fn percentile(sorted: &[i64], quantile: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * quantile).ceil() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn validate_feature_sequences(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
) -> Result<(), String> {
    for (label, frames) in [("来源", source), ("目标", target)] {
        let mut previous_time = None;
        let mut previous_presentation_time = None;
        for frame in frames {
            if frame.values.is_empty() || frame.values.iter().any(|value| !value.is_finite()) {
                return Err(format!("{label}细粒度特征为空或包含非有限值。"));
            }
            if previous_time.is_some_and(|previous| frame.time_ms <= previous) {
                return Err(format!("{label}细粒度特征时间戳不是严格递增。"));
            }
            if previous_presentation_time
                .is_some_and(|previous| frame.presentation_time_ms <= previous)
            {
                return Err(format!(
                    "{label}细粒度特征 presentation 时间戳不是严格递增。"
                ));
            }
            previous_time = Some(frame.time_ms);
            previous_presentation_time = Some(frame.presentation_time_ms);
        }
    }
    if let (Some(source_width), Some(target_width)) = (
        source.first().map(|frame| frame.values.len()),
        target.first().map(|frame| frame.values.len()),
    ) {
        if source_width != target_width
            || source
                .iter()
                .any(|frame| frame.values.len() != source_width)
            || target
                .iter()
                .any(|frame| frame.values.len() != target_width)
        {
            return Err("来源与目标细粒度特征维度不一致。".to_string());
        }
    }
    Ok(())
}

fn validate_edit_config(config: &EditAlignmentConfig) -> Result<(), String> {
    if config.band_radius_ms <= 0
        || config.max_dp_cells == 0
        || config.gap_open_cost <= 0
        || config.gap_extend_cost <= 0
        || config.gap_open_cost < config.gap_extend_cost
        || config.ambiguous_match_cost <= 0
    {
        return Err("EditAlignmentConfig 的窄带与 affine gap 参数必须为正。".to_string());
    }
    Ok(())
}

fn target_band_range(
    target: &[FineFeatureFrame],
    predicted_target_ms: f64,
    band_radius_ms: i64,
) -> (usize, usize) {
    let lower = (predicted_target_ms - band_radius_ms as f64).floor() as i64;
    let upper = (predicted_target_ms + band_radius_ms as f64).ceil() as i64;
    let start = target.partition_point(|frame| frame.time_ms < lower);
    let end = target.partition_point(|frame| frame.time_ms <= upper);
    // DP 的矩阵索引比 frame 索引大 1，end 本身就是半开上界所需的矩阵索引。
    (start + 1, end + 1)
}

fn is_inside_affine_band(
    source: &FineFeatureFrame,
    target: &FineFeatureFrame,
    coarse: &AffineHypothesis,
    band_radius_ms: i64,
) -> bool {
    let predicted = coarse.scale * source.time_ms as f64 + coarse.offset_ms as f64;
    (target.time_ms as f64 - predicted).abs() <= band_radius_ms as f64
}

fn precompute_feature_norms(
    frames: &[FineFeatureFrame],
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<f64>, String> {
    let mut norms = Vec::new();
    norms
        .try_reserve_exact(frames.len())
        .map_err(|error| format!("细粒度 DP feature norm 内存预留失败：{error}"))?;
    for (index, frame) in frames.iter().enumerate() {
        if index.is_multiple_of(EDIT_DP_NORM_CANCEL_INTERVAL) {
            check_algorithm_cancelled(cancel_flag)?;
        }
        norms.push(feature_norm(&frame.values));
    }
    Ok(norms)
}

fn feature_dot(left: &[f32], right: &[f32]) -> f64 {
    left.iter()
        .zip(right)
        .map(|(left, right)| *left as f64 * *right as f64)
        .sum::<f64>()
}

fn feature_norm(values: &[f32]) -> f64 {
    values
        .iter()
        .map(|value| (*value as f64).powi(2))
        .sum::<f64>()
        .sqrt()
}

fn feature_distance_cost_with_norms(
    left: &[f32],
    right: &[f32],
    left_norm: f64,
    right_norm: f64,
) -> i64 {
    let dot = feature_dot(left, right);
    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        return 1_000;
    }
    ((1.0 - dot / (left_norm * right_norm)).clamp(0.0, 2.0) * 1_000.0).round() as i64
}

#[cfg(test)]
fn feature_distance_cost(left: &[f32], right: &[f32]) -> i64 {
    // Preserve the original operation order for the full-matrix parity oracle: dot first, then
    // each norm, then the norm product/division/clamp/round sequence.
    feature_distance_cost_with_norms(left, right, feature_norm(left), feature_norm(right))
}

fn feature_context_distance_cost_with_norms(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
    source_index: usize,
    target_index: usize,
    source_norms: &[f64],
    target_norms: &[f64],
) -> i64 {
    let backward = EDIT_DP_CONTEXT_RADIUS_FRAMES.min(source_index.min(target_index));
    let forward = EDIT_DP_CONTEXT_RADIUS_FRAMES.min(
        source
            .len()
            .saturating_sub(source_index + 1)
            .min(target.len().saturating_sub(target_index + 1)),
    );
    let mut total_cost = 0i64;
    let mut observation_count = 0i64;
    for offset in -(backward as isize)..=(forward as isize) {
        let source_context_index = source_index.wrapping_add_signed(offset);
        let target_context_index = target_index.wrapping_add_signed(offset);
        total_cost = total_cost.saturating_add(feature_distance_cost_with_norms(
            &source[source_context_index].values,
            &target[target_context_index].values,
            source_norms[source_context_index],
            target_norms[target_context_index],
        ));
        observation_count += 1;
    }
    (total_cost + observation_count / 2) / observation_count
}

fn select_min_state(matched: i64, source_only: i64, target_only: i64) -> (u8, i64) {
    select_min_candidate(&[
        (STATE_MATCHED, matched),
        (STATE_SOURCE_ONLY, source_only),
        (STATE_TARGET_ONLY, target_only),
    ])
}

fn select_min_candidate(candidates: &[(u8, i64)]) -> (u8, i64) {
    candidates
        .iter()
        .copied()
        .min_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)))
        .unwrap_or((STATE_NONE, COST_INFINITY))
}

fn add_cost(base: i64, addition: i64) -> i64 {
    if base >= COST_INFINITY {
        COST_INFINITY
    } else {
        base.saturating_add(addition).min(COST_INFINITY)
    }
}

fn select_alignment_endpoint_from_final_row(
    source_len: usize,
    target_len: usize,
    mode: EditAlignmentMode,
    matched_costs: &[i64],
    source_only_costs: &[i64],
    target_only_costs: &[i64],
    cancel_flag: Option<&AtomicBool>,
) -> Result<(usize, usize, u8, i64), String> {
    let target_range = if mode == EditAlignmentMode::Global {
        target_len..=target_len
    } else {
        0..=target_len
    };
    let mut endpoint = None::<(usize, usize, u8, i64)>;
    for target_index in target_range {
        if target_index.is_multiple_of(EDIT_DP_WIDE_LOOP_CANCEL_INTERVAL) {
            check_algorithm_cancelled(cancel_flag)?;
        }
        for (state, cost) in [
            (STATE_MATCHED, matched_costs[target_index]),
            (STATE_SOURCE_ONLY, source_only_costs[target_index]),
            (STATE_TARGET_ONLY, target_only_costs[target_index]),
        ] {
            let candidate = (source_len, target_index, state, cost);
            if endpoint
                .as_ref()
                .is_none_or(|current| compare_alignment_endpoints(&candidate, current).is_lt())
            {
                endpoint = Some(candidate);
            }
        }
    }
    let endpoint = endpoint.ok_or_else(|| "细粒度 DP 没有终点。".to_string())?;
    if endpoint.3 >= COST_INFINITY {
        return Err("粗仿射窄带内不存在完整单调路径。".to_string());
    }
    Ok(endpoint)
}

fn compare_alignment_endpoints(
    left: &(usize, usize, u8, i64),
    right: &(usize, usize, u8, i64),
) -> std::cmp::Ordering {
    left.3
        .cmp(&right.3)
        .then_with(|| right.1.cmp(&left.1))
        .then_with(|| left.2.cmp(&right.2))
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn select_alignment_endpoint(
    source_len: usize,
    target_len: usize,
    width: usize,
    mode: EditAlignmentMode,
    matched_costs: &[i64],
    source_only_costs: &[i64],
    target_only_costs: &[i64],
) -> Result<(usize, usize, u8, i64), String> {
    let mut endpoints = Vec::new();
    if mode == EditAlignmentMode::Global {
        let index = source_len * width + target_len;
        for (state, cost) in [
            (STATE_MATCHED, matched_costs[index]),
            (STATE_SOURCE_ONLY, source_only_costs[index]),
            (STATE_TARGET_ONLY, target_only_costs[index]),
        ] {
            endpoints.push((source_len, target_len, state, cost));
        }
    } else {
        for target_index in 0..=target_len {
            let index = source_len * width + target_index;
            for (state, cost) in [
                (STATE_MATCHED, matched_costs[index]),
                (STATE_SOURCE_ONLY, source_only_costs[index]),
                (STATE_TARGET_ONLY, target_only_costs[index]),
            ] {
                endpoints.push((source_len, target_index, state, cost));
            }
        }
    }
    let endpoint = endpoints
        .into_iter()
        .min_by(compare_alignment_endpoints)
        .ok_or_else(|| "细粒度 DP 没有终点。".to_string())?;
    if endpoint.3 >= COST_INFINITY {
        return Err("粗仿射窄带内不存在完整单调路径。".to_string());
    }
    Ok(endpoint)
}

fn create_frame_boundaries(frames: &[FineFeatureFrame]) -> Result<Vec<i64>, String> {
    if frames.is_empty() {
        return Err("无法为空特征创建时间边界。".to_string());
    }
    let hop_ms = if frames.len() >= 2 {
        let mut differences = frames
            .windows(2)
            .map(|window| window[1].presentation_time_ms - window[0].presentation_time_ms)
            .collect::<Vec<_>>();
        differences.sort_unstable();
        differences[differences.len() / 2]
    } else {
        1
    };
    let mut boundaries = frames
        .iter()
        .map(|frame| frame.presentation_time_ms)
        .collect::<Vec<_>>();
    boundaries.push(
        frames
            .last()
            .and_then(|frame| frame.presentation_time_ms.checked_add(hop_ms))
            .ok_or_else(|| "特征尾边界毫秒溢出。".to_string())?,
    );
    Ok(boundaries)
}

fn collapse_opposite_gap_runs(path: Vec<EditPathStep>) -> Vec<EditPathStep> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < path.len() {
        if !matches!(
            path[index].kind,
            EditPathKind::SourceOnly | EditPathKind::TargetOnly
        ) {
            output.push(path[index].clone());
            index += 1;
            continue;
        }
        let start = index;
        let mut has_source_only = false;
        let mut has_target_only = false;
        while index < path.len()
            && matches!(
                path[index].kind,
                EditPathKind::SourceOnly | EditPathKind::TargetOnly
            )
        {
            has_source_only |= path[index].kind == EditPathKind::SourceOnly;
            has_target_only |= path[index].kind == EditPathKind::TargetOnly;
            index += 1;
        }
        if has_source_only && has_target_only {
            let run = &path[start..index];
            let source_start_ms = run
                .iter()
                .map(|step| step.source_start_ms)
                .min()
                .unwrap_or(0);
            let source_end_ms = run
                .iter()
                .map(|step| step.source_end_ms)
                .max()
                .unwrap_or(source_start_ms);
            let target_start_ms = run
                .iter()
                .map(|step| step.target_start_ms)
                .min()
                .unwrap_or(0);
            let target_end_ms = run
                .iter()
                .map(|step| step.target_end_ms)
                .max()
                .unwrap_or(target_start_ms);
            output.push(EditPathStep {
                kind: EditPathKind::Ambiguous,
                source_start_ms,
                source_end_ms,
                target_start_ms,
                target_end_ms,
                local_cost: run.iter().map(|step| step.local_cost).sum(),
            });
        } else {
            output.extend(path[start..index].iter().cloned());
        }
    }
    output
}

fn merge_path_to_spans(path: &[EditPathStep]) -> Vec<EditTimeSpan> {
    let mut spans = Vec::<EditTimeSpan>::new();
    for step in path {
        if let Some(previous) = spans.last_mut() {
            if previous.kind == step.kind
                && previous.source_end_ms == step.source_start_ms
                && previous.target_end_ms == step.target_start_ms
            {
                previous.source_end_ms = step.source_end_ms;
                previous.target_end_ms = step.target_end_ms;
                continue;
            }
        }
        spans.push(EditTimeSpan {
            kind: step.kind,
            source_start_ms: step.source_start_ms,
            source_end_ms: step.source_end_ms,
            target_start_ms: step.target_start_ms,
            target_end_ms: step.target_end_ms,
        });
    }
    spans
}

fn validate_monotonic_spans(spans: &[EditTimeSpan]) -> Result<(), String> {
    for span in spans {
        if span.source_end_ms < span.source_start_ms || span.target_end_ms < span.target_start_ms {
            return Err("编辑路径生成了反向区间。".to_string());
        }
    }
    for pair in spans.windows(2) {
        if pair[0].source_end_ms != pair[1].source_start_ms
            || pair[0].target_end_ms != pair[1].target_start_ms
        {
            return Err("编辑路径生成了交叉或不连续区间。".to_string());
        }
    }
    Ok(())
}

fn validate_boundary_config(config: &BoundaryRefinementConfig) -> Result<(), String> {
    if config.sample_rate == 0
        || config.search_radius_ms < 0
        || config.search_step_ms <= 0
        || config.search_step_ms > config.search_radius_ms.max(1)
        || config.window_ms <= 0
        || !config.score_tolerance.is_finite()
        || config.score_tolerance < 0.0
        || !config.min_correlation.is_finite()
        || !(-1.0..=1.0).contains(&config.min_correlation)
        || !config.min_alternative_margin.is_finite()
        || config.min_alternative_margin < 0.0
        || config.max_uncertainty_ms < 0
    {
        return Err("BoundaryRefinementConfig 无效。".to_string());
    }
    Ok(())
}

fn timeline_ms_to_sample(
    time_ms: i64,
    presentation_offset_ms: i64,
    sample_rate: u32,
) -> Result<usize, String> {
    let relative_ms = time_ms
        .checked_sub(presentation_offset_ms)
        .ok_or_else(|| "时间减 presentation offset 溢出。".to_string())?;
    if relative_ms < 0 {
        return Err("边界早于 PCM presentation offset。".to_string());
    }
    milliseconds_to_samples(relative_ms, sample_rate)
}

fn milliseconds_to_samples(milliseconds: i64, sample_rate: u32) -> Result<usize, String> {
    if milliseconds < 0 || sample_rate == 0 {
        return Err("毫秒或采样率无效。".to_string());
    }
    let samples = (milliseconds as i128 * sample_rate as i128 + 500) / 1_000;
    usize::try_from(samples).map_err(|_| "毫秒换算采样点溢出。".to_string())
}

fn samples_to_milliseconds(samples: usize, sample_rate: u32) -> i64 {
    ((samples as i128 * 1_000 + sample_rate as i128 / 2) / sample_rate as i128) as i64
}

fn centered_window(samples: &[i16], center: usize, length: usize) -> Option<&[i16]> {
    let start = center.checked_sub(length / 2)?;
    let end = start.checked_add(length)?;
    samples.get(start..end)
}

fn boundary_window(
    samples: &[i16],
    center: usize,
    length: usize,
    mode: BoundaryWindowMode,
) -> Option<&[i16]> {
    match mode {
        BoundaryWindowMode::Centered => centered_window(samples, center, length),
        BoundaryWindowMode::OneSided(BoundaryContextSide::Before) => {
            let start = center.checked_sub(length)?;
            samples.get(start..center)
        }
        BoundaryWindowMode::OneSided(BoundaryContextSide::After) => {
            let end = center.checked_add(length)?;
            samples.get(center..end)
        }
    }
}

fn normalized_cross_correlation(left: &[i16], right: &[i16]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return -1.0;
    }
    let left_mean = left.iter().map(|value| *value as f64).sum::<f64>() / left.len() as f64;
    let right_mean = right.iter().map(|value| *value as f64).sum::<f64>() / right.len() as f64;
    let mut numerator = 0.0;
    let mut left_energy = 0.0;
    let mut right_energy = 0.0;
    for (left, right) in left.iter().zip(right) {
        let centered_left = *left as f64 - left_mean;
        let centered_right = *right as f64 - right_mean;
        numerator += centered_left * centered_right;
        left_energy += centered_left * centered_left;
        right_energy += centered_right * centered_right;
    }
    let denominator = (left_energy * right_energy).sqrt();
    if denominator <= f64::EPSILON {
        0.0
    } else {
        (numerator / denominator).clamp(-1.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landmark_extraction_uses_presentation_offset_and_suppresses_silence() {
        let config = LandmarkConfig {
            sample_rate: 8_000,
            presentation_offset_ms: 750,
            max_hash_occurrences: 20,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(config.sample_rate, &[310, 470, 690, 930, 1_270, 1_610]);
        let landmarks = extract_landmarks(&pcm, &config).unwrap();
        assert!(!landmarks.is_empty());
        assert!(landmarks.iter().all(|item| item.time_ms >= 750));
        let mut family_counts = HashMap::<u64, usize>::new();
        for landmark in &landmarks {
            *family_counts
                .entry(landmark_family(landmark.hash))
                .or_default() += 1;
        }
        assert!(family_counts.values().all(|count| *count <= 20));
        assert!(extract_landmarks(&vec![0; pcm.len()], &config)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn streaming_landmarks_match_one_shot_across_stft_and_temporal_seams() {
        let config = LandmarkConfig {
            sample_rate: 8_000,
            presentation_offset_ms: 913,
            window_ms: 40,
            hop_ms: 25,
            max_hash_occurrences: 10_000,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(
            config.sample_rate,
            &[310, 470, 690, 930, 1_270, 1_610, 430, 770],
        );
        let expected = extract_landmarks(&pcm, &config).unwrap();
        assert!(!expected.is_empty());

        let seam_chunks = [1, 318, 1, 1, 199, 1, 200, 319, 7, 401, 23, 809];
        let actual = stream_landmarks_with_chunks(&pcm, &config, &seam_chunks);

        assert!(actual.exact_one_shot_equivalent);
        assert_eq!(actual.capped_family_count, 0);
        assert_eq!(actual.landmarks, expected);
    }

    #[test]
    fn streaming_landmarks_are_chunk_invariant_for_random_partitions() {
        let config = LandmarkConfig {
            sample_rate: 16_000,
            presentation_offset_ms: -275,
            window_ms: 50,
            hop_ms: 50,
            max_hash_occurrences: 10_000,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(
            config.sample_rate,
            &[280, 390, 540, 720, 980, 1_310, 1_760, 2_230],
        );
        let expected = extract_landmarks(&pcm, &config).unwrap();
        for seed in 1..=12u64 {
            let chunks = pseudo_random_chunk_sizes(seed, pcm.len());
            let actual = stream_landmarks_with_chunks(&pcm, &config, &chunks);
            assert!(actual.exact_one_shot_equivalent, "seed={seed}");
            assert_eq!(actual.landmarks, expected, "seed={seed}");
        }
    }

    #[test]
    fn streaming_coarse_fingerprint_persists_log_rms_envelope() {
        let config = LandmarkConfig {
            sample_rate: 16_000,
            presentation_offset_ms: 250,
            window_ms: 50,
            hop_ms: 50,
            max_hash_occurrences: 10_000,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(
            config.sample_rate,
            &[220, 330, 550, 880, 1_320, 1_760, 440, 660],
        );
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();
        let extraction =
            stream_landmarks_with_backend_chunks(&pcm, &config, &[137, 509, 997], &cpu_request);

        assert!(!extraction.coarse_fingerprint.is_empty());
        assert!(extraction
            .coarse_fingerprint
            .iter()
            .all(|frame| frame.log_rms_milli <= 12_000));
        assert!(extraction
            .coarse_fingerprint
            .iter()
            .any(|frame| frame.log_rms_milli > 0));
        assert!(extraction
            .coarse_fingerprint
            .windows(2)
            .any(|pair| pair[0].log_rms_milli != pair[1].log_rms_milli));
    }

    #[test]
    fn streaming_cuda_landmarks_match_cpu_across_pcm_chunk_seams() {
        let require_cuda = std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1")
            || std::env::var("C137_SPECTRAL_BACKEND").as_deref() == Ok("cuda");
        let cuda_request =
            match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
                Ok(request) => request,
                Err(error) if !require_cuda => {
                    eprintln!("skip streaming CUDA equivalence: {error}");
                    return;
                }
                Err(error) => panic!("CUDA was required for streaming equivalence: {error}"),
            };
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();
        let config = LandmarkConfig {
            sample_rate: 16_000,
            presentation_offset_ms: 417,
            window_ms: 40,
            hop_ms: 25,
            max_hash_occurrences: 10_000,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(
            config.sample_rate,
            &[173, 331, 719, 1_237, 2_411, 283, 467, 881, 1_661],
        );
        let chunks = pseudo_random_chunk_sizes(137, pcm.len());
        let cpu = stream_landmarks_with_backend_chunks(&pcm, &config, &chunks, &cpu_request);
        let cuda = stream_landmarks_with_backend_chunks(&pcm, &config, &chunks, &cuda_request);

        assert_eq!(
            cpu.spectral_backend.backend_id,
            STREAMING_CPU_SPECTRAL_BACKEND_ID
        );
        assert_eq!(cuda.spectral_backend.backend_id, CUDA_FFT_BACKEND_ID);
        assert_eq!(cuda.spectral_backend.requested_backend, "cuda");
        assert_eq!(cuda.index, cpu.index);
        assert_eq!(cuda.coarse_fingerprint, cpu.coarse_fingerprint);
    }

    #[test]
    fn streaming_cuda_batches_stay_bounded_across_pcm_and_gpu_batch_seams() {
        let request = match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("skip streaming CUDA state bound: {error}");
                return;
            }
        };
        let config = LandmarkConfig {
            sample_rate: 16_000,
            window_ms: 40,
            hop_ms: 25,
            ..LandmarkConfig::default()
        };
        let window_samples =
            milliseconds_to_samples(config.window_ms as i64, config.sample_rate).unwrap();
        let hop_samples =
            milliseconds_to_samples(config.hop_ms as i64, config.sample_rate).unwrap();
        let expected_frames = CUDA_FFT_DEFAULT_BATCH_FRAMES + 17;
        let sample_count = window_samples + (expected_frames - 1) * hop_samples;
        let pcm = synth_streaming_chirp(config.sample_rate, sample_count);
        let mut extractor =
            StreamingLandmarkExtractor::new_with_backend_request(config, &request).unwrap();
        let mut previous_pending = 0usize;
        let mut observed_gpu_batch_flush = false;
        for chunk in pcm.chunks(997) {
            extractor.push_pcm(chunk).unwrap();
            let usage = extractor.state_usage();
            assert!(usage.pending_spectral_frames <= CUDA_FFT_DEFAULT_BATCH_FRAMES);
            assert_eq!(
                usage.pending_cuda_input_samples,
                usage.pending_spectral_frames * CUDA_FFT_FRAME_LEN
            );
            observed_gpu_batch_flush |= usage.pending_spectral_frames < previous_pending;
            previous_pending = usage.pending_spectral_frames;
        }
        assert!(observed_gpu_batch_flush);
        assert_eq!(extractor.next_frame_index, expected_frames);
        assert_eq!(extractor.spectral_backend().backend_id, CUDA_FFT_BACKEND_ID);
        let result = extractor.finish_with_backend().unwrap();
        assert_eq!(result.spectral_backend.backend_id, CUDA_FFT_BACKEND_ID);
    }

    #[test]
    fn streaming_cuda_policy_falls_back_only_for_auto_and_forced_cuda_is_fail_closed() {
        let config = LandmarkConfig {
            sample_rate: 4_000,
            window_ms: 50,
            hop_ms: 50,
            ..LandmarkConfig::default()
        };
        let auto_request = SpectralBackendRequest {
            preference: SpectralBackendPreference::Auto,
            planned_backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "auto".to_string(),
            backend_detail: "test CUDA".to_string(),
            fallback_reason: None,
        };
        let auto =
            StreamingLandmarkExtractor::new_with_backend_request(config.clone(), &auto_request)
                .unwrap();
        assert_eq!(
            auto.spectral_backend().backend_id,
            STREAMING_CPU_SPECTRAL_BACKEND_ID
        );
        assert!(auto
            .spectral_backend()
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("显式回退 CPU")));

        let forced_request = SpectralBackendRequest {
            preference: SpectralBackendPreference::Cuda,
            planned_backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "cuda".to_string(),
            backend_detail: "test CUDA".to_string(),
            fallback_reason: None,
        };
        let error = StreamingLandmarkExtractor::new_with_backend_request(config, &forced_request)
            .unwrap_err();
        assert!(error.starts_with("blocked:cuda-fft-runtime"));
    }

    #[test]
    fn streaming_hybrid_fallback_preserves_cuda_runtime_identity() {
        let create_backend = |runtime_detail: &str| SpectralBackendExecution {
            backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "auto".to_string(),
            backend_detail: runtime_detail.to_string(),
            fallback_reason: None,
        };
        let first_cuda_detail = "CUDA/cuFFT device #0 RTX 4090; bindings=CUDA 13.x ABI via cudarc 0.19.8; driverLibrary=nvcuda.dll; cufftLibrary=cufft64_12.dll; driverRuntime=13030; cufftRuntime=12300";
        let second_cuda_detail = "CUDA/cuFFT device #0 RTX 4090; bindings=CUDA 13.x ABI via cudarc 0.19.8; driverLibrary=nvcuda.dll; cufftLibrary=cufft64_12.dll; driverRuntime=13040; cufftRuntime=12400";
        let mut first = create_backend(first_cuda_detail);
        let mut second = create_backend(second_cuda_detail);

        apply_streaming_cuda_fallback_identity(&mut first, 4_096, "fixture runtime failure");
        apply_streaming_cuda_fallback_identity(&mut second, 4_096, "fixture runtime failure");

        assert_eq!(first.backend_id, STREAMING_HYBRID_SPECTRAL_BACKEND_ID);
        assert_eq!(second.backend_id, STREAMING_HYBRID_SPECTRAL_BACKEND_ID);
        assert!(first.backend_detail.contains(first_cuda_detail));
        assert!(second.backend_detail.contains(second_cuda_detail));
        assert!(first
            .backend_detail
            .contains("execution=hybrid-cuda-then-cpu-streaming"));
        assert_ne!(first.backend_detail, second.backend_detail);
        assert_ne!(first, second);

        let mut zero_cuda_frames = create_backend(first_cuda_detail);
        apply_streaming_cuda_fallback_identity(
            &mut zero_cuda_frames,
            0,
            "fixture initialization failure",
        );
        assert_eq!(
            zero_cuda_frames.backend_id,
            STREAMING_CPU_SPECTRAL_BACKEND_ID
        );
        assert_eq!(zero_cuda_frames.backend_detail, "CPU 流式 radix-2 f64 FFT");
    }

    #[test]
    fn streaming_cuda_finish_observes_cancellation_before_flushing_pending_batch() {
        let request = match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("skip streaming CUDA cancellation: {error}");
                return;
            }
        };
        let config = LandmarkConfig {
            sample_rate: 16_000,
            window_ms: 40,
            hop_ms: 25,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(config.sample_rate, &[310, 470, 690, 930]);
        let mut extractor =
            StreamingLandmarkExtractor::new_with_backend_request(config, &request).unwrap();
        extractor.push_pcm(&pcm).unwrap();
        assert!(extractor.state_usage().pending_spectral_frames > 0);
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            extractor
                .finish_with_backend_and_cancel(Some(&cancelled))
                .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
    }

    #[test]
    fn streaming_landmark_state_stays_within_declared_bounds() {
        let config = LandmarkConfig {
            sample_rate: 8_000,
            window_ms: 50,
            hop_ms: 20,
            max_pair_delta_ms: 600,
            max_hash_occurrences: 7,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(
            config.sample_rate,
            &[300, 410, 560, 730, 950, 1_220, 1_570, 1_990, 2_430, 2_810],
        );
        let window_samples =
            milliseconds_to_samples(config.window_ms as i64, config.sample_rate).unwrap();
        let max_pending_frames =
            (config.max_pair_delta_ms as usize).div_ceil(config.hop_ms as usize) + 2;
        let mut extractor = StreamingLandmarkExtractor::new(config.clone()).unwrap();
        for chunk in pcm.chunks(37) {
            extractor.push_pcm(chunk).unwrap();
            let usage = extractor.state_usage();
            assert!(usage.stft_tail_samples < window_samples);
            assert!(usage.temporal_spectrum_count <= 2);
            assert!(usage.pending_anchor_frames <= max_pending_frames);
            assert!(
                usage.pending_anchor_peaks
                    <= max_pending_frames.saturating_mul(config.max_peaks_per_frame)
            );
            assert!(usage.coarse_family_count <= SPECTRAL_BIN_COUNT * SPECTRAL_BIN_COUNT);
            assert!(
                usage.retained_coarse_landmarks
                    <= SPECTRAL_BIN_COUNT * SPECTRAL_BIN_COUNT * config.max_hash_occurrences
            );
        }
        let result = extractor.finish().unwrap();
        assert_eq!(result.retained_landmark_count, result.landmarks.len());
    }

    #[test]
    fn media_coarse_index_reports_strict_capped_family_error_contract() {
        let mut index = MediaCoarseIndex::new(3).unwrap();
        let mut candidates = Vec::new();
        for ordinal in 0..11i64 {
            let landmark = SpectralLandmark {
                hash: create_landmark_hash(7, 13, 150),
                time_ms: ordinal * 250,
                strength_milli: 500 + ordinal as u32,
            };
            candidates.push(landmark.clone());
            index.push(landmark).unwrap();
        }
        let result = index.finish().unwrap();

        assert!(!result.exact_one_shot_equivalent);
        assert_eq!(result.observed_landmark_count, 11);
        assert_eq!(result.retained_landmark_count, 3);
        assert_eq!(result.capped_family_count, 1);
        assert_eq!(result.max_symmetric_difference_per_capped_family, 6);
        assert!(result
            .landmarks
            .iter()
            .all(|landmark| candidates.contains(landmark)));
    }

    #[test]
    fn streaming_capped_sampling_is_chunk_invariant() {
        let config = LandmarkConfig {
            sample_rate: 8_000,
            window_ms: 40,
            hop_ms: 25,
            max_hash_occurrences: 2,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(
            config.sample_rate,
            &[430, 430, 430, 430, 430, 430, 770, 770, 770, 770, 770, 770],
        );
        let single = stream_landmarks_with_chunks(&pcm, &config, &[pcm.len()]);
        let random =
            stream_landmarks_with_chunks(&pcm, &config, &pseudo_random_chunk_sizes(77, pcm.len()));

        assert_eq!(single, random);
        assert!(single
            .landmarks
            .iter()
            .all(|landmark| validate_streaming_landmark_hash(landmark.hash).is_ok()));
    }

    #[test]
    fn capped_sampling_retains_the_same_ordinals_across_pts_and_codec_perturbations() {
        let mut source = MediaCoarseIndex::new(5).unwrap();
        let mut target = MediaCoarseIndex::new(5).unwrap();
        for ordinal in 0..64i64 {
            source
                .push(SpectralLandmark {
                    hash: create_landmark_hash(7, 13, 150),
                    time_ms: ordinal * 250,
                    strength_milli: 500 + ordinal as u32,
                })
                .unwrap();
            target
                .push(SpectralLandmark {
                    hash: create_landmark_hash(7, 13, 175),
                    time_ms: ordinal * 250 + 12_345,
                    strength_milli: 900 + (63 - ordinal) as u32,
                })
                .unwrap();
        }

        let source = source.finish().unwrap();
        let target = target.finish().unwrap();
        assert_eq!(source.capped_family_count, 1);
        assert_eq!(target.capped_family_count, 1);
        let retained_positions = |items: &[SpectralLandmark], offset_ms: i64| {
            items
                .iter()
                .map(|item| item.time_ms - offset_ms)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            retained_positions(&source.landmarks, 0),
            retained_positions(&target.landmarks, 12_345)
        );
    }

    #[test]
    fn media_coarse_index_rejects_unbounded_family_limits_without_allocating() {
        let error = MediaCoarseIndex::new(usize::MAX).unwrap_err();
        assert!(error.contains("family 保留上限"));

        let config = LandmarkConfig {
            max_hash_occurrences: usize::MAX,
            ..LandmarkConfig::default()
        };
        assert!(StreamingLandmarkExtractor::new(config)
            .unwrap_err()
            .contains("family 保留上限"));
    }

    #[test]
    fn streaming_landmark_constructor_rejects_unbounded_window_and_pending_state() {
        let oversized_window = LandmarkConfig {
            sample_rate: u32::MAX,
            window_ms: 100,
            hop_ms: 50,
            ..LandmarkConfig::default()
        };
        assert!(StreamingLandmarkExtractor::new(oversized_window)
            .unwrap_err()
            .contains("STFT window"));

        let oversized_pending_window = LandmarkConfig {
            hop_ms: 20,
            min_pair_delta_ms: 20,
            max_pair_delta_ms: 100_000,
            ..LandmarkConfig::default()
        };
        assert!(StreamingLandmarkExtractor::new(oversized_pending_window)
            .unwrap_err()
            .contains("pending anchor frame"));
    }

    #[test]
    fn media_coarse_index_enforces_global_retained_landmark_budget() {
        let mut index = MediaCoarseIndex::new(MAX_STREAMING_HASH_OCCURRENCES_PER_FAMILY).unwrap();
        let complete_families =
            MAX_STREAMING_RETAINED_LANDMARKS / MAX_STREAMING_HASH_OCCURRENCES_PER_FAMILY;
        assert!(complete_families < SPECTRAL_BIN_COUNT);
        for anchor_bin in 0..complete_families {
            for ordinal in 0..MAX_STREAMING_HASH_OCCURRENCES_PER_FAMILY {
                index
                    .push(SpectralLandmark {
                        hash: create_landmark_hash(anchor_bin, 3, 150),
                        time_ms: ordinal as i64,
                        strength_milli: 1_000,
                    })
                    .unwrap();
            }
        }
        assert_eq!(
            index.retained_landmark_count(),
            MAX_STREAMING_RETAINED_LANDMARKS
        );
        let error = index
            .push(SpectralLandmark {
                hash: create_landmark_hash(complete_families, 3, 150),
                time_ms: 0,
                strength_milli: 1_000,
            })
            .unwrap_err();
        assert!(error.contains("全局上限"));
        assert_eq!(
            index.retained_landmark_count(),
            MAX_STREAMING_RETAINED_LANDMARKS
        );
    }

    #[test]
    fn streaming_landmark_push_and_finish_observe_cancellation() {
        let config = LandmarkConfig {
            sample_rate: 8_000,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(config.sample_rate, &[310, 470, 690, 930]);
        let cancelled = AtomicBool::new(true);
        let mut push_extractor = StreamingLandmarkExtractor::new(config.clone()).unwrap();
        assert_eq!(
            push_extractor
                .push_pcm_with_cancel(&pcm, Some(&cancelled))
                .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );

        let mut finish_extractor = StreamingLandmarkExtractor::new(config).unwrap();
        finish_extractor.push_pcm(&pcm).unwrap();
        assert_eq!(
            finish_extractor
                .finish_with_cancel(Some(&cancelled))
                .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
    }

    #[test]
    fn affine_matching_recovers_speed_drift_and_ignores_repeated_intro_decoy() {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for index in 0..12usize {
            let hash = (((100 + index) as u64) << 8) | 5;
            let source_time_ms = index as i64 * 1_000;
            source.push(test_landmark(hash, source_time_ms));
            target.push(test_landmark(
                hash,
                (source_time_ms as f64 * 1.02).round() as i64 + 5_000,
            ));
            if index < 3 {
                target.push(test_landmark(hash, source_time_ms));
            }
        }
        source.push(test_landmark((999u64 << 8) | 5, 12_000));
        target.sort_by_key(|item| item.time_ms);
        let result =
            match_landmarks_affine(&source, &target, &AffineMatchConfig::default()).unwrap();
        let best = result.hypotheses.first().unwrap();
        assert!((best.scale - 1.02).abs() < 0.001);
        assert!(best.offset_ms.abs_diff(5_000) <= 2);
        assert_eq!(best.unique_source_count + best.held_out_anchors.len(), 12);
        assert_eq!(best.held_out_anchors.len(), 3);
        assert!((best.unique_source_coverage - 9.0 / 13.0).abs() < 0.000_1);
        assert_eq!(best.unique_target_count, 9);
        assert!((best.unique_target_coverage - 9.0 / 15.0).abs() < 0.000_1);
        assert!(best.p95_residual_ms <= 1);
        assert!(best
            .held_out_anchors
            .iter()
            .all(|item| item.residual_ms <= 1));
        assert!(result.top1_top2_margin > 0.4);
    }

    #[test]
    fn affine_coarse_universe_preserves_legacy_top_k_and_full_evidence() {
        let (source, target) = affine_repeated_episode_fixture();
        let config = AffineMatchConfig {
            min_inliers: 6,
            top_k: 2,
            ..AffineMatchConfig::default()
        };

        let universe = match_landmarks_affine_coarse_universe(&source, &target, &config).unwrap();
        let legacy = match_landmarks_affine(&source, &target, &config).unwrap();
        let materialized = universe
            .hypotheses
            .iter()
            .take(config.top_k)
            .map(|hypothesis| {
                materialize_affine_hypothesis(&source, &target, &config, hypothesis).unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(legacy.hypotheses, materialized);
        assert_eq!(legacy.hypotheses.len(), config.top_k);
        assert_eq!(legacy.observation_count, universe.observation_count);
        assert_eq!(legacy.source_landmark_count, universe.source_landmark_count);
        assert_eq!(legacy.target_landmark_count, universe.target_landmark_count);
        assert_eq!(legacy.top1_top2_margin, universe.top1_top2_margin);
        assert!(legacy.hypotheses.iter().all(|hypothesis| {
            !hypothesis.training_anchors.is_empty() && !hypothesis.held_out_anchors.is_empty()
        }));
    }

    #[test]
    fn affine_coarse_universe_retains_candidates_beyond_legacy_top_k() {
        let (source, target) = affine_repeated_episode_fixture();
        let config = AffineMatchConfig {
            min_inliers: 6,
            top_k: 1,
            ..AffineMatchConfig::default()
        };

        let universe = match_landmarks_affine_coarse_universe(&source, &target, &config).unwrap();
        let legacy = match_landmarks_affine(&source, &target, &config).unwrap();

        assert_eq!(legacy.hypotheses.len(), 1);
        assert!(universe.hypotheses.len() > legacy.hypotheses.len());
        assert_eq!(
            legacy.hypotheses[0].offset_ms,
            universe.hypotheses[0].offset_ms
        );
        assert!(universe
            .hypotheses
            .iter()
            .any(|hypothesis| hypothesis.offset_ms.abs_diff(5_000) <= 2));
        assert!(universe
            .hypotheses
            .iter()
            .any(|hypothesis| hypothesis.offset_ms.abs_diff(-55_000) <= 2));
    }

    #[test]
    fn affine_coarse_universe_retains_sixth_candidate_beyond_legacy_top_five() {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for index in 0..25usize {
            let hash = (((20_000 + index) as u64) << 8) | 4;
            let episode_time_ms = index as i64 * 1_000;
            for episode in 0..7_i64 {
                source.push(test_landmark(hash, episode * 60_000 + episode_time_ms));
            }
            target.push(test_landmark(hash, 5_000 + episode_time_ms));
        }
        source.sort_by_key(|item| item.time_ms);
        let config = AffineMatchConfig {
            min_inliers: 6,
            top_k: 5,
            ..AffineMatchConfig::default()
        };

        let universe = match_landmarks_affine_coarse_universe(&source, &target, &config).unwrap();
        let legacy = match_landmarks_affine(&source, &target, &config).unwrap();

        assert_eq!(legacy.hypotheses.len(), 5);
        assert!(
            universe.hypotheses.len() >= 7,
            "complete universe must retain all seven repeated locations: {:?}",
            universe
                .hypotheses
                .iter()
                .map(|hypothesis| hypothesis.offset_ms)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            legacy
                .hypotheses
                .iter()
                .map(|hypothesis| hypothesis.offset_ms)
                .collect::<Vec<_>>(),
            universe
                .hypotheses
                .iter()
                .take(5)
                .map(|hypothesis| hypothesis.offset_ms)
                .collect::<Vec<_>>()
        );
        assert!(universe.hypotheses[5..].iter().any(|hypothesis| {
            !legacy.hypotheses.iter().any(|legacy| {
                legacy.scale.to_bits() == hypothesis.scale.to_bits()
                    && legacy.offset_ms == hypothesis.offset_ms
            })
        }));
    }

    #[test]
    fn affine_coarse_materialization_matches_legacy_scalars_and_anchors() {
        let (source, target) = affine_speed_drift_fixture();
        let config = AffineMatchConfig::default();
        let universe = match_landmarks_affine_coarse_universe(&source, &target, &config).unwrap();
        let coarse = universe.hypotheses.first().expect("coarse hypothesis");
        let anchor_free = coarse.to_anchor_free_affine_hypothesis();
        let materialized =
            materialize_affine_hypothesis(&source, &target, &config, coarse).unwrap();
        let legacy = match_landmarks_affine(&source, &target, &config)
            .unwrap()
            .hypotheses
            .into_iter()
            .next()
            .expect("legacy hypothesis");

        assert_eq!(materialized, legacy);
        assert_eq!(anchor_free.scale, legacy.scale);
        assert_eq!(anchor_free.offset_ms, legacy.offset_ms);
        assert_eq!(anchor_free.inlier_count, legacy.inlier_count);
        assert_eq!(anchor_free.unique_source_count, legacy.unique_source_count);
        assert_eq!(anchor_free.unique_target_count, legacy.unique_target_count);
        assert_eq!(anchor_free.p95_residual_ms, legacy.p95_residual_ms);
        assert!(anchor_free.training_anchors.is_empty());
        assert!(anchor_free.held_out_anchors.is_empty());
        assert_eq!(anchor_free.held_out_within_tolerance_count, 0);
        assert!(!materialized.training_anchors.is_empty());
        assert!(!materialized.held_out_anchors.is_empty());
    }

    #[test]
    fn affine_coarse_universe_candidate_order_is_stable() {
        let (source, target) = affine_repeated_episode_fixture();
        let config = AffineMatchConfig {
            min_inliers: 6,
            top_k: 1,
            ..AffineMatchConfig::default()
        };

        let first = match_landmarks_affine_coarse_universe(&source, &target, &config).unwrap();
        let second = match_landmarks_affine_coarse_universe(&source, &target, &config).unwrap();

        assert_eq!(first, second);
        assert!(first.seed_count > 0);
        assert!(first.seed_count <= AFFINE_COARSE_MAX_MODEL_SEEDS);
        assert!(first.hypotheses.len() <= first.seed_count);
        assert!(first
            .hypotheses
            .windows(2)
            .all(|pair| !compare_coarse_hypotheses(&pair[0], &pair[1]).is_gt()));

        let cancelled = AtomicBool::new(true);
        assert_eq!(
            match_landmarks_affine_coarse_universe_with_cancel(
                &source,
                &target,
                &config,
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
        assert_eq!(
            materialize_affine_hypothesis_with_cancel(
                &source,
                &target,
                &config,
                &first.hypotheses[0],
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
    }

    #[test]
    fn affine_holdout_keeps_all_frequencies_from_one_time_frame_in_one_partition() {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for time_ordinal in 0..15usize {
            let source_time_ms = time_ordinal as i64 * AFFINE_HOLDOUT_TIME_BLOCK_MS;
            for frequency_ordinal in 0..3usize {
                let family = 300 + time_ordinal * 3 + frequency_ordinal;
                let hash = ((family as u64) << 8) | 7;
                source.push(test_landmark(hash, source_time_ms));
                target.push(test_landmark(hash, source_time_ms + 5_000));
            }
        }
        let observations =
            create_landmark_observations(&source, &target, &AffineMatchConfig::default(), None)
                .unwrap();
        let held_out_time_blocks = select_distributed_holdout_time_blocks(&observations, 4);

        assert_eq!(held_out_time_blocks.len(), 3);
        for time_ordinal in 0..15usize {
            let source_time_ms = time_ordinal as i64 * AFFINE_HOLDOUT_TIME_BLOCK_MS;
            let frame_observations = observations
                .iter()
                .filter(|item| item.source_time_ms == source_time_ms)
                .collect::<Vec<_>>();
            assert_eq!(frame_observations.len(), 3);
            let held_out_count = frame_observations
                .iter()
                .filter(|item| {
                    held_out_time_blocks.contains(&affine_holdout_time_block(item.source_time_ms))
                })
                .count();
            assert!(held_out_count == 0 || held_out_count == frame_observations.len());
        }
    }

    #[test]
    fn affine_holdout_scales_beyond_thirty_two_blocks_for_sparse_long_media_support() {
        let observations = (0..5_000usize)
            .map(|index| LandmarkObservation {
                source_index: index,
                target_index: index,
                source_time_ms: index as i64 * AFFINE_HOLDOUT_TIME_BLOCK_MS,
                target_time_ms: index as i64 * AFFINE_HOLDOUT_TIME_BLOCK_MS + 5_000,
            })
            .collect::<Vec<_>>();

        let held_out_time_blocks = select_distributed_holdout_time_blocks(&observations, 24);

        assert_eq!(held_out_time_blocks.len(), 1_000);
        assert!(held_out_time_blocks.len() > 32);
        let sparse_phase_hits = (0..5_000i64)
            .step_by(50)
            .map(|block| block + 2)
            .filter(|block| held_out_time_blocks.contains(block))
            .count();
        assert!(
            (10..=30).contains(&sparse_phase_hits),
            "stratified deterministic jitter must avoid both fixed-phase capture and starvation: {sparse_phase_hits}"
        );
        assert!(held_out_time_blocks.iter().any(|block| *block < 500));
        assert!(held_out_time_blocks
            .iter()
            .any(|block| (2_250..2_750).contains(block)));
        assert!(held_out_time_blocks.iter().any(|block| *block >= 4_500));
    }

    #[test]
    fn affine_holdout_is_partitioned_before_seed_and_keeps_supported_edit_offset() {
        let source = (0..15usize)
            .map(|index| test_landmark((((200 + index) as u64) << 8) | 7, index as i64 * 1_000))
            .collect::<Vec<_>>();
        let baseline_target = source
            .iter()
            .map(|item| test_landmark(item.hash, item.time_ms + 5_000))
            .collect::<Vec<_>>();
        let observations = create_landmark_observations(
            &source,
            &baseline_target,
            &AffineMatchConfig::default(),
            None,
        )
        .unwrap();
        let held_out_time_blocks = select_distributed_holdout_time_blocks(&observations, 4);
        let held_out_ordinals = held_out_time_blocks
            .iter()
            .filter_map(|block| usize::try_from(*block).ok())
            .collect::<HashSet<_>>();
        let shifted_target = source
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let shift = if held_out_ordinals.contains(&index) {
                    35_000
                } else {
                    5_000
                };
                test_landmark(item.hash, item.time_ms + shift)
            })
            .collect::<Vec<_>>();
        let config = AffineMatchConfig::default();
        let baseline = match_landmarks_affine(&source, &baseline_target, &config).unwrap();
        let shifted = match_landmarks_affine(&source, &shifted_target, &config).unwrap();
        let baseline = baseline.hypotheses.first().expect("baseline hypothesis");
        let shifted = shifted.hypotheses.first().expect("shifted hypothesis");

        assert!((baseline.scale - shifted.scale).abs() < f64::EPSILON);
        assert_eq!(baseline.offset_ms, shifted.offset_ms);
        assert_eq!(baseline.inlier_count, shifted.inlier_count);
        assert_eq!(baseline.training_anchors, shifted.training_anchors);
        assert_eq!(baseline.held_out_anchors.len(), held_out_ordinals.len());
        assert_eq!(shifted.held_out_anchors.len(), held_out_ordinals.len());
        assert!(baseline
            .held_out_anchors
            .iter()
            .all(|item| item.residual_ms == 0));
        assert!(shifted
            .held_out_anchors
            .iter()
            .all(|item| item.residual_ms >= 30_000));
        assert_eq!(shifted.held_out_within_tolerance_count, 0);
    }

    #[test]
    fn affine_holdout_rejects_unclustered_large_offset_collisions() {
        let held_out_time_blocks = HashSet::from([10]);
        let observations = [30_000i64, 60_000, 90_000]
            .into_iter()
            .enumerate()
            .map(|(index, offset_ms)| LandmarkObservation {
                source_index: index,
                target_index: index,
                source_time_ms: 10_000 + index as i64 * 250,
                target_time_ms: 10_000 + index as i64 * 250 + offset_ms,
            })
            .collect::<Vec<_>>();

        let anchors = evaluate_affine_holdout(&observations, &held_out_time_blocks, 1.0, 0.0, 100);

        assert!(anchors.is_empty());
    }

    #[test]
    fn affine_holdout_keeps_locally_supported_large_edit_offsets() {
        let held_out_time_blocks = HashSet::from([10, 11, 12, 13, 14, 15]);
        let observations = (0..6usize)
            .map(|index| LandmarkObservation {
                source_index: index,
                target_index: index,
                source_time_ms: 10_000 + index as i64 * 1_000,
                target_time_ms: 40_000 + index as i64 * 1_000,
            })
            .collect::<Vec<_>>();

        let anchors = evaluate_affine_holdout(&observations, &held_out_time_blocks, 1.0, 0.0, 100);

        assert_eq!(anchors.len(), observations.len());
        assert!(anchors.iter().all(|anchor| anchor.residual_ms == 30_000));
    }

    #[test]
    fn affine_holdout_does_not_count_same_instant_landmarks_as_independent_consensus() {
        let held_out_time_blocks = HashSet::from([10]);
        let observations = (0..6usize)
            .map(|index| LandmarkObservation {
                source_index: index,
                target_index: index,
                source_time_ms: 10_000,
                target_time_ms: 16_000,
            })
            .collect::<Vec<_>>();

        let anchors = evaluate_affine_holdout(&observations, &held_out_time_blocks, 1.0, 0.0, 100);

        assert!(anchors.is_empty());
    }

    #[test]
    fn fine_decode_windows_inverse_project_the_complete_target_episode() {
        let hypothesis = AffineHypothesis {
            scale: 1.0,
            offset_ms: -300_000,
            inlier_count: 20,
            unique_source_count: 20,
            unique_source_coverage: 0.8,
            unique_target_count: 20,
            unique_target_coverage: 0.8,
            source_start_ms: 315_000,
            source_end_ms: 405_000,
            p50_residual_ms: 5,
            p95_residual_ms: 10,
            max_residual_ms: 20,
            training_anchors: Vec::new(),
            held_out_anchors: Vec::new(),
            held_out_within_tolerance_count: 0,
        };
        let windows = derive_affine_fine_decode_windows(
            &hypothesis,
            &AffineFineWindowRequest {
                source_bounds: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 600_000,
                },
                target_bounds: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 120_000,
                },
                target_query: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 120_000,
                },
                source_guard_ms: 30_800,
                target_guard_ms: 800,
            },
        )
        .unwrap();

        assert_eq!(
            windows.source,
            PresentationRangeMs {
                start_ms: 269_200,
                end_ms: 450_800,
            }
        );
        assert_eq!(
            windows.target,
            PresentationRangeMs {
                start_ms: 0,
                end_ms: 120_000,
            }
        );
        assert!(windows.source.start_ms < hypothesis.source_start_ms);
        assert!(windows.source.end_ms > hypothesis.source_end_ms);
    }

    #[test]
    fn fine_decode_windows_round_outward_for_speed_drift_and_clamp_bounds() {
        let hypothesis = AffineHypothesis {
            scale: 1.02,
            offset_ms: -10_000,
            inlier_count: 10,
            unique_source_count: 10,
            unique_source_coverage: 1.0,
            unique_target_count: 10,
            unique_target_coverage: 1.0,
            source_start_ms: 10_000,
            source_end_ms: 80_000,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors: Vec::new(),
            held_out_anchors: Vec::new(),
            held_out_within_tolerance_count: 0,
        };
        let windows = derive_affine_fine_decode_windows(
            &hypothesis,
            &AffineFineWindowRequest {
                source_bounds: PresentationRangeMs {
                    start_ms: 5_000,
                    end_ms: 100_000,
                },
                target_bounds: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 90_000,
                },
                target_query: PresentationRangeMs {
                    start_ms: 20_000,
                    end_ms: 80_000,
                },
                source_guard_ms: 1_000,
                target_guard_ms: 500,
            },
        )
        .unwrap();

        assert_eq!(
            windows.target,
            PresentationRangeMs {
                start_ms: 19_500,
                end_ms: 80_500,
            }
        );
        assert_eq!(windows.source.start_ms, 9_000);
        assert_eq!(windows.source.end_ms, 89_726);
    }

    #[test]
    fn fine_decode_windows_keep_source_only_gap_wider_than_guard() {
        let hypothesis = AffineHypothesis {
            scale: 1.0,
            offset_ms: -400_000,
            inlier_count: 24,
            unique_source_count: 24,
            unique_source_coverage: 0.8,
            unique_target_count: 24,
            unique_target_coverage: 0.8,
            // Inliers exist on both sides of a 45 s source-only advertisement. The support
            // envelope, unlike a fixed 31 s inverse-projection guard, retains the whole gap.
            source_start_ms: 350_000,
            source_end_ms: 565_000,
            p50_residual_ms: 10,
            p95_residual_ms: 30,
            max_residual_ms: 50,
            training_anchors: Vec::new(),
            held_out_anchors: Vec::new(),
            held_out_within_tolerance_count: 0,
        };
        let windows = derive_affine_fine_decode_windows(
            &hypothesis,
            &AffineFineWindowRequest {
                source_bounds: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 900_000,
                },
                target_bounds: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 180_000,
                },
                target_query: PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 180_000,
                },
                source_guard_ms: 31_000,
                target_guard_ms: 31_000,
            },
        )
        .unwrap();

        assert!(windows.source.start_ms <= 319_000);
        assert!(windows.source.end_ms >= 596_000);
        assert!(windows.source.end_ms - windows.source.start_ms < 60 * 60 * 1_000);
    }

    #[test]
    fn fine_decode_windows_reject_invalid_or_disjoint_requests() {
        let mut hypothesis = test_affine_hypothesis();
        hypothesis.scale = 0.0;
        let request = AffineFineWindowRequest {
            source_bounds: PresentationRangeMs {
                start_ms: 0,
                end_ms: 10_000,
            },
            target_bounds: PresentationRangeMs {
                start_ms: 0,
                end_ms: 10_000,
            },
            target_query: PresentationRangeMs {
                start_ms: 20_000,
                end_ms: 30_000,
            },
            source_guard_ms: 0,
            target_guard_ms: 0,
        };
        assert!(derive_affine_fine_decode_windows(&hypothesis, &request)
            .unwrap_err()
            .contains("scale"));

        hypothesis.scale = 1.0;
        assert!(derive_affine_fine_decode_windows(&hypothesis, &request)
            .unwrap_err()
            .contains("没有交集"));
    }

    #[test]
    fn fine_features_keep_presentation_timeline_and_requested_hop() {
        let pcm = synth_tone_bursts(16_000, &[330, 510, 770, 1_130]);
        let frames = extract_fine_features(
            &pcm,
            &FineFeatureConfig {
                presentation_offset_ms: 375,
                ..FineFeatureConfig::default()
            },
        )
        .unwrap();
        assert!(!frames.is_empty());
        assert_eq!(frames[0].time_ms, 400);
        assert_eq!(frames[1].time_ms - frames[0].time_ms, 50);
        assert_eq!(frames[0].values.len(), FINE_SPECTRAL_BAND_COUNT + 2);
        assert!(frames
            .iter()
            .flat_map(|frame| &frame.values)
            .all(|value| value.is_finite()));
    }

    #[test]
    fn fine_only_cpu_backend_is_exactly_equivalent_to_legacy_cpu_extraction() {
        let pcm = synth_tone_bursts(16_000, &[211, 347, 613, 997, 1_541, 2_303]);
        let config = FineFeatureConfig {
            presentation_offset_ms: 375,
            window_ms: 50,
            hop_ms: 25,
            ..FineFeatureConfig::default()
        };
        let expected = extract_fine_features_with_cancel(&pcm, &config, None).unwrap();
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();

        let actual =
            extract_fine_features_with_backend_request(&pcm, &config, None, &cpu_request).unwrap();

        assert_eq!(actual.fine_features, expected);
        assert_eq!(actual.spectral_backend.backend_id, CPU_SPECTRAL_BACKEND_ID);
        assert_eq!(actual.spectral_backend.requested_backend, "cpu");
        assert!(actual.spectral_backend.fallback_reason.is_none());
    }

    #[test]
    fn fine_only_cuda_backend_matches_cpu_without_per_frame_cpu_fft() {
        let require_cuda = std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1")
            || std::env::var("C137_SPECTRAL_BACKEND").as_deref() == Ok("cuda");
        let cuda_request =
            match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
                Ok(request) => request,
                Err(error) if !require_cuda => {
                    eprintln!("skip fine-only CUDA equivalence: {error}");
                    return;
                }
                Err(error) => panic!("CUDA was required for fine-only equivalence: {error}"),
            };
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();
        let pcm = synth_tone_bursts(16_000, &[173, 331, 719, 1_237, 2_411]);
        let config = FineFeatureConfig {
            presentation_offset_ms: -225,
            window_ms: 50,
            hop_ms: 25,
            ..FineFeatureConfig::default()
        };
        let cpu =
            extract_fine_features_with_backend_request(&pcm, &config, None, &cpu_request).unwrap();
        TEST_SPECTRUM_CALCULATION_COUNT.with(|count| count.set(0));

        let cuda =
            extract_fine_features_with_backend_request(&pcm, &config, None, &cuda_request).unwrap();

        assert_eq!(cuda.spectral_backend.backend_id, CUDA_FFT_BACKEND_ID);
        assert_eq!(cuda.spectral_backend.requested_backend, "cuda");
        assert!(cuda.spectral_backend.fallback_reason.is_none());
        assert_eq!(
            TEST_SPECTRUM_CALCULATION_COUNT.with(std::cell::Cell::get),
            0,
            "a successful CUDA fine-only extraction must not call the per-frame CPU FFT"
        );
        assert_eq!(cpu.fine_features.len(), cuda.fine_features.len());
        for (cpu_frame, cuda_frame) in cpu.fine_features.iter().zip(&cuda.fine_features) {
            assert_eq!(cpu_frame.time_ms, cuda_frame.time_ms);
            assert_eq!(cpu_frame.values.len(), cuda_frame.values.len());
            for (cpu_value, cuda_value) in cpu_frame.values.iter().zip(&cuda_frame.values) {
                assert!((cpu_value - cuda_value).abs() <= 2.0e-5);
            }
        }
    }

    #[test]
    fn fine_only_cuda_crosses_bounded_batch_seam_without_retaining_cpu_spectra() {
        let require_cuda = std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1")
            || std::env::var("C137_SPECTRAL_BACKEND").as_deref() == Ok("cuda");
        let cuda_request =
            match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
                Ok(request) => request,
                Err(error) if !require_cuda => {
                    eprintln!("skip bounded fine-only CUDA batches: {error}");
                    return;
                }
                Err(error) => panic!("CUDA was required for bounded fine-only batches: {error}"),
            };
        let config = FineFeatureConfig {
            window_ms: 50,
            hop_ms: 25,
            ..FineFeatureConfig::default()
        };
        let window_samples =
            milliseconds_to_samples(config.window_ms as i64, config.sample_rate).unwrap();
        let hop_samples =
            milliseconds_to_samples(config.hop_ms as i64, config.sample_rate).unwrap();
        let expected_frames = CUDA_FFT_DEFAULT_BATCH_FRAMES + 17;
        let sample_count = window_samples + (expected_frames - 1) * hop_samples;
        let pcm = synth_streaming_chirp(config.sample_rate, sample_count);
        TEST_SPECTRUM_CALCULATION_COUNT.with(|count| count.set(0));

        let extraction =
            extract_fine_features_with_backend_request(&pcm, &config, None, &cuda_request).unwrap();

        assert_eq!(extraction.fine_features.len(), expected_frames);
        assert_eq!(extraction.spectral_backend.backend_id, CUDA_FFT_BACKEND_ID);
        assert_eq!(
            TEST_SPECTRUM_CALCULATION_COUNT.with(std::cell::Cell::get),
            0
        );
    }

    #[test]
    fn fine_only_empty_and_cancelled_inputs_preserve_fail_closed_contract() {
        let config = FineFeatureConfig::default();
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();
        let empty =
            extract_fine_features_with_backend_request(&[], &config, None, &cpu_request).unwrap();
        assert!(empty.fine_features.is_empty());
        assert_eq!(empty.spectral_backend.backend_id, CPU_SPECTRAL_BACKEND_ID);
        assert_eq!(empty.spectral_backend.requested_backend, "cpu");

        let cancelled = AtomicBool::new(true);
        let error = extract_fine_features_with_backend_request(
            &[0; 800],
            &config,
            Some(&cancelled),
            &cpu_request,
        )
        .unwrap_err();
        assert_eq!(error, ALIGNMENT_V2_CANCELLED);
    }

    #[test]
    fn fine_only_auto_cuda_failure_recomputes_all_on_cpu_and_forced_cuda_blocks() {
        let pcm = synth_tone_bursts(4_000, &[173, 331, 719, 1_237]);
        let config = FineFeatureConfig {
            sample_rate: 4_000,
            window_ms: 50,
            hop_ms: 50,
            ..FineFeatureConfig::default()
        };
        let expected = extract_fine_features_with_cancel(&pcm, &config, None).unwrap();
        let auto_request = SpectralBackendRequest {
            preference: SpectralBackendPreference::Auto,
            planned_backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "auto".to_string(),
            backend_detail: "test CUDA device".to_string(),
            fallback_reason: None,
        };

        let auto =
            extract_fine_features_with_backend_request(&pcm, &config, None, &auto_request).unwrap();
        assert_eq!(auto.fine_features, expected);
        assert_eq!(auto.spectral_backend.backend_id, CPU_SPECTRAL_BACKEND_ID);
        assert_eq!(auto.spectral_backend.requested_backend, "auto");
        assert!(auto
            .spectral_backend
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("512 点 R2C")));

        let forced_request = SpectralBackendRequest {
            preference: SpectralBackendPreference::Cuda,
            planned_backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "cuda".to_string(),
            backend_detail: "test CUDA device".to_string(),
            fallback_reason: None,
        };
        let error =
            extract_fine_features_with_backend_request(&pcm, &config, None, &forced_request)
                .unwrap_err();
        assert!(error.starts_with("blocked:cuda-fft-runtime"));
    }

    #[test]
    fn fine_backend_lock_follows_actual_coarse_execution_and_preserves_diagnostics() {
        let cuda_execution = SpectralBackendExecution {
            backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "auto".to_string(),
            backend_detail: "CUDA/cuFFT device #0 RTX 4090".to_string(),
            fallback_reason: None,
        };
        let cuda_request = lock_fine_spectral_backend_request(&cuda_execution).unwrap();
        assert_eq!(cuda_request.preference, SpectralBackendPreference::Cuda);
        assert_eq!(cuda_request.planned_backend_id, CUDA_FFT_BACKEND_ID);
        assert_eq!(cuda_request.requested_backend, "auto");
        assert_eq!(cuda_request.backend_detail, cuda_execution.backend_detail);
        assert!(cuda_request.fallback_reason.is_none());

        for backend_id in [
            CPU_SPECTRAL_BACKEND_ID,
            STREAMING_CPU_SPECTRAL_BACKEND_ID,
            STREAMING_HYBRID_SPECTRAL_BACKEND_ID,
        ] {
            let cpu_execution = SpectralBackendExecution {
                backend_id: backend_id.to_string(),
                requested_backend: "auto".to_string(),
                backend_detail: format!("coarse detail for {backend_id}"),
                fallback_reason: Some("coarse fallback diagnostic".to_string()),
            };
            let cpu_request = lock_fine_spectral_backend_request(&cpu_execution).unwrap();
            assert_eq!(cpu_request.preference, SpectralBackendPreference::Cpu);
            assert_eq!(cpu_request.planned_backend_id, CPU_SPECTRAL_BACKEND_ID);
            assert_eq!(cpu_request.requested_backend, "auto");
            assert_eq!(
                cpu_request.fallback_reason.as_deref(),
                Some("coarse fallback diagnostic")
            );
            assert!(cpu_request.backend_detail.contains(backend_id));
            assert!(cpu_request
                .backend_detail
                .contains(&cpu_execution.backend_detail));
        }

        let unknown = SpectralBackendExecution {
            backend_id: "unknown-spectral-backend".to_string(),
            requested_backend: "auto".to_string(),
            backend_detail: "unknown".to_string(),
            fallback_reason: None,
        };
        assert!(lock_fine_spectral_backend_request(&unknown)
            .unwrap_err()
            .starts_with("blocked:spectral-backend-continuity"));
    }

    #[test]
    fn shared_spectral_extraction_is_exactly_equivalent_and_runs_one_fft_per_frame() {
        let pcm = synth_tone_bursts(16_000, &[310, 470, 690, 930, 1_270, 1_610]);
        let landmark_config = LandmarkConfig {
            presentation_offset_ms: 375,
            window_ms: 50,
            hop_ms: 50,
            max_hash_occurrences: 64,
            ..LandmarkConfig::default()
        };
        let fine_config = FineFeatureConfig {
            presentation_offset_ms: 375,
            window_ms: 50,
            hop_ms: 50,
            ..FineFeatureConfig::default()
        };
        let window_samples = milliseconds_to_samples(50, 16_000).unwrap();
        let hop_samples = milliseconds_to_samples(50, 16_000).unwrap();
        let expected_frame_count = 1 + (pcm.len() - window_samples) / hop_samples;

        TEST_SPECTRUM_CALCULATION_COUNT.with(|count| count.set(0));
        let shared =
            extract_landmarks_and_fine_features(&pcm, &landmark_config, &fine_config).unwrap();
        let shared_spectrum_count = TEST_SPECTRUM_CALCULATION_COUNT.with(std::cell::Cell::get);

        TEST_SPECTRUM_CALCULATION_COUNT.with(|count| count.set(0));
        let independent_landmarks = extract_landmarks(&pcm, &landmark_config).unwrap();
        let independent_fine = extract_fine_features(&pcm, &fine_config).unwrap();
        let independent_spectrum_count = TEST_SPECTRUM_CALCULATION_COUNT.with(std::cell::Cell::get);

        assert!(!shared.landmarks.is_empty());
        assert_eq!(shared.landmarks, independent_landmarks);
        assert_eq!(shared.fine_features, independent_fine);
        assert_eq!(shared_spectrum_count, expected_frame_count);
        assert_eq!(independent_spectrum_count, expected_frame_count * 2);
    }

    #[test]
    fn cuda_spectra_match_cpu_spectra_on_the_production_grid() {
        let require_cuda = std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1")
            || std::env::var("C137_SPECTRAL_BACKEND").as_deref() == Ok("cuda");
        let cuda_request =
            match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
                Ok(request) => request,
                Err(error) if !require_cuda => {
                    eprintln!("skip CUDA spectral equivalence: {error}");
                    return;
                }
                Err(error) => panic!("CUDA was required for spectral equivalence: {error}"),
            };
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();
        let pcm = synth_tone_bursts(16_000, &[173, 331, 719, 1_237, 2_411]);
        let config = LandmarkConfig {
            window_ms: 50,
            hop_ms: 25,
            ..LandmarkConfig::default()
        };
        let window_samples = milliseconds_to_samples(50, 16_000).unwrap();
        let hop_samples = milliseconds_to_samples(25, 16_000).unwrap();
        let frame_count = 1 + (pcm.len() - window_samples) / hop_samples;
        let (cpu, cpu_backend) =
            analyze_landmark_spectral_frames_with_backend(&pcm, &config, None, None, &cpu_request)
                .unwrap();
        let (cuda, cuda_backend) =
            analyze_landmark_spectral_frames_with_backend(&pcm, &config, None, None, &cuda_request)
                .unwrap();
        let cpu = cpu.unwrap();
        let cuda = cuda.unwrap();

        assert_eq!(cpu_backend.backend_id, CPU_SPECTRAL_BACKEND_ID);
        assert_eq!(cuda_backend.backend_id, CUDA_FFT_BACKEND_ID);
        assert_eq!(cpu.spectra.len(), frame_count);
        assert_eq!(cuda.spectra.len(), frame_count);
        assert_eq!(cpu.active_frames, cuda.active_frames);
        for (frame_index, (cpu_frame, cuda_frame)) in
            cpu.spectra.iter().zip(&cuda.spectra).enumerate()
        {
            for (bin, (cpu_value, cuda_value)) in cpu_frame.iter().zip(cuda_frame).enumerate() {
                let tolerance = 1.0e-3 + 5.0e-5 * cpu_value.abs();
                assert!(
                    (cpu_value - cuda_value).abs() <= tolerance,
                    "frame {frame_index} bin {bin}: cpu={cpu_value}, cuda={cuda_value}, tolerance={tolerance}"
                );
            }
        }
    }

    #[test]
    fn cuda_landmark_and_fine_bundle_is_semantically_equivalent_to_cpu() {
        let require_cuda = std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1")
            || std::env::var("C137_SPECTRAL_BACKEND").as_deref() == Ok("cuda");
        let cuda_request =
            match resolve_spectral_backend_preference(SpectralBackendPreference::Cuda) {
                Ok(request) => request,
                Err(error) if !require_cuda => {
                    eprintln!("skip CUDA bundle equivalence: {error}");
                    return;
                }
                Err(error) => panic!("CUDA was required for bundle equivalence: {error}"),
            };
        let cpu_request =
            resolve_spectral_backend_preference(SpectralBackendPreference::Cpu).unwrap();
        let pcm = synth_tone_bursts(16_000, &[211, 347, 613, 997, 1_541, 2_303]);
        let landmark_config = LandmarkConfig {
            sample_rate: 16_000,
            window_ms: 50,
            hop_ms: 50,
            max_hash_occurrences: 64,
            ..LandmarkConfig::default()
        };
        let fine_config = FineFeatureConfig {
            sample_rate: 16_000,
            window_ms: 50,
            hop_ms: 50,
            ..FineFeatureConfig::default()
        };
        let cpu = extract_landmarks_and_fine_features_with_backend_request(
            &pcm,
            &landmark_config,
            &fine_config,
            None,
            &cpu_request,
        )
        .unwrap();
        let cuda = extract_landmarks_and_fine_features_with_backend_request(
            &pcm,
            &landmark_config,
            &fine_config,
            None,
            &cuda_request,
        )
        .unwrap();

        assert_eq!(cpu.spectral_backend.backend_id, CPU_SPECTRAL_BACKEND_ID);
        assert_eq!(cuda.spectral_backend.backend_id, CUDA_FFT_BACKEND_ID);
        assert_eq!(cpu.bundle.landmarks, cuda.bundle.landmarks);
        assert_eq!(
            cpu.bundle.fine_features.len(),
            cuda.bundle.fine_features.len()
        );
        for (cpu_frame, cuda_frame) in cpu
            .bundle
            .fine_features
            .iter()
            .zip(&cuda.bundle.fine_features)
        {
            assert_eq!(cpu_frame.time_ms, cuda_frame.time_ms);
            assert_eq!(cpu_frame.values.len(), cuda_frame.values.len());
            for (cpu_value, cuda_value) in cpu_frame.values.iter().zip(&cuda_frame.values) {
                assert!((cpu_value - cuda_value).abs() <= 2.0e-5);
            }
        }
    }

    #[test]
    fn auto_cuda_runtime_fallback_reports_cpu_identity() {
        let request = SpectralBackendRequest {
            preference: SpectralBackendPreference::Auto,
            planned_backend_id: CUDA_FFT_BACKEND_ID.to_string(),
            requested_backend: "auto".to_string(),
            backend_detail: "test CUDA device".to_string(),
            fallback_reason: None,
        };
        let pcm = synth_tone_bursts(4_000, &[173, 331, 719, 1_237]);
        let landmark_config = LandmarkConfig {
            sample_rate: 4_000,
            window_ms: 50,
            hop_ms: 50,
            ..LandmarkConfig::default()
        };
        let fine_config = FineFeatureConfig {
            sample_rate: 4_000,
            window_ms: 50,
            hop_ms: 50,
            ..FineFeatureConfig::default()
        };

        let extraction = extract_landmarks_and_fine_features_with_backend_request(
            &pcm,
            &landmark_config,
            &fine_config,
            None,
            &request,
        )
        .unwrap();

        assert_eq!(
            extraction.spectral_backend.backend_id,
            CPU_SPECTRAL_BACKEND_ID
        );
        assert_eq!(
            extraction.spectral_backend.backend_detail,
            "CPU radix-2 f64 FFT"
        );
        assert!(extraction
            .spectral_backend
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("512 点 R2C")));
    }

    #[test]
    fn shared_spectral_extraction_rejects_mismatched_frame_grids_before_fft() {
        let pcm = synth_tone_bursts(16_000, &[330, 510, 770, 1_130]);
        TEST_SPECTRUM_CALCULATION_COUNT.with(|count| count.set(0));

        let error = extract_landmarks_and_fine_features(
            &pcm,
            &LandmarkConfig {
                window_ms: 50,
                hop_ms: 50,
                ..LandmarkConfig::default()
            },
            &FineFeatureConfig {
                window_ms: 50,
                hop_ms: 25,
                ..FineFeatureConfig::default()
            },
        )
        .unwrap_err();

        assert!(error.contains("相同 sample rate、window 和 hop"));
        assert_eq!(
            TEST_SPECTRUM_CALCULATION_COUNT.with(std::cell::Cell::get),
            0
        );
    }

    #[test]
    fn edit_dp_models_source_and_target_deletions_symmetrically() {
        let source = feature_sequence(&[0, 1, 2, 3, 4, 5, 6], 0, 100);
        let target = feature_sequence(&[0, 1, 3, 7, 4, 5, 6], 0, 100);
        let result = align_features_edit_aware(
            &source,
            &target,
            &identity_hypothesis(),
            &EditAlignmentConfig {
                band_radius_ms: 1_000,
                gap_open_cost: 250,
                gap_extend_cost: 40,
                ambiguous_match_cost: 700,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        let kinds = result
            .spans
            .iter()
            .map(|span| span.kind)
            .collect::<Vec<_>>();
        assert!(kinds.contains(&EditPathKind::SourceOnly));
        assert!(kinds.contains(&EditPathKind::TargetOnly));
        assert_monotonic(&result.spans);
    }

    #[test]
    fn edit_dp_marks_opposite_gap_replacement_as_ambiguous() {
        let source = feature_sequence(&[0, 1, 2], 0, 100);
        let target = feature_sequence(&[0, 3, 2], 0, 100);
        let result = align_features_edit_aware(
            &source,
            &target,
            &identity_hypothesis(),
            &EditAlignmentConfig {
                band_radius_ms: 500,
                gap_open_cost: 220,
                gap_extend_cost: 40,
                ambiguous_match_cost: 700,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        assert!(result
            .spans
            .iter()
            .any(|span| span.kind == EditPathKind::Ambiguous));
        assert_monotonic(&result.spans);
    }

    #[test]
    fn narrow_band_dp_follows_coarse_speed_scale() {
        let source = feature_sequence(&[0, 1, 2, 3, 4, 5, 6, 7], 0, 1_000);
        let mut target = feature_sequence(&[0, 1, 2, 3, 4, 5, 6, 7], 4_000, 1_020);
        for (index, frame) in target.iter_mut().enumerate() {
            frame.time_ms = 4_000 + index as i64 * 1_020;
        }
        let coarse = AffineHypothesis {
            scale: 1.02,
            offset_ms: 4_000,
            ..identity_hypothesis()
        };
        let result = align_features_edit_aware(
            &source,
            &target,
            &coarse,
            &EditAlignmentConfig {
                band_radius_ms: 80,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result.matched_step_count, source.len());
        assert_eq!(result.spans.len(), 1);
        assert_eq!(result.spans[0].kind, EditPathKind::Matched);
    }

    #[test]
    fn semi_global_dp_aligns_complete_source_inside_target() {
        let source = feature_sequence(&[1, 2, 3], 0, 100);
        let target = feature_sequence(&[7, 1, 2, 3, 6], 0, 100);
        let coarse = AffineHypothesis {
            offset_ms: 100,
            ..identity_hypothesis()
        };
        let result = align_features_edit_aware(
            &source,
            &target,
            &coarse,
            &EditAlignmentConfig {
                mode: EditAlignmentMode::SemiGlobal,
                band_radius_ms: 120,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result.matched_step_count, source.len());
        assert!(result
            .path
            .iter()
            .all(|step| step.kind == EditPathKind::Matched));
        assert_eq!(result.spans[0].target_start_ms, 100);
        assert_eq!(result.spans[0].target_end_ms, 400);
    }

    #[test]
    fn rolling_edit_dp_is_bit_exact_with_full_matrix_reference() {
        fn label_sequences(length: usize) -> Vec<Vec<usize>> {
            let sequence_count = 3_usize.pow(length as u32);
            (0..sequence_count)
                .map(|mut encoded| {
                    let mut sequence = vec![0_usize; length];
                    for label in &mut sequence {
                        *label = encoded % 3;
                        encoded /= 3;
                    }
                    sequence
                })
                .collect()
        }

        let configurations = [
            (
                AffineHypothesis {
                    offset_ms: 0,
                    ..identity_hypothesis()
                },
                EditAlignmentConfig {
                    mode: EditAlignmentMode::Global,
                    band_radius_ms: 1_000,
                    gap_open_cost: 250,
                    gap_extend_cost: 40,
                    ambiguous_match_cost: 700,
                    ..EditAlignmentConfig::default()
                },
            ),
            (
                AffineHypothesis {
                    offset_ms: 0,
                    ..identity_hypothesis()
                },
                EditAlignmentConfig {
                    mode: EditAlignmentMode::SemiGlobal,
                    band_radius_ms: 1_000,
                    gap_open_cost: 250,
                    gap_extend_cost: 40,
                    ambiguous_match_cost: 700,
                    ..EditAlignmentConfig::default()
                },
            ),
            (
                AffineHypothesis {
                    offset_ms: 100,
                    ..identity_hypothesis()
                },
                EditAlignmentConfig {
                    mode: EditAlignmentMode::Global,
                    band_radius_ms: 75,
                    gap_open_cost: 500,
                    gap_extend_cost: 500,
                    ambiguous_match_cost: 700,
                    ..EditAlignmentConfig::default()
                },
            ),
            (
                AffineHypothesis {
                    offset_ms: -100,
                    ..identity_hypothesis()
                },
                EditAlignmentConfig {
                    mode: EditAlignmentMode::SemiGlobal,
                    band_radius_ms: 125,
                    gap_open_cost: 300,
                    gap_extend_cost: 60,
                    ambiguous_match_cost: 1_000,
                    ..EditAlignmentConfig::default()
                },
            ),
        ];

        for source_len in 1..=3 {
            for target_len in 1..=3 {
                for source_labels in label_sequences(source_len) {
                    for target_labels in label_sequences(target_len) {
                        let source = feature_sequence(&source_labels, 0, 100);
                        let target = feature_sequence(&target_labels, 0, 100);
                        for (coarse, config) in &configurations {
                            let expected = align_features_edit_aware_full_matrix_reference(
                                &source, &target, coarse, config,
                            );
                            let actual = align_features_edit_aware_with_cancel(
                                &source, &target, coarse, config, None,
                            );
                            assert_eq!(
                                actual, expected,
                                "source={source_labels:?}, target={target_labels:?}, mode={:?}, offset={}, band={}",
                                config.mode, coarse.offset_ms, config.band_radius_ms
                            );
                        }
                    }
                }
            }
        }

        let source = vec![
            FineFeatureFrame {
                time_ms: 0,
                presentation_time_ms: 0,
                values: vec![0.25, -0.75, 1.5, 0.0],
            },
            FineFeatureFrame {
                time_ms: 100,
                presentation_time_ms: 100,
                values: vec![0.0, 0.0, 0.0, 0.0],
            },
            FineFeatureFrame {
                time_ms: 200,
                presentation_time_ms: 200,
                values: vec![3.5, -2.25, 0.125, 0.5],
            },
        ];
        let target = vec![
            FineFeatureFrame {
                time_ms: 0,
                presentation_time_ms: 0,
                values: vec![0.5, -1.25, 0.75, 0.25],
            },
            FineFeatureFrame {
                time_ms: 100,
                presentation_time_ms: 100,
                values: vec![0.0, 0.0, 0.0, 0.0],
            },
            FineFeatureFrame {
                time_ms: 200,
                presentation_time_ms: 200,
                values: vec![2.0, -1.0, 0.375, -0.75],
            },
        ];
        for mode in [EditAlignmentMode::Global, EditAlignmentMode::SemiGlobal] {
            let config = EditAlignmentConfig {
                mode,
                band_radius_ms: 1_000,
                ..EditAlignmentConfig::default()
            };
            assert_eq!(
                align_features_edit_aware_with_cancel(
                    &source,
                    &target,
                    &identity_hypothesis(),
                    &config,
                    None,
                ),
                align_features_edit_aware_full_matrix_reference(
                    &source,
                    &target,
                    &identity_hypothesis(),
                    &config,
                )
            );
        }
    }

    #[test]
    fn correlation_refines_integer_millisecond_boundary_and_reports_ambiguity() {
        let source = deterministic_noise(5_000);
        let mut target = vec![0i16; 123];
        target.extend_from_slice(&source);
        let config = BoundaryRefinementConfig {
            sample_rate: 1_000,
            search_radius_ms: 50,
            window_ms: 400,
            score_tolerance: 0.001,
            min_correlation: 0.8,
            min_alternative_margin: 0.000_1,
            max_uncertainty_ms: 5,
            ..BoundaryRefinementConfig::default()
        };
        let result =
            refine_boundary_by_correlation(&source, &target, 2_000, 2_100, &config).unwrap();
        assert_eq!(result.refined_target_boundary_ms, 2_123);
        assert_eq!(result.shift_ms, 23);
        assert!(result.best_correlation > 0.999);
        assert!(result.uncertainty_ms <= 2);
        assert!(!result.ambiguous);

        let periodic_source = (0..5_000)
            .map(|index| if index % 20 < 10 { 12_000 } else { -12_000 })
            .collect::<Vec<_>>();
        let periodic = refine_boundary_by_correlation(
            &periodic_source,
            &periodic_source,
            2_000,
            2_000,
            &BoundaryRefinementConfig {
                min_alternative_margin: 0.01,
                ..config
            },
        )
        .unwrap();
        assert!(periodic.ambiguous);
        assert!(periodic.alternative_margin < 0.001);
    }

    #[test]
    fn one_sided_correlation_recovers_both_edges_of_inserted_content() {
        let source = deterministic_noise(5_000);
        let insertion = (0..700)
            .map(|index| if index % 37 < 13 { 20_000 } else { -7_000 })
            .collect::<Vec<_>>();
        let mut target = source[..2_500].to_vec();
        target.extend_from_slice(&insertion);
        target.extend_from_slice(&source[2_500..]);
        let config = BoundaryRefinementConfig {
            sample_rate: 1_000,
            search_radius_ms: 80,
            window_ms: 400,
            score_tolerance: 0.001,
            min_correlation: 0.9,
            min_alternative_margin: 0.01,
            max_uncertainty_ms: 5,
            ..BoundaryRefinementConfig::default()
        };

        let before = refine_boundary_by_one_sided_correlation_with_cancel(
            &source,
            &target,
            2_500,
            2_470,
            BoundaryContextSide::Before,
            &config,
            None,
        )
        .unwrap();
        let after = refine_boundary_by_one_sided_correlation_with_cancel(
            &source,
            &target,
            2_500,
            3_230,
            BoundaryContextSide::After,
            &config,
            None,
        )
        .unwrap();

        assert_eq!(before.refined_target_boundary_ms, 2_500);
        assert_eq!(after.refined_target_boundary_ms, 3_200);
        for (result, expected) in [(&before, 2_500), (&after, 3_200)] {
            assert!(result.uncertainty_start_ms <= expected);
            assert!(result.uncertainty_end_ms >= expected);
            assert!(result.uncertainty_ms <= 2);
            assert!(!result.ambiguous);
        }
    }

    #[test]
    fn cancellable_algorithm_entrypoints_honor_cancel_token() {
        let cancelled = AtomicBool::new(true);
        let pcm = synth_tone_bursts(16_000, &[330, 510, 770, 1_130]);
        assert_eq!(
            extract_landmarks_with_cancel(&pcm, &LandmarkConfig::default(), Some(&cancelled),)
                .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
        assert_eq!(
            extract_fine_features_with_cancel(
                &pcm,
                &FineFeatureConfig::default(),
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
        assert_eq!(
            extract_landmarks_and_fine_features_with_cancel(
                &pcm,
                &LandmarkConfig {
                    window_ms: 50,
                    hop_ms: 50,
                    ..LandmarkConfig::default()
                },
                &FineFeatureConfig::default(),
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
        let source = feature_sequence(&[0, 1, 2], 0, 100);
        let target = feature_sequence(&[0, 1, 2], 0, 100);
        assert_eq!(
            align_features_edit_aware_with_cancel(
                &source,
                &target,
                &identity_hypothesis(),
                &EditAlignmentConfig::default(),
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
    }

    fn synth_tone_bursts(sample_rate: u32, frequencies: &[u32]) -> Vec<i16> {
        let burst_samples = sample_rate as usize / 4;
        let mut output = Vec::new();
        for (burst_index, frequency) in frequencies.iter().enumerate() {
            for sample_index in 0..burst_samples {
                let phase = sample_index as f64 / sample_rate as f64;
                let envelope = (std::f64::consts::PI * sample_index as f64
                    / burst_samples.max(1) as f64)
                    .sin()
                    .max(0.0);
                let carrier = (2.0 * std::f64::consts::PI * *frequency as f64 * phase).sin();
                let overtone = (2.0
                    * std::f64::consts::PI
                    * (*frequency as f64 * 1.5 + burst_index as f64 * 7.0)
                    * phase)
                    .sin();
                output.push(((carrier * 0.75 + overtone * 0.25) * envelope * 24_000.0) as i16);
            }
        }
        output
    }

    fn stream_landmarks_with_chunks(
        pcm: &[i16],
        config: &LandmarkConfig,
        chunk_sizes: &[usize],
    ) -> MediaCoarseIndexResult {
        let mut extractor = StreamingLandmarkExtractor::new(config.clone()).unwrap();
        let mut offset = 0usize;
        let mut chunk_index = 0usize;
        while offset < pcm.len() {
            let requested = chunk_sizes
                .get(chunk_index % chunk_sizes.len().max(1))
                .copied()
                .unwrap_or(pcm.len())
                .max(1);
            let end = offset.saturating_add(requested).min(pcm.len());
            extractor.push_pcm(&pcm[offset..end]).unwrap();
            offset = end;
            chunk_index += 1;
        }
        extractor.finish().unwrap()
    }

    fn stream_landmarks_with_backend_chunks(
        pcm: &[i16],
        config: &LandmarkConfig,
        chunk_sizes: &[usize],
        backend_request: &SpectralBackendRequest,
    ) -> StreamingLandmarkExtraction {
        let mut extractor =
            StreamingLandmarkExtractor::new_with_backend_request(config.clone(), backend_request)
                .unwrap();
        let mut offset = 0usize;
        let mut chunk_index = 0usize;
        while offset < pcm.len() {
            let requested = chunk_sizes
                .get(chunk_index % chunk_sizes.len().max(1))
                .copied()
                .unwrap_or(pcm.len())
                .max(1);
            let end = offset.saturating_add(requested).min(pcm.len());
            extractor.push_pcm(&pcm[offset..end]).unwrap();
            offset = end;
            chunk_index += 1;
        }
        extractor.finish_with_backend().unwrap()
    }

    fn synth_streaming_chirp(sample_rate: u32, sample_count: usize) -> Vec<i16> {
        (0..sample_count)
            .map(|sample_index| {
                let time = sample_index as f64 / sample_rate as f64;
                let block = sample_index / (sample_rate as usize / 2).max(1);
                let frequency = 180.0 + (block % 29) as f64 * 83.0;
                let overtone = frequency * 1.73 + (block % 11) as f64 * 17.0;
                let signal = (2.0 * std::f64::consts::PI * frequency * time).sin() * 0.68
                    + (2.0 * std::f64::consts::PI * overtone * time).sin() * 0.27;
                (signal * 24_000.0) as i16
            })
            .collect()
    }

    fn pseudo_random_chunk_sizes(mut state: u64, total_samples: usize) -> Vec<usize> {
        let mut chunks = Vec::new();
        let mut covered = 0usize;
        while covered < total_samples {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let size = (state as usize % 1_531).saturating_add(1);
            chunks.push(size);
            covered = covered.saturating_add(size);
        }
        chunks
    }

    fn affine_speed_drift_fixture() -> (Vec<SpectralLandmark>, Vec<SpectralLandmark>) {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for index in 0..12usize {
            let hash = (((100 + index) as u64) << 8) | 5;
            let source_time_ms = index as i64 * 1_000;
            source.push(test_landmark(hash, source_time_ms));
            target.push(test_landmark(
                hash,
                (source_time_ms as f64 * 1.02).round() as i64 + 5_000,
            ));
            if index < 3 {
                target.push(test_landmark(hash, source_time_ms));
            }
        }
        source.push(test_landmark((999u64 << 8) | 5, 12_000));
        target.sort_by_key(|item| item.time_ms);
        (source, target)
    }

    fn affine_repeated_episode_fixture() -> (Vec<SpectralLandmark>, Vec<SpectralLandmark>) {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for index in 0..25usize {
            let hash = (((10_000 + index) as u64) << 8) | 4;
            let episode_time_ms = index as i64 * 1_000;
            source.push(test_landmark(hash, episode_time_ms));
            source.push(test_landmark(hash, 60_000 + episode_time_ms));
            target.push(test_landmark(hash, 5_000 + episode_time_ms));
        }
        source.sort_by_key(|item| item.time_ms);
        (source, target)
    }

    fn test_landmark(hash: u64, time_ms: i64) -> SpectralLandmark {
        SpectralLandmark {
            hash,
            time_ms,
            strength_milli: 1_000,
        }
    }

    fn test_affine_hypothesis() -> AffineHypothesis {
        AffineHypothesis {
            scale: 1.0,
            offset_ms: 0,
            inlier_count: 10,
            unique_source_count: 10,
            unique_source_coverage: 1.0,
            unique_target_count: 10,
            unique_target_coverage: 1.0,
            source_start_ms: 0,
            source_end_ms: 10_000,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors: Vec::new(),
            held_out_anchors: Vec::new(),
            held_out_within_tolerance_count: 0,
        }
    }

    fn feature_sequence(labels: &[usize], start_ms: i64, hop_ms: i64) -> Vec<FineFeatureFrame> {
        labels
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let mut values = vec![0.0; 8];
                values[*label] = 1.0;
                let presentation_time_ms = start_ms + index as i64 * hop_ms;
                FineFeatureFrame {
                    time_ms: presentation_time_ms,
                    presentation_time_ms,
                    values,
                }
            })
            .collect()
    }

    fn identity_hypothesis() -> AffineHypothesis {
        AffineHypothesis {
            scale: 1.0,
            offset_ms: 0,
            inlier_count: 0,
            unique_source_count: 0,
            unique_source_coverage: 0.0,
            unique_target_count: 0,
            unique_target_coverage: 0.0,
            source_start_ms: 0,
            source_end_ms: 0,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors: Vec::new(),
            held_out_anchors: Vec::new(),
            held_out_within_tolerance_count: 0,
        }
    }

    fn deterministic_noise(length: usize) -> Vec<i16> {
        let mut state = 0x1234_5678u32;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 16) as i16).saturating_div(2)
            })
            .collect()
    }

    fn assert_monotonic(spans: &[EditTimeSpan]) {
        for pair in spans.windows(2) {
            assert_eq!(pair[0].source_end_ms, pair[1].source_start_ms);
            assert_eq!(pair[0].target_end_ms, pair[1].target_start_ms);
        }
    }
}
