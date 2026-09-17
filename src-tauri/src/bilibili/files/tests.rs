use super::*;
use crate::bilibili::tests::fixture_view;

struct TestFolder(PathBuf);
impl TestFolder {
    fn new() -> Self {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).unwrap();
        let path =
            std::env::temp_dir().join(format!("dts-bilibili-test-{:x}", u64::from_le_bytes(bytes)));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestFolder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn probe() -> PlayProbe {
    PlayProbe {
        duration_ms: 12_345,
        duration_source: "playurl.dash.duration".into(),
        exact_duration: true,
        audio: None,
    }
}
fn comments() -> Vec<DanmakuElem> {
    vec![DanmakuElem {
        id: 123,
        progress: 1_234,
        mode: 1,
        fontsize: 25,
        color: 16777215,
        content: "保留 <内容> & 引号\"".into(),
        ..Default::default()
    }]
}

fn fixture_receipt() -> PackageReceipt {
    let view = fixture_view();
    PackageReceipt {
        version: 1,
        bvid: view.bvid,
        aid: view.aid,
        cid: view.pages[0].cid,
        page: 1,
        page_count: 2,
        part: view.pages[0].part.clone(),
        duration_ms: probe().duration_ms,
        duration_source: probe().duration_source,
        exact_duration: true,
        danmaku_count: 1,
        xml: FileReceipt {
            name: "a.xml".into(),
            size: 1,
            sha256: "0".repeat(64),
        },
        audio: None,
    }
}

#[test]
fn writes_metadata_and_xml_escaping_then_rejects_truncation() {
    let view = fixture_view();
    let xml = build_xml(&view, &view.pages[0], &probe(), &comments(), None);
    assert!(xml.contains("duration-ms=\"12345\""));
    assert!(xml.contains("1.234,1,25,16777215"));
    assert!(xml.contains("&lt;内容&gt; &amp;"));
    let receipt = fixture_receipt();
    assert!(validate_xml(&xml, &receipt).is_ok());
    assert!(validate_xml(xml.trim_end_matches("</i>\n"), &receipt).is_err());
    assert!(validate_xml(&xml.replace("cid=\"1234\"", "cid=\"9999\""), &receipt).is_err());
    assert!(validate_xml(&xml.replace("</i>", "</wrong>"), &receipt).is_err());
}

#[tokio::test]
async fn publishes_complete_xml_package_then_resumes_verified_result() {
    let folder = TestFolder::new();
    let view = fixture_view();
    let page = &view.pages[0];
    let output = PageOutput::new(&folder.0, &view, page, false).unwrap();
    let context = RunContext::quiet();
    assert!(output
        .resume(&context, &view, page, false)
        .await
        .unwrap()
        .is_none());
    let result = output
        .publish(
            &context,
            &api::build_client(None, true).unwrap(),
            &view,
            page,
            &probe(),
            &comments(),
            false,
            1,
            1,
        )
        .await
        .unwrap();
    assert!(Path::new(&result.xml_path).is_file());
    assert!(output.directory.join(MANIFEST_NAME).is_file());
    assert!(result.audio_path.is_none());
    let resumed = output
        .resume(&context, &view, page, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resumed.xml_path, result.xml_path);
    assert_eq!(resumed.duration_ms, 12_345);
    assert_eq!(resumed.danmaku_count, 1);
    assert!(std::fs::read_dir(output.directory.parent().unwrap())
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("partial")));
}

#[tokio::test]
async fn modified_xml_is_not_silently_accepted_as_completed() {
    let folder = TestFolder::new();
    let view = fixture_view();
    let page = &view.pages[0];
    let output = PageOutput::new(&folder.0, &view, page, false).unwrap();
    let context = RunContext::quiet();
    let result = output
        .publish(
            &context,
            &api::build_client(None, true).unwrap(),
            &view,
            page,
            &probe(),
            &comments(),
            false,
            1,
            1,
        )
        .await
        .unwrap();
    let xml = std::fs::read_to_string(&result.xml_path).unwrap();
    std::fs::write(&result.xml_path, xml.replace("内容", "修改")).unwrap();
    assert!(output.resume(&context, &view, page, false).await.is_err());
}

#[tokio::test]
async fn cancellation_removes_only_owned_staging_and_never_publishes_half_page() {
    let folder = TestFolder::new();
    let view = fixture_view();
    let page = &view.pages[0];
    let output = PageOutput::new(&folder.0, &view, page, false).unwrap();
    let context = RunContext::quiet();
    context.cancellation.cancel();
    let error = output
        .publish(
            &context,
            &api::build_client(None, true).unwrap(),
            &view,
            page,
            &probe(),
            &comments(),
            false,
            1,
            1,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Cancelled);
    assert!(!output.directory.exists());
    assert_eq!(
        std::fs::read_dir(output.directory.parent().unwrap())
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn incomplete_folder_and_preexisting_destination_are_never_overwritten() {
    let folder = TestFolder::new();
    let destination = folder.0.join("existing");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("user.txt"), "keep me").unwrap();
    let staging = StagingDirectory::create(&folder.0).unwrap();
    std::fs::write(staging.path.join("new.xml"), "new").unwrap();
    assert!(staging.publish(&destination).is_err());
    assert_eq!(
        std::fs::read_to_string(destination.join("user.txt")).unwrap(),
        "keep me"
    );
    assert!(!destination.join("new.xml").exists());
}

#[test]
fn manifest_paths_cannot_escape_package_and_audio_upgrade_is_separate() {
    assert!(!safe_name("../source.xml", "xml"));
    assert!(!safe_name("C:\\source.xml", "xml"));
    assert!(!safe_name("source.xml:stream", "xml"));
    let view = fixture_view();
    let plain = PageOutput::new(Path::new("root"), &view, &view.pages[0], false).unwrap();
    let audio = PageOutput::new(Path::new("root"), &view, &view.pages[0], true).unwrap();
    assert_ne!(plain.directory, audio.directory);
}
