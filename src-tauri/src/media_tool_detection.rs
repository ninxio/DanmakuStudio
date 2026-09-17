use crate::media_tools::{MediaToolDetectionRequest, MediaToolDetectionResult};
use crate::process_supervision::{
    SupervisedCommand, SupervisedOutputLimits, SupervisedProcessErrorKind,
};
use std::path::Path;
use std::time::Duration;

const MEDIA_TOOL_DETECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MEDIA_TOOL_DETECTION_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MEDIA_TOOL_DETECTION_TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);
const MEDIA_TOOL_DETECTION_POLL_INTERVAL: Duration = Duration::from_millis(10);
pub(crate) const MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaToolDetectionFailure {
    Spawn,
    Timeout,
    StdoutOverflow,
    StderrOverflow,
    Reader,
    Wait,
    Cleanup,
    NonZeroExit,
}

pub(crate) fn detect_media_tool_inner(
    request: MediaToolDetectionRequest,
) -> Result<MediaToolDetectionResult, String> {
    let tool = normalize_media_tool(&request.tool)?;
    let executable_path = resolve_tool_executable_path(tool, request.executable_path.as_deref());
    if tool == "mpv" && executable_path.trim().is_empty() {
        return Ok(MediaToolDetectionResult {
            tool: tool.to_string(),
            executable_path: String::new(),
            available: false,
            version: None,
            message: "尚未配置 mpv 路径。请先选择 mpv 可执行文件。".to_string(),
        });
    }
    let limits = media_tool_detection_limits();
    let primary = probe_media_tool_version(tool, Path::new(&executable_path), limits);
    let primary_version = match primary {
        Ok(version) => version,
        Err(failure) => {
            return Ok(unavailable_media_tool_result(
                tool,
                executable_path,
                tool_display_name(tool),
                failure,
            ));
        }
    };

    let display_name = tool_display_name(tool);
    let version = format_detected_versions(&[(display_name, primary_version.as_deref())]);
    let message = if primary_version.is_some() {
        format!("{display_name} 可运行。")
    } else {
        format!("{display_name} 可运行，版本未知。")
    };
    Ok(MediaToolDetectionResult {
        tool: tool.to_string(),
        executable_path,
        available: true,
        version,
        message,
    })
}

pub(crate) fn media_tool_detection_limits() -> SupervisedOutputLimits {
    SupervisedOutputLimits {
        execution_timeout: MEDIA_TOOL_DETECTION_TIMEOUT,
        output_drain_timeout: MEDIA_TOOL_DETECTION_OUTPUT_DRAIN_TIMEOUT,
        termination_timeout: MEDIA_TOOL_DETECTION_TERMINATION_TIMEOUT,
        poll_interval: MEDIA_TOOL_DETECTION_POLL_INTERVAL,
        stdout_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
        stderr_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
    }
}

fn probe_media_tool_version(
    tool: &str,
    executable_path: &Path,
    limits: SupervisedOutputLimits,
) -> Result<Option<String>, MediaToolDetectionFailure> {
    let mut command = SupervisedCommand::new(executable_path);
    command.arg(media_tool_version_argument(tool));
    run_media_tool_version_command(tool, &command, limits)
}

pub(crate) fn media_tool_version_argument(tool: &str) -> &'static str {
    if tool.eq_ignore_ascii_case("mpv") {
        "--version"
    } else {
        "-version"
    }
}

pub(crate) fn run_media_tool_version_command(
    tool: &str,
    command: &SupervisedCommand,
    limits: SupervisedOutputLimits,
) -> Result<Option<String>, MediaToolDetectionFailure> {
    let output = command
        .output(limits, || false)
        .map_err(|error| match error.kind() {
            SupervisedProcessErrorKind::Spawn => MediaToolDetectionFailure::Spawn,
            SupervisedProcessErrorKind::Timeout => MediaToolDetectionFailure::Timeout,
            SupervisedProcessErrorKind::NoProgress => MediaToolDetectionFailure::Timeout,
            SupervisedProcessErrorKind::Cancelled => MediaToolDetectionFailure::Wait,
            SupervisedProcessErrorKind::StdoutOverflow => MediaToolDetectionFailure::StdoutOverflow,
            SupervisedProcessErrorKind::StderrOverflow => MediaToolDetectionFailure::StderrOverflow,
            SupervisedProcessErrorKind::Reader => MediaToolDetectionFailure::Reader,
            SupervisedProcessErrorKind::Wait => MediaToolDetectionFailure::Wait,
            SupervisedProcessErrorKind::Cleanup => MediaToolDetectionFailure::Cleanup,
        })?;
    if !output.status.success() {
        return Err(MediaToolDetectionFailure::NonZeroExit);
    }
    Ok(parse_media_tool_semantic_version(
        tool,
        &output.stdout,
        &output.stderr,
    ))
}

