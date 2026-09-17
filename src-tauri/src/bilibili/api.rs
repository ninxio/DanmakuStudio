//! Fixed Bilibili endpoints, bounded protobuf decoding, and unauthenticated CDN streaming.
//! Protocol/XML field mappings adapted from DanmakuBox under its MIT license.

use super::*;
use prost::Message;
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, COOKIE, REFERER, USER_AGENT},
    Client, Url,
};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};
use tokio::io::AsyncWriteExt;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_SEGMENTS: i64 = 1_000;
const MAX_AUDIO_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const API_ROOT: &str = "https://api.bilibili.com";

#[derive(Debug, Deserialize)]
pub(super) struct ViewData {
    pub bvid: String,
    pub aid: u64,
    pub title: String,
    pub owner: ViewOwner,
    pub pages: Vec<ViewPage>,
}
#[derive(Debug, Deserialize)]
pub(super) struct ViewOwner {
    pub name: String,
}
#[derive(Clone, Debug, Deserialize)]
pub(super) struct ViewPage {
    pub cid: u64,
    pub page: u32,
    pub part: String,
    pub duration: f64,
}

mod play_info;
use play_info::{DashAudio, DashInfo, PlayUrlData};

#[derive(Deserialize)]
struct NavData {
    #[serde(rename = "isLogin")]
    is_login: bool,
    uname: Option<String>,
}
#[derive(Debug)]
pub(super) struct PlayProbe {
    pub duration_ms: u64,
    pub duration_source: String,
    pub exact_duration: bool,
    pub audio: Option<DashAudio>,
}

#[derive(Clone, PartialEq, Message)]
struct DmWebViewReply {
    #[prost(message, optional, tag = "4")]
    dm_sge: Option<DmSegConfig>,
}
#[derive(Clone, PartialEq, Message)]
struct DmSegConfig {
    #[prost(int64, tag = "1")]
    page_size: i64,
    #[prost(int64, tag = "2")]
    total: i64,
}
#[derive(Clone, PartialEq, Message)]
struct DmSegMobileReply {
    #[prost(message, repeated, tag = "1")]
    elems: Vec<DanmakuElem>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct DanmakuElem {
    #[prost(int64, tag = "1")]
    pub id: i64,
    #[prost(int32, tag = "2")]
    pub progress: i32,
    #[prost(int32, tag = "3")]
    pub mode: i32,
    #[prost(int32, tag = "4")]
    pub fontsize: i32,
    #[prost(uint32, tag = "5")]
    pub color: u32,
    #[prost(string, tag = "6")]
    pub mid_hash: String,
    #[prost(string, tag = "7")]
    pub content: String,
    #[prost(int64, tag = "8")]
    pub ctime: i64,
    #[prost(int32, tag = "9")]
    pub weight: i32,
    #[prost(string, tag = "10")]
    pub action: String,
    #[prost(int32, tag = "11")]
    pub pool: i32,
    #[prost(string, tag = "12")]
    pub id_str: String,
    #[prost(int32, tag = "13")]
    pub attr: i32,
}

pub(super) fn build_client(cookie: Option<&str>, media: bool) -> DownloadResult<Client> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://www.bilibili.com/"),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
    );
    if !media {
        if let Some(cookie) = cookie.map(str::trim).filter(|s| !s.is_empty()) {
            if cookie.len() > 32 * 1024 {
                return Err(DownloadError::permanent("Cookie 内容过长。"));
            }
            let mut value = HeaderValue::from_str(cookie)
                .map_err(|_| DownloadError::permanent("Cookie 包含无效字符。"))?;
            value.set_sensitive(true);
            headers.insert(COOKIE, value);
        }
    }
    let redirect = if media {
        reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_allowed_media_url(attempt.url()) {
                attempt.error("不允许的媒体重定向")
            } else {
                attempt.follow()
            }
        })
    } else {
        reqwest::redirect::Policy::none()
    };
    let mut builder = Client::builder()
        .default_headers(headers)
        .redirect(redirect)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60));
    if !media {
        builder = builder.timeout(Duration::from_secs(45));
    }
    builder
        .build()
        .map_err(|_| DownloadError::permanent("无法初始化 B 站网络客户端。"))
}

