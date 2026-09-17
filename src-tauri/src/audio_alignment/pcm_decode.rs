use crate::media_probe::AudioDecodeTimelineProbe;

pub(super) const PCM_TIMELINE_POLICY_VERSION: &str = "pcm-timeline-evidence-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PcmTimelineMode {
    SampleClock,
    PreservePositiveGaps,
    LegacyUnprobed,
}

impl PcmTimelineMode {
    fn cache_label(self) -> &'static str {
        match self {
            Self::SampleClock => "sample-clock",
            Self::PreservePositiveGaps => "positive-gap-async",
            Self::LegacyUnprobed => "legacy-unprobed-async",
        }
    }

    fn audio_filter(self, sample_rate: u32) -> String {
        match self {
            Self::SampleClock => format!("aresample={sample_rate},asetpts=N/SR/TB"),
            Self::PreservePositiveGaps | Self::LegacyUnprobed => {
                format!("aresample={sample_rate}:async=1:first_pts=0")
            }
        }
    }

    fn preserves_input_timestamps(self) -> bool {
        true
    }
}

fn timeline_mode(timeline: Option<&AudioDecodeTimelineProbe>) -> Result<PcmTimelineMode, String> {
    let Some(timeline) = timeline else {
        // Legacy callers outside the production V2 probe path have no frame evidence. Keep their
        // old behavior rather than silently changing presentation-time semantics.
        return Ok(PcmTimelineMode::LegacyUnprobed);
    };
    if timeline.pts_discontinuities_truncated {
        return Err(
            "blocked:decode-timeline-inconsistent：音轨 PTS 断点超过可复核上限，无法安全选择 PCM 时间轴策略。"
                .to_string(),
        );
    }
    if timeline
        .pts_discontinuities
        .iter()
        .any(|item| item.delta_ms < 0)
    {
        return Err(
            "blocked:decode-timeline-reset：音轨存在负向 PTS 回跳，无法在不篡改展示时间轴的前提下自动解码。"
                .to_string(),
        );
    }
    if timeline.pts_discontinuity_count == 0 {
        Ok(PcmTimelineMode::SampleClock)
    } else {
        Ok(PcmTimelineMode::PreservePositiveGaps)
    }
}

pub(super) fn cache_identity(
    timeline: Option<&AudioDecodeTimelineProbe>,
) -> Result<String, String> {
    let mode = timeline_mode(timeline)?;
    Ok(format!(
        "policy={PCM_TIMELINE_POLICY_VERSION}|mode={}",
        mode.cache_label()
    ))
}

pub(super) fn legacy_policy_cache_is_compatible(
    timeline: Option<&AudioDecodeTimelineProbe>,
) -> bool {
    matches!(
        timeline_mode(timeline),
        Ok(PcmTimelineMode::PreservePositiveGaps | PcmTimelineMode::LegacyUnprobed)
    )
}

pub(super) fn complete_audio_args(
    media_path: &str,
    stream_index: u32,
    sample_rate: u32,
    timeline: Option<&AudioDecodeTimelineProbe>,
) -> Result<Vec<String>, String> {
    let mode = timeline_mode(timeline)?;
    let mut args = vec![
        "-nostdin".to_string(),
        "-v".to_string(),
        "error".to_string(),
    ];
    if mode.preserves_input_timestamps() {
        args.push("-copyts".to_string());
        args.push("-start_at_zero".to_string());
    }
    args.extend([
        "-i".to_string(),
        media_path.to_string(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-af".to_string(),
        mode.audio_filter(sample_rate),
        "-f".to_string(),
        "s16le".to_string(),
        "pipe:1".to_string(),
    ]);
    Ok(args)
}

pub(super) fn window_audio_args(
    media_path: &str,
    stream_index: u32,
    sample_rate: u32,
    timeline: Option<&AudioDecodeTimelineProbe>,
    seek_ms: u64,
    duration_ms: u64,
) -> Result<Vec<String>, String> {
    let mode = timeline_mode(timeline)?;
    Ok(vec![
        "-nostdin".to_string(),
        "-v".to_string(),
        "error".to_string(),
        // Input-side accurate seeking keeps long compilations bounded. The parent restores the
        // absolute presentation offset after decoding this interval.
        "-ss".to_string(),
        format!("{:.3}", seek_ms as f64 / 1_000.0),
        "-accurate_seek".to_string(),
        "-i".to_string(),
        media_path.to_string(),
        "-map".to_string(),
        format!("0:{stream_index}"),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-af".to_string(),
        mode.audio_filter(sample_rate),
        // Output-side duration and the independent stdout limit jointly bound memory.
        "-t".to_string(),
        format!("{:.3}", duration_ms as f64 / 1_000.0),
        "-f".to_string(),
        "s16le".to_string(),
        "pipe:1".to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_probe::{AudioDecodeTimelineProbe, AudioPtsDiscontinuity};

    #[test]
    fn timeline_mode_rejects_negative_resets_and_truncated_evidence() {
        let negative = AudioDecodeTimelineProbe {
            pts_discontinuity_count: 1,
            pts_discontinuities: vec![AudioPtsDiscontinuity {
                frame_ordinal: 2,
                previous_end_ms: 5_000,
                next_pts_ms: 0,
                delta_ms: -5_000,
            }],
            ..AudioDecodeTimelineProbe::default()
        };
        assert!(timeline_mode(Some(&negative))
            .unwrap_err()
            .starts_with("blocked:decode-timeline-reset"));

        let truncated = AudioDecodeTimelineProbe {
            pts_discontinuity_count: 1,
            pts_discontinuities_truncated: true,
            ..AudioDecodeTimelineProbe::default()
        };
        assert!(timeline_mode(Some(&truncated))
            .unwrap_err()
            .starts_with("blocked:decode-timeline-inconsistent"));
    }
}
