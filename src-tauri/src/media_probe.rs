use crate::process_supervision::{
    resolve_supervised_executable, SupervisedCommand, SupervisedOutput, SupervisedOutputLimits,
    SupervisedProcessError, SupervisedProcessErrorKind, SupervisedStreamingLimits,
    SupervisedStreamingOutput,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    ffi::OsString,
    fmt::Write as _,
    fs::{self, File},
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, UNIX_EPOCH},
};

const MEDIA_IDENTITY_ALGORITHM: &str = "sha256-full-file-v2";
const MEDIA_IDENTITY_READ_BUFFER_BYTES: usize = 1024 * 1024;
const SHA256_INITIAL_STATE: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUND_CONSTANTS: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
// This is a total-workload limit, not a resident buffer. 8 GiB covers compact frame+packet
// records for the product's bounded set of audio candidates across a 24-hour local recording,
// while rejecting pathological files long before they can emit tens of GiB for two hours. The
// streaming supervisor retains only a few 32 KiB chunks at any instant.
const AUDIO_TIMELINE_PROBE_MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const AUDIO_TIMELINE_PROBE_MAX_STDERR_BYTES: usize = 1024 * 1024;
const AUDIO_TIMELINE_PROBE_MAX_RECORD_BYTES: usize = 1024 * 1024;
const AUDIO_TIMELINE_PROBE_STDOUT_CHUNK_BYTES: usize = 32 * 1024;
const AUDIO_TIMELINE_PROBE_STDOUT_BUFFERED_CHUNKS: usize = 2;
const AUDIO_TIMELINE_PROBE_MAX_STREAMS: usize = 256;
const AUDIO_TIMELINE_PROBE_MAX_DISCONTINUITIES_PER_STREAM: usize = 1_024;
const AUDIO_PTS_DISCONTINUITY_TOLERANCE_MS: i64 = 5;
const MEDIA_TIMELINE_PROBE_MAX_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const MEDIA_TIMELINE_PROBE_MAX_STDERR_BYTES: usize = 256 * 1024;
const MEDIA_TIMELINE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const AUDIO_TIMELINE_PROBE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const PROBE_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MEDIA_INVENTORY_QUICK_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const MEDIA_INVENTORY_FALLBACK_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_INVENTORY_PROBE_MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MEDIA_INVENTORY_PROBE_MAX_STDERR_BYTES: usize = 256 * 1024;