pub(super) fn is_allowed_media_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    ["bilivideo.com", "bilivideo.cn", "bilivideo.net"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        || (host.starts_with("upos-") && host.ends_with(".akamaized.net"))
}

fn media_url(value: &str) -> DownloadResult<Url> {
    let mut url = Url::parse(value).map_err(|_| DownloadError::permanent("音轨地址格式无效。"))?;
    if url.scheme() == "http" {
        let _ = url.set_scheme("https");
    }
    if !is_allowed_media_url(&url) {
        return Err(DownloadError::permanent(
            "音轨地址不属于允许的 B 站媒体 CDN。",
        ));
    }
    Ok(url)
}

pub(super) fn network_error(context: &str, error: reqwest::Error) -> DownloadError {
    // Do not include reqwest's URL: signed play URLs are transient credentials.
    let kind = if error.is_timeout() || error.is_connect() || error.is_body() || error.is_decode() {
        ErrorKind::Retryable
    } else {
        ErrorKind::Permanent
    };
    DownloadError::new(kind, format!("{context}：{}", error.without_url()))
}

fn check_status(response: &reqwest::Response, context: &str) -> DownloadResult<()> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let kind = if status.as_u16() == 429 || status.as_u16() == 412 {
        ErrorKind::RateControl
    } else if status.is_server_error() || status.as_u16() == 408 {
        ErrorKind::Retryable
    } else {
        ErrorKind::Permanent
    };
    Err(DownloadError::new(
        kind,
        format!(
            "{context}返回 HTTP {}{}",
            status.as_u16(),
            if kind == ErrorKind::RateControl {
                "，请求已停止，请稍后重试。"
            } else {
                "。"
            }
        ),
    ))
}

async fn read_bytes(
    context: &RunContext,
    request: reqwest::RequestBuilder,
    label: &str,
) -> DownloadResult<Vec<u8>> {
    context
        .cancellation
        .run(async {
            let mut response = request.send().await.map_err(|e| network_error(label, e))?;
            check_status(&response, label)?;
            if response
                .content_length()
                .is_some_and(|len| len > MAX_BODY_BYTES as u64)
            {
                return Err(DownloadError::permanent(format!(
                    "{label}响应超过安全大小。"
                )));
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| network_error(label, e))?
            {
                if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                    return Err(DownloadError::permanent(format!(
                        "{label}响应超过安全大小。"
                    )));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        })
        .await
}

async fn json_payload<T: DeserializeOwned>(
    context: &RunContext,
    request: reqwest::RequestBuilder,
    label: &str,
) -> DownloadResult<T> {
    for attempt in 1..=3 {
        let result = async {
            let bytes = read_bytes(
                context,
                request
                    .try_clone()
                    .ok_or_else(|| DownloadError::permanent("无法创建 API 请求。"))?,
                label,
            )
            .await?;
            if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'<') {
                return Err(DownloadError::new(
                    ErrorKind::RateControl,
                    format!("{label}返回 B 站验证页面，请停止连续请求并稍后重试。"),
                ));
            }
            let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
                DownloadError::new(ErrorKind::Retryable, format!("{label}响应损坏或不完整。"))
            })?;
            let code = value
                .get("code")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| DownloadError::permanent(format!("{label}缺少状态码。")))?;
            if code != 0 {
                return Err(api_error(
                    label,
                    code,
                    value.get("message").and_then(|v| v.as_str()),
                ));
            }
            let payload = value
                .get("data")
                .filter(|v| !v.is_null())
                .or_else(|| value.get("result"))
                .ok_or_else(|| DownloadError::permanent(format!("{label}没有返回数据。")))?;
            serde_json::from_value(payload.clone())
                .map_err(|_| DownloadError::permanent(format!("{label}数据结构不受支持。")))
        }
        .await;
        match result {
            Err(error) if error.kind == ErrorKind::Retryable && attempt < 3 => {
                context.wait(attempt * 500).await?
            }
            other => return other,
        }
    }
    unreachable!()
}

