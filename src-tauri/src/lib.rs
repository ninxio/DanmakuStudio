use reqwest::{
    header::{HeaderName, HeaderValue},
    Method, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;

mod alignment_experiment_queue;
mod alignment_v2;
mod app_settings;
mod audio_alignment;
mod bilibili;
mod c137_process_attestation;
mod coarse_fingerprint;
mod credential_protection;
pub mod cuda_fft_backend;
mod diagnostic_log;
mod emby_audio;
mod emby_transport;
mod local_media_path;
mod export_files;
pub mod fine_frontier;
mod libmpv_player;
mod manual_verification;
mod media_inventory;
mod media_probe;
mod media_tool_detection;
mod media_toolchain;
mod media_tools;
mod mpv_sidecar;
mod physical_file;
mod process_supervision;
mod project_library;
mod project_library_commands;
mod project_files;
mod private_library;
mod motrix;
mod source_browser;
mod storage;
mod xml_import_receipt;
mod webdav;

/// Runs the exact production audio-alignment implementation without creating a Tauri window.
///
/// This narrow JSON boundary is used by the development-only synthetic regression CLI. It keeps
/// the production algorithm, request validation, tool pinning, persistent caches, and process
/// supervision identical to the desktop path while avoiding a second alignment implementation.
pub fn run_headless_audio_alignment_json(request_json: &str) -> Result<String, String> {
    audio_alignment::run_headless_audio_alignment_json(request_json)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let storage = storage::StorageRuntime::initialize(app.handle()).map_err(std::io::Error::other)?;
            let runtime = match storage.paths() {
                Ok(paths) => project_library::ProjectLibraryRuntime::open(paths.database.clone()),
                Err(_) => project_library::ProjectLibraryRuntime::storage_unavailable(),
            };
            app.manage(storage);
            app.manage(runtime);
            app.manage(webdav::WebDavRuntime::default());
            Ok(())
        })
        .invoke_handler({let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            ping,
            webdav::get_webdav_workspace,
            webdav::save_webdav_connection,
            webdav::remove_webdav_connection,
            webdav::list_webdav_entries,
            webdav::inspect_webdav_entry,
            webdav::start_webdav_audio_job,
            webdav::cancel_webdav_audio_job,
            webdav::remove_webdav_job,
            webdav::import_webdav_audio_job,
            webdav::prepare_webdav_source_job,
            webdav::inspect_webdav_source_job,
            storage::get_storage_status,
            storage::get_host_environment,
            export_files::edited::save_edited_xml_export,
            project_files::get_project_storage_location,
            project_files::save_portable_project,
            bilibili::inspect_bilibili_video,
            bilibili::check_bilibili_login,
            bilibili::download_bilibili_package,
            bilibili::cancel_bilibili_download,
            bilibili::auth::bilibili_auth_start_qr,
            bilibili::auth::bilibili_auth_poll_qr,
            bilibili::auth::bilibili_auth_cancel_qr,
            bilibili::auth::bilibili_auth_status,
            bilibili::auth::bilibili_auth_logout,
            alignment_experiment_queue::load_alignment_experiment_queue_file,
            alignment_experiment_queue::save_alignment_experiment_queue_file,
            alignment_experiment_queue::clear_alignment_experiment_queue_file,
            alignment_experiment_queue::load_synthetic_alignment_lab_queue_file,
            alignment_experiment_queue::save_synthetic_alignment_lab_queue_file,
            alignment_experiment_queue::clear_synthetic_alignment_lab_queue_file,
            alignment_experiment_queue::load_synthetic_alignment_lab_baseline_file,
            alignment_experiment_queue::save_synthetic_alignment_lab_baseline_file,
            alignment_experiment_queue::clear_synthetic_alignment_lab_baseline_file,
            alignment_experiment_queue::load_synthetic_alignment_report_archive_file,
            alignment_experiment_queue::save_synthetic_alignment_report_archive_file,
            alignment_experiment_queue::clear_synthetic_alignment_report_archive_file,
            alignment_experiment_queue::load_multimodal_rule_snapshot_archive_file,
            alignment_experiment_queue::save_multimodal_rule_snapshot_archive_file,
            alignment_experiment_queue::clear_multimodal_rule_snapshot_archive_file,
            alignment_experiment_queue::load_multimodal_blind_review_draft_archive_file,
            alignment_experiment_queue::save_multimodal_blind_review_draft_archive_file,
            alignment_experiment_queue::clear_multimodal_blind_review_draft_archive_file,
            app_settings::load_app_settings_file,
            app_settings::save_app_settings_file,
            app_settings::clear_app_settings_file,
            private_library::library::browse_private_library,
            private_library::catalog::private_library_catalog,
            private_library::library::read_private_library_files,
            private_library::library::review_private_library_episode,
            private_library::get_private_library_status,
            private_library::configure_private_library,
            private_library::test_private_library,
            private_library::clear_private_library,
            private_library::get_private_library_player_url,
            private_library::publish_private_library_xml,
            private_library::prepare_private_library_publication,
            private_library::outbox::save_publication_delivery,
            private_library::outbox::list_publication_deliveries,
            private_library::outbox::load_publication_delivery,
            private_library::outbox::save_publication_draft,
            private_library::management::get_private_library_metadata,
            private_library::management::list_private_library_catalog,
            private_library::management::list_private_library_revisions,
            private_library::management::rollback_private_library_episode,
            motrix::get_motrix_workspace,
            motrix::add_motrix_download,
            motrix::repair_motrix_download,
            motrix::refresh_motrix_downloads,
            motrix::get_motrix_completed_files,
            motrix::fetch_original_source_page,
            motrix::open_original_source_page,
            source_browser::open_original_source_browser,
            export_files::save_text_report_file,
            export_files::save_verified_projected_xml_export,
            export_files::open_export_directory,
            xml_import_receipt::import_bilibili_xml_files,
            emby_http_request,
            emby_audio::download_emby_audio,
            emby_audio::cancel_emby_audio_download,
            emby_audio::get_emby_audio_cache_status,
            emby_audio::clear_emby_audio_cache,
            audio_alignment::align_audio_files,
            audio_alignment::start_audio_alignment_job,
            audio_alignment::get_audio_alignment_job,
            audio_alignment::cancel_audio_alignment_job,
            audio_alignment::start_audio_alignment_batch_job,
            audio_alignment::get_audio_alignment_batch_job,
            audio_alignment::cancel_audio_alignment_batch_job,
            audio_alignment::build_alignment_sensitive_blind_review_pack,
            audio_alignment::get_alignment_feature_cache_status,
            audio_alignment::clear_alignment_feature_caches,
            diagnostic_log::open_alignment_diagnostic_log_directory,
            diagnostic_log::open_alignment_sensitive_manifest_directory,
            diagnostic_log::list_alignment_sensitive_manifest_summaries,
            audio_alignment::begin_alignment_benchmark_session,
            audio_alignment::get_active_alignment_benchmark_session,
            audio_alignment::reset_alignment_benchmark_caches,
            audio_alignment::start_alignment_benchmark_job,
            audio_alignment::get_alignment_benchmark_job,
            audio_alignment::cancel_alignment_benchmark_job,
            audio_alignment::finish_alignment_benchmark_session,
            audio_alignment::seal_c137_blind_batch_receipt,
            audio_alignment::seal_c137_performance_raw_evidence,
            c137_process_attestation::begin_c137_process_attestation,
            c137_process_attestation::finalize_c137_process_attestation,
            cuda_fft_backend::probe_cuda_fft_capability,
            media_inventory::start_media_inventory_job,
            media_inventory::get_media_inventory_job,
            media_inventory::cancel_media_inventory_job,
            project_library_commands::query_project_library,
            project_library_commands::open_project_library_session,
            project_library_commands::commit_project_library_session,
            media_probe::probe_media_timeline,
            media_probe::probe_media_identity,
            manual_verification::issue_manual_time_map_verification,
            manual_verification::verify_manual_time_map_verification,
            manual_verification::revoke_manual_time_map_verification,
            libmpv_player::detect_libmpv_runtime,
            libmpv_player::set_libmpv_danmaku_track,
            libmpv_player::create_libmpv_session,
            libmpv_player::control_libmpv_session,
            libmpv_player::get_libmpv_session_status,
            libmpv_player::set_libmpv_session_bounds,
            libmpv_player::destroy_libmpv_session,
            media_tools::detect_media_tool,
            media_tools::start_mpv_sidecar,
            media_tools::stop_mpv_sidecar,
            media_tools::get_mpv_sidecar_status,
            media_tools::control_mpv_sidecar,
            exit_app
        ]; move |invoke| {
            if invoke.message.webview_ref().label() != "main" {
                invoke.resolver.reject("Source browser has no Studio command access");
                true
            } else { handler(invoke) }
        }})
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[cfg(test)]
mod headless_alignment_tests {
    use super::run_headless_audio_alignment_json;

