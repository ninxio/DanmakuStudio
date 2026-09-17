pub mod library;
pub mod catalog;
pub mod management;
pub mod outbox;
mod vault;
#[cfg(test)]
mod publish_tests;

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

const MAX_OBJECT_BYTES: usize = 64 * 1024 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    base_url: String,
    publish_token: String,
    #[serde(default)]
    read_token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    configured: bool,
    base_url: String,
    has_read_token: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationMetadata {
    work_key: String,
    edition_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_label: Option<String>,
    #[serde(
        default,
        deserialize_with = "explicit_version",
        skip_serializing_if = "Option::is_none"
    )]
    expected_metadata_version: Option<Value>,
    title: String,
    aliases: Vec<String>,
    year: Option<u16>,
    kind: String,
    edition: String,
    season: u16,
    episode: u16,
    label: String,
    duration_ms: Option<u64>,
    file_names: Vec<String>,
    allow_auto_match: bool,
}
fn explicit_version<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if !value.is_null() && !value.as_u64().is_some_and(|v| v > 0) {
        return Err(serde::de::Error::custom("作品版本无效。"));
    }
    Ok(Some(value))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    xml: String,
    metadata: PublicationMetadata,
    baseline: PublicationBaseline,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationBaseline {
    expected_revision: Value,
    connection_scope: String,
    identity: String,
}
fn publication_identity(meta: &PublicationMetadata) -> String {
    hash(
        serde_json::to_string(&(
            meta.source_key.as_deref().unwrap_or("legacy"),
            &meta.work_key,
            &meta.edition_key,
            meta.season,
            meta.episode,
        ))
        .unwrap_or_default()
        .as_bytes(),
    )
}
#[tauri::command]
pub async fn prepare_private_library_publication(
    app: AppHandle,
    metadata: PublicationMetadata,
) -> Result<PublicationBaseline, String> {
    prepare_with_connection(&connection(&app)?, &metadata).await
}
async fn prepare_with_connection(
    c: &Connection,
    meta: &PublicationMetadata,
) -> Result<PublicationBaseline, String> {
    let current = request_json(
        client()?
            .get(format!("{}/admin/v1/episodes", c.base_url))
            .bearer_auth(&c.publish_token)
            .query(&[
                ("workKey", meta.work_key.clone()),
                ("editionKey", meta.edition_key.clone()),
                (
                    "sourceKey",
                    meta.source_key.clone().unwrap_or_else(|| "legacy".into()),
                ),
                ("season", meta.season.to_string()),
                ("episode", meta.episode.to_string()),
            ]),
    )
    .await?;
    Ok(PublicationBaseline {
        expected_revision: current["current"]["revision"].clone(),
        connection_scope: c.base_url.clone(),
        identity: publication_identity(meta),
    })
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationResult {
    episode_id: u64,
    anime_id: u64,
    revision: String,
    comment_count: usize,
    metadata_version: Option<u64>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法定位应用数据目录。")?
        .join("private-library")
        .join("connection.dpapi"))
}
fn connection(app: &AppHandle) -> Result<Connection, String> {
    vault::load(&config_path(app)?)?.ok_or("请先在设置中连接私人弹幕库。".into())
}
fn status(value: Option<&Connection>) -> ConnectionStatus {
    ConnectionStatus {
        configured: value.is_some(),
        base_url: value.map(|v| v.base_url.clone()).unwrap_or_default(),
        has_read_token: value.is_some_and(|v| !v.read_token.is_empty()),
    }
}
fn normalize_url(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "私人 API 地址无效。")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (!matches!(url.scheme(), "https") && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "请填写 HTTPS 服务根地址，不带凭据、路径或查询参数；本机开发可用 HTTP。".into(),
        );
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}
fn validate_token(token: &str) -> Result<(), String> {
    if !(32..=256).contains(&token.len())
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("凭据应为 32–256 位字母、数字、短横线或下划线。".into());
    }
    Ok(())
}
fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "无法初始化私人库连接。".into())
}
async fn body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "私人库请求失败（HTTP {}）；请检查连接或重新发布。",
            response.status().as_u16()
        ));
    }
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "私人库连接中断；可以重试。")?;
        if output.len() + chunk.len() > limit {
            return Err("私人库响应超过允许大小。".into());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}
