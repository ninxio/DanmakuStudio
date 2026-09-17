use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    work_key: String,
    edition_key: String,
    source_key: Option<String>,
    season: u16,
    episode: u16,
}
#[tauri::command]
pub async fn get_private_library_metadata(
    app: AppHandle,
    identity: Identity,
) -> Result<Value, String> {
    let c = connection(&app)?;
    let result = request_json(
        client()?
            .get(format!("{}/admin/v1/episodes", c.base_url))
            .bearer_auth(&c.publish_token)
            .query(&[
                ("workKey", identity.work_key),
                ("editionKey", identity.edition_key),
                (
                    "sourceKey",
                    identity.source_key.unwrap_or_else(|| "legacy".into()),
                ),
                ("season", identity.season.to_string()),
                ("episode", identity.episode.to_string()),
            ]),
    )
    .await?;
    Ok(result["metadata"].clone())
}
#[tauri::command]
pub async fn list_private_library_catalog(
    app: AppHandle,
    after: Option<u64>,
    q: Option<String>,
) -> Result<Value, String> {
    let q = validate_catalog_query(q)?;
    let c = connection(&app)?;
    request_json(
        client()?
            .get(format!("{}/admin/v1/catalog", c.base_url))
            .bearer_auth(&c.publish_token)
            .query(&[("after", after.unwrap_or(0)), ("limit", 30)])
            .query(&[("q", q)]),
    )
    .await
}
fn validate_catalog_query(q: Option<String>) -> Result<String, String> {
    let q = q.unwrap_or_default();
    if q.encode_utf16().count() > 200 {
        return Err("作品或别名搜索最多 200 字符。".into());
    }
    Ok(q)
}
#[cfg(test)]
mod catalog_query_tests {
    use super::*;
    #[test]
    fn optional_search_matches_worker_utf16_bound() {
        assert_eq!(validate_catalog_query(None).unwrap(), "");
        assert!(validate_catalog_query(Some("剧".repeat(200))).is_ok());
        assert!(validate_catalog_query(Some("剧".repeat(201))).is_err());
        assert!(validate_catalog_query(Some("🎬".repeat(100))).is_ok());
        assert!(validate_catalog_query(Some("🎬".repeat(101))).is_err());
    }
}
#[tauri::command]
pub async fn list_private_library_revisions(
    app: AppHandle,
    episode_id: u64,
    before: Option<String>,
) -> Result<Value, String> {
    let c = connection(&app)?;
    let mut request = client()?
        .get(format!(
            "{}/admin/v1/episodes/{episode_id}/revisions",
            c.base_url
        ))
        .bearer_auth(&c.publish_token)
        .query(&[("limit", "20")]);
    if let Some(before) = before {
        request = request.query(&[("before", before)]);
    }
    request_json(request).await
}
#[tauri::command]
pub async fn rollback_private_library_episode(
    app: AppHandle,
    episode_id: u64,
    revision: String,
    expected_revision: String,
) -> Result<Value, String> {
    if [revision.as_str(), expected_revision.as_str()]
        .iter()
        .any(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("修订身份无效。".into());
    }
    let c = connection(&app)?;
    let http = client()?;
    let base = format!("{}/admin/v1/episodes/{episode_id}", c.base_url);
    request_json(
        http.post(format!("{base}/rollback"))
            .bearer_auth(&c.publish_token)
            .json(&json!({"revision":revision,"expectedRevision":expected_revision})),
    )
    .await?;
    let current = request_json(http.get(&base).bearer_auth(&c.publish_token)).await?;
    if current["revision"] != revision {
        return Err("回退后云端版本已变化，请刷新核对。".into());
    }
    let response = http
        .get(format!("{base}/xml"))
        .bearer_auth(&c.publish_token)
        .send()
        .await
        .map_err(|_| "回退已提交，XML 回读中断；请刷新核对。")?;
    if current["manifest"]["xmlHash"] != hash(&body(response, MAX_OBJECT_BYTES).await?) {
        return Err("回退成品校验未通过，请刷新核对。".into());
    }
    Ok(current)
}
