use super::*;
use axum::{body::Bytes, extract::State, http::Uri, response::IntoResponse, routing::any, Router};
use std::{
    io::Read,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct ServerState {
    requests: Vec<String>,
    manifest: Value,
    json: Vec<u8>,
    corrupt_read: bool,
}
fn json_response(value: Value) -> axum::response::Response {
    ([("Content-Type", "application/json")], value.to_string()).into_response()
}
async fn handler(
    State(state): State<Arc<Mutex<ServerState>>>,
    uri: Uri,
    headers: axum::http::HeaderMap,
    bytes: Bytes,
) -> axum::response::Response {
    let mut state = state.lock().unwrap();
    let path = uri.path();
    assert_eq!(
        headers.get("Authorization").unwrap(),
        &format!("Bearer {}", "test-only".repeat(6))
    );
    if path.contains("/publications") {
        assert_eq!(headers.get("X-Storage-Format").unwrap(), "json-gzip");
    }
    state.requests.push(path.to_string());
    if path.ends_with("/publications/plan") {
        let p: Value = serde_json::from_slice(&bytes).unwrap();
        return json_response(
            json!({"success":true,"action":"create","storageFormat":"json-gzip",
            "missingObjects":[{"format":"json-gzip","hash":p["commentsHash"]}]}),
        )
        .into_response();
    }
    if path.contains("/storage/json/") {
        let mut json = Vec::new();
        flate2::read::GzDecoder::new(bytes.as_ref())
            .read_to_end(&mut json)
            .unwrap();
        assert!(path.ends_with(&hash(&json)));
        state.json = json;
        return json_response(json!({"success":true}));
    }
    if path.ends_with("/publications") {
        state.manifest = serde_json::from_slice(&bytes).unwrap();
        return json_response(
            json!({"success":true,"episodeId":42,"animeId":1000001,"revision":"b".repeat(64),"metadataVersion":1}),
        );
    }
    if path.ends_with("/episodes/42") {
        return json_response(
            json!({"success":true,"revision":"b".repeat(64),"manifest":state.manifest}),
        )
        .into_response();
    }
    if path.ends_with("/episodes/42/json") {
        let raw = if state.corrupt_read {
            b"wrong".as_slice()
        } else {
            &state.json
        };
        return (
            [
                ("Content-Type", "application/json"),
                ("Content-Encoding", "gzip"),
            ],
            compress_comments(raw).unwrap(),
        )
            .into_response();
    }
    (axum::http::StatusCode::NOT_FOUND, "unexpected endpoint").into_response()
}

#[tokio::test]
async fn native_json_only_publish_uploads_one_gzip_and_checks_decompressed_readback() {
    for corrupt in [false, true] {
        let state = Arc::new(Mutex::new(ServerState {
            corrupt_read: corrupt,
            ..Default::default()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(any(handler))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let metadata: PublicationMetadata = serde_json::from_value(json!({
            "workKey":"test","editionKey":"current","title":"测试","aliases":[],"year":null,
            "kind":"tv","edition":"current","season":1,"episode":1,"label":"第一集",
            "durationMs":null,"fileNames":[],"allowAutoMatch":false
        }))
        .unwrap();
        let baseline = PublicationBaseline {
            connection_scope: base.clone(),
            identity: publication_identity(&metadata),
            expected_revision: Value::Null,
        };
        let connection = Connection {
            base_url: base,
            publish_token: "test-only".repeat(6),
            read_token: String::new(),
        };
        let request = PublishRequest {
            xml: "<i><d p=\"1.001,1,25,16711680,0,0,user,1\">中文 &amp; 原文</d></i>".into(),
            metadata,
            baseline,
        };
        let result = publish_with_connection(&connection, request).await;
        server.abort();
        if corrupt {
            assert!(result.err().unwrap().contains("播放器数据回读校验失败"));
        } else {
            assert_eq!(result.unwrap().episode_id, 42);
        }
        let state = state.lock().unwrap();
        assert_eq!(state.requests.len(), 5);
        assert_eq!(
            state
                .requests
                .iter()
                .filter(|p| p.contains("/storage/json/"))
                .count(),
            1
        );
        assert!(!state
            .requests
            .iter()
            .any(|p| p.ends_with("/xml") || p.contains("/objects/")));
    }
}
