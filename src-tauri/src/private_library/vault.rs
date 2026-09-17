use super::Connection;
use crate::credential_protection::protect;
use std::{fs, path::Path};

pub(super) fn save(path: &Path, connection: &Connection) -> Result<(), String> {
    let bytes = serde_json::to_vec(connection).map_err(|_| "连接信息无法序列化。")?;
    let encrypted = protect(&bytes, false)?;
    fs::create_dir_all(path.parent().ok_or("连接目录无效。")?)
        .map_err(|_| "无法创建私人库设置目录。")?;
    crate::project_files::atomic_write(path, &encrypted)
}
pub(super) fn load(path: &Path) -> Result<Option<Connection>, String> {
    let bytes = match fs::read(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取私人库连接。".into()),
    };
    if bytes.len() > 16 * 1024 {
        return Err("私人库连接文件损坏。".into());
    }
    let decrypted = protect(&bytes, true)?;
    serde_json::from_slice(&decrypted)
        .map(Some)
        .map_err(|_| "私人库连接文件损坏。".into())
}
