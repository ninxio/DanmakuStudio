use super::*;
use std::io::{Read, Write};

fn local_response(
    status: &str,
    content: &[u8],
    declared_size: Option<usize>,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        declared_size.unwrap_or(content.len())
    );
    let content = content.to_vec();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = [0u8; 8192];
        let count = stream.read(&mut bytes).unwrap();
        stream.write_all(response.as_bytes()).unwrap();
        stream.write_all(&content).unwrap();
        String::from_utf8_lossy(&bytes[..count]).into_owned()
    });
    (format!("http://{address}"), thread)
}

#[test]
fn distinguishes_rate_control_and_truncated_protobuf() {
    let error = decode_segment(br#"{"code":-352,"message":"risk control"}"#).unwrap_err();
    assert_eq!(error.kind, ErrorKind::RateControl);
    assert!(error.message.contains("-352"));
    assert!(!error.message.contains("未登录专用"));
    assert_eq!(
        decode_segment(&[0x0a, 0x05, 0x08]).unwrap_err().kind,
        ErrorKind::Retryable
    );
    assert_eq!(
        decode_segment(b"<html>challenge</html>").unwrap_err().kind,
        ErrorKind::Permanent
    );
    assert_eq!(api_error("登录", -101, None).kind, ErrorKind::Permanent);
}

#[test]
fn decodes_real_protobuf_field_mapping_without_float_time_conversion() {
    let item = DanmakuElem {
        id: 9223372036854775806,
        progress: 1_234,
        content: "测试 & 内容".into(),
        ..Default::default()
    };
    let bytes = DmSegMobileReply {
        elems: vec![item.clone()],
    }
    .encode_to_vec();
    assert_eq!(decode_segment(&bytes).unwrap(), vec![item]);
}

#[test]
fn only_allows_bilibili_cdn_https_without_credentials_or_custom_port() {
    for url in [
        "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/a?token=secret",
        "https://upos-hz-mirrorakam.akamaized.net/a",
        "https://cn-a.bilivideo.cn/a",
    ] {
        assert!(is_allowed_media_url(&Url::parse(url).unwrap()));
    }
    for url in [
        "http://cdn.bilivideo.com/a",
        "https://bilivideo.com.evil.example/a",
        "https://127.0.0.1/a",
        "https://user:pass@cdn.bilivideo.com/a",
        "https://cdn.bilivideo.com:8080/a",
        "https://other.akamaized.net/a",
    ] {
        assert!(!is_allowed_media_url(&Url::parse(url).unwrap()));
    }
}

#[test]
fn recognizes_snake_case_audio_urls_and_selects_normal_aac() {
    let dash: DashInfo = serde_json::from_value(serde_json::json!({"duration":1.25,"audio":[
        {"base_url":"https://cdn.bilivideo.com/a", "backup_url":["https://other.bilivideo.com/a"], "bandwidth":192000,"codecs":"mp4a.40.2","mime_type":"audio/mp4"},
        {"baseUrl":"https://cdn.bilivideo.com/b", "bandwidth":320000,"codecs":"ec-3","mimeType":"audio/mp4"}
    ]})).unwrap();
    let audio = select_audio(dash).unwrap();
    assert_eq!(audio.bandwidth, 192000);
    assert_eq!(audio.backup_url.len(), 1);
    assert_eq!(seconds_to_millis(1.25), 1250);
    assert_eq!(seconds_to_millis(f64::NAN), 0);
}

#[test]
fn verifies_audio_body_length_and_container_before_publish() {
    let prefix = b"\0\0\0\x18ftypM4A \0\0\0\0";
    assert!(validate_audio_bytes(prefix, 24, Some(24)).is_ok());
    assert!(validate_audio_bytes(prefix, 16, Some(24)).is_err());
    assert!(validate_audio_bytes(b"<html>denied</html>", 19, Some(19)).is_err());
    assert!(validate_audio_bytes(&[], 0, Some(0)).is_err());
}

#[tokio::test]
async fn classifies_http_412_and_html_metadata_without_retries() {
    let (url, server) = local_response("412 Precondition Failed", b"<html>risk</html>", None);
    let error = json_payload::<serde_json::Value>(
        &RunContext::quiet(),
        build_client(None, false).unwrap().get(url),
        "获取视频信息",
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::RateControl);
    assert!(error.message.contains("412"));
    server.join().unwrap();
    let (url, server) = local_response("200 OK", b"<html>risk</html>", None);
    let error = json_payload::<serde_json::Value>(
        &RunContext::quiet(),
        build_client(None, false).unwrap().get(url),
        "获取视频信息",
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::RateControl);
    server.join().unwrap();
}

#[tokio::test]
async fn media_client_never_forwards_cookie_even_when_supplied() {
    let (url, server) = local_response("200 OK", b"ok", None);
    build_client(Some("SESSDATA=local-secret"), true)
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap();
    let request = server.join().unwrap().to_lowercase();
    assert!(!request.contains("cookie:"));
    assert!(!request.contains("local-secret"));
}

#[test]
fn user_errors_do_not_include_signed_urls() {
    let message = api_error(
        "下载",
        -412,
        Some("denied https://cdn.bilivideo.com/a?token=private"),
    )
    .message;
    assert!(!message.contains("token=private"));
}

#[test]
fn playurl_accepts_coexisting_camel_and_snake_case_audio_fields() {
    let payload = serde_json::json!({"timelength":261000,"dash":{"duration":261,"audio":[{
        "baseUrl":"https://cdn.bilivideo.com/audio", "base_url":"https://cdn.bilivideo.com/audio",
        "backupUrl":[], "backup_url":[], "mimeType":"audio/mp4", "mime_type":"audio/mp4",
        "codecs":"mp4a.40.2", "bandwidth":192000
    }]}});
    let parsed: PlayUrlData =
        serde_json::from_value(payload).expect("playurl must not reject dual naming fields");
    assert_eq!(parsed.timelength, Some(261000));
    assert_eq!(
        select_audio(parsed.dash.unwrap()).unwrap().bandwidth,
        192000
    );
}

#[test]
fn optional_audio_cannot_destroy_playback_duration() {
    let view = crate::bilibili::tests::fixture_view();
    for audio in [
        serde_json::Value::Null,
        serde_json::json!([]),
        serde_json::json!([null, 7, {"baseUrl":null,"backupUrl":null}]),
        serde_json::json!({"unexpected":true}),
    ] {
        let payload =
            serde_json::json!({"timelength":261123,"dash":{"duration":261.123,"audio":audio}});
        let probe = probe_from_payload(serde_json::from_value(payload).unwrap(), &view.pages[0]);
        assert_eq!(probe.duration_ms, 261123);
        assert!(probe.exact_duration);
        assert!(probe.audio.is_none());
    }
    let payload = serde_json::json!({"timelength":261123,"dash":null});
    let probe = probe_from_payload(serde_json::from_value(payload).unwrap(), &view.pages[0]);
    assert_eq!(probe.duration_ms, 261123);
    assert_eq!(probe.duration_source, "playurl.timelength");
    let payload = serde_json::json!({"timelength":-1,"dash":{"duration":-1}});
    let probe = probe_from_payload(serde_json::from_value(payload).unwrap(), &view.pages[0]);
    assert_eq!(probe.duration_ms, 10000);
    assert!(!probe.exact_duration);
}

#[test]
fn dual_aliases_have_deterministic_precedence_and_deduplicated_backups() {
    let audio: DashAudio = serde_json::from_value(serde_json::json!({
        "baseUrl":null,"base_url":"https://cdn.bilivideo.com/a",
        "backupUrl":["https://cdn.bilivideo.com/b",null],
        "backup_url":["https://cdn.bilivideo.com/b","https://cdn.bilivideo.com/c"],
        "mimeType":"","mime_type":"audio/mp4", "bandwidth":null
    }))
    .unwrap();
    assert_eq!(audio.base_url, "https://cdn.bilivideo.com/a");
    assert_eq!(audio.backup_url.len(), 2);
    assert_eq!(audio.mime_type, "audio/mp4");
    let audio: DashAudio = serde_json::from_value(serde_json::json!({
        "baseUrl":"https://cdn.bilivideo.com/primary", "base_url":"https://cdn.bilivideo.com/alias"
    }))
    .unwrap();
    assert!(audio.base_url.ends_with("/primary"));
}

#[tokio::test]
async fn playurl_http_response_reaches_xml_publication_and_resume() {
    let body = serde_json::json!({"code":0,"data":{"timelength":261123,"dash":{"duration":261.123,"audio":[{
        "baseUrl":"https://cdn.bilivideo.com/a", "base_url":"https://cdn.bilivideo.com/a",
        "backupUrl":[], "backup_url":[], "mimeType":"audio/mp4", "mime_type":"audio/mp4", "codecs":"mp4a.40.2"
    }]}}});
    let (url, server) = local_response("200 OK", &serde_json::to_vec(&body).unwrap(), None);
    let context = RunContext::quiet();
    let payload: PlayUrlData = json_payload(
        &context,
        build_client(None, false).unwrap().get(url),
        "获取播放信息",
    )
    .await
    .unwrap();
    server.join().unwrap();
    let view = crate::bilibili::tests::fixture_view();
    let page = &view.pages[0];
    let probe = probe_from_payload(payload, page);
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).unwrap();
    let folder =
        std::env::temp_dir().join(format!("dts-playurl-fix-{}", u64::from_le_bytes(random)));
    std::fs::create_dir(&folder).unwrap();
    let output = crate::bilibili::files::PageOutput::new(&folder, &view, page, false).unwrap();
    let comments = [DanmakuElem {
        id: 1,
        progress: 1000,
        content: "test".into(),
        ..Default::default()
    }];
    let result = output
        .publish(
            &context,
            &build_client(None, true).unwrap(),
            &view,
            page,
            &probe,
            &comments,
            false,
            1,
            1,
        )
        .await
        .unwrap();
    let xml = std::fs::read_to_string(&result.xml_path).unwrap();
    assert!(xml.contains("duration-ms=\"261123\""));
    assert!(xml.contains("exact-duration=\"true\""));
    assert!(xml.contains("<d p="));
    assert!(result.audio_path.is_none());
    assert!(output
        .resume(&context, &view, page, false)
        .await
        .unwrap()
        .is_some());
    std::fs::remove_dir_all(folder).unwrap();
}