async fn request_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接私人库；请检查服务地址和网络。")?;
    serde_json::from_slice(&body(response, 4 * 1024 * 1024).await?)
        .map_err(|_| "私人库返回了无效数据。".into())
}
async fn verify_connection(c: &Connection) -> Result<Value, String> {
    let result = request_json(
        client()?
            .get(format!("{}/admin/v1/status", c.base_url))
            .bearer_auth(&c.publish_token),
    )
    .await?;
    if result["success"] != true || result["schemaVersion"] != 1 {
        return Err("服务不是兼容的私人弹幕库。".into());
    }
    if !c.read_token.is_empty() {
        let reader = request_json(client()?.get(format!(
            "{}/r/{}/api/v2/search/anime",
            c.base_url, c.read_token
        )))
        .await?;
        if reader["success"] != true {
            return Err("播放器读取凭据无效。".into());
        }
    }
    Ok(result)
}
#[tauri::command]
pub fn get_private_library_status(app: AppHandle) -> Result<ConnectionStatus, String> {
    let c = vault::load(&config_path(&app)?)?;
    Ok(status(c.as_ref()))
}
#[tauri::command]
pub async fn configure_private_library(
    app: AppHandle,
    mut request: Connection,
) -> Result<ConnectionStatus, String> {
    request.base_url = normalize_url(&request.base_url)?;
    if let Some(old) = vault::load(&config_path(&app)?)? {
        if old.base_url == request.base_url {
            if request.publish_token.is_empty() {
                request.publish_token = old.publish_token;
            }
            if request.read_token.is_empty() {
                request.read_token = old.read_token;
            }
        }
    }
    validate_token(&request.publish_token)?;
    if !request.read_token.is_empty() {
        validate_token(&request.read_token)?;
    }
    if request.read_token == request.publish_token {
        return Err("读取与发布必须使用不同凭据。".into());
    }
    verify_connection(&request).await?;
    vault::save(&config_path(&app)?, &request)?;
    Ok(status(Some(&request)))
}
#[tauri::command]
pub async fn test_private_library(app: AppHandle) -> Result<Value, String> {
    verify_connection(&connection(&app)?).await
}
#[tauri::command]
pub fn clear_private_library(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(config_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("未能清除连接。".into()),
    }
}
#[tauri::command]
pub fn get_private_library_player_url(app: AppHandle) -> Result<String, String> {
    let c = connection(&app)?;
    if c.read_token.is_empty() {
        return Err("请先保存播放器读取凭据。".into());
    }
    Ok(format!("{}/r/{}", c.base_url, c.read_token))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn compress_comments(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    gzip.write_all(bytes).map_err(|_| "无法压缩播放器数据。")?;
    gzip.finish().map_err(|_| "无法完成播放器数据压缩。".into())
}
fn compile(xml: &str) -> Result<(Vec<u8>, usize), String> {
    if xml.len() > MAX_OBJECT_BYTES {
        return Err("XML 超过 64 MiB。".into());
    }
    let items = crate::xml_import_receipt::parse_publication_items(xml.as_bytes())?;
    let mut comments = Vec::with_capacity(items.len());
    for item in items {
        let mode = match item.mode {
            Some(1..=3) => 1,
            Some(4) => 4,
            Some(5) => 5,
            Some(6) => 6,
            _ => {
                return Err(format!(
                    "第 {} 条属于不支持的高级弹幕，请在 Studio 处理后重新导出。",
                    item.original_index + 1
                ))
            }
        };
        let color = item
            .color
            .filter(|v| (0..=0xffffff).contains(v))
            .ok_or("XML 的弹幕颜色无效。")?;
        let time = if item.source_time_ms % 1000 == 0 {
            (item.source_time_ms / 1000).to_string()
        } else {
            format!(
                "{}.{:03}",
                item.source_time_ms / 1000,
                item.source_time_ms % 1000
            )
            .trim_end_matches('0')
            .to_string()
        };
        comments.push(json!({"cid":comments.len()+1,"p":format!("{time},{mode},{color},{}",item.user_hash.unwrap_or_default()),"m":item.text}));
    }
    let count = comments.len();
    let bytes = serde_json::to_vec(&json!({"count":count,"comments":comments}))
        .map_err(|_| "无法生成播放器弹幕。")?;
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err("播放器弹幕超过 64 MiB。".into());
    }
    Ok((bytes, count))
}
#[tauri::command]
pub async fn publish_private_library_xml(
    app: AppHandle,
    request: PublishRequest,
) -> Result<PublicationResult, String> {
    let c = connection(&app)?;
    publish_with_connection(&c, request).await
}
async fn publish_with_connection(
    c: &Connection,
    request: PublishRequest,
) -> Result<PublicationResult, String> {
    let base = normalize_url(&c.base_url)?;
    if request.baseline.connection_scope != base
        || request.baseline.identity != publication_identity(&request.metadata)
    {
        return Err("连接或分集身份已变化，请先核对并采用当前云端修订。".into());
    }
    let xml = request.xml;
    let (xml, comments, count) = tauri::async_runtime::spawn_blocking(move || {
        let (comments, count) = compile(&xml)?;
        Ok::<_, String>((xml, comments, count))
    })
    .await
    .map_err(|_| "成品准备任务中断。")??;
    let xml_hash = hash(xml.as_bytes());
    let comments_hash = hash(&comments);
    let http = client()?;
    let meta = request.metadata;
    let mut payload = serde_json::to_value(meta).map_err(|_| "发布信息无效。")?;
    let map = payload.as_object_mut().ok_or("发布信息无效。")?;
    map.insert("schemaVersion".into(), json!(1));
    map.insert("xmlHash".into(), json!(xml_hash));
    map.insert("commentsHash".into(), json!(comments_hash));
    map.insert("commentCount".into(), json!(count));
    map.insert(
        "expectedRevision".into(),
        request.baseline.expected_revision,
    );
    let plan = request_json(
        http.post(format!("{base}/admin/v1/publications/plan"))
            .bearer_auth(&c.publish_token)
            .header("X-Storage-Format", "json-gzip")
            .json(&payload),
    )
    .await?;
    if plan["action"] == "conflict" {
        return Err("云端版本已变化。请载入云端最新作品信息并核对后再发布；未覆盖云端。".into());
    }
    let missing = plan["missingObjects"]
        .as_array()
        .ok_or("私人库不支持增量发布计划。")?;
    if plan["storageFormat"] == "json-gzip" {
        if missing
            .iter()
            .any(|v| v["format"] == "json-gzip" && v["hash"] == comments_hash)
        {
            let raw_length = comments.len();
            let compressed =
                tauri::async_runtime::spawn_blocking(move || compress_comments(&comments))
                    .await
                    .map_err(|_| "压缩任务中断。")??;
            request_json(
                http.put(format!("{base}/admin/v1/storage/json/{comments_hash}"))
                    .bearer_auth(&c.publish_token)
                    .header("Content-Type", "application/gzip")
                    .header("X-Uncompressed-Length", raw_length)
                    .header("X-Gzip-SHA256", hash(&compressed))
                    .body(compressed),
            )
            .await?;
        }
    } else {
        return Err("私人库服务器必须支持 json-gzip；未上传 XML 或未压缩的弹幕。".into());
    }
    let result = request_json(
        http.post(format!("{base}/admin/v1/publications"))
            .bearer_auth(&c.publish_token)
            .header("X-Storage-Format", "json-gzip")
            .json(&payload),
    )
    .await?;
    let id = result["episodeId"].as_u64().ok_or("发布未返回分集 ID。")?;
    let revision = result["revision"]
        .as_str()
        .ok_or("发布未返回修订。")?
        .to_string();
    let check = request_json(
        http.get(format!("{base}/admin/v1/episodes/{id}"))
            .bearer_auth(&c.publish_token),
    )
    .await?;
    if check["revision"] != revision || check["manifest"]["xmlHash"] != xml_hash {
        return Err("云端清单回读不一致，请重试。".into());
    }
    let response = http
        .get(format!("{base}/admin/v1/episodes/{id}/json"))
        .bearer_auth(&c.publish_token)
        .send()
        .await
        .map_err(|_| "云端已提交，回读中断；重试会核验同一修订。")?;
    if hash(&body(response, MAX_OBJECT_BYTES).await?) != comments_hash {
        return Err("云端播放器数据回读校验失败。".into());
    }
    Ok(PublicationResult {
        episode_id: id,
        anime_id: result["animeId"].as_u64().ok_or("缺少作品 ID。")?,
        revision,
        comment_count: count,
        metadata_version: result["metadataVersion"].as_u64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gzip_preserves_the_complete_player_payload() {
        use std::io::Read;
        let (json, count) =
            compile("<i><d p=\"1.001,1,25,16711680,0,0,user,1\">中文 &amp; 原文</d></i>").unwrap();
        assert_eq!(count, 1);
        let compressed = compress_comments(&json).unwrap();
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, json);
        assert_eq!(hash(&decoded), hash(&json));
    }
    #[test]
    fn explicit_new_metadata_version_is_not_treated_as_a_legacy_omission() {
        let base = json!({"workKey":"w","editionKey":"e","title":"t","aliases":[],"year":null,
            "kind":"tv","edition":"v","season":1,"episode":1,"label":"1","durationMs":null,
            "fileNames":[],"allowAutoMatch":false});
        let legacy: PublicationMetadata = serde_json::from_value(base.clone()).unwrap();
        assert!(!serde_json::to_value(legacy)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("expectedMetadataVersion"));
        let mut next = base;
        next["expectedMetadataVersion"] = Value::Null;
        let explicit: PublicationMetadata = serde_json::from_value(next).unwrap();
        assert!(serde_json::to_value(explicit)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("expectedMetadataVersion"));
    }
    #[test]
    fn protects_connection_boundary() {
        assert!(normalize_url("https://private.example").is_ok());
        assert!(normalize_url("http://127.0.0.1:8787").is_ok());
        for value in [
            "http://remote.example",
            "https://u:p@host",
            "https://host/r/token",
            "https://host?token=a",
        ] {
            assert!(normalize_url(value).is_err());
        }
        assert!(validate_token("short").is_err());
        let c = Connection {
            base_url: "https://test.example".into(),
            publish_token: "secret".into(),
            read_token: "reader-secret".into(),
        };
        let encoded = serde_json::to_string(&status(Some(&c))).unwrap();
        assert!(!encoded.contains("secret"));
    }
    #[test]
    fn exact_time_color_and_entity_conversion() {
        let (bytes, count) =
            compile(r#"<i><d p="1.001,5,25,16711680,0,0,u,1">A &amp; B</d></i>"#).unwrap();
        assert_eq!(count, 1);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["comments"][0]["p"], "1.001,5,16711680,u");
        assert_eq!(value["comments"][0]["m"], "A & B");
        assert!(compile("<!DOCTYPE i><i/>").is_err());
        assert!(compile(r#"<i><d p="1,7,25,1,0,0,u,1">advanced</d></i>"#).is_err());
    }
    #[tokio::test]
    #[ignore = "requires an explicitly selected private connection and writes a synthetic test entry"]
    async fn live_private_publication_roundtrip() {
        let path = std::env::var_os("STUDIO_TEST_CONNECTION_PATH")
            .expect("explicit connection path required");
        let c = vault::load(std::path::Path::new(&path)).unwrap().unwrap();
        verify_connection(&c).await.unwrap();
        let metadata = PublicationMetadata {
            work_key: "studio-native-test".into(),
            edition_key: "synthetic-v1".into(),
            source_key: None,
            source_label: None,
            expected_metadata_version: None,
            title: "Studio 原生连接测试".into(),
            aliases: vec!["Studio Native Test".into()],
            year: None,
            kind: "movie".into(),
            edition: "合成测试，非影视收藏".into(),
            season: 0,
            episode: 1,
            label: "原生发布与回读".into(),
            duration_ms: None,
            file_names: vec![],
            allow_auto_match: false,
        };
        let baseline = prepare_with_connection(&c, &metadata).await.unwrap();
        let original_metadata = metadata.clone();
        let original_baseline = baseline.clone();
        let result = publish_with_connection(
            &c,
            PublishRequest {
                xml: r#"<i><d p="1.001,1,25,16711680,0,0,test,1">Studio 原生发布测试</d></i>"#
                    .into(),
                metadata,
                baseline,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.comment_count, 1);
        assert!(result.episode_id > 0);
        let original_xml =
            r#"<i><d p="1.001,1,25,16711680,0,0,test,1">Studio 原生发布测试</d></i>"#;
        let changed = format!("{original_xml}\n<!--native revision guard-->");
        let baseline = prepare_with_connection(&c, &original_metadata)
            .await
            .unwrap();
        publish_with_connection(
            &c,
            PublishRequest {
                xml: changed,
                metadata: original_metadata.clone(),
                baseline,
            },
        )
        .await
        .unwrap();
        let conflict = publish_with_connection(
            &c,
            PublishRequest {
                xml: original_xml.into(),
                metadata: original_metadata.clone(),
                baseline: original_baseline,
            },
        )
        .await;
        assert!(
            conflict.is_err(),
            "a stale batch must not overwrite newer episode content"
        );
        let baseline = prepare_with_connection(&c, &original_metadata)
            .await
            .unwrap();
        publish_with_connection(
            &c,
            PublishRequest {
                xml: original_xml.into(),
                metadata: original_metadata,
                baseline,
            },
        )
        .await
        .unwrap();
    }
}
