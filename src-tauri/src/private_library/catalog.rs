//! Fixed publisher API routes; TMDB credentials never enter the desktop renderer.
use super::*;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum CatalogRequest {
    Search { kind: String, query: String },
    Work { kind: String, id: u32 },
    Profile { #[serde(rename = "workKey")] work_key: String },
    Plan { data: Value },
    Save { data: Value },
}
fn route(request: CatalogRequest) -> Result<(String, Option<Value>), String> {
    let valid_kind = |kind: &str| matches!(kind, "tv" | "movie");
    match request {
        CatalogRequest::Search { kind, query } => {
            if !valid_kind(&kind) || !(2..=100).contains(&query.encode_utf16().count()) {
                return Err("请选择影视类型并输入 2–100 字符的片名。".into());
            }
            let mut url = Url::parse("https://catalog.invalid/admin/v1/tmdb/search").unwrap();
            url.query_pairs_mut().append_pair("kind", &kind).append_pair("q", &query);
            Ok((format!("{}?{}", url.path(), url.query().unwrap()), None))
        }
        CatalogRequest::Work { kind, id } => {
            if !valid_kind(&kind) || id == 0 || id > 999_999_999 { return Err("影视身份无效。".into()); }
            Ok((format!("/admin/v1/tmdb/{kind}/{id}"), None))
        }
        CatalogRequest::Profile { work_key } => {
            if work_key.is_empty() || work_key.len()>80 || !work_key.bytes().all(|b|b.is_ascii_alphanumeric() || b"_-".contains(&b)) {
                return Err("影视身份无效。".into());
            }
            Ok((format!("/admin/v1/catalog-profiles/{work_key}"), None))
        }
        CatalogRequest::Plan { data } | CatalogRequest::Save { data } if data.to_string().len()>4096 => Err("影视资料请求过大。".into()),
        CatalogRequest::Plan { data } => Ok(("/admin/v1/catalog-profiles/plan".into(), Some(data))),
        CatalogRequest::Save { data } => Ok(("/admin/v1/catalog-profiles/save".into(), Some(data))),
    }
}
#[tauri::command]
pub async fn private_library_catalog(app: AppHandle, request: CatalogRequest) -> Result<Value,String> {
    let (path,body)=route(request)?;
    let c=connection(&app)?;
    let url=format!("{}{path}",c.base_url);
    let builder=if let Some(body)=body { client()?.post(url).json(&body) } else { client()?.get(url) };
    let response=builder.bearer_auth(&c.publish_token).send().await.map_err(|_|"无法连接影视资料服务，请检查私人库连接。")?;
    let status=response.status();
    let retry=response.headers().get("Retry-After").and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u32>().ok());
    let mut bytes=Vec::new();let mut stream=response.bytes_stream();
    while let Some(chunk)=stream.next().await {
        let chunk=chunk.map_err(|_|"影视资料读取中断，请重试。")?;
        if bytes.len()+chunk.len()>512*1024 {return Err("影视资料响应过大。".into());}
        bytes.extend_from_slice(&chunk);
    }
    let value:Value=serde_json::from_slice(&bytes).map_err(|_|"影视资料服务返回无效数据，请更新服务端。")?;
    if !status.is_success() {
        let message=value["errorMessage"].as_str().filter(|v|v.len()<1200).unwrap_or("影视资料请求失败，请刷新重试。");
        return Err(if let Some(seconds)=retry {format!("{message}（约 {seconds} 秒后可重试）")}else{message.to_owned()});
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_routes_cannot_escape_the_private_api() {
        assert!(route(CatalogRequest::Work{kind:"../other".into(),id:42}).is_err());
        assert!(route(CatalogRequest::Profile{work_key:"../status".into()}).is_err());
        let (path,body)=route(CatalogRequest::Search{kind:"tv".into(),query:"万神殿 & q=other".into()}).unwrap();
        assert!(path.starts_with("/admin/v1/tmdb/search?kind=tv&q="));
        assert!(path.contains("%26"));
        assert!(body.is_none());
        assert!(route(CatalogRequest::Save{data:json!({"note":"a".repeat(5000)})}).is_err());
    }
}
