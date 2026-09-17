use super::*;
fn input(address: &str) -> ConfigureRequest {
    ConfigureRequest {
        api_address: address.into(),
        read_token: String::new(),
        admin_token: String::new(),
    }
}
#[test]
fn logvar_addresses_keep_tokens_out_of_status_and_support_proxy_prefix() {
    for address in [
        "https://api.example/reader",
        "https://api.example/reader/api/v2/",
    ] {
        let c = normalize(input(address), None).unwrap();
        assert_eq!(
            endpoint(&c, false, &["api", "v2", "local-danmu", "list"])
                .unwrap()
                .as_str(),
            "https://api.example/reader/api/v2/local-danmu/list"
        );
        assert!(!serde_json::to_string(&status(Some(&c)))
            .unwrap()
            .contains("reader"));
    }
    let c = normalize(input("http://127.0.0.1:9321/proxy/reader/api/v2"), None).unwrap();
    assert_eq!(c.base_url, "http://127.0.0.1:9321/proxy");
    assert!(normalize(input("https://u:password@api.example/reader"), None).is_err());
    assert!(normalize(input("https://api.example/reader?token=secret"), None).is_err());
    assert!(normalize(input("https://api.example/a%2Fb/api/v2"), None).is_err());
    assert!(normalize(input("https://api.example/api/v2"), None).is_err());
    assert!(!status(None).configured);
}
#[test]
fn changing_endpoint_or_reader_does_not_reuse_admin_credentials() {
    let old = Connection {
        base_url: "https://api.example".into(),
        read_token: "reader".into(),
        admin_token: "admin-secret".into(),
    };
    assert!(normalize(input("https://other.example/reader"), Some(&old))
        .unwrap()
        .admin_token
        .is_empty());
    assert!(normalize(input("https://api.example/next"), Some(&old))
        .unwrap()
        .admin_token
        .is_empty());
    assert_eq!(
        normalize(input(""), Some(&old)).unwrap().admin_token,
        "admin-secret"
    );
    assert_eq!(
        normalize(input("https://api.example/reader"), Some(&old))
            .unwrap()
            .admin_token,
        "admin-secret"
    );
}
#[test]
fn compatible_payload_preserves_text_entities_color_and_explicit_precision() {
    let prepared =
        prepare("<i><d p=\"1.006,5,25,16711680,0,0,u,1\"> 001 &amp; true </d></i>").unwrap();
    assert_eq!(
        prepared.comments[0],
        json!({"p":"1.01,5,16711680","m":"001 & true"})
    );
    assert_eq!(prepared.trimmed, 1);
    verify_comments(
        &json!({"comments":[{"cid":1,"p":"1.010,5,16711680,user","m":"001 & true"}]}),
        &prepared.comments,
    )
    .unwrap();
    assert!(verify_comments(&json!({"comments":[]}), &prepared.comments).is_err());
    assert!(prepare("<i><d p=\"1,1,25,0,0,0,u,1\">black</d></i>").is_err());
    assert!(prepare("<i><d p=\"1,1,25,1,0,0,u,1\">&lt;b&gt;text&lt;/b&gt;</d></i>").is_err());
}
#[test]
fn resource_keys_match_logvar_season_movie_and_normalization() {
    let mut meta = Metadata {
        title: " Ｄｅｍｏ:  Movie ".into(),
        year: 2025,
        kind: "tv".into(),
        season: 2,
        episode: Some(3),
    };
    assert_eq!(resource_key(&meta).unwrap(), "demo movie|2025|tv|s2|3");
    meta.kind = "movie".into();
    meta.season = 1;
    meta.episode = None;
    assert_eq!(resource_key(&meta).unwrap(), "demo movie|2025|movie|all");
}

#[tokio::test]
#[ignore = "requires an explicitly provided disposable LogVar server; never uses the saved connection"]
async fn logvar_live_roundtrip_and_stale_guard() {
    let address = std::env::var("STUDIO_TEST_LOGVAR_URL").expect("disposable server URL required");
    assert!(address.starts_with("http://127.0.0.1:"));
    let mut request = input(&address);
    request.admin_token = std::env::var("STUDIO_TEST_LOGVAR_ADMIN").expect("test admin token");
    let c = normalize(request, None).unwrap();
    let mut denied = c.clone();
    denied.read_token = "incorrect-reader".into();
    denied.admin_token.clear();
    assert!(resources(&denied).await.err().unwrap().contains("TOKEN"));
    let meta = Metadata {
        title: format!("Studio synthetic {}", std::process::id()),
        year: 2025,
        kind: "tv".into(),
        season: 2,
        episode: Some(3),
    };
    let xml = "<i><d p=\"1.006,5,25,16711680,0,0,u,1\">001 &amp; true</d></i>";
    let preview = preview_with(&c, xml, &meta).await.unwrap();
    let mut reader_only = c.clone();
    reader_only.admin_token.clear();
    let reader_preview = preview_with(&reader_only, xml, &meta).await.unwrap();
    let denied_upload = upload_with(
        &reader_only,
        UploadRequest {
            xml: xml.into(),
            metadata: meta.clone(),
            preview: reader_preview,
        },
    )
    .await;
    assert!(denied_upload.unwrap_err().contains("ADMIN_TOKEN"));
    let result = upload_with(
        &c,
        UploadRequest {
            xml: xml.into(),
            metadata: meta.clone(),
            preview: preview.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(result["verifiedCount"], 1);
    assert!(upload_with(
        &c,
        UploadRequest {
            xml: xml.into(),
            metadata: meta.clone(),
            preview
        }
    )
    .await
    .is_err());
    let next = preview_with(&c, xml, &meta).await.unwrap();
    upload_with(
        &c,
        UploadRequest {
            xml: xml.into(),
            metadata: meta,
            preview: next,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn redirects_are_rejected_and_decoded_response_is_bounded_without_leaking_tokens() {
    use std::io::{Read, Write};
    for (reply, limit, expected) in [
        ("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n".to_string(), 64, "跳转"),
        (format!("HTTP/1.1 200 OK\r\nContent-Length: 256\r\nConnection: close\r\n\r\n{}", "x".repeat(256)), 64, "安全上限"),
    ] {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move || {let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();let mut bytes=[0;4096];socket.read(&mut bytes).unwrap();socket.write_all(reply.as_bytes()).unwrap();});
        let error=response(client().unwrap().get(format!("http://{address}/private-reader/api/v2/local-danmu/list")),limit).await.unwrap_err();
        assert!(error.contains(expected));assert!(!error.contains("private-reader"));server.join().unwrap();
    }
}

#[test]
fn too_many_comments_fail_instead_of_silently_truncating() {
    let xml = format!(
        "<i>{}</i>",
        "<d p=\"1,1,25,16777215,0,0,u,1\">x</d>".repeat(MAX_COMMENTS + 1)
    );
    assert!(prepare(&xml).err().unwrap().contains("200000"));
}