    #[test]
    fn headless_alignment_rejects_invalid_json_before_touching_media() {
        let error = run_headless_audio_alignment_json("{").unwrap_err();
        assert!(error.contains("请求 JSON 无效"));
    }

    #[test]
    fn headless_alignment_rejects_unknown_request_fields() {
        let error = run_headless_audio_alignment_json(
            r#"{"completePath":"missing-target","sourcePath":"missing-source","ffmpegPath":null,"unexpected":true}"#,
        )
        .unwrap_err();
        assert!(error.contains("unknown field `unexpected`"));
    }
}

#[derive(Debug, Deserialize)]
struct EmbyHttpHeader {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct EmbyHttpRequest {
    url: String,
    method: String,
    headers: Vec<EmbyHttpHeader>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct EmbyHttpResponse {
    status: u16,
    body: Value,
}

#[tauri::command]
async fn emby_http_request(request: EmbyHttpRequest) -> Result<EmbyHttpResponse, String> {
    let url = parse_emby_url(&request.url)?;
    let method = parse_emby_method(&request.method)?;
    let client = emby_transport::client(Duration::from_secs(30))
        .map_err(|error| format!("Emby 桌面代理初始化失败：{error}"))?;
    let mut builder = client.request(method, url);

    for header in &request.headers {
        builder = append_allowed_header(builder, header)?;
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("Emby 桌面代理请求失败：{error}"))?;
    let status = response.status().as_u16();
    let text = emby_transport::read_text(response, 8 * 1024 * 1024).await?;

    Ok(EmbyHttpResponse {
        status,
        body: parse_json_response_body(&text),
    })
}

fn parse_emby_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("Emby URL 格式无效：{error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("Emby 桌面代理只允许 http 或 https 地址。".to_string()),
    }
}

fn parse_emby_method(raw: &str) -> Result<Method, String> {
    match raw.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        _ => Err("Emby 桌面代理仅支持 GET 和 POST 请求。".to_string()),
    }
}

