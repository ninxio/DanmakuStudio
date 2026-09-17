use super::*;
use crate::process_supervision::{
    SupervisedCommand, SupervisedOutputLimits, SupervisedStreamingLimits,
};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub index: u32,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub channels: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub probe_id: String,
    pub name: String,
    pub source_presentation_origin_ms: i64,
    pub source_reported_duration_ms: Option<u64>,
    pub streams: Vec<AudioStream>,
}
#[derive(Clone)]
pub(super) struct Prepared {
    pub connection: Connection,
    pub target: reqwest::Url,
    pub validator: transport::Validator,
    pub public: Inspection,
    pub created: Instant,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub local: Option<(String, PathBuf, String)>,
}
// Demuxers that consume a single media object. In particular, no HLS, DASH, concat or image lists.
const CONTAINERS: &str =
    "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpegts,avi,mpeg,flac,mp3,wav,ogg,aac,asf";
pub(super) fn limits(seconds: u64) -> SupervisedOutputLimits {
    SupervisedOutputLimits {
        execution_timeout: Duration::from_secs(seconds),
        output_drain_timeout: Duration::from_secs(5),
        termination_timeout: Duration::from_secs(5),
        poll_interval: Duration::from_millis(20),
        stdout_hard_limit: 2 * 1024 * 1024,
        stderr_hard_limit: 256 * 1024,
    }
}

