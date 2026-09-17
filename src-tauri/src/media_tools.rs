use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolDetectionRequest {
    pub(crate) tool: String,
    pub(crate) executable_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolDetectionResult {
    pub(crate) tool: String,
    pub(crate) executable_path: String,
    pub(crate) available: bool,
    pub(crate) version: Option<String>,
    pub(crate) message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStartRequest {
    pub(crate) mpv_path: String,
    pub(crate) media_path: String,
    pub(crate) start_position_ms: Option<u64>,
    pub(crate) start_paused: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvControlRequest {
    pub(crate) action: String,
    pub(crate) position_ms: Option<u64>,
    pub(crate) playback_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MpvPlaybackStatus {
    Idle,
    Playing,
    Paused,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvTrackSummary {
    pub(crate) id: i64,
    pub(crate) track_type: String,
    pub(crate) title: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) codec: Option<String>,
    pub(crate) selected: bool,
    pub(crate) external: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSidecarStatus {
    pub(crate) running: bool,
    pub(crate) backend: &'static str,
    pub(crate) playback_status: MpvPlaybackStatus,
    pub(crate) media_path: Option<String>,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: u64,
    pub(crate) tracks: Vec<MpvTrackSummary>,
    pub(crate) message: String,
    pub(crate) error: Option<String>,
    pub(crate) updated_at_ms: u64,
}

#[tauri::command]
pub fn detect_media_tool(
    request: MediaToolDetectionRequest,
) -> Result<MediaToolDetectionResult, String> {
    crate::media_tool_detection::detect_media_tool_inner(request)
}

#[tauri::command]
pub fn start_mpv_sidecar(request: MpvStartRequest) -> Result<MpvSidecarStatus, String> {
    crate::mpv_sidecar::start_mpv_sidecar_inner(request)
}

#[tauri::command]
pub fn stop_mpv_sidecar() -> Result<MpvSidecarStatus, String> {
    crate::mpv_sidecar::stop_mpv_sidecar()
}

#[tauri::command]
pub fn get_mpv_sidecar_status() -> Result<MpvSidecarStatus, String> {
    crate::mpv_sidecar::get_mpv_sidecar_status()
}

#[tauri::command]
pub fn control_mpv_sidecar(request: MpvControlRequest) -> Result<MpvSidecarStatus, String> {
    crate::mpv_sidecar::control_mpv_sidecar(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_tool_detection::{
        detect_media_tool_inner, format_detected_versions, media_tool_detection_limits,
        media_tool_version_argument, parse_media_tool_semantic_version,
        resolve_tool_executable_path,
    };
    #[cfg(windows)]
    use crate::media_tool_detection::{
        format_media_tool_detection_failure, run_media_tool_version_command,
        MediaToolDetectionFailure, MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
    };
    use crate::mpv_sidecar::{
        ensure_mpv_success, parse_mpv_track_list, redact_sensitive_media_text,
        start_mpv_sidecar_inner, validate_mpv_media_path,
    };
    #[cfg(windows)]
    use crate::process_supervision::{SupervisedCommand, SupervisedOutputLimits};
    use serde_json::json;
    #[cfg(windows)]
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn blank_mpv_path_reports_unconfigured() {
        let result = detect_media_tool_inner(MediaToolDetectionRequest {
            tool: "mpv".to_string(),
            executable_path: None,
        })
        .unwrap();

        assert!(!result.available);
        assert_eq!(result.executable_path, "");
        assert!(result.message.contains("尚未配置 mpv 路径"));
    }

    #[test]
    fn ffmpeg_uses_path_when_blank() {
        assert_eq!(resolve_tool_executable_path("ffmpeg", None), "ffmpeg");
        assert_eq!(
            resolve_tool_executable_path("mpv", Some(" C:\\tools\\mpv.exe ")),
            "C:\\tools\\mpv.exe"
        );
    }

    #[test]
    fn unknown_tool_is_rejected() {
        assert!(crate::media_tool_detection::normalize_media_tool("vlc").is_err());
    }

    #[test]
    fn detection_contract_uses_ten_second_and_64_kib_hard_limits() {
        let limits = media_tool_detection_limits();

        assert_eq!(limits.execution_timeout, Duration::from_secs(10));
        assert_eq!(limits.stdout_hard_limit, 64 * 1024);
        assert_eq!(limits.stderr_hard_limit, 64 * 1024);
    }

    #[test]
    fn detection_uses_each_tools_supported_version_switch() {
        assert_eq!(media_tool_version_argument("ffmpeg"), "-version");
        assert_eq!(media_tool_version_argument("ffprobe"), "-version");
        assert_eq!(media_tool_version_argument("mpv"), "--version");
    }

    #[test]
    fn media_tool_versions_are_reduced_to_tool_name_and_numeric_semver() {
        let ffmpeg = parse_media_tool_semantic_version(
            "ffmpeg",
            br#"ffmpeg version 7.1.1-full_build-www.example.test Copyright secret C:\Users\alice"#,
            b"",
        );
        let mpv = parse_media_tool_semantic_version(
            "mpv",
            b"unrelated banner\nmpv v0.40.0-dirty Copyright private-builder",
            b"",
        );

        assert_eq!(ffmpeg.as_deref(), Some("7.1.1"));
        assert_eq!(mpv.as_deref(), Some("0.40.0"));
        let ffmpeg_label = format_detected_versions(&[("FFmpeg", ffmpeg.as_deref())]).unwrap();
        let mpv_label = format_detected_versions(&[("mpv", mpv.as_deref())]).unwrap();
        assert_eq!(ffmpeg_label, "FFmpeg 7.1.1");
        assert_eq!(mpv_label, "mpv 0.40.0");
        assert!(!ffmpeg_label.contains("alice"));
        assert!(!mpv_label.contains("private-builder"));
    }

    #[test]
    fn successful_unknown_version_uses_the_existing_generic_contract() {
        assert_eq!(
            parse_media_tool_semantic_version(
                "ffmpeg",
                br#"wrapper ready at C:\Users\alice\private\ffmpeg.exe?token=secret"#,
                b"",
            ),
            None
        );
        assert_eq!(
            parse_media_tool_semantic_version("ffmpeg", b"ffmpeg version 7.1.private-path", b"",),
            None
        );
        assert_eq!(
            parse_media_tool_semantic_version("mpv", b"mpv v0.40secret", b""),
            None
        );
        assert_eq!(format_detected_versions(&[("FFmpeg", None)]), None);
    }

    #[test]
    fn mpv_start_requires_existing_media_file() {
        let error = start_mpv_sidecar_inner(MpvStartRequest {
            mpv_path: "mpv".to_string(),
            media_path: "Z:\\missing\\video.mkv".to_string(),
            start_position_ms: None,
            start_paused: None,
        })
        .unwrap_err();

        assert!(error.contains("无法读取本地视频文件"));
    }

    #[test]
    fn mpv_accepts_remote_authorized_media_url() {
        assert!(validate_mpv_media_path(
            "https://emby.example.test/Videos/item/stream?api_key=secret-token&MediaSourceId=source-1"
        )
        .is_ok());
    }

    #[test]
    fn mpv_status_and_errors_redact_emby_tokens() {
        let redacted = redact_sensitive_media_text(
            "https://emby.example.test/Videos/item/stream?api_key=secret-token&token=other failed",
        );

        assert_eq!(
            redacted,
            "https://emby.example.test/Videos/item/stream?api_key=<已隐藏>&token=<已隐藏> failed"
        );
    }

    #[test]
    fn mpv_control_requires_running_process() {
        let _ = stop_mpv_sidecar();
        let error = control_mpv_sidecar(MpvControlRequest {
            action: "play".to_string(),
            position_ms: None,
            playback_rate: None,
        })
        .unwrap_err();

        assert!(error.contains("尚未启动"));
    }

    #[test]
    fn mpv_success_response_accepts_only_success_error_field() {
        assert!(ensure_mpv_success(json!({ "error": "success" })).is_ok());
        assert!(ensure_mpv_success(json!({ "error": "property unavailable" })).is_err());
    }

    #[test]
    fn mpv_track_list_is_summarized_for_player_session() {
        let tracks = parse_mpv_track_list(&[
            json!({
                "id": 1,
                "type": "audio",
                "title": "日语 2.0",
                "lang": "jpn",
                "codec": "aac",
                "selected": true,
                "external": false
            }),
            json!({
                "id": 2,
                "type": "sub",
                "title": "简体中文",
                "lang": "chi",
                "codec": "ass",
                "selected": true,
                "external": true
            }),
            json!({ "id": 3, "type": "unknown" }),
        ]);

        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].track_type, "audio");
        assert_eq!(tracks[0].title.as_deref(), Some("日语 2.0"));
        assert!(tracks[1].external);
        assert_eq!(tracks[1].track_type, "subtitle");
    }

    #[cfg(windows)]
    fn supervised_detection_helper_command(test_name: &str) -> SupervisedCommand {
        let mut command = SupervisedCommand::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", test_name, "--nocapture"]);
        command
    }

    #[cfg(windows)]
    fn supervised_detection_test_limits(timeout: Duration) -> SupervisedOutputLimits {
        SupervisedOutputLimits {
            execution_timeout: timeout,
            output_drain_timeout: Duration::from_millis(200),
            termination_timeout: Duration::from_secs(2),
            poll_interval: Duration::from_millis(5),
            stdout_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
            stderr_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection timeout wrapper helper"]
    #[allow(clippy::zombie_processes)]
    fn supervised_detection_timeout_wrapper_helper() {
        use std::io::Write as _;

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
    #[ignore = "media-tool detection stdout overflow wrapper helper"]
    fn supervised_detection_stdout_overflow_wrapper_helper() {
        use std::io::Write as _;

        let mut stdout = std::io::stdout();
        for _ in 0..20 {
            stdout.write_all(&[b'x'; 4 * 1024]).unwrap();
        }
        stdout.flush().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection stderr overflow wrapper helper"]
    fn supervised_detection_stderr_overflow_wrapper_helper() {
        use std::io::Write as _;

        let mut stderr = std::io::stderr();
        for _ in 0..20 {
            stderr.write_all(&[b'e'; 4 * 1024]).unwrap();
        }
        stderr.flush().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection sensitive nonzero wrapper helper"]
    fn supervised_detection_sensitive_nonzero_wrapper_helper() {
        use std::io::Write as _;

        let secret = br#"C:\Users\alice\private\ffmpeg.exe?api_key=secret-token&token=other"#;
        std::io::stdout().write_all(secret).unwrap();
        std::io::stderr().write_all(secret).unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stderr().flush().unwrap();
        std::process::exit(23);
    }

    #[cfg(windows)]
    #[test]
    fn malicious_wrapper_timeout_is_bounded_and_reports_no_raw_output() {
        let command = supervised_detection_helper_command(
            "media_tools::tests::supervised_detection_timeout_wrapper_helper",
        );
        let started = std::time::Instant::now();
        let failure = run_media_tool_version_command(
            "ffmpeg",
            &command,
            supervised_detection_test_limits(Duration::from_millis(150)),
        )
        .unwrap_err();
        let message = format_media_tool_detection_failure("FFmpeg", failure);

        assert_eq!(failure, MediaToolDetectionFailure::Timeout);
        assert!(message.starts_with("blocked:tool-timeout"));
        assert!(!message.contains("descendant="));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[cfg(windows)]
    #[test]
    fn malicious_wrapper_stdout_and_stderr_overflow_are_hard_bounded() {
        for (test_name, expected_failure) in [
            (
                "media_tools::tests::supervised_detection_stdout_overflow_wrapper_helper",
                MediaToolDetectionFailure::StdoutOverflow,
            ),
            (
                "media_tools::tests::supervised_detection_stderr_overflow_wrapper_helper",
                MediaToolDetectionFailure::StderrOverflow,
            ),
        ] {
            let command = supervised_detection_helper_command(test_name);
            let started = std::time::Instant::now();
            let failure = run_media_tool_version_command(
                "ffmpeg",
                &command,
                supervised_detection_test_limits(Duration::from_secs(3)),
            )
            .unwrap_err();

            assert_eq!(failure, expected_failure);
            assert!(format_media_tool_detection_failure("FFmpeg", failure)
                .starts_with("blocked:resource-limit"));
            assert!(started.elapsed() < Duration::from_secs(4));
        }
    }

    #[cfg(windows)]
    #[test]
    fn malicious_wrapper_nonzero_never_echoes_paths_or_secrets() {
        let command = supervised_detection_helper_command(
            "media_tools::tests::supervised_detection_sensitive_nonzero_wrapper_helper",
        );
        let failure = run_media_tool_version_command(
            "ffmpeg",
            &command,
            supervised_detection_test_limits(Duration::from_secs(3)),
        )
        .unwrap_err();
        let message = format_media_tool_detection_failure("FFmpeg", failure);

        assert_eq!(failure, MediaToolDetectionFailure::NonZeroExit);
        for secret in ["alice", "ffmpeg.exe", "secret-token", "token=other"] {
            assert!(!message.contains(secret));
        }
    }
}
