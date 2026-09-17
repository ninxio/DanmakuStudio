//! A separate, unprivileged website window. Handoffs fill Studio's form; never start downloads.
use reqwest::Url;
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Handoff {
    project_id: String,
    magnet: String,
    title: String,
}

fn handoff(url: &Url, nonce: &str, project_id: &str) -> Option<Handoff> {
    if url.scheme() != "studio-source"
        || url.host_str() != Some("handoff")
        || url.as_str().len() > 20000
    {
        return None;
    }
    let p: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if p.get("nonce").map(String::as_str) != Some(nonce) {
        return None;
    }
    let magnet = crate::motrix::magnet(p.get("magnet")?).ok()?.to_string();
    let title = p
        .get("title")
        .cloned()
        .unwrap_or_default()
        .chars()
        .take(400)
        .collect();
    Some(Handoff {
        project_id: project_id.into(),
        magnet,
        title,
    })
}

#[tauri::command]
pub async fn open_original_source_browser(
    app: tauri::AppHandle,
    project_id: String,
    url: String,
) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > 200 {
        return Err("项目身份无效。".into());
    }
    let url = crate::motrix::source_url(&url)?;
    // One window per originating project: later project switches cannot redirect a handoff.
    use sha2::{Digest, Sha256};
    let label = format!("source-{:x}", Sha256::digest(project_id.as_bytes()));
    if let Some(window) = app.get_webview_window(&label) {
        window.navigate(url).map_err(|_| "无法导航来源网页。")?;
        window.set_focus().map_err(|_| "无法显示来源窗口。")?;
        return Ok(());
    }
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| "无法创建来源会话。")?;
    let nonce = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let script =
        include_str!("source_browser_bridge.js").replace("__STUDIO_SOURCE_NONCE__", &nonce);
    let event_app = app.clone();
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法创建浏览器目录。")?
        .join("source-browser");
    std::fs::create_dir_all(&data).map_err(|_| "无法创建浏览器目录。")?;
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title("原片来源 · 选择磁力后送回 Studio")
        .inner_size(1100.0, 800.0)
        .data_directory(data)
        .initialization_script(script)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_navigation(move |url| {
            if let Some(value) = handoff(url, &nonce, &project_id) {
                if let Some(main) = event_app.get_webview_window("main") {
                    let _ = main.emit("original-source-magnet", value);
                    let _ = main.set_focus();
                }
                return false;
            }
            crate::motrix::source_url(url.as_str()).is_ok()
        })
        .build()
        .map_err(|_| "无法打开来源浏览器。可改用外部网页复制磁力。")?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handoff_requires_nonce_and_real_hash_and_keeps_originating_project() {
        let mut u = Url::parse("studio-source://handoff").unwrap();
        u.query_pairs_mut()
            .append_pair("nonce", "test")
            .append_pair("magnet", &format!("magnet:?xt=urn:btih:{}", "a".repeat(40)))
            .append_pair("title", "Movie");
        assert!(handoff(&u, "different", "p").is_none());
        assert_eq!(handoff(&u, "test", "origin").unwrap().project_id, "origin");
        u.query_pairs_mut()
            .clear()
            .append_pair("nonce", "test")
            .append_pair("magnet", "magnet:?xt=urn:btih:123");
        assert!(handoff(&u, "test", "p").is_none());
    }
}