fn safe_api_message(message: Option<&str>) -> String {
    message
        .unwrap_or("接口未返回原因")
        .split_whitespace()
        .take(40)
        .map(|word| {
            if word.contains("://") {
                "[地址已隐藏]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

pub(super) fn api_error(label: &str, code: i64, message: Option<&str>) -> DownloadError {
    let detail = safe_api_message(message);
    let (kind, instruction) = match code {
        -352 | -412 => (
            ErrorKind::RateControl,
            "请求已停止，请稍后重试；风控不等同于未登录。",
        ),
        -101 => (ErrorKind::Permanent, "请检查或更新登录 Cookie。"),
        _ => (ErrorKind::Permanent, ""),
    };
    DownloadError::new(
        kind,
        format!("{label}失败（code {code}）：{detail}。{instruction}"),
    )
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum VideoIdentity {
    Bvid(String),
    Aid(u64),
}

pub(super) fn parse_video_identity(input: &str) -> DownloadResult<VideoIdentity> {
    let value = input.trim();
    if value.is_empty() || value.len() > 2_048 {
        return Err(DownloadError::permanent(
            "请输入普通视频链接、BV 号或 av 号。",
        ));
    }
    let identity = if value.contains("://") {
        let url = Url::parse(value).map_err(|_| DownloadError::permanent("视频链接格式无效。"))?;
        if !matches!(url.scheme(), "https" | "http")
            || !matches!(
                url.host_str(),
                Some("www.bilibili.com" | "bilibili.com" | "m.bilibili.com")
            )
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(DownloadError::permanent(
                "请使用 bilibili.com 的普通视频完整链接或 BV/av 号；暂不支持短链和合集链接。",
            ));
        }
        let segments: Vec<_> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect();
        if segments.len() != 2 || segments[0] != "video" {
            return Err(DownloadError::permanent(
                "此入口支持普通视频与分 P，请使用 /video/BV… 链接。",
            ));
        }
        segments[1].to_string()
    } else {
        value.to_string()
    };
    let bytes = identity.as_bytes();
    if bytes.len() == 12
        && bytes[..2].eq_ignore_ascii_case(b"BV")
        && bytes[2..].iter().all(u8::is_ascii_alphanumeric)
    {
        return Ok(VideoIdentity::Bvid(format!("BV{}", &identity[2..])));
    }
    let aid = if bytes.len() > 2 && bytes[..2].eq_ignore_ascii_case(b"av") {
        &identity[2..]
    } else {
        &identity
    };
    if aid.bytes().all(|c| c.is_ascii_digit()) {
        if let Ok(aid) = aid.parse::<u64>() {
            if aid > 0 && aid <= MAX_SAFE_INTEGER {
                return Ok(VideoIdentity::Aid(aid));
            }
        }
    }
    Err(DownloadError::permanent(
        "请输入有效的 BV 号、av 号或普通视频链接。",
    ))
}

pub(super) async fn fetch_view(
    context: &RunContext,
    client: &Client,
    input: &str,
) -> DownloadResult<ViewData> {
    let request = client
        .get(format!("{API_ROOT}/x/web-interface/view"))
        .header(ACCEPT, "application/json");
    let request = match parse_video_identity(input)? {
        VideoIdentity::Bvid(bvid) => request.query(&[("bvid", bvid)]),
        VideoIdentity::Aid(aid) => request.query(&[("aid", aid.to_string())]),
    };
    let view: ViewData = json_payload(context, request, "获取视频信息").await?;
    validate_view(&view)?;
    Ok(view)
}

pub(super) fn validate_view(view: &ViewData) -> DownloadResult<()> {
    let mut cids = HashSet::new();
    let mut pages = HashSet::new();
    if !matches!(parse_video_identity(&view.bvid), Ok(VideoIdentity::Bvid(_)))
        || view.aid == 0
        || view.aid > MAX_SAFE_INTEGER
        || view.pages.is_empty()
        || view.pages.len() > MAX_PAGES
        || view.pages.iter().any(|page| {
            page.cid == 0
                || page.cid > MAX_SAFE_INTEGER
                || page.page == 0
                || !cids.insert(page.cid)
                || !pages.insert(page.page)
                || !page.duration.is_finite()
                || page.duration < 0.0
                || page.duration > MAX_SAFE_INTEGER as f64 / 1_000.0
        })
    {
        return Err(DownloadError::permanent(
            "视频信息包含无效、重复或超出支持范围的分 P。",
        ));
    }
    Ok(())
}

pub(super) async fn check_login(
    context: &RunContext,
    cookie: &str,
) -> DownloadResult<BilibiliLoginStatus> {
    if cookie.trim().is_empty() {
        return Ok(BilibiliLoginStatus {
            logged_in: false,
            username: None,
            message: "未提供 Cookie，将使用匿名访问。".into(),
        });
    }
    let client = build_client(Some(cookie), false)?;
    let result: DownloadResult<NavData> = json_payload(
        context,
        client
            .get(format!("{API_ROOT}/x/web-interface/nav"))
            .header(ACCEPT, "application/json"),
        "检查登录状态",
    )
    .await;
    let data = match result {
        Err(error) if error.message.contains("code -101") => {
            return Ok(BilibiliLoginStatus {
                logged_in: false,
                username: None,
                message: "Cookie 未登录或已过期，请更新后重试。".into(),
            })
        }
        other => other?,
    };
    let username = data.uname.filter(|name| !name.trim().is_empty());
    Ok(BilibiliLoginStatus {
        logged_in: data.is_login,
        message: if data.is_login {
            username
                .as_ref()
                .map(|name| format!("已登录：{name}"))
                .unwrap_or_else(|| "Cookie 已通过登录校验。".into())
        } else {
            "Cookie 未形成有效登录状态，请更新后重试。".into()
        },
        username,
    })
}

pub(super) async fn fetch_play_probe(
    context: &RunContext,
    client: &Client,
    view: &ViewData,
    page: &ViewPage,
) -> DownloadResult<PlayProbe> {
    let payload: PlayUrlData = json_payload(
        context,
        client
            .get(format!("{API_ROOT}/x/player/playurl"))
            .header(ACCEPT, "application/json")
            .query(&[
                ("avid", view.aid.to_string()),
                ("bvid", view.bvid.clone()),
                ("cid", page.cid.to_string()),
                ("qn", "80".into()),
                ("otype", "json".into()),
                ("fourk", "1".into()),
                ("fnver", "0".into()),
                ("fnval", "4048".into()),
            ]),
        "获取播放信息",
    )
    .await?;
    Ok(probe_from_payload(payload, page))
}

fn probe_from_payload(payload: PlayUrlData, page: &ViewPage) -> PlayProbe {
    let dash_ms = payload
        .dash
        .as_ref()
        .and_then(|d| d.duration)
        .map(seconds_to_millis)
        .filter(|ms| *ms > 0);
    let (duration_ms, source, exact_duration) = if let Some(ms) = dash_ms {
        (ms, "playurl.dash.duration", true)
    } else if let Some(ms) = payload
        .timelength
        .filter(|ms| *ms > 0 && *ms <= MAX_SAFE_INTEGER)
    {
        (ms, "playurl.timelength", true)
    } else {
        (
            seconds_to_millis(page.duration),
            "view.pages.duration",
            false,
        )
    };
    PlayProbe {
        duration_ms,
        duration_source: source.into(),
        exact_duration,
        audio: payload.dash.and_then(select_audio),
    }
}

pub(super) fn select_audio(dash: DashInfo) -> Option<DashAudio> {
    dash.audio
        .into_iter()
        .filter(|audio| {
            !audio.base_url.is_empty()
                && (audio.codecs.is_empty() || audio.codecs.starts_with("mp4a"))
                && (audio.mime_type.is_empty() || audio.mime_type == "audio/mp4")
        })
        .max_by_key(|audio| audio.bandwidth)
}

pub(super) fn seconds_to_millis(seconds: f64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 || seconds > MAX_SAFE_INTEGER as f64 / 1_000.0 {
        0
    } else {
        (seconds * 1_000.0).round() as u64
    }
}

fn classify_binary(bytes: &[u8], label: &str) -> DownloadResult<()> {
    let trimmed = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map(|start| &bytes[start..])
        .unwrap_or(bytes);
    if trimmed.first() == Some(&b'{') {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(trimmed) {
            return Err(api_error(
                label,
                value.get("code").and_then(|v| v.as_i64()).unwrap_or(-1),
                value.get("message").and_then(|v| v.as_str()),
            ));
        }
    }
    if trimmed.first() == Some(&b'<') {
        return Err(DownloadError::permanent(format!(
            "{label}返回验证网页，已停止请求，请稍后重试。"
        )));
    }
    Ok(())
}

pub(super) fn decode_segment(bytes: &[u8]) -> DownloadResult<Vec<DanmakuElem>> {
    classify_binary(bytes, "获取弹幕分段")?;
    let reply = DmSegMobileReply::decode(bytes)
        .map_err(|_| DownloadError::new(ErrorKind::Retryable, "弹幕分段被截断或损坏。"))?;
    if reply.elems.len() > MAX_DANMAKUS {
        return Err(DownloadError::permanent(
            "单 P 弹幕超过可导入数量，请缩小范围。",
        ));
    }
    Ok(reply.elems)
}

pub(super) async fn fetch_all_danmakus(
    context: &RunContext,
    client: &Client,
    aid: u64,
    cid: u64,
    current: usize,
    selected: usize,
    page: u32,
) -> DownloadResult<Vec<DanmakuElem>> {
    let bytes = read_bytes(
        context,
        client
            .get(format!("{API_ROOT}/x/v2/dm/web/view"))
            .header(ACCEPT, "application/octet-stream, */*")
            .query(&[
                ("type", "1".to_string()),
                ("oid", cid.to_string()),
                ("pid", aid.to_string()),
            ]),
        "获取弹幕分页",
    )
    .await?;
    classify_binary(&bytes, "获取弹幕分页")?;
    let reply = DmWebViewReply::decode(bytes.as_slice())
        .map_err(|_| DownloadError::permanent("弹幕分页信息损坏或不完整。"))?;
    let total = reply.dm_sge.map(|c| c.total).unwrap_or(1).max(1);
    if total > MAX_SEGMENTS {
        return Err(DownloadError::permanent("弹幕分页数量超过支持范围。"));
    }
    let mut all = Vec::new();
    for segment in 1..=total {
        if segment > 1 {
            context.wait(150).await?;
        }
        context.progress(
            "danmaku",
            current,
            selected,
            page,
            (segment - 1) as f64 / total as f64 * 100.0,
            format!("正在获取 P{page} 弹幕 {segment}/{total}"),
        );
        for attempt in 1..=3 {
            let result = async {
                let bytes = read_bytes(
                    context,
                    client
                        .get(format!("{API_ROOT}/x/v2/dm/web/seg.so"))
                        .header(ACCEPT, "application/octet-stream, */*")
                        .query(&[
                            ("type", "1".to_string()),
                            ("oid", cid.to_string()),
                            ("pid", aid.to_string()),
                            ("segment_index", segment.to_string()),
                        ]),
                    "获取弹幕分段",
                )
                .await?;
                decode_segment(&bytes)
            }
            .await;
            match result {
                Ok(elements) => {
                    if all.len() + elements.len() > MAX_DANMAKUS {
                        return Err(DownloadError::permanent("单 P 弹幕超过可导入数量。"));
                    }
                    all.extend(elements);
                    break;
                }
                Err(error) if error.kind == ErrorKind::Retryable && attempt < 3 => {
                    context.wait(attempt * 500).await?
                }
                Err(error) => return Err(error),
            }
        }
    }
    all.sort_by_key(|item| item.progress);
    Ok(all)
}

pub(super) struct DownloadedAudio {
    pub size: u64,
    pub sha256: String,
}

pub(super) async fn download_audio(
    context: &RunContext,
    client: &Client,
    audio: &DashAudio,
    path: &Path,
    current: usize,
    total: usize,
    page: u32,
) -> DownloadResult<DownloadedAudio> {
    let mut candidates = Vec::new();
    for value in std::iter::once(&audio.base_url)
        .chain(audio.backup_url.iter())
        .take(8)
    {
        if let Ok(url) = media_url(value) {
            if !candidates.contains(&url) {
                candidates.push(url);
            }
        }
    }
    if candidates.is_empty() {
        return Err(DownloadError::permanent("没有可用的 B 站 HTTPS 音轨地址。"));
    }
    let mut last_error = DownloadError::permanent("音轨下载失败。");
    for attempt in 0..2 {
        for url in &candidates {
            context.cancellation.check()?;
            let result = stream_audio(context, client, url, path, current, total, page).await;
            match result {
                Ok(result) => return Ok(result),
                Err(error) => {
                    let _ = tokio::fs::remove_file(path).await;
                    if matches!(error.kind, ErrorKind::Cancelled | ErrorKind::RateControl) {
                        return Err(error);
                    }
                    last_error = error;
                }
            }
        }
        if last_error.kind != ErrorKind::Retryable {
            break;
        }
        if attempt == 0 {
            context.wait(1_000).await?;
        }
    }
    Err(last_error)
}

async fn stream_audio(
    context: &RunContext,
    client: &Client,
    url: &Url,
    path: &Path,
    current: usize,
    total: usize,
    page: u32,
) -> DownloadResult<DownloadedAudio> {
    context
        .cancellation
        .run(async {
            let mut response = client
                .get(url.clone())
                .send()
                .await
                .map_err(|e| network_error("连接音轨 CDN 失败", e))?;
            check_status(&response, "音轨 CDN")?;
            let expected = response.content_length();
            if expected.is_some_and(|size| size == 0 || size > MAX_AUDIO_BYTES) {
                return Err(DownloadError::permanent("音轨大小无效或超过支持范围。"));
            }
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .await
                .map_err(|e| DownloadError::io("无法创建音轨临时文件", e))?;
            let mut size = 0u64;
            let mut digest = Sha256::new();
            let mut prefix = Vec::new();
            let mut last_progress = std::time::Instant::now();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| network_error("音轨传输中断", e))?
            {
                size = size.saturating_add(chunk.len() as u64);
                if size > MAX_AUDIO_BYTES {
                    return Err(DownloadError::permanent("音轨超过支持大小，下载已停止。"));
                }
                if prefix.len() < 64 {
                    prefix.extend_from_slice(&chunk[..chunk.len().min(64 - prefix.len())]);
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|e| DownloadError::io("音轨写入失败", e))?;
                digest.update(&chunk);
                if last_progress.elapsed() >= Duration::from_millis(150) {
                    context.progress(
                        "audio",
                        current,
                        total,
                        page,
                        expected
                            .map(|len| size as f64 / len as f64 * 100.0)
                            .unwrap_or(0.0),
                        format!(
                            "正在下载 P{page} 音轨（{:.1} MB）",
                            size as f64 / 1_048_576.0
                        ),
                    );
                    last_progress = std::time::Instant::now();
                }
            }
            validate_audio_bytes(&prefix, size, expected)?;
            file.flush()
                .await
                .map_err(|e| DownloadError::io("完成音轨写入失败", e))?;
            file.sync_all()
                .await
                .map_err(|e| DownloadError::io("保存音轨失败", e))?;
            Ok(DownloadedAudio {
                size,
                sha256: format!("{:x}", digest.finalize()),
            })
        })
        .await
}

pub(super) fn validate_audio_bytes(
    prefix: &[u8],
    received: u64,
    expected: Option<u64>,
) -> DownloadResult<()> {
    if received < 12 || expected.is_some_and(|value| value != received) {
        return Err(DownloadError::new(
            ErrorKind::Retryable,
            "音轨内容为空或传输不完整。",
        ));
    }
    if prefix.len() < 12 || &prefix[4..8] != b"ftyp" {
        return Err(DownloadError::permanent(
            "CDN 未返回预期的 MP4 音频容器，未保存为 m4a。",
        ));
    }
    let box_size = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as u64;
    if box_size < 12 || box_size > received {
        return Err(DownloadError::permanent("音轨容器头无效。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
