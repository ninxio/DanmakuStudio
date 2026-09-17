use super::*;
use crate::process_supervision::SupervisedCommand;
use axum::{
    body::Body,
    extract::State,
    http::{Request, Response},
    routing::any,
    Router,
};
use std::sync::atomic::AtomicUsize;

struct Fixture {
    bytes: Vec<u8>,
    changed: AtomicBool,
    strong: bool,
    requests: AtomicUsize,
}
async fn serve(State(f): State<Arc<Fixture>>, request: Request<Body>) -> Response<Body> {
    f.requests.fetch_add(1, Ordering::Relaxed);
    if request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        != Some("Basic dTpw")
    {
        return Response::builder().status(401).body(Body::empty()).unwrap();
    }
    if request.method().as_str() == "PROPFIND" {
        assert_eq!(request.headers()["depth"], "1");
        return Response::builder().status(207).body(Body::from("<d:multistatus xmlns:d='DAV:'><d:response><d:href>/dav/Tom%20&amp;%20Jerry.S01E02.mkv</d:href><d:propstat><d:prop><d:displayname>Tom &amp; Jerry.S01E02.mkv</d:displayname><d:getcontentlength>123</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>")).unwrap();
    }
    let etag = if f.changed.load(Ordering::Acquire) {
        "\"v2\""
    } else {
        "\"v1\""
    };
    let mut builder = Response::builder()
        .header("Accept-Ranges", "bytes")
        .header("Content-Type", "video/x-matroska");
    if f.strong {
        builder = builder.header("ETag", etag);
    } else {
        builder = builder.header("Last-Modified", "Sun, 13 Sep 2026 00:00:00 GMT");
    }
    let size = f.bytes.len();
    if f.strong {
        if let Some(r) = request.headers().get("range") {
            let (a, b) = r
                .to_str()
                .unwrap()
                .strip_prefix("bytes=")
                .unwrap()
                .split_once('-')
                .unwrap();
            let a = a.parse::<usize>().unwrap();
            let b = if b.is_empty() {
                size - 1
            } else {
                b.parse::<usize>().unwrap().min(size - 1)
            };
            if a >= size {
                return builder.status(416).body(Body::empty()).unwrap();
            }
            return builder
                .status(206)
                .header("Content-Range", format!("bytes {a}-{b}/{size}"))
                .header("Content-Length", b - a + 1)
                .body(if request.method() == "HEAD" {
                    Body::empty()
                } else {
                    Body::from(f.bytes[a..=b].to_vec())
                })
                .unwrap();
        }
    }
    builder
        .header("Content-Length", size)
        .body(if request.method() == "HEAD" {
            Body::empty()
        } else {
            Body::from(f.bytes.clone())
        })
        .unwrap()
}
async fn server(
    bytes: Vec<u8>,
    strong: bool,
) -> (Connection, Arc<Fixture>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let f = Arc::new(Fixture {
        bytes,
        changed: AtomicBool::new(false),
        strong,
        requests: AtomicUsize::new(0),
    });
    let router = Router::new().fallback(any(serve)).with_state(f.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (
        Connection {
            id: "fixture".into(),
            name: "Fixture".into(),
            root: format!("http://{addr}/dav/"),
            username: "u".into(),
            password: "p".into(),
        },
        f,
        task,
    )
}
fn temp() -> PathBuf {
    let p = std::env::temp_dir().join(format!("studio-webdav-test-{}", random_id().unwrap()));
    std::fs::create_dir(&p).unwrap();
    p
}
fn movie(path: &Path, shift: bool) {
    let mut command = SupervisedCommand::new("ffmpeg");
    command.args([
        "-v",
        "error",
        "-nostdin",
        "-n",
        "-f",
        "lavfi",
        "-i",
        "color=s=32x32:r=10:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=1.5",
        "-filter_complex",
        "[1:a]asetpts=PTS+0.5/TB[a]",
        "-map",
        "0:v",
        "-map",
        "[a]",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
    ]);
    if shift {
        command.args(["-output_ts_offset", "5"]);
    }
    let result = command
        .arg(path)
        .output(media::limits(30), || false)
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn assert_audio(path: &Path) {
    let result = SupervisedCommand::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"])
        .output(media::limits(20), || false)
        .unwrap();
    assert!(result.status.success());
    let samples = result
        .stdout
        .chunks_exact(2)
        .map(|v| i16::from_le_bytes([v[0], v[1]]))
        .collect::<Vec<_>>();
    assert!(
        (31950..=32050).contains(&samples.len()),
        "{} samples",
        samples.len()
    );
    assert!(samples[..7000].iter().all(|s| *s == 0));
    assert!(samples[9000..12000].iter().any(|s| s.abs() > 100));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn range_to_flac_receipt_import_preserves_leading_silence_and_shifted_origin() {
    for shift in [false, true] {
        let root = temp();
        let original = root.join("source.mkv");
        movie(&original, shift);
        let bytes = std::fs::read(&original).unwrap();
        let (c, _, server) = server(bytes, true).await;
        let entries = browse::list(&c, "/dav/").await.unwrap();
        assert_eq!(entries[0].name, "Tom & Jerry.S01E02.mkv");
        let prepared = media::inspect(c, entries[0].href.clone(), None)
            .await
            .unwrap();
        assert_eq!(
            prepared.public.source_presentation_origin_ms,
            if shift { 5000 } else { 0 }
        );
        let mut job = jobs::new(&prepared, 1, root.join("cache")).unwrap();
        let receipt = jobs::acquire(&prepared, &job, Arc::new(AtomicBool::new(false)), |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert!((1990..=2010).contains(&receipt.output_duration_ms));
        assert_eq!(receipt.source_presentation_end_ms, None);
        assert_audio(&job.directory.join("audio.flac"));
        job.status = JobStatus::Completed;
        job.receipt = Some(receipt);
        let imported = jobs::validate_import(&job).unwrap();
        assert!(imported
            .file_name
            .starts_with("Tom & Jerry.S01E02.audio-1-"));
        assert!(imported.file_name.ends_with(".flac"));
        std::fs::write(job.directory.join("audio.flac"), b"tampered").unwrap();
        assert!(jobs::validate_import(&job).is_err());
        server.abort();
        let _ = server.await;
        // Fixture owns this unique temporary subtree; no user paths are passed to cleanup.
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn weak_server_uses_single_get_local_source_and_rejects_modified_input() {
    let root = temp();
    let original = root.join("fixture.mkv");
    movie(&original, false);
    let (c, fixture, server) = server(std::fs::read(&original).unwrap(), false).await;
    let target = connection::href(
        &connection::root(&c.root).unwrap(),
        &connection::root(&c.root).unwrap(),
        "/dav/S01E01.mkv",
    )
    .unwrap();
    assert!(transport::pin(&c, &target).await.is_err());
    let directory = root.join("attempt");
    std::fs::create_dir(&directory).unwrap();
    let before = fixture.requests.load(Ordering::Relaxed);
    let source = temporary::download(&c, &target, &directory, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), before + 1);
    let mut job = Job {
        id: "j".into(),
        connection_id: c.id,
        href: target.path().into(),
        name: "S01E01.mkv".into(),
        stream_index: 1,
        status: JobStatus::AwaitingTrack,
        message: String::new(),
        created_at_ms: 0,
        directory: directory.clone(),
        receipt: None,
        source: Some(source),
    };
    let p = temporary::inspect(job.clone(), None).await.unwrap();
    let r = jobs::acquire(&p, &job, Arc::new(AtomicBool::new(false)), |_, _| Ok(()))
        .await
        .unwrap();
    assert_eq!(r.source_consistency, "single-response-local-sha256");
    assert_audio(&directory.join("audio.flac"));
    job.status = JobStatus::Completed;
    job.receipt = Some(r);
    jobs::validate_import(&job).unwrap();
    std::fs::write(directory.join("source.input"), b"changed").unwrap();
    assert!(
        jobs::acquire(&p, &job, Arc::new(AtomicBool::new(false)), |_, _| Ok(()))
            .await
            .is_err()
    );
    server.abort();
    let _ = server.await;
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn range_change_is_latched_and_playlist_demuxer_is_denied() {
    let (c,f,server)=server(b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://example.invalid/secret.ts\n#EXT-X-ENDLIST\n".to_vec(),true).await;
    let root = connection::root(&c.root).unwrap();
    let target = connection::href(&root, &root, "/dav/a.mkv").unwrap();
    let v = transport::pin(&c, &target).await.unwrap();
    let proxy = transport::Proxy::open(c.clone(), target.clone(), v)
        .await
        .unwrap();
    f.changed.store(true, Ordering::Release);
    let response = transport::client()
        .unwrap()
        .get(&proxy.url)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    assert!(proxy.close().await.is_err());
    f.changed.store(false, Ordering::Release);
    assert!(media::inspect(c, "/dav/a.mkv".into(), None).await.is_err());
    server.abort();
    let _ = server.await;
}

#[test]
fn write_failure_does_not_mutate_in_memory_status_and_cancelled_never_imports() {
    let root = temp();
    let blocking = root.join("blocked");
    std::fs::write(&blocking, b"keep").unwrap();
    let job = Job {
        id: "j".into(),
        connection_id: "c".into(),
        href: "/a".into(),
        name: "a".into(),
        stream_index: 0,
        status: JobStatus::Cancelled,
        message: String::new(),
        created_at_ms: 0,
        directory: root.clone(),
        receipt: None,
        source: None,
    };
    let mut s = Store {
        root: blocking,
        connections: vec![],
        jobs: vec![job],
        probes: BTreeMap::new(),
        active: BTreeMap::new(),
    };
    assert!(jobs::change(&mut s, "j", |j| j.status = JobStatus::Completed).is_err());
    assert_eq!(s.jobs[0].status, JobStatus::Cancelled);
    assert!(jobs::validate_import(&s.jobs[0]).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_slow_single_get_closes_request_and_only_owned_input_is_removed() {
    use futures_util::stream;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = Router::new().fallback(any(|| async {
        let stream = stream::unfold(0, |n| async move {
            if n >= 16 {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            Some((Ok::<_, std::io::Error>(vec![0u8; 512]), n + 1))
        });
        Response::builder()
            .header("Content-Length", 8192)
            .body(Body::from_stream(stream))
            .unwrap()
    }));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let c = Connection {
        id: "c".into(),
        name: "slow".into(),
        root: format!("http://{addr}/dav/"),
        username: "".into(),
        password: "".into(),
    };
    let target = connection::root(&c.root).unwrap().join("a.mkv").unwrap();
    let root = temp();
    let job = Job {
        id: random_id().unwrap(),
        connection_id: "c".into(),
        href: "/dav/a.mkv".into(),
        name: "a".into(),
        stream_index: 0,
        status: JobStatus::Downloading,
        message: String::new(),
        created_at_ms: 0,
        directory: root.join("attempt"),
        receipt: None,
        source: None,
    };
    temporary::create_directory(&job).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let token = cancel.clone();
    let dir = job.directory.clone();
    let task = tokio::spawn(async move { temporary::download(&c, &target, &dir, &token).await });
    tokio::time::sleep(Duration::from_millis(150)).await;
    cancel.store(true, Ordering::Release);
    assert!(tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    std::fs::write(job.directory.join("audio.flac"), b"retained").unwrap();
    temporary::remove_inputs(&job).unwrap();
    assert!(!job.directory.join("source.partial").exists());
    assert!(job.directory.join("audio.flac").exists());
    std::fs::write(job.directory.join("owner.txt"), b"unknown").unwrap();
    std::fs::write(job.directory.join("source.input"), b"unknown media").unwrap();
    assert!(temporary::remove_inputs(&job).is_err());
    assert!(job.directory.join("source.input").exists());
    server.abort();
    let _ = server.await;
    std::fs::remove_dir_all(root).unwrap();
}
