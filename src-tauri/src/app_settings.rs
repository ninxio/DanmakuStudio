use serde_json::Value;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE_NAME: &str = "app-settings.json";
static SETTINGS_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub fn load_app_settings_file(app: AppHandle) -> Result<Option<String>, String> {
    let path = app_settings_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取桌面应用设置失败：{error}")),
    }
}

#[tauri::command]
pub fn save_app_settings_file(app: AppHandle, content: String) -> Result<(), String> {
    let _guard = SETTINGS_WRITE.lock().map_err(|_| "设置保存锁不可用。")?;
    validate_settings_content(&content)?;
    app.state::<crate::storage::StorageRuntime>()
        .validate_settings(&content)?;
    let path = app_settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建桌面应用设置目录失败：{error}"))?;
    }
    crate::project_files::atomic_write(&path, content.as_bytes())
}

#[tauri::command]
pub fn clear_app_settings_file(app: AppHandle) -> Result<(), String> {
    let _guard = SETTINGS_WRITE.lock().map_err(|_| "设置保存锁不可用。")?;
    let path = app_settings_path(&app)?;
    // Resetting preferences must never implicitly switch to an old/empty project library.
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => "{}".into(),
        Err(error) => return Err(error.to_string()),
    };
    let storage = crate::storage::settings_from_content(&content)?;
    let content = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"storage":storage}))
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(path.parent().ok_or("设置路径无效。")?).map_err(|e| e.to_string())?;
    crate::project_files::atomic_write(&path, &content)
}

fn app_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("定位桌面应用设置目录失败：{error}"))?;
    Ok(settings_path_in_config_dir(&config_dir))
}

fn settings_path_in_config_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE_NAME)
}

fn validate_settings_content(content: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("桌面应用设置不是有效 JSON：{error}"))?;
    if value.is_object() {
        Ok(())
    } else {
        Err("桌面应用设置必须是 JSON 对象。".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_path_uses_app_config_dir() {
        let path = settings_path_in_config_dir(Path::new("config-root"));

        assert_eq!(path, PathBuf::from("config-root").join(SETTINGS_FILE_NAME));
    }

    #[test]
    fn settings_content_must_be_json_object() {
        assert!(validate_settings_content(r#"{"emby":{},"alignment":{}}"#).is_ok());
        assert!(validate_settings_content("[]").is_err());
        assert!(validate_settings_content("not json").is_err());
    }
}
