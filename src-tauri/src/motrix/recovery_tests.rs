//! Exercise recovery through the HTTP transport and durable queue, with isolated fake MDXP.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

struct State {
    tasks: Vec<Value>,
    removed: Vec<String>,
    requests: Vec<String>,
    changed: bool,
    lose_receipt: bool,
}
struct Server {
    port: u16,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(tasks: Vec<Value>, changed: bool, lose_receipt: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(Mutex::new(State {
            tasks,
            removed: vec![],
            requests: vec![],
            changed,
            lose_receipt,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, stopped) = (state.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                // Windows accepted sockets inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                let request: Value = loop {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                                .unwrap();
                        }
                    }
                };
                let mut state = shared.lock().unwrap();
                let params = &request["params"];
                let mut status = 200;
                let result = match request["method"].as_str().unwrap() {
                    "task/list" => json!({"tasks":state.tasks,"total":state.tasks.len()}),
                    "task/get" => {
                        if state.changed {
                            state.tasks[0]["status"] = json!("paused");
                        }
                        json!({"task":state.tasks.iter().find(|t| t["id"] == params["taskId"])})
                    }
                    "task/remove" => {
                        assert_eq!(params["deleteFiles"], false);
                        state
                            .removed
                            .push(params["taskId"].as_str().unwrap().into());
                        state.tasks.retain(|t| t["id"] != params["taskId"]);
                        json!({})
                    }
                    "download/add" => {
                        let key = params["idempotencyKey"].as_str().unwrap().to_owned();
                        assert_eq!(params["kind"], "torrent");
                        state.requests.push(key);
                        let task = json!({"id":"accepted", "type":"bt", "status":"downloading", "infoHash":fixture_hash(), "saveDir":params["saveDir"], "progress":0.2});
                        if !state.tasks.iter().any(|t| t["id"] == "accepted") {
                            state.tasks.push(task.clone());
                        }
                        if state.lose_receipt {
                            state.lose_receipt = false;
                            status = 500;
                        }
                        task
                    }
                    _ => panic!("unexpected fixture method"),
                };
                let body = if status == 500 {
                    json!({"jsonrpc":"2.0","id":"studio","error":{"code":-32001,"message":"internal error"}})
                } else { json!({"jsonrpc":"2.0","id":"studio","result":result}) }.to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            port,
            state,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let result = self.thread.take().unwrap().join();
        if !std::thread::panicking() {
            assert!(result.is_ok(), "fixture server failed");
        }
    }
}

fn fixture_hash() -> String {
    ring::digest::digest(
        &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        b"d6:lengthi4e4:name8:test.wave",
    )
    .as_ref()
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect()
}

async fn exercise(changed: bool, lose_receipt: bool) {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "studio-mdxp-recovery-{}-{nonce}",
        std::process::id()
    ));
    let path = root.join("motrix-v1.json");
    let hash = fixture_hash();
    let cache = root.join("metadata").join(&hash);
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        cache.join(format!("{hash}.torrent")),
        b"d4:infod6:lengthi4e4:name8:test.wavee",
    )
    .unwrap();
    let save_dir = root.join("downloads");
    let task = |id, kind, status, dir: &Path| json!({"id":id,"type":kind,"status":status,"infoHash":hash,"saveDir":dir.to_string_lossy(),"progress":0});
    let tasks = if changed {
        vec![task("failed", "bt", "error", &save_dir)]
    } else {
        vec![
            task("parent", "magnet", "completed", &save_dir),
            task("child1", "bt", "error", &save_dir.join("Example.motrix")),
            task("child2", "bt", "error", &save_dir.join("Example.motrix")),
        ]
    };
    let server = Server::start(tasks, changed, lose_receipt);
    let mut rows: Vec<Download> = serde_json::from_value(json!([{"key":"stable-key","projectId":"project","title":"Fixture","uri":format!("magnet:?xt=urn:btih:{hash}"),"saveDir":save_dir.to_string_lossy(),"taskId":null,"status":"uncertain","progress":0,"message":"","files":[]}])).unwrap();
    save_queue(&path, &rows).unwrap();
    TEST_RPC_ENDPOINT
        .scope(
            Endpoint {
                port: server.port,
                local_token: "fixture-public-token".into(),
            },
            async {
                let outcome = recovery::repair(&path, &mut rows, 0).await;
                if changed {
                    assert!(outcome
                        .err()
                        .expect("changed task must stop repair")
                        .contains("状态已变化"));
                    assert!(server.state.lock().unwrap().removed.is_empty());
                    assert!(server.state.lock().unwrap().requests.is_empty());
                    return;
                }
                let outcome = outcome.unwrap();
                if lose_receipt {
                    assert_eq!(outcome.status, "uncertain");
                    assert!(outcome.task_id.is_none());
                    // Restart from the disk intent; refresh can attach the accepted task read-only.
                    rows = load_queue(&path).unwrap();
                    recovery::reconcile(&mut rows[0]).await.unwrap();
                }
                assert_eq!(rows[0].task_id.as_deref(), Some("accepted"));
                let retry = dispatch_download(&path, &mut rows, 0).await.unwrap();
                assert_eq!(retry.task_id.as_deref(), Some("accepted"));
                assert_eq!(
                    load_queue(&path).unwrap()[0].task_id.as_deref(),
                    Some("accepted")
                );
                let state = server.state.lock().unwrap();
                assert_eq!(state.removed, ["parent", "child1", "child2"]);
                assert_eq!(state.requests, ["stable-key", "stable-key"]);
                assert_eq!(state.tasks.len(), 1);
            },
        )
        .await;
    drop(server);
    // Only this generated fixture directory, containing no links or user inputs.
    assert!(root.starts_with(std::env::temp_dir()));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn removes_only_failed_records_and_retains_one_durable_receipt() {
    exercise(false, false).await;
}
#[tokio::test]
async fn task_becoming_healthy_before_removal_stops_repair() {
    exercise(true, false).await;
}
#[tokio::test]
async fn lost_create_receipt_is_recovered_from_disk_without_duplicate_download() {
    exercise(false, true).await;
}