pub(crate) fn parse_media_tool_semantic_version(
    tool: &str,
    stdout: &[u8],
    stderr: &[u8],
) -> Option<String> {
    for bytes in [stdout, stderr] {
        for line in String::from_utf8_lossy(bytes).lines() {
            let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
            let Some(name) = fields.first() else {
                continue;
            };
            if !name.eq_ignore_ascii_case(tool) {
                continue;
            }
            let raw_version = if tool.eq_ignore_ascii_case("mpv") {
                fields.get(1).copied()
            } else if fields
                .get(1)
                .is_some_and(|marker| marker.eq_ignore_ascii_case("version"))
            {
                fields.get(2).copied()
            } else {
                None
            };
            let Some(raw_version) = raw_version else {
                continue;
            };
            if let Some(version) = normalize_numeric_semantic_version(raw_version) {
                return Some(version);
            }
        }
    }
    None
}

fn normalize_numeric_semantic_version(raw_version: &str) -> Option<String> {
    let raw_version = raw_version
        .strip_prefix('v')
        .or_else(|| raw_version.strip_prefix('V'))
        .unwrap_or(raw_version);
    let numeric_prefix = raw_version
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    if numeric_prefix.ends_with('.') {
        return None;
    }
    let suffix = raw_version.strip_prefix(&numeric_prefix)?;
    if !suffix.is_empty() && !suffix.starts_with(['-', '+']) {
        return None;
    }
    let components = numeric_prefix.split('.').collect::<Vec<_>>();
    if !(2..=3).contains(&components.len())
        || components.iter().any(|component| component.is_empty())
    {
        return None;
    }
    let mut parsed = components
        .iter()
        .map(|component| component.parse::<u32>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    while parsed.len() < 3 {
        parsed.push(0);
    }
    Some(format!("{}.{}.{}", parsed[0], parsed[1], parsed[2]))
}

pub(crate) fn format_detected_versions(versions: &[(&str, Option<&str>)]) -> Option<String> {
    let labels = versions
        .iter()
        .filter_map(|(name, version)| version.map(|version| format!("{name} {version}")))
        .collect::<Vec<_>>();
    (!labels.is_empty()).then(|| labels.join("；"))
}

fn unavailable_media_tool_result(
    requested_tool: &str,
    executable_path: String,
    failed_tool_name: &str,
    failure: MediaToolDetectionFailure,
) -> MediaToolDetectionResult {
    MediaToolDetectionResult {
        tool: requested_tool.to_string(),
        executable_path,
        available: false,
        version: None,
        message: format_media_tool_detection_failure(failed_tool_name, failure),
    }
}

pub(crate) fn format_media_tool_detection_failure(
    tool_name: &str,
    failure: MediaToolDetectionFailure,
) -> String {
    match failure {
        MediaToolDetectionFailure::Spawn => {
            format!("{tool_name} 无法在受监督进程中启动，请检查工具配置。")
        }
        MediaToolDetectionFailure::Timeout => {
            format!("blocked:tool-timeout：{tool_name} 版本检测超过 10 秒，已终止其进程树。")
        }
        MediaToolDetectionFailure::StdoutOverflow => {
            format!("blocked:resource-limit：{tool_name} 版本检测标准输出超过 64 KiB 硬上限。")
        }
        MediaToolDetectionFailure::StderrOverflow => {
            format!("blocked:resource-limit：{tool_name} 版本检测错误输出超过 64 KiB 硬上限。")
        }
        MediaToolDetectionFailure::Reader => {
            format!("{tool_name} 版本检测的有界输出读取失败。")
        }
        MediaToolDetectionFailure::Wait => {
            format!("{tool_name} 版本检测的受监督进程状态读取失败。")
        }
        MediaToolDetectionFailure::Cleanup => {
            format!("blocked:cleanup-failed：{tool_name} 版本检测的进程树未完成有界清理。")
        }
        MediaToolDetectionFailure::NonZeroExit => {
            format!("{tool_name} 无法运行；为保护本地路径与访问凭据，未回显工具错误输出。")
        }
    }
}

pub(crate) fn normalize_media_tool(tool: &str) -> Result<&'static str, String> {
    match tool.trim().to_ascii_lowercase().as_str() {
        "ffmpeg" => Ok("ffmpeg"),
        "mpv" => Ok("mpv"),
        _ => Err(format!("未知媒体工具：{tool}")),
    }
}

pub(crate) fn resolve_tool_executable_path(tool: &str, executable_path: Option<&str>) -> String {
    let trimmed = executable_path.unwrap_or("").trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    if tool == "ffmpeg" {
        return "ffmpeg".to_string();
    }
    String::new()
}

fn tool_display_name(tool: &str) -> &'static str {
    match tool {
        "ffmpeg" => "FFmpeg",
        "mpv" => "mpv",
        _ => "媒体工具",
    }
}