fn append_allowed_header(
    builder: reqwest::RequestBuilder,
    header: &EmbyHttpHeader,
) -> Result<reqwest::RequestBuilder, String> {
    if !is_allowed_emby_proxy_header(&header.name) {
        return Err(format!("Emby 桌面代理不允许转发请求头：{}", header.name));
    }
    let name = HeaderName::from_bytes(header.name.as_bytes())
        .map_err(|error| format!("Emby 请求头名称无效：{error}"))?;
    let value = HeaderValue::from_str(&header.value)
        .map_err(|error| format!("Emby 请求头内容无效：{error}"))?;
    Ok(builder.header(name, value))
}

fn is_allowed_emby_proxy_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "x-emby-authorization" | "x-emby-token"
    )
}

fn parse_json_response_body(text: &str) -> Value {
    if text.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(text)
        .unwrap_or_else(|_| json!({ "Message": truncate_response_text(text) }))
}

fn truncate_response_text(text: &str) -> String {
    const MAX_CHARS: usize = 400;
    let mut truncated: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        truncated.push_str("...");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emby_proxy_accepts_only_http_urls() {
        assert!(parse_emby_url("https://example.test/emby").is_ok());
        assert!(parse_emby_url("http://127.0.0.1:8096").is_ok());
        assert!(parse_emby_url("file:///tmp/emby").is_err());
    }

    #[test]
    fn emby_proxy_limits_methods_and_headers() {
        assert_eq!(parse_emby_method("post").unwrap(), Method::POST);
        assert!(parse_emby_method("DELETE").is_err());
        assert!(is_allowed_emby_proxy_header("X-Emby-Token"));
        assert!(!is_allowed_emby_proxy_header("Cookie"));
    }

    #[test]
    fn emby_proxy_keeps_non_json_errors_readable() {
        let body = parse_json_response_body("<html>not json</html>");
        assert_eq!(body["Message"], "<html>not json</html>");
    }
}
