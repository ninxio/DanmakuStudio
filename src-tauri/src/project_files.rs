//! User-selected portable snapshots, independent of the autosave database protocol.
use serde::Serialize;
use std::{fs::{self, OpenOptions}, io::Write, path::Path};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStorageLocation { directory_path: String, database_path: String }

#[tauri::command]
pub fn get_project_storage_location(app: tauri::AppHandle) -> Result<ProjectStorageLocation, String> {
    let directory = crate::storage::paths(&app)?.projects;
    Ok(ProjectStorageLocation { database_path: directory.join("library.sqlite3").to_string_lossy().into_owned(), directory_path: directory.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn save_portable_project(app: tauri::AppHandle, file_name: String, content: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_content(&content)?;
        let safe_name: String = file_name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).take(220).collect();
        let selected = app.dialog().file().set_title("保存项目文件").add_filter("Danmaku 项目", &["json"]).set_file_name(if safe_name.is_empty() { "项目.danmaku-project.json" } else { &safe_name }).blocking_save_file();
        let Some(selected) = selected else { return Ok(None); };
        let mut path = selected.into_path().map_err(|e| format!("无法解析保存位置：{e}"))?;
        if path.extension().and_then(|s| s.to_str()).is_none_or(|s| !s.eq_ignore_ascii_case("json")) { path.set_extension("danmaku-project.json"); }
        atomic_write(&path, content.as_bytes())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|e| e.to_string())?
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > 256 * 1024 * 1024 { return Err("项目超过 256 MiB，请先减少项目库存。".into()); }
    let value: serde_json::Value = serde_json::from_str(content).map_err(|e| format!("项目 JSON 无效：{e}"))?;
    if !value["schemaVersion"].is_u64() || !value["id"].is_string() || !value["assets"].is_array() { return Err("不是有效的项目快照。".into()); }
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !path.is_absolute() { return Err("请选择完整的本机保存路径。".into()); }
    let parent = path.parent().ok_or("保存路径缺少文件夹。")?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let temp = parent.join(format!(".danmaku-project-{}-{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| format!("不能写入所选文件夹：{e}"))?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| format!("写入项目失败：{e}"))?;
        drop(file);
        replace(&temp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: Both buffers are NUL terminated and live for the duration of the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(format!("保存未完成，旧文件未被覆盖：{}", std::io::Error::last_os_error())); }
    Ok(())
}
#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> Result<(), String> { fs::rename(source, target).map_err(|e| format!("保存未完成：{e}")) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_project_and_writes_selected_snapshot() {
        assert!(validate_content("{}").is_err());
        let content = r#"{"schemaVersion":18,"id":"sample","assets":[]}"#;
        assert!(validate_content(content).is_ok());
        let directory = std::env::temp_dir().join(format!("danmaku-project-file-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("test.json");
        fs::write(&path, "old").unwrap();
        atomic_write(&path, content.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