#[cfg(test)]
thread_local! {
    static MEDIA_IDENTITY_READ_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaInventoryProbePass {
    Quick,
    Fallback,
}

fn media_inventory_probe_arguments(pass: MediaInventoryProbePass, path: &Path) -> Vec<OsString> {
    let mut arguments = vec![OsString::from("-v"), OsString::from("error")];
    if pass == MediaInventoryProbePass::Quick {
        arguments.extend([
            OsString::from("-probesize"),
            OsString::from("1048576"),
            OsString::from("-analyzeduration"),
            OsString::from("2000000"),
        ]);
    }
    arguments.extend([
        OsString::from("-select_streams"),
        OsString::from("a"),
        OsString::from("-show_entries"),
        OsString::from(
            "format=duration:stream=index,codec_type,codec_name,duration,sample_rate,channels,channel_layout:stream_tags=language,title:stream_disposition=default,original,dub,comment,descriptions,visual_impaired,hearing_impaired,clean_effects,karaoke",
        ),
        OsString::from("-of"),
        OsString::from("json"),
        path.as_os_str().to_os_string(),
    ]);
    arguments
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeRequest {
    path: String,
    ffprobe_path: Option<String>,
    ffmpeg_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIdentityProbeRequest {
    path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeSnapshot {
    #[serde(skip_serializing)]
    pub path: String,
    pub presentation_origin_ms: i64,
    pub duration_ms: Option<u64>,
    pub content_identity: Option<MediaContentIdentity>,
    pub video_streams: Vec<VideoStreamProbe>,
    pub audio_streams: Vec<AudioStreamProbe>,
    pub preferred_audio_stream_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContentIdentity {
    pub algorithm: &'static str,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
    pub first_sample_digest: String,
    pub middle_sample_digest: String,
    pub last_sample_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamProbe {
    #[serde(rename = "index")]
    pub stream_index: u32,
    #[serde(rename = "codec")]
    pub codec_name: Option<String>,
    #[serde(rename = "startMs")]
    pub start_time_ms: i64,
    pub timeline_offset_ms: i64,
    pub duration_ms: Option<u64>,
    pub time_base: Option<String>,
    pub frame_rate: Option<f64>,
    pub language: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "default")]
    pub is_default: bool,
    #[serde(rename = "commentary")]
    pub is_commentary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamProbe {
    #[serde(rename = "index")]
    pub stream_index: u32,
    #[serde(rename = "codec")]
    pub codec_name: Option<String>,
    #[serde(rename = "startMs")]
    pub start_time_ms: i64,
    pub timeline_offset_ms: i64,
    pub duration_ms: Option<u64>,
    pub time_base: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    #[serde(skip_serializing)]
    pub channel_layout: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "default")]
    pub is_default: bool,
    #[serde(rename = "commentary")]
    pub is_commentary: bool,
}

/// FFprobe frame/packet evidence used to bind normalized PCM samples to presentation time.
///
/// This evidence intentionally remains internal to the Rust alignment pipeline for now. The
/// selected values are copied into the V2 cache identity and human-readable diagnostics, so a
/// cached landmark set can never be reused after the timestamp interpretation changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AudioPtsDiscontinuity {
    pub frame_ordinal: u64,
    pub previous_end_ms: i64,
    pub next_pts_ms: i64,
    pub delta_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AudioDecodeTimelineProbe {
    pub first_decoded_pts_ms: Option<i64>,
    pub pts_discontinuity_count: u64,
    pub max_pts_gap_ms: Option<u64>,
    pub pts_discontinuities: Vec<AudioPtsDiscontinuity>,
    pub pts_discontinuities_truncated: bool,
    pub skip_samples: u64,
    pub discard_padding: u64,
    pub decoded_frame_count: u64,
    pub decoded_sample_count: u64,
    pub last_decoded_end_ms: Option<i64>,
    pub normalized_pcm_origin_ms: i64,
}

#[derive(Debug, Default)]
struct AudioTimelineAccumulator {
    evidence: AudioDecodeTimelineProbe,
    previous_frame_end_ms: Option<i64>,
}

#[derive(Debug)]
struct AudioTimelineCompactStreamParser {
    accumulators: HashMap<u32, AudioTimelineAccumulator>,
    carry: Vec<u8>,
    record_hard_limit: usize,
}

impl AudioTimelineCompactStreamParser {
    fn new(record_hard_limit: usize) -> Self {
        Self {
            accumulators: HashMap::new(),
            carry: Vec::new(),
            record_hard_limit,
        }
    }

    fn consume_chunk(
        &mut self,
        chunk: &[u8],
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 音频逐帧时间戳结果解析")?;
        let mut remaining = chunk;
        while let Some(newline_offset) = remaining.iter().position(|byte| *byte == b'\n') {
            let record = &remaining[..newline_offset];
            if self.carry.is_empty() {
                self.consume_borrowed_record(record, cancel_flag)?;
            } else {
                self.extend_carry(record)?;
                self.consume_complete_record(cancel_flag)?;
            }
            remaining = &remaining[newline_offset + 1..];
        }
        self.extend_carry(remaining)
    }

    fn finish(
        mut self,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
        ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 音频逐帧时间戳结果解析")?;
        if !self.carry.is_empty() {
            self.consume_complete_record(cancel_flag)?;
        }
        Ok(self
            .accumulators
            .into_iter()
            .filter_map(|(stream_index, accumulator)| {
                (accumulator.evidence.decoded_frame_count > 0)
                    .then_some((stream_index, accumulator.evidence))
            })
            .collect())
    }

    fn extend_carry(&mut self, bytes: &[u8]) -> Result<(), String> {
        // The legacy whole-buffer parser removes one CR before applying the record limit. Keep
        // that exact behavior across chunk boundaries without ever allowing an unbounded carry.
        let Some(next_len) = self.carry.len().checked_add(bytes.len()) else {
            return Err(audio_timeline_record_limit_error(self.record_hard_limit));
        };
        let valid_crlf_allowance =
            self.record_hard_limit
                .checked_add(1)
                .is_some_and(|crlf_limit| {
                    next_len == crlf_limit
                        && bytes.last().or_else(|| self.carry.last()) == Some(&b'\r')
                });
        if next_len > self.record_hard_limit && !valid_crlf_allowance {
            return Err(audio_timeline_record_limit_error(self.record_hard_limit));
        }
        self.carry.extend_from_slice(bytes);
        Ok(())
    }

    fn consume_borrowed_record(
        &mut self,
        record: &[u8],
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<(), String> {
        ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 音频逐帧时间戳结果解析")?;
        let record = record.strip_suffix(b"\r").unwrap_or(record);
        if record.len() > self.record_hard_limit {
            return Err(audio_timeline_record_limit_error(self.record_hard_limit));
        }
        let record = String::from_utf8_lossy(record);
        apply_audio_timeline_compact_record(record.trim(), &mut self.accumulators)
    }

    fn consume_complete_record(&mut self, cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
        ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 音频逐帧时间戳结果解析")?;
        let mut record = std::mem::take(&mut self.carry);
        if record.last() == Some(&b'\r') {
            record.pop();
        }
        if record.len() > self.record_hard_limit {
            return Err(audio_timeline_record_limit_error(self.record_hard_limit));
        }
        let result = {
            let record_text = String::from_utf8_lossy(&record);
            apply_audio_timeline_compact_record(record_text.trim(), &mut self.accumulators)
        };
        record.clear();
        self.carry = record;
        result
    }
}

fn audio_timeline_record_limit_error(record_hard_limit: usize) -> String {
    format!(
        "blocked:resource-limit：FFprobe 音频逐帧时间戳单条记录超过 {} KiB 硬上限。",
        record_hard_limit / 1024
    )
}

#[derive(Debug, Deserialize)]
struct RawProbeOutput {
    #[serde(default)]
    streams: Vec<RawProbeStream>,
    format: Option<RawProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct RawProbeFormat {
    start_time: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProbeStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    start_time: Option<String>,
    duration: Option<String>,
    time_base: Option<String>,
    avg_frame_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    disposition: Option<RawDisposition>,
}

#[derive(Debug, Default, Deserialize)]
struct RawDisposition {
    #[serde(default)]
    default: u8,
    #[serde(default)]
    original: u8,
    #[serde(default)]
    dub: u8,
    #[serde(default)]
    comment: u8,
    #[serde(default)]
    descriptions: u8,
    #[serde(default)]
    visual_impaired: u8,
    #[serde(default)]
    hearing_impaired: u8,
    #[serde(default)]
    clean_effects: u8,
    #[serde(default)]
    karaoke: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaInventoryProbeCompleteness {
    Complete,
    Partial,
    FallbackRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaInventoryAudioDispositions {
    pub is_default: bool,
    pub is_original: bool,
    pub is_dub: bool,
    pub is_commentary: bool,
    pub is_descriptions: bool,
    pub is_visual_impaired: bool,
    pub is_hearing_impaired: bool,
    pub is_clean_effects: bool,
    pub is_karaoke: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaInventoryAudioStreamMetadata {
    pub stream_index: u32,
    pub codec_name: Option<String>,
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub channel_layout: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub dispositions: MediaInventoryAudioDispositions,
    pub commentary_title_hint: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaInventoryProbeMetadata {
    pub duration_ms: Option<u64>,
    pub audio_streams: Vec<MediaInventoryAudioStreamMetadata>,
    pub completeness: MediaInventoryProbeCompleteness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaInventoryMetadataProbeErrorKind {
    FfprobeUnavailable,
    ProbeTimeout,
    ProbeOutputLimit,
    ProbeFailed,
    InvalidProbeOutput,
    MetadataIncomplete,
    Cancelled,
    ProcessCleanupFault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaInventoryMetadataProbeError {
    kind: MediaInventoryMetadataProbeErrorKind,
    message: String,
}

impl MediaInventoryMetadataProbeError {
    fn new(kind: MediaInventoryMetadataProbeErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn kind(&self) -> MediaInventoryMetadataProbeErrorKind {
        self.kind
    }
}

impl std::fmt::Display for MediaInventoryMetadataProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MediaInventoryMetadataProbeError {}

trait MediaInventoryProbeCommandRunner: Send + Sync {
    fn run(
        &self,
        executable: &Path,
        pass: MediaInventoryProbePass,
        arguments: &[OsString],
        cancel_flag: &AtomicBool,
    ) -> Result<Vec<u8>, MediaInventoryMetadataProbeError>;
}

struct SupervisedMediaInventoryProbeCommandRunner;

impl MediaInventoryProbeCommandRunner for SupervisedMediaInventoryProbeCommandRunner {
    fn run(
        &self,
        executable: &Path,
        pass: MediaInventoryProbePass,
        arguments: &[OsString],
        cancel_flag: &AtomicBool,
    ) -> Result<Vec<u8>, MediaInventoryMetadataProbeError> {
        let mut command = SupervisedCommand::new(executable);
        command.args(arguments.iter());
        let limits = media_inventory_probe_limits(pass);
        let output = command
            .output(limits, || cancel_flag.load(Ordering::Acquire))
            .map_err(map_media_inventory_supervision_error)?;
        if !output.status.success() {
            return Err(MediaInventoryMetadataProbeError::new(
                MediaInventoryMetadataProbeErrorKind::ProbeFailed,
                "FFprobe 媒体清单探测失败；本地路径与工具输出已隐藏。",
            ));
        }
        Ok(output.stdout)
    }
}

#[derive(Clone)]
pub(crate) struct MediaInventoryMetadataProbe {
    executable: PathBuf,
    tool_stamp: u64,
    runner: Arc<dyn MediaInventoryProbeCommandRunner>,
}

impl MediaInventoryMetadataProbe {
    pub(crate) fn prepare(
        ffprobe_path: Option<&str>,
        ffmpeg_path: Option<&str>,
    ) -> Result<Self, MediaInventoryMetadataProbeError> {
        let requested = resolve_requested_ffprobe_path(ffprobe_path, ffmpeg_path);
        let executable = resolve_supervised_executable(&requested)
            .map_err(map_media_inventory_supervision_error)?;
        let tool_stamp = media_inventory_tool_stamp(&executable);
        Ok(Self {
            executable,
            tool_stamp,
            runner: Arc::new(SupervisedMediaInventoryProbeCommandRunner),
        })
    }

    #[cfg(test)]
    fn with_test_runner(
        executable: PathBuf,
        tool_stamp: u64,
        runner: Arc<dyn MediaInventoryProbeCommandRunner>,
    ) -> Self {
        Self {
            executable,
            tool_stamp,
            runner,
        }
    }

    pub(crate) fn tool_stamp(&self) -> u64 {
        self.tool_stamp
    }

    pub(crate) fn probe(
        &self,
        path: &Path,
        cancel_flag: &AtomicBool,
    ) -> Result<MediaInventoryProbeMetadata, MediaInventoryMetadataProbeError> {
        if cancel_flag.load(Ordering::Acquire) {
            return Err(cancelled_media_inventory_probe_error());
        }
        let quick_arguments = media_inventory_probe_arguments(MediaInventoryProbePass::Quick, path);
        let quick = self
            .runner
            .run(
                &self.executable,
                MediaInventoryProbePass::Quick,
                &quick_arguments,
                cancel_flag,
            )
            .and_then(|output| {
                let text = std::str::from_utf8(&output).map_err(|_| {
                    MediaInventoryMetadataProbeError::new(
                        MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput,
                        "FFprobe 返回的媒体清单不是 UTF-8。",
                    )
                })?;
                parse_media_inventory_probe_json(text)
            });
        match quick {
            Ok(metadata) if metadata.completeness == MediaInventoryProbeCompleteness::Complete => {
                Ok(metadata)
            }
            Ok(_) => self.run_fallback(path, cancel_flag).map(|mut metadata| {
                if metadata.completeness == MediaInventoryProbeCompleteness::Complete {
                    metadata.completeness = MediaInventoryProbeCompleteness::FallbackRequired;
                }
                metadata
            }),
            Err(error) if should_try_media_inventory_fallback(error.kind()) => {
                self.run_fallback(path, cancel_flag).map(|mut metadata| {
                    if metadata.completeness == MediaInventoryProbeCompleteness::Complete {
                        metadata.completeness = MediaInventoryProbeCompleteness::FallbackRequired;
                    }
                    metadata
                })
            }
            Err(error) => Err(error),
        }
    }

    fn run_fallback(
        &self,
        path: &Path,
        cancel_flag: &AtomicBool,
    ) -> Result<MediaInventoryProbeMetadata, MediaInventoryMetadataProbeError> {
        if cancel_flag.load(Ordering::Acquire) {
            return Err(cancelled_media_inventory_probe_error());
        }
        let arguments = media_inventory_probe_arguments(MediaInventoryProbePass::Fallback, path);
        let output = self.runner.run(
            &self.executable,
            MediaInventoryProbePass::Fallback,
            &arguments,
            cancel_flag,
        )?;
        let text = std::str::from_utf8(&output).map_err(|_| {
            MediaInventoryMetadataProbeError::new(
                MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput,
                "FFprobe 返回的媒体清单不是 UTF-8。",
            )
        })?;
        parse_media_inventory_probe_json(text)
    }
}

fn media_inventory_probe_limits(pass: MediaInventoryProbePass) -> SupervisedOutputLimits {
    SupervisedOutputLimits {
        execution_timeout: match pass {
            MediaInventoryProbePass::Quick => MEDIA_INVENTORY_QUICK_PROBE_TIMEOUT,
            MediaInventoryProbePass::Fallback => MEDIA_INVENTORY_FALLBACK_PROBE_TIMEOUT,
        },
        output_drain_timeout: PROBE_OUTPUT_DRAIN_TIMEOUT,
        termination_timeout: PROBE_TERMINATION_TIMEOUT,
        poll_interval: PROBE_POLL_INTERVAL,
        stdout_hard_limit: MEDIA_INVENTORY_PROBE_MAX_STDOUT_BYTES,
        stderr_hard_limit: MEDIA_INVENTORY_PROBE_MAX_STDERR_BYTES,
    }
}

fn map_media_inventory_supervision_error(
    error: SupervisedProcessError,
) -> MediaInventoryMetadataProbeError {
    let (kind, message) = match error.kind() {
        SupervisedProcessErrorKind::Spawn => (
            MediaInventoryMetadataProbeErrorKind::FfprobeUnavailable,
            "无法启动 FFprobe 媒体清单探测。",
        ),
        SupervisedProcessErrorKind::Timeout | SupervisedProcessErrorKind::NoProgress => (
            MediaInventoryMetadataProbeErrorKind::ProbeTimeout,
            "FFprobe 媒体清单探测超过有界等待时间。",
        ),
        SupervisedProcessErrorKind::Cancelled => (
            MediaInventoryMetadataProbeErrorKind::Cancelled,
            "FFprobe 媒体清单探测已取消。",
        ),
        SupervisedProcessErrorKind::StdoutOverflow | SupervisedProcessErrorKind::StderrOverflow => {
            (
                MediaInventoryMetadataProbeErrorKind::ProbeOutputLimit,
                "FFprobe 媒体清单输出超过安全上限。",
            )
        }
        SupervisedProcessErrorKind::Cleanup => (
            MediaInventoryMetadataProbeErrorKind::ProcessCleanupFault,
            "FFprobe 媒体清单进程树未能可信收尾。",
        ),
        SupervisedProcessErrorKind::Reader | SupervisedProcessErrorKind::Wait => (
            MediaInventoryMetadataProbeErrorKind::ProbeFailed,
            "FFprobe 媒体清单探测未能完成。",
        ),
    };
    MediaInventoryMetadataProbeError::new(kind, message)
}

fn should_try_media_inventory_fallback(kind: MediaInventoryMetadataProbeErrorKind) -> bool {
    matches!(
        kind,
        MediaInventoryMetadataProbeErrorKind::ProbeTimeout
            | MediaInventoryMetadataProbeErrorKind::ProbeFailed
            | MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput
            | MediaInventoryMetadataProbeErrorKind::MetadataIncomplete
    )
}

fn cancelled_media_inventory_probe_error() -> MediaInventoryMetadataProbeError {
    MediaInventoryMetadataProbeError::new(
        MediaInventoryMetadataProbeErrorKind::Cancelled,
        "FFprobe 媒体清单探测已取消。",
    )
}

fn media_inventory_tool_stamp(executable: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    executable.hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(executable) {
        metadata.len().hash(&mut hasher);
        metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .hash(&mut hasher);
    }
    hasher.finish()
}

#[tauri::command]
pub fn probe_media_timeline(request: MediaProbeRequest) -> Result<MediaProbeSnapshot, String> {
    let path = request.path.trim();
    if path.is_empty() {
        return Err("媒体路径不能为空。".to_string());
    }
    if path.contains("://") {
        return Err("高精度媒体探测只接受用户导入的本地文件。".to_string());
    }
    crate::local_media_path::ensure_local_media_path(path)?;
    let media_path = Path::new(path);
    if !media_path.is_file() {
        return Err("媒体文件不存在或不可读取。".to_string());
    }

    let ffprobe_path = resolve_requested_ffprobe_path(
        request.ffprobe_path.as_deref(),
        request.ffmpeg_path.as_deref(),
    );
    probe_media_timeline_with_ffprobe(path, &ffprobe_path)
}

/// Computes only the stable content identity. This command deliberately has no FFmpeg/FFprobe
/// dependency, so export preflight cannot fail merely because a media-analysis tool moved.
#[tauri::command]
pub fn probe_media_identity(
    request: MediaIdentityProbeRequest,
) -> Result<MediaContentIdentity, String> {
    let path = request.path.trim();
    validate_local_media_path(path)?;
    probe_media_content_identity(Path::new(path))
}

fn validate_local_media_path(path: &str) -> Result<(), String> {
    crate::local_media_path::ensure_local_media_path(path)?;
    if path.is_empty() {
        return Err("媒体路径不能为空。".to_string());
    }
    if path.contains("://") {
        return Err("媒体身份探测只接受用户导入的本地文件。".to_string());
    }
    if !Path::new(path).is_file() {
        return Err("媒体文件不存在或不可读取。".to_string());
    }
    Ok(())
}

pub(crate) fn probe_media_timeline_with_ffprobe(
    path: &str,
    ffprobe_path: &Path,
) -> Result<MediaProbeSnapshot, String> {
    probe_media_timeline_with_ffprobe_cancellable(path, ffprobe_path, None)
}

pub(crate) fn probe_media_timeline_with_ffprobe_cancellable(
    path: &str,
    ffprobe_path: &Path,
    cancel_flag: Option<&AtomicBool>,
) -> Result<MediaProbeSnapshot, String> {
    ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 媒体时间线探测")?;
    let content_identity_before =
        probe_media_content_identity_cancellable(Path::new(path), cancel_flag)?;
    let mut command = SupervisedCommand::new(ffprobe_path);
    command.args([
        "-v",
        "error",
        "-show_entries",
        "format=start_time,duration:stream=index,codec_type,codec_name,start_time,duration,time_base,avg_frame_rate,sample_rate,channels,channel_layout:stream_tags=language,title:stream_disposition=default,comment",
        "-of",
        "json",
        path,
    ]);
    let output = run_supervised_ffprobe(
        &command,
        media_timeline_probe_limits(),
        || alignment_probe_cancelled(cancel_flag),
        "FFprobe 媒体时间线探测",
    )?;
    // FFprobe re-opens the path independently. Re-hash after it exits so a path replacement or
    // in-place rewrite during analysis can never be paired with stale stream metadata.
    let content_identity_after =
        probe_media_content_identity_cancellable(Path::new(path), cancel_flag)?;
    if !are_media_content_identities_equal(&content_identity_before, &content_identity_after) {
        return Err(
            "媒体文件在 FFprobe 分析期间被替换或修改，请等待文件稳定后重新分析。".to_string(),
        );
    }
    ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 媒体时间线结果解析")?;
    let output_text = String::from_utf8_lossy(&output.stdout);
    let mut snapshot = parse_media_probe_json_cancellable(path, &output_text, cancel_flag)?;
    snapshot.content_identity = Some(content_identity_after);
    Ok(snapshot)
}

/// Scans decoded audio frame PTS and packet skip-sample metadata under a bounded process owner.
///
/// Compact records are aggregated incrementally through a two-slot bounded queue. The supervisor
/// still enforces a large but finite total-workload cap, timeout, cancellation and whole-process-
/// tree cleanup, while resident stdout stays bounded to small chunks plus one 1 MiB record carry.
#[cfg(test)]
pub(crate) fn probe_audio_decode_timelines_with_ffprobe(
    path: &str,
    ffprobe_path: &Path,
) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
    let expected_identity = probe_media_content_identity(Path::new(path))?;
    probe_audio_decode_timelines_with_ffprobe_cancellable(
        path,
        ffprobe_path,
        &expected_identity,
        None,
    )
}

pub(crate) fn probe_audio_decode_timelines_with_ffprobe_cancellable(
    path: &str,
    ffprobe_path: &Path,
    expected_identity: &MediaContentIdentity,
    cancel_flag: Option<&AtomicBool>,
) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
    ensure_alignment_probe_not_cancelled(cancel_flag, "FFprobe 音频逐帧时间戳探测")?;
    let content_identity_before = probe_audio_timeline_guard_identity(path, cancel_flag)?;
    ensure_strict_audio_timeline_identity_match(expected_identity, &content_identity_before)?;
    let mut command = SupervisedCommand::new(ffprobe_path);
    command.args([
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_frames",
        "-show_packets",
        "-show_entries",
        "frame=stream_index,best_effort_timestamp_time,pts_time,pkt_duration_time,nb_samples:frame_side_data=side_data_type,skip_samples,discard_padding:packet=stream_index,pts_time,duration_time:packet_side_data=side_data_type,skip_samples,discard_padding",
        "-of",
        "compact=p=1:nk=0",
        path,
    ]);
    let limits = audio_timeline_probe_streaming_limits();
    let mut parser = AudioTimelineCompactStreamParser::new(AUDIO_TIMELINE_PROBE_MAX_RECORD_BYTES);
    let mut consumer_error = None;
    let output = command
        .stream_stdout(
            limits,
            || alignment_probe_cancelled(cancel_flag),
            |chunk| match parser.consume_chunk(chunk, cancel_flag) {
                Ok(()) => Ok(()),
                Err(error) => {
                    consumer_error = Some(error.clone());
                    Err(error)
                }
            },
        )
        .map_err(|error| {
            if error.kind() == SupervisedProcessErrorKind::Reader {
                if let Some(error) = consumer_error.take() {
                    return error;
                }
            }
            format_supervised_ffprobe_error(
                "FFprobe 音频逐帧时间戳探测",
                error,
                limits.process.stdout_hard_limit,
                limits.process.stderr_hard_limit,
            )
        })?;
    ensure_supervised_ffprobe_streaming_success(&output, "FFprobe 音频逐帧时间戳探测")?;
    // Aggregation starts while stdout is flowing, but the result remains local and unusable until
    // every process in the supervised Job exits and the full file identity is re-verified.
    let content_identity_after = probe_audio_timeline_guard_identity(path, cancel_flag)?;
    ensure_strict_audio_timeline_identity_match(&content_identity_before, &content_identity_after)?;
    ensure_strict_audio_timeline_identity_match(expected_identity, &content_identity_after)?;
    parser.finish(cancel_flag)
}

fn probe_audio_timeline_guard_identity(
    path: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<MediaContentIdentity, String> {
    probe_media_content_identity_cancellable(Path::new(path), cancel_flag).map_err(|error| {
        if error.starts_with("cancelled：") {
            "cancelled：FFprobe 音频逐帧时间戳身份复核已取消。".to_string()
        } else {
            "blocked:media-identity-recheck：FFprobe 音频逐帧时间戳探测无法复核全文件媒体身份；未解析工具输出。"
                .to_string()
        }
    })
}

fn ensure_strict_audio_timeline_identity_match(
    expected: &MediaContentIdentity,
    observed: &MediaContentIdentity,
) -> Result<(), String> {
    if expected == observed {
        Ok(())
    } else {
        Err(
            "blocked:media-identity-changed：媒体文件在逐帧/packet PTS 探测期间发生变化；未解析工具输出。"
                .to_string(),
        )
    }
}

fn alignment_probe_cancelled(cancel_flag: Option<&AtomicBool>) -> bool {
    cancel_flag.is_some_and(|flag| flag.load(Ordering::Acquire))
}

fn ensure_alignment_probe_not_cancelled(
    cancel_flag: Option<&AtomicBool>,
    context: &str,
) -> Result<(), String> {
    if alignment_probe_cancelled(cancel_flag) {
        Err(format!("cancelled：{context}已取消。"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn parse_audio_timeline_compact_output(
    output: &[u8],
    record_hard_limit: usize,
) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
    parse_audio_timeline_compact_output_cancellable(output, record_hard_limit, None)
}

#[cfg(test)]
fn parse_audio_timeline_compact_output_cancellable(
    output: &[u8],
    record_hard_limit: usize,
    cancel_flag: Option<&AtomicBool>,
) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
    let mut parser = AudioTimelineCompactStreamParser::new(record_hard_limit);
    parser.consume_chunk(output, cancel_flag)?;
    parser.finish(cancel_flag)
}

fn media_timeline_probe_limits() -> SupervisedOutputLimits {
    SupervisedOutputLimits {
        execution_timeout: MEDIA_TIMELINE_PROBE_TIMEOUT,
        output_drain_timeout: PROBE_OUTPUT_DRAIN_TIMEOUT,
        termination_timeout: PROBE_TERMINATION_TIMEOUT,
        poll_interval: PROBE_POLL_INTERVAL,
        stdout_hard_limit: MEDIA_TIMELINE_PROBE_MAX_STDOUT_BYTES,
        stderr_hard_limit: MEDIA_TIMELINE_PROBE_MAX_STDERR_BYTES,
    }
}

fn audio_timeline_probe_streaming_limits() -> SupervisedStreamingLimits {
    SupervisedStreamingLimits {
        process: SupervisedOutputLimits {
            execution_timeout: AUDIO_TIMELINE_PROBE_TIMEOUT,
            output_drain_timeout: PROBE_OUTPUT_DRAIN_TIMEOUT,
            termination_timeout: PROBE_TERMINATION_TIMEOUT,
            poll_interval: PROBE_POLL_INTERVAL,
            stdout_hard_limit: usize::try_from(AUDIO_TIMELINE_PROBE_MAX_TOTAL_BYTES)
                .unwrap_or(usize::MAX),
            stderr_hard_limit: AUDIO_TIMELINE_PROBE_MAX_STDERR_BYTES,
        },
        stdout_chunk_size: AUDIO_TIMELINE_PROBE_STDOUT_CHUNK_BYTES,
        stdout_buffered_chunks: AUDIO_TIMELINE_PROBE_STDOUT_BUFFERED_CHUNKS,
        stdout_inactivity_timeout: None,
    }
}

fn ensure_supervised_ffprobe_streaming_success(
    output: &SupervisedStreamingOutput,
    context: &str,
) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        let exit = output
            .status
            .code()
            .map(|code| format!("退出码 {code}"))
            .unwrap_or_else(|| "无退出码".to_string());
        Err(format!(
            "{context}失败（{exit}）；为保护本地路径与访问凭据，未回显媒体工具错误输出。"
        ))
    }
}

fn run_supervised_ffprobe<F>(
    command: &SupervisedCommand,
    limits: SupervisedOutputLimits,
    is_cancelled: F,
    context: &str,
) -> Result<SupervisedOutput, String>
where
    F: Fn() -> bool,
{
    let output = command.output(limits, is_cancelled).map_err(|error| {
        format_supervised_ffprobe_error(
            context,
            error,
            limits.stdout_hard_limit,
            limits.stderr_hard_limit,
        )
    })?;
    if !output.status.success() {
        let exit = output
            .status
            .code()
            .map(|code| format!("退出码 {code}"))
            .unwrap_or_else(|| "无退出码".to_string());
        return Err(format!(
            "{context}失败（{exit}）；为保护本地路径与访问凭据，未回显媒体工具错误输出。"
        ));
    }
    Ok(output)
}

fn format_supervised_ffprobe_error(
    context: &str,
    error: SupervisedProcessError,
    stdout_limit: usize,
    stderr_limit: usize,
) -> String {
    match error.kind() {
        SupervisedProcessErrorKind::Spawn => format!("{context}无法在受监督进程中启动。"),
        SupervisedProcessErrorKind::Timeout => {
            format!("blocked:process-timeout：{context}超过最长执行或有界收尾时间。")
        }
        SupervisedProcessErrorKind::NoProgress => {
            format!("blocked:process-stalled：{context}持续没有产生新数据，已终止进程。")
        }
        SupervisedProcessErrorKind::Cancelled => format!("cancelled：{context}已取消。"),
        SupervisedProcessErrorKind::StdoutOverflow => format!(
            "blocked:resource-limit：{context}标准输出超过 {} MiB 硬上限。",
            stdout_limit.div_ceil(1024 * 1024)
        ),
        SupervisedProcessErrorKind::StderrOverflow => format!(
            "blocked:resource-limit：{context}错误输出超过 {} KiB 硬上限。",
            stderr_limit.div_ceil(1024)
        ),
        SupervisedProcessErrorKind::Reader => {
            #[cfg(test)]
            {
                format!("{context}的有界输出读取失败（test-safe-detail: {error}）。")
            }
            #[cfg(not(test))]
            {
                format!("{context}的有界输出读取失败。")
            }
        }
        SupervisedProcessErrorKind::Wait => format!("{context}的受监督进程状态读取失败。"),
        SupervisedProcessErrorKind::Cleanup => {
            format!("blocked:cleanup-failed：{context}的受监督进程树未完成有界清理。")
        }
    }
}

fn apply_audio_timeline_compact_record(
    record: &str,
    accumulators: &mut HashMap<u32, AudioTimelineAccumulator>,
) -> Result<(), String> {
    if record.is_empty() {
        return Ok(());
    }
    let mut fields = record.split('|');
    let record_type = fields.next().unwrap_or_default();
    let mut stream_index = None;
    let mut best_effort_timestamp_time = None;
    let mut pts_time = None;
    let mut packet_duration_time = None;
    let mut nb_samples = None;
    let mut skip_samples = None;
    let mut discard_padding = None;
    for field in fields {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        match key {
            "stream_index" => stream_index = Some(value),
            "best_effort_timestamp_time" => best_effort_timestamp_time = Some(value),
            "pts_time" => pts_time = Some(value),
            "pkt_duration_time" => packet_duration_time = Some(value),
            "nb_samples" => nb_samples = Some(value),
            "skip_samples" => skip_samples = Some(value),
            "discard_padding" => discard_padding = Some(value),
            _ => {}
        }
    }
    let Some(stream_index) = stream_index.and_then(|value| value.parse::<u32>().ok()) else {
        return Ok(());
    };
    let stream_capacity_reached = accumulators.len() >= AUDIO_TIMELINE_PROBE_MAX_STREAMS;
    let accumulator = match accumulators.entry(stream_index) {
        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
        std::collections::hash_map::Entry::Vacant(entry) if !stream_capacity_reached => {
            entry.insert(AudioTimelineAccumulator::default())
        }
        std::collections::hash_map::Entry::Vacant(_) => {
            return Err(format!(
                "blocked:resource-limit：FFprobe 音频逐帧时间戳输出超过 {AUDIO_TIMELINE_PROBE_MAX_STREAMS} 条音频流硬上限。"
            ));
        }
    };
    match record_type {
        "frame" => {
            let pts_ms = best_effort_timestamp_time
                .or(pts_time)
                .and_then(|value| parse_signed_seconds_ms(Some(value)));
            let Some(pts_ms) = pts_ms else {
                return Ok(());
            };
            let duration_ms = packet_duration_time
                .and_then(|value| parse_duration_ms(Some(value)))
                .and_then(|value| i64::try_from(value).ok())
                .filter(|value| *value > 0);
            accumulator
                .evidence
                .first_decoded_pts_ms
                .get_or_insert(pts_ms);
            accumulator.evidence.decoded_frame_count =
                accumulator.evidence.decoded_frame_count.saturating_add(1);
            accumulator.evidence.decoded_sample_count =
                accumulator.evidence.decoded_sample_count.saturating_add(
                    nb_samples
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0),
                );
            if let Some(previous_end_ms) = accumulator.previous_frame_end_ms {
                let gap_ms = pts_ms.saturating_sub(previous_end_ms);
                if gap_ms.abs() > AUDIO_PTS_DISCONTINUITY_TOLERANCE_MS {
                    accumulator.evidence.pts_discontinuity_count = accumulator
                        .evidence
                        .pts_discontinuity_count
                        .saturating_add(1);
                    let absolute_gap = gap_ms.unsigned_abs();
                    accumulator.evidence.max_pts_gap_ms = Some(
                        accumulator
                            .evidence
                            .max_pts_gap_ms
                            .unwrap_or(0)
                            .max(absolute_gap),
                    );
                    if accumulator.evidence.pts_discontinuities.len()
                        < AUDIO_TIMELINE_PROBE_MAX_DISCONTINUITIES_PER_STREAM
                    {
                        accumulator
                            .evidence
                            .pts_discontinuities
                            .push(AudioPtsDiscontinuity {
                                frame_ordinal: accumulator.evidence.decoded_frame_count,
                                previous_end_ms,
                                next_pts_ms: pts_ms,
                                delta_ms: gap_ms,
                            });
                    } else {
                        accumulator.evidence.pts_discontinuities_truncated = true;
                    }
                }
            }
            accumulator.previous_frame_end_ms =
                duration_ms.map(|duration_ms| pts_ms.saturating_add(duration_ms));
            accumulator.evidence.last_decoded_end_ms = accumulator.previous_frame_end_ms;
        }
        "packet" => {
            accumulator.evidence.skip_samples = accumulator.evidence.skip_samples.saturating_add(
                skip_samples
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0),
            );
            accumulator.evidence.discard_padding =
                accumulator.evidence.discard_padding.saturating_add(
                    discard_padding
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0),
                );
        }
        _ => {}
    }
    Ok(())
}

/// Creates a deterministic full-file identity for replacement detection.
///
/// The file is opened exactly once. Both metadata reads and the streaming SHA-256 hash use that
/// same handle, so swapping the directory entry cannot splice samples from different files. The
/// legacy three digest fields are intentionally all populated with the same complete-file digest
/// to keep schema v10 projects readable without a migration.
pub(crate) fn probe_media_content_identity(path: &Path) -> Result<MediaContentIdentity, String> {
    probe_media_content_identity_cancellable(path, None)
}

pub(crate) fn probe_media_content_identity_cancellable(
    path: &Path,
    cancel_flag: Option<&AtomicBool>,
) -> Result<MediaContentIdentity, String> {
    #[cfg(test)]
    MEDIA_IDENTITY_READ_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    ensure_alignment_probe_not_cancelled(cancel_flag, "媒体身份读取")?;
    let mut file =
        File::open(path).map_err(|error| format!("无法打开媒体文件以生成身份：{error}"))?;
    let metadata_before = file
        .metadata()
        .map_err(|error| format!("无法从已打开媒体读取身份元数据：{error}"))?;
    if !metadata_before.is_file() {
        return Err("媒体身份只能从本地文件生成。".to_string());
    }
    let size_bytes = metadata_before.len();
    let modified_unix_ms = read_modified_unix_ms(&metadata_before)?;
    let mut hasher = StreamingSha256::new();
    let mut buffer = vec![0_u8; MEDIA_IDENTITY_READ_BUFFER_BYTES];
    let mut bytes_read = 0_u64;
    loop {
        ensure_alignment_probe_not_cancelled(cancel_flag, "媒体身份读取")?;
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("媒体身份全文件读取失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes_read = bytes_read.saturating_add(read as u64);
    }

    ensure_alignment_probe_not_cancelled(cancel_flag, "媒体身份读取")?;

    let metadata_after = file
        .metadata()
        .map_err(|error| format!("媒体身份读取后无法从同一文件句柄重读元数据：{error}"))?;
    if bytes_read != size_bytes
        || metadata_after.len() != size_bytes
        || read_modified_unix_ms(&metadata_after)? != modified_unix_ms
    {
        return Err("媒体文件在全文件身份读取期间发生变化，请等待写入完成后重试。".to_string());
    }
    let full_digest = sha256_hex(hasher.finalize());

    Ok(MediaContentIdentity {
        algorithm: MEDIA_IDENTITY_ALGORITHM,
        size_bytes,
        modified_unix_ms,
        first_sample_digest: full_digest.clone(),
        middle_sample_digest: full_digest.clone(),
        last_sample_digest: full_digest,
    })
}

/// Small dependency-free SHA-256 implementation used only for streaming local-file identity.
/// The implementation follows FIPS 180-4 and is covered by the NIST `abc` and million-`a`
/// vectors below. Keeping the state here avoids loading a multi-gigabyte video into memory.
struct StreamingSha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    message_len_bytes: u64,
}

impl StreamingSha256 {
    fn new() -> Self {
        Self {
            state: SHA256_INITIAL_STATE,
            buffer: [0; 64],
            buffer_len: 0,
            message_len_bytes: 0,
        }
    }

    fn update(&mut self, mut input: &[u8]) {
        self.message_len_bytes = self.message_len_bytes.wrapping_add(input.len() as u64);

        if self.buffer_len > 0 {
            let missing = 64 - self.buffer_len;
            let copied = missing.min(input.len());
            self.buffer[self.buffer_len..self.buffer_len + copied]
                .copy_from_slice(&input[..copied]);
            self.buffer_len += copied;
            input = &input[copied..];
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.compress_block(&block);
                self.buffer_len = 0;
            }
        }

        while input.len() >= 64 {
            let block: &[u8; 64] = input[..64].try_into().expect("64-byte SHA-256 block slice");
            self.compress_block(block);
            input = &input[64..];
        }

        if !input.is_empty() {
            self.buffer[..input.len()].copy_from_slice(input);
            self.buffer_len = input.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.message_len_bytes.wrapping_mul(8);
        self.buffer[self.buffer_len] = 0x80;
        self.buffer_len += 1;
        if self.buffer_len > 56 {
            self.buffer[self.buffer_len..].fill(0);
            let block = self.buffer;
            self.compress_block(&block);
            self.buffer = [0; 64];
            self.buffer_len = 0;
        }
        self.buffer[self.buffer_len..56].fill(0);
        self.buffer[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buffer;
        self.compress_block(&block);

        let mut digest = [0_u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        digest
    }

    fn compress_block(&mut self, block: &[u8; 64]) {
        let mut schedule = [0_u32; 64];
        for (index, word) in block.chunks_exact(4).enumerate() {
            schedule[index] = u32::from_be_bytes(
                word.try_into()
                    .expect("four-byte SHA-256 message schedule word"),
            );
        }
        for index in 16..64 {
            let sigma0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let sigma1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(sigma0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(sigma1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for index in 0..64 {
            let upper_sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let temporary1 = h
                .wrapping_add(upper_sigma1)
                .wrapping_add(choice)
                .wrapping_add(SHA256_ROUND_CONSTANTS[index])
                .wrapping_add(schedule[index]);
            let upper_sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temporary2 = upper_sigma0.wrapping_add(majority);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temporary1);
            d = c;
            c = b;
            b = a;
            a = temporary1.wrapping_add(temporary2);
        }

        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }
}

fn sha256_hex(digest: [u8; 32]) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing SHA-256 into String cannot fail");
    }
    encoded
}

/// Content equality intentionally ignores mtime for v2. mtime remains serialized as a useful
/// cache/diagnostic hint, but copying identical bytes must not invalidate a verified time map.
pub(crate) fn are_media_content_identities_equal(
    left: &MediaContentIdentity,
    right: &MediaContentIdentity,
) -> bool {
    if left.algorithm == MEDIA_IDENTITY_ALGORITHM && right.algorithm == MEDIA_IDENTITY_ALGORITHM {
        return left.size_bytes == right.size_bytes
            && left.first_sample_digest == right.first_sample_digest
            && left.middle_sample_digest == right.middle_sample_digest
            && left.last_sample_digest == right.last_sample_digest;
    }
    left == right
}

fn read_modified_unix_ms(metadata: &fs::Metadata) -> Result<u64, String> {
    let modified = metadata
        .modified()
        .map_err(|error| format!("无法读取媒体文件修改时间：{error}"))?;
    let elapsed = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "媒体文件修改时间早于 Unix epoch，无法建立稳定身份。".to_string())?;
    u64::try_from(elapsed.as_millis()).map_err(|_| "媒体文件修改时间超出可保存范围。".to_string())
}

pub(crate) fn resolve_ffprobe_path(ffmpeg_path: &str) -> PathBuf {
    let trimmed = ffmpeg_path.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("ffmpeg") {
        return PathBuf::from("ffprobe");
    }
    let ffmpeg = Path::new(trimmed);
    let Some(file_name) = ffmpeg.file_name().and_then(|value| value.to_str()) else {
        return PathBuf::from("ffprobe");
    };
    let probe_file_name = if file_name.eq_ignore_ascii_case("ffmpeg.exe") {
        "ffprobe.exe"
    } else if file_name.eq_ignore_ascii_case("ffmpeg") {
        "ffprobe"
    } else {
        return PathBuf::from("ffprobe");
    };
    ffmpeg.with_file_name(probe_file_name)
}

fn resolve_requested_ffprobe_path(
    ffprobe_path: Option<&str>,
    ffmpeg_path: Option<&str>,
) -> PathBuf {
    ffprobe_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_ffprobe_path(ffmpeg_path.unwrap_or("ffmpeg")))
}

fn parse_media_inventory_probe_json(
    text: &str,
) -> Result<MediaInventoryProbeMetadata, MediaInventoryMetadataProbeError> {
    let raw: RawProbeOutput = serde_json::from_str(text).map_err(|_| {
        MediaInventoryMetadataProbeError::new(
            MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput,
            "FFprobe 返回的媒体清单 JSON 无法解析。",
        )
    })?;
    if raw.format.is_none() && raw.streams.is_empty() {
        return Err(MediaInventoryMetadataProbeError::new(
            MediaInventoryMetadataProbeErrorKind::MetadataIncomplete,
            "FFprobe 未返回可用的媒体清单 metadata。",
        ));
    }

    let duration_ms = raw
        .format
        .as_ref()
        .and_then(|format| parse_duration_ms(format.duration.as_deref()));
    let mut audio_streams = Vec::new();
    for stream in raw.streams {
        if !matches!(stream.codec_type.as_deref(), None | Some("audio")) {
            continue;
        }
        let disposition = stream.disposition.unwrap_or_default();
        let title = normalized_optional_text(stream.tags.get("title").cloned());
        let commentary_title_hint = title.as_deref().is_some_and(is_commentary_track_title);
        audio_streams.push(MediaInventoryAudioStreamMetadata {
            stream_index: stream.index,
            codec_name: normalized_optional_text(stream.codec_name),
            duration_ms: parse_duration_ms(stream.duration.as_deref()),
            sample_rate: stream
                .sample_rate
                .as_deref()
                .and_then(|value| value.parse::<u32>().ok()),
            channels: stream.channels,
            channel_layout: normalized_optional_text(stream.channel_layout),
            language: normalized_optional_text(stream.tags.get("language").cloned()),
            title,
            dispositions: MediaInventoryAudioDispositions {
                is_default: disposition.default == 1,
                is_original: disposition.original == 1,
                is_dub: disposition.dub == 1,
                is_commentary: disposition.comment == 1,
                is_descriptions: disposition.descriptions == 1,
                is_visual_impaired: disposition.visual_impaired == 1,
                is_hearing_impaired: disposition.hearing_impaired == 1,
                is_clean_effects: disposition.clean_effects == 1,
                is_karaoke: disposition.karaoke == 1,
            },
            commentary_title_hint,
        });
    }
    audio_streams.sort_by_key(|stream| stream.stream_index);
    if audio_streams
        .windows(2)
        .any(|window| window[0].stream_index == window[1].stream_index)
    {
        return Err(MediaInventoryMetadataProbeError::new(
            MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput,
            "FFprobe 返回了重复的音轨索引。",
        ));
    }
    let completeness = if duration_ms.is_none()
        || audio_streams.iter().any(|stream| {
            stream.codec_name.is_none() || stream.sample_rate.is_none() || stream.channels.is_none()
        }) {
        MediaInventoryProbeCompleteness::Partial
    } else {
        MediaInventoryProbeCompleteness::Complete
    };

    Ok(MediaInventoryProbeMetadata {
        duration_ms,
        audio_streams,
        completeness,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaProbeJsonParseCheckpoint {
    BeforeDeserialize,
    AfterDeserialize,
    NormalizeStream,
    AfterNormalize,
}

#[cfg(test)]
fn parse_media_probe_json(path: &str, text: &str) -> Result<MediaProbeSnapshot, String> {
    parse_media_probe_json_with_cancel_check(path, text, |_| false)
}

fn parse_media_probe_json_cancellable(
    path: &str,
    text: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<MediaProbeSnapshot, String> {
    parse_media_probe_json_with_cancel_check(path, text, |_| alignment_probe_cancelled(cancel_flag))
}

fn parse_media_probe_json_with_cancel_check<F>(
    path: &str,
    text: &str,
    mut is_cancelled: F,
) -> Result<MediaProbeSnapshot, String>
where
    F: FnMut(MediaProbeJsonParseCheckpoint) -> bool,
{
    let ensure_not_cancelled = |cancelled: bool| {
        if cancelled {
            Err("cancelled：FFprobe 媒体时间线结果解析已取消。".to_string())
        } else {
            Ok(())
        }
    };
    // Production stdout is already capped at 8 MiB by the process supervisor. Checking on both
    // sides of serde's bounded in-memory deserialize avoids returning a snapshot after a cancel;
    // normalization additionally checks once per stream so a metadata-heavy result is interruptible.
    ensure_not_cancelled(is_cancelled(
        MediaProbeJsonParseCheckpoint::BeforeDeserialize,
    ))?;
    let raw: RawProbeOutput =
        serde_json::from_str(text).map_err(|error| format!("FFprobe JSON 无法解析：{error}"))?;
    ensure_not_cancelled(is_cancelled(
        MediaProbeJsonParseCheckpoint::AfterDeserialize,
    ))?;
    let format_start_ms = raw
        .format
        .as_ref()
        .and_then(|format| parse_signed_seconds_ms(format.start_time.as_deref()));
    let earliest_stream_start_ms = raw
        .streams
        .iter()
        .filter(|stream| matches!(stream.codec_type.as_deref(), Some("audio" | "video")))
        .filter_map(|stream| parse_signed_seconds_ms(stream.start_time.as_deref()))
        .min();
    let presentation_origin_ms = match (format_start_ms, earliest_stream_start_ms) {
        (Some(format_start), Some(stream_start)) => format_start.min(stream_start),
        (Some(format_start), None) => format_start,
        (None, Some(stream_start)) => stream_start,
        (None, None) => 0,
    };
    let duration_ms = raw
        .format
        .as_ref()
        .and_then(|format| parse_duration_ms(format.duration.as_deref()));

    let mut video_streams = Vec::new();
    let mut audio_streams = Vec::new();
    for stream in raw.streams {
        ensure_not_cancelled(is_cancelled(MediaProbeJsonParseCheckpoint::NormalizeStream))?;
        let start_time_ms =
            parse_signed_seconds_ms(stream.start_time.as_deref()).unwrap_or(presentation_origin_ms);
        let timeline_offset_ms = start_time_ms.saturating_sub(presentation_origin_ms);
        let stream_duration_ms = parse_duration_ms(stream.duration.as_deref());
        let disposition = stream.disposition.unwrap_or_default();
        match stream.codec_type.as_deref() {
            Some("video") => video_streams.push(VideoStreamProbe {
                stream_index: stream.index,
                codec_name: stream.codec_name,
                start_time_ms,
                timeline_offset_ms,
                duration_ms: stream_duration_ms,
                time_base: normalized_optional_text(stream.time_base),
                frame_rate: parse_frame_rate(stream.avg_frame_rate.as_deref()),
                language: normalized_optional_text(stream.tags.get("language").cloned()),
                title: normalized_optional_text(stream.tags.get("title").cloned()),
                is_default: disposition.default == 1,
                is_commentary: disposition.comment == 1,
            }),
            Some("audio") => {
                let title = normalized_optional_text(stream.tags.get("title").cloned());
                let is_commentary = disposition.comment == 1
                    || title.as_deref().is_some_and(is_commentary_track_title);
                audio_streams.push(AudioStreamProbe {
                    stream_index: stream.index,
                    codec_name: stream.codec_name,
                    start_time_ms,
                    timeline_offset_ms,
                    duration_ms: stream_duration_ms,
                    time_base: normalized_optional_text(stream.time_base),
                    sample_rate: stream
                        .sample_rate
                        .as_deref()
                        .and_then(|value| value.parse::<u32>().ok()),
                    channels: stream.channels,
                    channel_layout: normalized_optional_text(stream.channel_layout),
                    language: normalized_optional_text(stream.tags.get("language").cloned()),
                    title,
                    is_default: disposition.default == 1,
                    is_commentary,
                });
            }
            _ => {}
        }
    }
    video_streams.sort_by_key(|stream| stream.stream_index);
    audio_streams.sort_by_key(|stream| stream.stream_index);
    let preferred_audio_stream_index = choose_preferred_audio_stream(&audio_streams);
    ensure_not_cancelled(is_cancelled(MediaProbeJsonParseCheckpoint::AfterNormalize))?;

    Ok(MediaProbeSnapshot {
        path: path.to_string(),
        presentation_origin_ms,
        duration_ms,
        content_identity: None,
        video_streams,
        audio_streams,
        preferred_audio_stream_index,
    })
}

pub fn choose_preferred_audio_stream(streams: &[AudioStreamProbe]) -> Option<u32> {
    streams
        .iter()
        .min_by_key(|stream| {
            (
                stream.is_commentary,
                !stream.is_default,
                stream.stream_index,
            )
        })
        .map(|stream| stream.stream_index)
}

pub(crate) fn select_audio_stream(
    snapshot: &MediaProbeSnapshot,
    requested_stream_index: Option<u32>,
    label: &str,
) -> Result<AudioStreamProbe, String> {
    let selected_index = match requested_stream_index {
        Some(index) => index,
        None => snapshot
            .preferred_audio_stream_index
            .ok_or_else(|| format!("{label}没有可用音轨。"))?,
    };
    snapshot
        .audio_streams
        .iter()
        .find(|stream| stream.stream_index == selected_index)
        .cloned()
        .ok_or_else(|| format!("{label}不存在音轨 #{selected_index}。"))
}

fn parse_signed_seconds_ms(value: Option<&str>) -> Option<i64> {
    let seconds = value?.parse::<f64>().ok()?;
    if !seconds.is_finite() {
        return None;
    }
    let milliseconds = (seconds * 1000.0).round();
    if milliseconds < i64::MIN as f64 || milliseconds > i64::MAX as f64 {
        return None;
    }
    Some(milliseconds as i64)
}

fn parse_duration_ms(value: Option<&str>) -> Option<u64> {
    let seconds = value?.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let milliseconds = (seconds * 1000.0).round();
    if milliseconds > u64::MAX as f64 {
        return None;
    }
    Some(milliseconds as u64)
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let text = value?.trim();
    let rate = if let Some((numerator, denominator)) = text.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        text.parse::<f64>().ok()?
    };
    rate.is_finite().then_some(rate).filter(|rate| *rate > 0.0)
}

fn normalized_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty() && text != "0/0")
}

fn is_commentary_track_title(title: &str) -> bool {
    let normalized = title.to_lowercase();
    if ["评论", "解说", "导评"]
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return true;
    }

    // A release title such as "DIRECTORS CUT" describes the edition, not the
    // audio track. Only treat explicit commentary words as title evidence;
    // ffprobe's disposition.comment flag remains the authoritative signal.
    normalized.contains("commentary")
        || normalized
            .split(|character: char| !character.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .any(|word| {
                matches!(
                    word,
                    "comment"
                        | "comments"
                        | "commentaire"
                        | "comentario"
                        | "comentarios"
                        | "kommentar"
                        | "commento"
                )
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};

    const PROBE_JSON: &str = r#"
    {
      "streams": [
        {
          "index": 0,
          "codec_type": "video",
          "codec_name": "h264",
          "start_time": "-0.080000",
          "duration": "120.000000",
          "time_base": "1/90000",
          "avg_frame_rate": "24000/1001",
          "disposition": { "default": 1, "comment": 0 }
        },
        {
          "index": 1,
          "codec_type": "audio",
          "codec_name": "aac",
          "start_time": "0.000000",
          "duration": "119.920000",
          "time_base": "1/48000",
          "sample_rate": "48000",
          "channels": 2,
          "channel_layout": "stereo",
          "tags": { "language": "jpn", "title": "Main" },
          "disposition": { "default": 1, "comment": 0 }
        },
        {
          "index": 2,
          "codec_type": "audio",
          "codec_name": "aac",
          "start_time": "0.000000",
          "duration": "119.920000",
          "time_base": "1/48000",
          "sample_rate": "48000",
          "channels": 2,
          "channel_layout": "stereo",
          "tags": { "language": "eng", "title": "Director Commentary" },
          "disposition": { "default": 0, "comment": 1 }
        }
      ],
      "format": { "start_time": "-0.080000", "duration": "120.000000" }
    }
    "#;

    struct TestInventoryProbeRunner {
        responses: Mutex<VecDeque<Result<Vec<u8>, MediaInventoryMetadataProbeError>>>,
        passes: Mutex<Vec<MediaInventoryProbePass>>,
    }

    impl TestInventoryProbeRunner {
        fn new(responses: Vec<Result<Vec<u8>, MediaInventoryMetadataProbeError>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                passes: Mutex::new(Vec::new()),
            }
        }
    }

    impl MediaInventoryProbeCommandRunner for TestInventoryProbeRunner {
        fn run(
            &self,
            _executable: &Path,
            pass: MediaInventoryProbePass,
            _arguments: &[OsString],
            _cancel_flag: &AtomicBool,
        ) -> Result<Vec<u8>, MediaInventoryMetadataProbeError> {
            self.passes.lock().unwrap().push(pass);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("test runner response")
        }
    }

    #[test]
    fn probe_parser_preserves_presentation_offsets_and_stream_identity() {
        let snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();

        assert_eq!(snapshot.presentation_origin_ms, -80);
        assert_eq!(snapshot.duration_ms, Some(120_000));
        assert_eq!(snapshot.video_streams[0].timeline_offset_ms, 0);
        assert!((snapshot.video_streams[0].frame_rate.unwrap() - 24_000.0 / 1_001.0).abs() < 1e-9);
        assert_eq!(snapshot.audio_streams[0].timeline_offset_ms, 80);
        assert_eq!(snapshot.audio_streams[0].language.as_deref(), Some("jpn"));
        assert_eq!(snapshot.preferred_audio_stream_index, Some(1));
        assert!(snapshot.audio_streams[1].is_commentary);
    }

    #[test]
    fn media_timeline_json_parse_honors_every_bounded_cancel_checkpoint() {
        for cancel_at in [
            MediaProbeJsonParseCheckpoint::BeforeDeserialize,
            MediaProbeJsonParseCheckpoint::AfterDeserialize,
            MediaProbeJsonParseCheckpoint::NormalizeStream,
            MediaProbeJsonParseCheckpoint::AfterNormalize,
        ] {
            let error =
                parse_media_probe_json_with_cancel_check("episode.mkv", PROBE_JSON, |checkpoint| {
                    checkpoint == cancel_at
                })
                .expect_err("a cancelled parse checkpoint must not return a snapshot");

            assert!(error.starts_with("cancelled："));
            assert!(error.contains("结果解析"));
        }
    }

    #[test]
    fn probe_snapshot_serialization_matches_the_tauri_wrapper_contract() {
        let snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();
        let serialized = serde_json::to_value(snapshot).unwrap();
        let video = &serialized["videoStreams"][0];
        let audio = &serialized["audioStreams"][0];

        assert!(serialized.get("path").is_none());
        assert_eq!(video["index"], 0);
        assert_eq!(video["codec"], "h264");
        assert_eq!(video["startMs"], -80);
        assert_eq!(video["timelineOffsetMs"], 0);
        assert!((video["frameRate"].as_f64().unwrap() - 24_000.0 / 1_001.0).abs() < 1e-9);
        assert_eq!(video["default"], true);
        assert_eq!(video["commentary"], false);
        assert!(video.get("streamIndex").is_none());
        assert!(video.get("codecName").is_none());
        assert!(video.get("averageFrameRate").is_none());

        assert_eq!(audio["index"], 1);
        assert_eq!(audio["codec"], "aac");
        assert_eq!(audio["startMs"], 0);
        assert_eq!(audio["timelineOffsetMs"], 80);
        assert_eq!(audio["sampleRate"], 48_000);
        assert_eq!(audio["channels"], 2);
        assert_eq!(audio["default"], true);
        assert_eq!(audio["commentary"], false);
        assert!(audio.get("channelLayout").is_none());
    }

    #[test]
    fn probe_parser_falls_back_to_earliest_stream_start() {
        let text = r#"{
          "streams": [
            {"index": 3,"codec_type":"audio","start_time":"1.250","disposition":{}},
            {"index": 0,"codec_type":"video","start_time":"0.500","disposition":{}}
          ]
        }"#;
        let snapshot = parse_media_probe_json("clip.mp4", text).unwrap();

        assert_eq!(snapshot.presentation_origin_ms, 500);
        assert_eq!(snapshot.audio_streams[0].timeline_offset_ms, 750);
    }

    #[test]
    fn probe_parser_uses_earliest_origin_so_relative_timeline_is_non_negative() {
        let text = r#"{
          "streams": [
            {"index":0,"codec_type":"video","start_time":"-0.080","disposition":{}},
            {"index":1,"codec_type":"audio","start_time":"0.000","disposition":{"default":1}}
          ],
          "format":{"start_time":"0.000","duration":"10.000"}
        }"#;
        let snapshot = parse_media_probe_json("clip.mp4", text).unwrap();

        assert_eq!(snapshot.presentation_origin_ms, -80);
        assert_eq!(snapshot.video_streams[0].timeline_offset_ms, 0);
        assert_eq!(snapshot.audio_streams[0].timeline_offset_ms, 80);
        assert!(snapshot
            .video_streams
            .iter()
            .all(|stream| stream.timeline_offset_ms >= 0));
        assert!(snapshot
            .audio_streams
            .iter()
            .all(|stream| stream.timeline_offset_ms >= 0));
    }

    #[test]
    fn preferred_audio_avoids_commentary_before_considering_default_flag() {
        let mut snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();
        snapshot.audio_streams[0].is_default = false;
        snapshot.audio_streams[1].is_default = true;

        assert_eq!(
            choose_preferred_audio_stream(&snapshot.audio_streams),
            Some(1)
        );
    }

    #[test]
    fn commentary_title_detection_does_not_confuse_directors_cut_with_commentary() {
        for title in [
            "Midsommar.2019.DiRECTORS.CUT.720p.BluRay",
            "Director's Cut",
            "Directors Cut English AAC",
            "Theatrical Cut",
            "English Main",
        ] {
            assert!(
                !is_commentary_track_title(title),
                "{title:?} is an edition or main-track title, not commentary"
            );
        }

        for title in [
            "Director Commentary",
            "Director's Commentary",
            "Audio-Commentary by Ari Aster",
            "English Comment",
            "Commentaire du réalisateur",
            "导演评论音轨",
            "中文解说",
        ] {
            assert!(
                is_commentary_track_title(title),
                "{title:?} explicitly identifies commentary"
            );
        }
    }

    #[test]
    fn probe_parser_keeps_a_directors_cut_default_track_eligible() {
        let text = r#"{
          "streams": [{
            "index": 1,
            "codec_type": "audio",
            "codec_name": "aac",
            "start_time": "0.000000",
            "duration": "10215.231000",
            "time_base": "1/48000",
            "sample_rate": "48000",
            "channels": 2,
            "tags": {
              "language": "eng",
              "title": "Midsommar.2019.DiRECTORS.CUT.720p.BluRay.999MB.x264-GalaxyRG"
            },
            "disposition": { "default": 1, "comment": 0 }
          }],
          "format": { "duration": "10215.231000" }
        }"#;

        let snapshot = parse_media_probe_json("Midsommar.Directors.Cut.mkv", text).unwrap();

        assert!(!snapshot.audio_streams[0].is_commentary);
        assert_eq!(snapshot.preferred_audio_stream_index, Some(1));
        assert_eq!(
            select_audio_stream(&snapshot, None, "目标原片")
                .unwrap()
                .stream_index,
            1
        );
    }

    #[test]
    fn audio_stream_selection_uses_preferred_track_but_allows_explicit_override() {
        let snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();

        assert_eq!(
            select_audio_stream(&snapshot, None, "原片")
                .unwrap()
                .stream_index,
            1
        );
        assert_eq!(
            select_audio_stream(&snapshot, Some(2), "原片")
                .unwrap()
                .stream_index,
            2
        );
        assert_eq!(
            select_audio_stream(&snapshot, Some(9), "原片").unwrap_err(),
            "原片不存在音轨 #9。"
        );
    }

    #[test]
    fn ffprobe_path_follows_a_configured_ffmpeg_binary() {
        assert_eq!(
            resolve_ffprobe_path(r"C:\tools\ffmpeg.exe"),
            PathBuf::from(r"C:\tools\ffprobe.exe")
        );
        assert_eq!(resolve_ffprobe_path("ffmpeg"), PathBuf::from("ffprobe"));
        assert_eq!(
            resolve_ffprobe_path(r"C:\tools\custom-decoder.exe"),
            PathBuf::from("ffprobe")
        );
    }

    #[test]
    fn probe_request_prefers_explicit_ffprobe_and_otherwise_follows_ffmpeg() {
        assert_eq!(
            resolve_requested_ffprobe_path(
                Some(r"C:\probe\ffprobe.exe"),
                Some(r"C:\tools\ffmpeg.exe")
            ),
            PathBuf::from(r"C:\probe\ffprobe.exe")
        );
        assert_eq!(
            resolve_requested_ffprobe_path(None, Some(r"C:\tools\ffmpeg.exe")),
            PathBuf::from(r"C:\tools\ffprobe.exe")
        );

        let request: MediaProbeRequest = serde_json::from_str(
            r#"{"path":"episode.mkv","ffprobePath":null,"ffmpegPath":"C:\\tools\\ffmpeg.exe"}"#,
        )
        .unwrap();
        assert_eq!(request.ffmpeg_path.as_deref(), Some(r"C:\tools\ffmpeg.exe"));
    }

    #[test]
    fn inventory_metadata_probe_arguments_are_bounded_and_never_decode_content() {
        let quick = media_inventory_probe_arguments(
            MediaInventoryProbePass::Quick,
            Path::new(r"C:\media\episode.mkv"),
        );
        let fallback = media_inventory_probe_arguments(
            MediaInventoryProbePass::Fallback,
            Path::new(r"C:\media\episode.mkv"),
        );

        let quick_text = quick
            .iter()
            .map(|argument| argument.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let fallback_text = fallback
            .iter()
            .map(|argument| argument.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(quick_text.contains("-probesize 1048576"));
        assert!(quick_text.contains("-analyzeduration 2000000"));
        assert!(!fallback_text.contains("-probesize"));
        for forbidden in [
            "-show_frames",
            "-show_packets",
            "-count_frames",
            "-count_packets",
            "-f lavfi",
            "-map",
        ] {
            assert!(
                !quick_text.contains(forbidden),
                "quick contains {forbidden}"
            );
            assert!(
                !fallback_text.contains(forbidden),
                "fallback contains {forbidden}"
            );
        }
        assert!(quick_text.contains("-select_streams a"));
        assert!(fallback_text.contains("-select_streams a"));
        assert!(quick_text.contains("stream_disposition="));
    }

    #[test]
    fn inventory_metadata_parser_preserves_all_audio_dispositions() {
        let metadata = parse_media_inventory_probe_json(
            r#"{
              "streams": [{
                "index": 7,
                "codec_type": "audio",
                "codec_name": "aac",
                "duration": "12.345",
                "sample_rate": "48000",
                "channels": 2,
                "channel_layout": "stereo",
                "tags": {"language": "eng", "title": "Director Commentary"},
                "disposition": {
                  "default": 1,
                  "original": 1,
                  "dub": 1,
                  "comment": 1,
                  "descriptions": 1,
                  "visual_impaired": 1,
                  "hearing_impaired": 1,
                  "clean_effects": 1,
                  "karaoke": 1
                }
              }],
              "format": {"duration": "12.500"}
            }"#,
        )
        .expect("parse metadata-only output");

        assert_eq!(metadata.duration_ms, Some(12_500));
        assert_eq!(metadata.audio_streams.len(), 1);
        let stream = &metadata.audio_streams[0];
        assert_eq!(stream.stream_index, 7);
        assert_eq!(stream.duration_ms, Some(12_345));
        assert_eq!(stream.sample_rate, Some(48_000));
        assert_eq!(stream.channel_layout.as_deref(), Some("stereo"));
        assert!(stream.dispositions.is_default);
        assert!(stream.dispositions.is_original);
        assert!(stream.dispositions.is_dub);
        assert!(stream.dispositions.is_commentary);
        assert!(stream.dispositions.is_descriptions);
        assert!(stream.dispositions.is_visual_impaired);
        assert!(stream.dispositions.is_hearing_impaired);
        assert!(stream.dispositions.is_clean_effects);
        assert!(stream.dispositions.is_karaoke);
        assert!(stream.commentary_title_hint);
    }

    #[test]
    fn production_inventory_adapter_uses_fallback_without_full_content_identity_reads() {
        MEDIA_IDENTITY_READ_COUNT.with(|count| count.set(0));
        let fallback_json = r#"{
          "streams": [{
            "index": 1,
            "codec_type": "audio",
            "codec_name": "aac",
            "duration": "20.0",
            "sample_rate": "48000",
            "channels": 2,
            "disposition": {}
          }],
          "format": {"duration": "20.0"}
        }"#;
        let runner = Arc::new(TestInventoryProbeRunner::new(vec![
            Ok(b"not-json".to_vec()),
            Ok(fallback_json.as_bytes().to_vec()),
        ]));
        let probe = MediaInventoryMetadataProbe::with_test_runner(
            PathBuf::from("ffprobe-test-double"),
            7,
            runner.clone(),
        );

        let metadata = probe
            .probe(Path::new("opaque-media-path"), &AtomicBool::new(false))
            .expect("fallback metadata");

        assert_eq!(
            metadata.completeness,
            MediaInventoryProbeCompleteness::FallbackRequired
        );
        assert_eq!(metadata.audio_streams[0].stream_index, 1);
        assert_eq!(probe.tool_stamp(), 7);
        assert_eq!(
            *runner.passes.lock().unwrap(),
            vec![
                MediaInventoryProbePass::Quick,
                MediaInventoryProbePass::Fallback
            ]
        );
        MEDIA_IDENTITY_READ_COUNT.with(|count| assert_eq!(count.get(), 0));
    }

    #[test]
    fn inventory_partial_quick_result_never_hides_fallback_failures() {
        let partial_json = br#"{
          "streams": [{"index": 1, "codec_type": "audio", "disposition": {}}],
          "format": {"duration": "20.0"}
        }"#;
        let cases = vec![
            (
                "timeout",
                Err(MediaInventoryMetadataProbeError::new(
                    MediaInventoryMetadataProbeErrorKind::ProbeTimeout,
                    "受控 fallback timeout。",
                )),
                MediaInventoryMetadataProbeErrorKind::ProbeTimeout,
            ),
            (
                "probe-failed",
                Err(MediaInventoryMetadataProbeError::new(
                    MediaInventoryMetadataProbeErrorKind::ProbeFailed,
                    "受控 fallback probe failure。",
                )),
                MediaInventoryMetadataProbeErrorKind::ProbeFailed,
            ),
            (
                "invalid-json",
                Ok(b"not-json".to_vec()),
                MediaInventoryMetadataProbeErrorKind::InvalidProbeOutput,
            ),
        ];

        for (label, fallback, expected_kind) in cases {
            let runner = Arc::new(TestInventoryProbeRunner::new(vec![
                Ok(partial_json.to_vec()),
                fallback,
            ]));
            let probe = MediaInventoryMetadataProbe::with_test_runner(
                PathBuf::from("ffprobe-test-double"),
                8,
                runner.clone(),
            );

            let error = match probe.probe(Path::new("opaque-media-path"), &AtomicBool::new(false)) {
                Ok(_) => panic!("{label} fallback failure was hidden"),
                Err(error) => error,
            };

            assert_eq!(error.kind(), expected_kind, "{label}");
            assert_eq!(
                *runner.passes.lock().unwrap(),
                vec![
                    MediaInventoryProbePass::Quick,
                    MediaInventoryProbePass::Fallback
                ],
                "{label}"
            );
        }
    }

    #[test]
    fn inventory_partial_is_published_only_after_fallback_parses_partial_metadata() {
        let partial_json = br#"{
          "streams": [{"index": 1, "codec_type": "audio", "disposition": {}}],
          "format": {"duration": "20.0"}
        }"#;
        let runner = Arc::new(TestInventoryProbeRunner::new(vec![
            Ok(partial_json.to_vec()),
            Ok(partial_json.to_vec()),
        ]));
        let probe = MediaInventoryMetadataProbe::with_test_runner(
            PathBuf::from("ffprobe-test-double"),
            8,
            runner.clone(),
        );

        let metadata = probe
            .probe(Path::new("opaque-media-path"), &AtomicBool::new(false))
            .expect("parsed fallback partial metadata");

        assert_eq!(
            metadata.completeness,
            MediaInventoryProbeCompleteness::Partial
        );
        assert_eq!(
            *runner.passes.lock().unwrap(),
            vec![
                MediaInventoryProbePass::Quick,
                MediaInventoryProbePass::Fallback
            ]
        );
    }

    #[test]
    fn inventory_adapter_observes_cancellation_before_starting_ffprobe() {
        let runner = Arc::new(TestInventoryProbeRunner::new(Vec::new()));
        let probe = MediaInventoryMetadataProbe::with_test_runner(
            PathBuf::from("ffprobe-test-double"),
            9,
            runner.clone(),
        );
        let cancelled = AtomicBool::new(true);

        let error = probe
            .probe(Path::new("opaque-media-path"), &cancelled)
            .expect_err("pre-cancelled probe must fail");

        assert_eq!(
            error.kind(),
            MediaInventoryMetadataProbeErrorKind::Cancelled
        );
        assert!(runner.passes.lock().unwrap().is_empty());
    }

    #[test]
    fn compact_audio_timeline_parser_detects_pts_gap_and_skip_samples() {
        let mut accumulators = HashMap::new();
        for record in [
            "packet|stream_index=2|pts_time=-0.021333|duration_time=0.021333|side_data|side_data_type=Skip Samples|skip_samples=1024|discard_padding=0",
            "frame|stream_index=2|pts_time=0.000000|best_effort_timestamp_time=0.000000|pkt_duration_time=0.020000|nb_samples=960",
            "frame|stream_index=2|pts_time=0.020000|best_effort_timestamp_time=0.020000|pkt_duration_time=0.020000|nb_samples=960",
            "frame|stream_index=2|pts_time=5.040000|best_effort_timestamp_time=5.040000|pkt_duration_time=0.020000|nb_samples=960",
            "packet|stream_index=2|pts_time=5.040000|duration_time=0.020000|side_data|side_data_type=Skip Samples|skip_samples=0|discard_padding=256",
        ] {
            apply_audio_timeline_compact_record(record, &mut accumulators).unwrap();
        }
        let evidence = &accumulators.get(&2).unwrap().evidence;

        assert_eq!(evidence.first_decoded_pts_ms, Some(0));
        assert_eq!(evidence.decoded_frame_count, 3);
        assert_eq!(evidence.decoded_sample_count, 2_880);
        assert_eq!(evidence.pts_discontinuity_count, 1);
        assert_eq!(evidence.max_pts_gap_ms, Some(5_000));
        assert_eq!(
            evidence.pts_discontinuities,
            vec![AudioPtsDiscontinuity {
                frame_ordinal: 3,
                previous_end_ms: 40,
                next_pts_ms: 5_040,
                delta_ms: 5_000,
            }]
        );
        assert!(!evidence.pts_discontinuities_truncated);
        assert_eq!(evidence.last_decoded_end_ms, Some(5_060));
        assert_eq!(evidence.skip_samples, 1_024);
        assert_eq!(evidence.discard_padding, 256);
        assert_eq!(evidence.normalized_pcm_origin_ms, 0);
    }

    #[test]
    fn compact_audio_timeline_parser_records_negative_pts_reset_direction() {
        let mut accumulators = HashMap::new();
        for record in [
            "frame|stream_index=1|pts_time=5.000000|best_effort_timestamp_time=5.000000|pkt_duration_time=0.020000|nb_samples=960",
            "frame|stream_index=1|pts_time=0.000000|best_effort_timestamp_time=0.000000|pkt_duration_time=0.020000|nb_samples=960",
        ] {
            apply_audio_timeline_compact_record(record, &mut accumulators).unwrap();
        }

        let evidence = &accumulators.get(&1).unwrap().evidence;
        assert_eq!(evidence.pts_discontinuity_count, 1);
        assert_eq!(evidence.max_pts_gap_ms, Some(5_020));
        assert_eq!(evidence.pts_discontinuities[0].delta_ms, -5_020);
        assert_eq!(evidence.pts_discontinuities[0].previous_end_ms, 5_020);
        assert_eq!(evidence.pts_discontinuities[0].next_pts_ms, 0);
    }

    #[test]
    fn compact_audio_timeline_output_has_a_per_record_hard_limit() {
        let valid =
            b"frame|stream_index=2|best_effort_timestamp_time=1.250|pkt_duration_time=0.020\n";
        let parsed = parse_audio_timeline_compact_output(valid, valid.len()).unwrap();
        assert_eq!(parsed[&2].first_decoded_pts_ms, Some(1_250));

        let oversized = vec![b'x'; 1_025];
        let error = parse_audio_timeline_compact_output(&oversized, 1_024).unwrap_err();
        assert!(error.starts_with("blocked:resource-limit"));
        assert!(error.contains("单条记录"));
    }

    #[test]
    fn compact_audio_timeline_output_caps_distinct_stream_accumulators() {
        use std::fmt::Write as _;

        let mut output = String::new();
        for stream_index in 0..=AUDIO_TIMELINE_PROBE_MAX_STREAMS {
            writeln!(
                output,
                "frame|stream_index={stream_index}|best_effort_timestamp_time=0.000"
            )
            .unwrap();
        }

        let error = parse_audio_timeline_compact_output(
            output.as_bytes(),
            AUDIO_TIMELINE_PROBE_MAX_RECORD_BYTES,
        )
        .unwrap_err();
        assert!(error.starts_with("blocked:resource-limit"));
        assert!(error.contains("音频流硬上限"));
    }

    fn legacy_reference_audio_timeline_parse(
        output: &[u8],
        record_hard_limit: usize,
    ) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
        let mut accumulators = HashMap::<u32, AudioTimelineAccumulator>::new();
        for line in output.split(|byte| *byte == b'\n') {
            let record = line.strip_suffix(b"\r").unwrap_or(line);
            if record.len() > record_hard_limit {
                return Err(audio_timeline_record_limit_error(record_hard_limit));
            }
            let record = String::from_utf8_lossy(record);
            apply_audio_timeline_compact_record(record.trim(), &mut accumulators)?;
        }
        Ok(accumulators
            .into_iter()
            .filter_map(|(stream_index, accumulator)| {
                (accumulator.evidence.decoded_frame_count > 0)
                    .then_some((stream_index, accumulator.evidence))
            })
            .collect())
    }

    #[test]
    fn streaming_compact_parser_matches_legacy_across_deterministic_random_chunk_boundaries() {
        let mut output = Vec::new();
        for frame_index in 0..257u32 {
            let stream_index = frame_index % 3;
            let pts_seconds = f64::from(frame_index) * 0.021_333;
            let ending: &[u8] = if frame_index % 2 == 0 { b"\r\n" } else { b"\n" };
            output.extend_from_slice(
                format!(
                    "frame|stream_index={stream_index}|best_effort_timestamp_time={pts_seconds:.6}|pkt_duration_time=0.021333|nb_samples=1024"
                )
                .as_bytes(),
            );
            output.extend_from_slice(ending);
            if frame_index % 31 == 0 {
                output.extend_from_slice(
                    format!(
                        "packet|stream_index={stream_index}|pts_time={pts_seconds:.6}|duration_time=0.021333|side_data_type=Skip Samples|skip_samples={frame_index}|discard_padding=0\n"
                    )
                    .as_bytes(),
                );
            }
        }
        // Exercise String::from_utf8_lossy compatibility on a record that is otherwise ignored.
        output.extend_from_slice(b"ignored|stream_index=9|tag=");
        output.extend_from_slice(&[0xff, 0xfe, b' ']);

        let expected =
            legacy_reference_audio_timeline_parse(&output, AUDIO_TIMELINE_PROBE_MAX_RECORD_BYTES)
                .unwrap();
        for seed in 1..=64u64 {
            let mut parser =
                AudioTimelineCompactStreamParser::new(AUDIO_TIMELINE_PROBE_MAX_RECORD_BYTES);
            let mut state = seed;
            let mut offset = 0usize;
            while offset < output.len() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                let chunk_len = ((state as usize) % 4_093).saturating_add(1);
                let end = offset.saturating_add(chunk_len).min(output.len());
                parser.consume_chunk(&output[offset..end], None).unwrap();
                offset = end;
            }
            assert_eq!(parser.finish(None).unwrap(), expected, "seed {seed}");
        }
    }

    #[test]
    fn streaming_compact_parser_enforces_bounded_carry_with_crlf_compatibility() {
        let mut parser = AudioTimelineCompactStreamParser::new(8);
        parser.consume_chunk(b"12345678", None).unwrap();
        let error = parser.consume_chunk(b"9", None).unwrap_err();
        assert!(error.starts_with("blocked:resource-limit"));

        let mut crlf_parser = AudioTimelineCompactStreamParser::new(8);
        crlf_parser.consume_chunk(b"12345678\r", None).unwrap();
        crlf_parser.consume_chunk(b"\n", None).unwrap();
        assert!(crlf_parser.finish(None).unwrap().is_empty());

        let mut cr_not_at_eol = AudioTimelineCompactStreamParser::new(8);
        cr_not_at_eol.consume_chunk(b"12345678\r", None).unwrap();
        let error = cr_not_at_eol.consume_chunk(b"x", None).unwrap_err();
        assert!(error.starts_with("blocked:resource-limit"));
    }

    #[test]
    fn streaming_compact_parser_consumes_eof_residual_and_observes_cancellation() {
        let record =
            b"frame|stream_index=7|best_effort_timestamp_time=1.250|pkt_duration_time=0.020";
        let mut parser = AudioTimelineCompactStreamParser::new(1_024);
        parser.consume_chunk(&record[..17], None).unwrap();
        parser.consume_chunk(&record[17..], None).unwrap();
        let parsed = parser.finish(None).unwrap();
        assert_eq!(parsed[&7].first_decoded_pts_ms, Some(1_250));
        assert_eq!(parsed[&7].decoded_frame_count, 1);

        let cancelled = AtomicBool::new(false);
        let mut parser = AudioTimelineCompactStreamParser::new(1_024);
        parser
            .consume_chunk(&record[..17], Some(&cancelled))
            .unwrap();
        cancelled.store(true, Ordering::Release);
        let error = parser
            .consume_chunk(&record[17..], Some(&cancelled))
            .unwrap_err();
        assert!(error.starts_with("cancelled"));
    }

    #[test]
    fn installed_ffprobe_streaming_audio_timeline_smoke() {
        let Ok(ffprobe_path) = crate::process_supervision::resolve_supervised_executable("ffprobe")
        else {
            return;
        };
        let path = std::env::temp_dir().join(format!(
            "media-probe-streaming-smoke-{}-{}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sample_rate = 8_000u32;
        let sample_count = sample_rate / 5;
        let data_bytes = sample_count * 2;
        let mut wav = Vec::with_capacity(44 + data_bytes as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        wav.resize(44 + data_bytes as usize, 0);
        std::fs::write(&path, wav).unwrap();

        let identity = probe_media_content_identity(&path).unwrap();
        let parsed = probe_audio_decode_timelines_with_ffprobe_cancellable(
            &path.to_string_lossy(),
            &ffprobe_path,
            &identity,
            None,
        )
        .unwrap();
        let evidence = parsed.values().next().expect("one WAV audio stream");
        assert_eq!(evidence.first_decoded_pts_ms, Some(0));
        assert!(evidence.decoded_frame_count > 0);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    #[ignore = "requires user-provided real media and profiles supervised stdout transport"]
    fn production_real_media_audio_pts_transport_profile_from_environment() {
        let source_path = std::env::var("C137_REAL_MEDIA_SOURCE")
            .expect("C137_REAL_MEDIA_SOURCE must point to one reference video");
        assert!(
            Path::new(&source_path).is_file(),
            "C137_REAL_MEDIA_SOURCE is not a file"
        );
        let mut command = SupervisedCommand::new("ffprobe");
        command.args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_frames",
            "-show_packets",
            "-show_entries",
            "frame=stream_index,best_effort_timestamp_time,pts_time,pkt_duration_time,nb_samples:frame_side_data=side_data_type,skip_samples,discard_padding:packet=stream_index,pts_time,duration_time:packet_side_data=side_data_type,skip_samples,discard_padding",
            "-of",
            "compact=p=1:nk=0",
            &source_path,
        ]);
        let mut chunk_count = 0_u64;
        let mut observed_bytes = 0_u64;
        let started_at = std::time::Instant::now();
        let output = command
            .stream_stdout(
                audio_timeline_probe_streaming_limits(),
                || false,
                |chunk| {
                    chunk_count = chunk_count.saturating_add(1);
                    observed_bytes = observed_bytes.saturating_add(chunk.len() as u64);
                    Ok(())
                },
            )
            .expect("real-media supervised PTS transport profile must complete");
        assert!(output.status.success());
        assert_eq!(output.stdout_bytes as u64, observed_bytes);
        let elapsed_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        eprintln!(
            "C137 real-media audio PTS transport profile: elapsedMs={elapsed_ms} chunkCount={chunk_count} stdoutBytes={observed_bytes}"
        );
    }

    #[cfg(windows)]
    fn supervised_probe_helper_command(test_name: &str) -> SupervisedCommand {
        let mut command = SupervisedCommand::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", test_name, "--nocapture"]);
        command
    }

    #[cfg(windows)]
    fn supervised_probe_test_limits(
        timeout: Duration,
        stdout_hard_limit: usize,
        stderr_hard_limit: usize,
    ) -> SupervisedOutputLimits {
        SupervisedOutputLimits {
            execution_timeout: timeout,
            output_drain_timeout: Duration::from_millis(200),
            termination_timeout: Duration::from_secs(2),
            poll_interval: Duration::from_millis(5),
            stdout_hard_limit,
            stderr_hard_limit,
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-probe supervised stdout overflow helper"]
    fn supervised_probe_stdout_overflow_helper() {
        use std::io::Write as _;

        let mut stdout = std::io::stdout();
        for _ in 0..16 {
            stdout.write_all(&[b'x'; 4 * 1024]).unwrap();
        }
        stdout.flush().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-probe supervised stderr overflow helper"]
    fn supervised_probe_stderr_overflow_helper() {
        use std::io::Write as _;

        let mut stderr = std::io::stderr();
        for _ in 0..16 {
            stderr.write_all(&[b'e'; 4 * 1024]).unwrap();
        }
        stderr.flush().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-probe supervised nonzero helper"]
    fn supervised_probe_sensitive_stderr_helper() {
        use std::io::Write as _;

        std::io::stderr()
            .write_all(br#"C:\Users\alice\private\episode.mkv?api_key=secret-token&token=other"#)
            .unwrap();
        std::io::stderr().flush().unwrap();
        std::process::exit(23);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-probe supervised cancellation helper"]
    #[allow(clippy::zombie_processes)]
    fn supervised_probe_cancellation_helper() {
        use std::io::Write as _;
        use std::process::Command;

        let descendant = Command::new("ping.exe")
            .args(["-t", "127.0.0.1"])
            .spawn()
            .unwrap();
        writeln!(std::io::stdout(), "descendant={}", descendant.id()).unwrap();
        std::io::stdout().flush().unwrap();
        std::mem::forget(descendant);
        std::thread::sleep(Duration::from_secs(30));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_probe_wrapper_stdout_overflow_is_bounded() {
        let command = supervised_probe_helper_command(
            "media_probe::tests::supervised_probe_stdout_overflow_helper",
        );
        let started = std::time::Instant::now();
        let error = run_supervised_ffprobe(
            &command,
            supervised_probe_test_limits(Duration::from_secs(3), 1_024, 64 * 1024),
            || false,
            "wrapper probe",
        )
        .unwrap_err();

        assert!(error.starts_with("blocked:resource-limit"));
        assert!(error.contains("标准输出"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_probe_wrapper_stderr_overflow_is_bounded() {
        let command = supervised_probe_helper_command(
            "media_probe::tests::supervised_probe_stderr_overflow_helper",
        );
        let started = std::time::Instant::now();
        let error = run_supervised_ffprobe(
            &command,
            supervised_probe_test_limits(Duration::from_secs(3), 64 * 1024, 1_024),
            || false,
            "wrapper probe",
        )
        .unwrap_err();

        assert!(error.starts_with("blocked:resource-limit"));
        assert!(error.contains("错误输出"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_probe_nonzero_error_never_echoes_stderr_or_local_paths() {
        let command = supervised_probe_helper_command(
            "media_probe::tests::supervised_probe_sensitive_stderr_helper",
        );
        let error = run_supervised_ffprobe(
            &command,
            supervised_probe_test_limits(Duration::from_secs(3), 64 * 1024, 64 * 1024),
            || false,
            "wrapper probe",
        )
        .unwrap_err();

        assert!(error.contains("退出码 23"));
        assert!(!error.contains("alice"));
        assert!(!error.contains("episode.mkv"));
        assert!(!error.contains("secret-token"));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_probe_cancel_and_watchdog_are_bounded_for_wrapper_descendants() {
        let cancelled_command = supervised_probe_helper_command(
            "media_probe::tests::supervised_probe_cancellation_helper",
        );
        let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
        let setter_flag = cancel_flag.clone();
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            setter_flag.store(true, Ordering::Release);
        });
        let cancel_started = std::time::Instant::now();
        let cancelled = run_supervised_ffprobe(
            &cancelled_command,
            supervised_probe_test_limits(Duration::from_secs(3), 64 * 1024, 64 * 1024),
            || alignment_probe_cancelled(Some(cancel_flag.as_ref())),
            "wrapper probe",
        )
        .unwrap_err();
        setter.join().unwrap();
        assert!(cancelled.starts_with("cancelled"));
        assert!(cancel_started.elapsed() < Duration::from_secs(4));

        let timeout_command = supervised_probe_helper_command(
            "media_probe::tests::supervised_probe_cancellation_helper",
        );
        let timeout_started = std::time::Instant::now();
        let timed_out = run_supervised_ffprobe(
            &timeout_command,
            supervised_probe_test_limits(Duration::from_millis(150), 64 * 1024, 64 * 1024),
            || false,
            "wrapper probe",
        )
        .unwrap_err();
        assert!(timed_out.starts_with("blocked:process-timeout"));
        assert!(timeout_started.elapsed() < Duration::from_secs(4));
    }

    #[cfg(windows)]
    #[test]
    fn production_probe_variants_observe_an_already_cancelled_atomic_flag() {
        let media_path = std::env::temp_dir().join(format!(
            "media-probe-cancel-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&media_path, b"cancel-probe-fixture").unwrap();
        let executable = std::env::current_exe().unwrap();
        let cancelled = AtomicBool::new(true);
        let path = media_path.to_string_lossy();
        let expected_identity = probe_media_content_identity(&media_path).unwrap();

        let timeline_error =
            probe_media_timeline_with_ffprobe_cancellable(&path, &executable, Some(&cancelled))
                .unwrap_err();
        assert!(timeline_error.starts_with("cancelled"));

        let frames_error = probe_audio_decode_timelines_with_ffprobe_cancellable(
            &path,
            &executable,
            &expected_identity,
            Some(&cancelled),
        )
        .unwrap_err();
        assert!(frames_error.starts_with("cancelled"));

        std::fs::remove_file(media_path).unwrap();
    }

    #[test]
    fn media_content_identity_is_stable_and_binds_every_byte_and_size() {
        let path = std::env::temp_dir().join(format!(
            "media-identity-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = (0..256 * 1024usize)
            .map(|index| (index.wrapping_mul(31) % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&path, &bytes).unwrap();
        let stable = probe_media_content_identity(&path).unwrap();
        assert_eq!(stable, probe_media_content_identity(&path).unwrap());
        assert_eq!(stable.algorithm, "sha256-full-file-v2");
        assert_eq!(stable.first_sample_digest.len(), 64);
        assert_eq!(stable.first_sample_digest, stable.middle_sample_digest);
        assert_eq!(stable.middle_sample_digest, stable.last_sample_digest);

        let mut previous = stable;
        for index in [0usize, 96 * 1024, bytes.len() / 2, bytes.len() - 1] {
            bytes[index] ^= 0x5a;
            std::fs::write(&path, &bytes).unwrap();
            let changed = probe_media_content_identity(&path).unwrap();
            assert_ne!(previous, changed, "sample index {index} was not bound");
            previous = changed;
        }
        bytes.push(7);
        std::fs::write(&path, &bytes).unwrap();
        let resized = probe_media_content_identity(&path).unwrap();
        assert_ne!(previous, resized);
        assert_eq!(resized.size_bytes, bytes.len() as u64);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn audio_timeline_identity_guard_is_strict_and_redacts_probe_failures() {
        let digest = "a".repeat(64);
        let expected = MediaContentIdentity {
            algorithm: MEDIA_IDENTITY_ALGORITHM,
            size_bytes: 42,
            modified_unix_ms: 100,
            first_sample_digest: digest.clone(),
            middle_sample_digest: digest.clone(),
            last_sample_digest: digest,
        };
        let mut changed = expected.clone();
        changed.modified_unix_ms = 101;
        let changed_error =
            ensure_strict_audio_timeline_identity_match(&expected, &changed).unwrap_err();
        assert!(changed_error.starts_with("blocked:media-identity-changed"));
        assert!(!changed_error.contains(&expected.first_sample_digest));

        let probe_error = probe_audio_timeline_guard_identity(
            r"C:\Users\alice\private\episode.mkv?token=secret",
            None,
        )
        .unwrap_err();
        assert!(probe_error.starts_with("blocked:media-identity-recheck"));
        assert!(!probe_error.contains("alice"));
        assert!(!probe_error.contains("secret"));
    }

    #[test]
    fn v2_content_equality_ignores_mtime_but_legacy_equality_stays_conservative() {
        let digest = "a".repeat(64);
        let current = MediaContentIdentity {
            algorithm: MEDIA_IDENTITY_ALGORITHM,
            size_bytes: 42,
            modified_unix_ms: 100,
            first_sample_digest: digest.clone(),
            middle_sample_digest: digest.clone(),
            last_sample_digest: digest,
        };
        let mut copied = current.clone();
        copied.modified_unix_ms = 200;
        assert!(are_media_content_identities_equal(&current, &copied));

        let legacy = MediaContentIdentity {
            algorithm: "fnv1a64-first-middle-last-64k-v1",
            size_bytes: 42,
            modified_unix_ms: 100,
            first_sample_digest: "1".repeat(16),
            middle_sample_digest: "2".repeat(16),
            last_sample_digest: "3".repeat(16),
        };
        let mut legacy_rewritten = legacy.clone();
        legacy_rewritten.modified_unix_ms = 200;
        assert!(!are_media_content_identities_equal(
            &legacy,
            &legacy_rewritten
        ));
    }

    #[test]
    fn streaming_sha256_matches_nist_abc_vector() {
        let mut hasher = StreamingSha256::new();
        hasher.update(b"abc");
        assert_eq!(
            sha256_hex(hasher.finalize()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn streaming_sha256_matches_nist_million_a_vector_across_irregular_chunks() {
        let input = vec![b'a'; 1_000_000];
        let mut hasher = StreamingSha256::new();
        let chunk_sizes = [1, 7, 63, 64, 65, 1_023, 4_097];
        let mut offset = 0;
        let mut chunk_index = 0;
        while offset < input.len() {
            let end = (offset + chunk_sizes[chunk_index % chunk_sizes.len()]).min(input.len());
            hasher.update(&input[offset..end]);
            offset = end;
            chunk_index += 1;
        }
        assert_eq!(
            sha256_hex(hasher.finalize()),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