pub(super) async fn inspect(
    connection: Connection,
    href: String,
    ffmpeg_path: Option<String>,
) -> Result<Prepared, String> {
    let root = connection::root(&connection.root)?;
    let target = connection::href(&root, &root, &href)?;
    if target.path().ends_with('/') {
        return Err("请选择媒体文件。".into());
    }
    let validator = tokio::time::timeout(
        Duration::from_secs(45),
        transport::pin(&connection, &target),
    )
    .await
    .map_err(|_| "媒体版本检查超时。")??;
    let proxy =
        transport::Proxy::open(connection.clone(), target.clone(), validator.clone()).await?;
    let ffmpeg =
        crate::media_tool_detection::resolve_tool_executable_path("ffmpeg", ffmpeg_path.as_deref());
    let ffprobe = crate::media_probe::resolve_ffprobe_path(&ffmpeg);
    let ffprobe = ffprobe.to_string_lossy().to_string();
    let probe_path = ffprobe.clone();
    let url = proxy.url.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        probe(&probe_path, &url, &AtomicBool::new(false))
    })
    .await
    .map_err(|_| "媒体探测任务异常。")?;
    let closed = proxy.close().await;
    let value = output?;
    closed?;
    let (origin, duration, streams) = parse(&value)?;
    if streams.is_empty() {
        return Err("文件未包含可用音轨。".into());
    }
    let name = connection::display_name(&target);
    Ok(Prepared {
        connection,
        target,
        validator,
        public: Inspection {
            probe_id: random_id()?,
            name,
            source_presentation_origin_ms: origin,
            source_reported_duration_ms: duration,
            streams,
        },
        created: Instant::now(),
        ffmpeg,
        ffprobe,
        local: None,
    })
}
pub(super) fn probe(ffprobe: &str, path: &str, cancel: &AtomicBool) -> Result<Value, String> {
    let output=SupervisedCommand::new(ffprobe).args(["-v","error","-format_whitelist",CONTAINERS,"-protocol_whitelist","file,http,tcp","-show_entries","format=start_time,duration:stream=index,codec_type,codec_name,start_time,duration,channels:stream_tags=language,title","-of","json",path]).output(limits(90),||cancel.load(Ordering::Acquire))
        .map_err(|_|"媒体探测失败、超时或已取消。")?;
    if !output.status.success() {
        return Err("FFprobe 无法探测此媒体；请确认 FFmpeg 路径和媒体格式。".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "媒体探测输出不合法。".into())
}
fn seconds_ms(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && n.abs() < 1e10)
        .map(|n| (n * 1000.0).round() as i64)
}
pub(super) fn parse(v: &Value) -> Result<(i64, Option<u64>, Vec<AudioStream>), String> {
    let streams = v["streams"].as_array().ok_or("媒体未返回音轨信息。")?;
    if streams.len() > 128 {
        return Err("媒体轨道数超过上限。".into());
    }
    let origin = std::iter::once(seconds_ms(v["format"].get("start_time")))
        .chain(
            streams
                .iter()
                .filter(|s| matches!(s["codec_type"].as_str(), Some("audio" | "video")))
                .map(|s| seconds_ms(s.get("start_time"))),
        )
        .flatten()
        .min()
        .ok_or("媒体缺少可观察的播放时间原点，不能可信归一化。")?;
    let duration = seconds_ms(v["format"].get("duration")).and_then(|n| u64::try_from(n).ok());
    let audio = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .map(|s| {
            Ok(AudioStream {
                index: s["index"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or("音轨编号不合法。")?,
                codec: s["codec_name"].as_str().unwrap_or("unknown").into(),
                language: s["tags"]["language"].as_str().map(str::to_owned),
                title: s["tags"]["title"].as_str().map(str::to_owned),
                channels: s["channels"].as_u64().and_then(|n| u32::try_from(n).ok()),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((origin, duration, audio))
}
pub(super) fn extract(
    prepared: &Prepared,
    url: &str,
    stream_index: u32,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<pts::PtsEvidence, String> {
    let filter=format!("ametadata=mode=delete:key=studio_pts,ametadata=mode=add:key=studio_pts:value=1,ametadata=mode=print:key=studio_pts:file=-:direct=1,asetpts=PTS-({}/1000)/TB,aresample=16000:async=1:first_pts=0",prepared.public.source_presentation_origin_ms);
    let mut guard = pts::PtsGuard::default();
    let mut pts_error = None;
    let mut process = limits(4 * 3600);
    process.stdout_hard_limit = 256 * 1024 * 1024;
    let result = SupervisedCommand::new(&prepared.ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-n",
            "-xerror",
            "-err_detect",
            "explode",
            "-format_whitelist",
            CONTAINERS,
            "-protocol_whitelist",
            "file,http,tcp",
            "-copyts",
            "-i",
            url,
            "-map",
            &format!("0:{stream_index}"),
            "-vn",
            "-sn",
            "-dn",
            "-af",
            &filter,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "flac",
            "-f",
            "flac",
        ])
        .arg(output)
        .stream_stdout(
            SupervisedStreamingLimits {
                process,
                stdout_chunk_size: 8192,
                stdout_buffered_chunks: 4,
                stdout_inactivity_timeout: Some(Duration::from_secs(90)),
            },
            || cancel.load(Ordering::Acquire),
            |bytes| {
                let result = guard.push(bytes);
                if let Err(e) = &result {
                    pts_error = Some(e.clone());
                }
                result
            },
        );
    if let Some(e) = pts_error {
        return Err(e);
    }
    let result = result.map_err(|_| "FFmpeg 获取失败、超时或已取消。")?;
    if !result.status.success() {
        return Err("FFmpeg 未能完整解码所选音轨。".into());
    }
    guard.finish()
}
pub(super) fn output_duration(
    ffprobe: &str,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let value = probe(
        ffprobe,
        path.to_str().ok_or("音轨缓存路径不合法。")?,
        cancel,
    )?;
    let duration = seconds_ms(value["format"].get("duration"))
        .filter(|n| *n > 0)
        .ok_or("输出音轨没有有效时长。")?;
    let streams = value["streams"].as_array().ok_or("输出音轨缺少流信息。")?;
    if streams.len() != 1 || streams[0]["codec_name"] != "flac" || streams[0]["channels"] != 1 {
        return Err("输出未符合单声道 FLAC 合同。".into());
    }
    Ok(duration as u64)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shifted_origin_does_not_infer_end() {
        let v = serde_json::json!({"format":{"start_time":"5","duration":"10"},"streams":[{"index":0,"codec_type":"video","start_time":"5"},{"index":1,"codec_type":"audio","start_time":"5.5","codec_name":"aac"}]});
        let (o, d, a) = parse(&v).unwrap();
        assert_eq!(o, 5000);
        assert_eq!(d, Some(10000));
        assert_eq!(a[0].index, 1);
    }
}
