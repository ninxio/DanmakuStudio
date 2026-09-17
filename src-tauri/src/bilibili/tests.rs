use super::*;

pub(super) fn fixture_view() -> api::ViewData {
    serde_json::from_value(serde_json::json!({
        "bvid": "BV1xx411c7mD", "aid": 170001, "title": "A & B", "owner": {"name": "作者"},
        "pages": [
            {"cid": 1234, "page": 1, "part": "第一 P <测试>", "duration": 10},
            {"cid": 5678, "page": 2, "part": "第二 P", "duration": 30}
        ]
    }))
    .unwrap()
}

#[test]
fn parses_existing_bvid_av_and_video_url_inputs() {
    use api::{parse_video_identity as parse, VideoIdentity};
    assert_eq!(
        parse("https://www.bilibili.com/video/BV1xx411c7mD?p=2").unwrap(),
        VideoIdentity::Bvid("BV1xx411c7mD".into())
    );
    assert_eq!(parse("av170001").unwrap(), VideoIdentity::Aid(170001));
    assert_eq!(parse("170001").unwrap(), VideoIdentity::Aid(170001));
    assert!(parse("https://example.com/BV1xx411c7mD").is_err());
    assert!(parse("https://b23.tv/a").is_err());
    assert!(parse("BV1xx411c7mDextra").is_err());
    assert!(parse("9007199254740992").is_err());
}

#[test]
fn validates_javascript_safe_unique_page_identity() {
    let mut view = fixture_view();
    assert!(api::validate_view(&view).is_ok());
    view.pages[1].cid = view.pages[0].cid;
    assert!(api::validate_view(&view).is_err());
    view.pages[1].cid = MAX_SAFE_INTEGER + 1;
    assert!(api::validate_view(&view).is_err());
}

#[test]
fn preserves_bulk_spacing_without_case_specific_parameters() {
    assert_eq!(bulk_page_delay_ms(1, 1, 123), 0);
    assert!((1_250..=1_600).contains(&bulk_page_delay_ms(100, 42, 1_234)));
}

#[tokio::test]
async fn cancellation_interrupts_pending_network_or_wait_future() {
    let cancellation = Arc::new(Cancellation::default());
    let trigger = cancellation.clone();
    let cancel = async move {
        tokio::task::yield_now().await;
        trigger.cancel();
    };
    let operation = cancellation.run(std::future::pending::<DownloadResult<()>>());
    let (result, ()) = tokio::join!(operation, cancel);
    assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
    assert_eq!(
        cancellation.run(async { Ok(()) }).await.unwrap_err().kind,
        ErrorKind::Cancelled
    );
}

#[test]
fn cancellation_is_scoped_to_request_id() {
    let cancellation = Arc::new(Cancellation::default());
    *active_download().lock().unwrap() = Some(ActiveDownload {
        request_id: "scoped-test".into(),
        cancellation: cancellation.clone(),
    });
    let _lease = DownloadLease;
    assert!(!cancel_bilibili_download("another-task".into()));
    assert!(cancellation.check().is_ok());
    assert!(cancel_bilibili_download("scoped-test".into()));
    assert_eq!(cancellation.check().unwrap_err().kind, ErrorKind::Cancelled);
}

#[tokio::test]
async fn invalid_output_returns_failed_outcome_instead_of_losing_task_identity() {
    let request = BilibiliDownloadRequest {
        request_id: "failed-output".into(),
        input: "av170001".into(),
        cookie: None,
        output_folder: "?:invalid-output".into(),
        selected_cids: vec![1234],
        download_audio: false,
    };
    let outcome = run_download(&RunContext::quiet(), request).await;
    assert_eq!(outcome.request_id, "failed-output");
    assert_eq!(outcome.status, "failed");
    assert!(outcome.results.is_empty());
    assert!(outcome.error.is_some());
}

#[tokio::test]
async fn cancelled_outcome_is_distinct_from_failure() {
    let context = RunContext::quiet();
    context.cancellation.cancel();
    let request = BilibiliDownloadRequest {
        request_id: "cancel-test".into(),
        input: "av170001".into(),
        cookie: None,
        output_folder: "unused".into(),
        selected_cids: vec![1234],
        download_audio: false,
    };
    let outcome = run_download(&context, request).await;
    assert_eq!(outcome.status, "cancelled");
    assert!(outcome.error.is_none());
}

#[tokio::test]
#[ignore = "requires public Bilibili access; do not run while the current network is rate controlled"]
async fn live_public_video_metadata_danmaku_and_audio_header() {
    let context = RunContext::quiet();
    let client = api::build_client(None, false).unwrap();
    let view = api::fetch_view(&context, &client, "BV1xx411c7mD")
        .await
        .unwrap();
    let page = &view.pages[0];
    let probe = api::fetch_play_probe(&context, &client, &view, page)
        .await
        .unwrap();
    let comments = api::fetch_all_danmakus(&context, &client, view.aid, page.cid, 1, 1, page.page)
        .await
        .unwrap();
    assert!(probe.duration_ms > 0);
    assert!(comments
        .windows(2)
        .all(|pair| pair[0].progress <= pair[1].progress));
    let audio = probe.audio.unwrap();
    let url = reqwest::Url::parse(&audio.base_url).unwrap();
    assert!(api::is_allowed_media_url(&url));
    let mut response = api::build_client(None, true)
        .unwrap()
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-1023")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(response.chunk().await.unwrap().is_some());
}
