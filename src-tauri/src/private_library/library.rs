//! Explicit file selection and work-level browsing, sharing the existing outbox and publisher.
use super::*;
use std::{fs, io::Read, path::Path};

#[tauri::command]
pub async fn review_private_library_episode(app: AppHandle, episode_id: u64, revision: String, approved: bool) -> Result<Value,String> {
    if episode_id == 0 || revision.len()!=64 || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("分集或修订无效。".into());
    }
    let c=connection(&app)?;
    request_json(client()?.post(format!("{}/admin/v1/library/episodes/{episode_id}/review",c.base_url))
       .bearer_auth(&c.publish_token).json(&json!({"revision":revision,"approved":approved}))).await
}

#[tauri::command]
pub async fn browse_private_library(
    app: AppHandle,
    q: Option<String>,
    work_key: Option<String>,
) -> Result<Value, String> {
    let c = connection(&app)?;
    let q = q.unwrap_or_default();
    if q.encode_utf16().count() > 200 {
        return Err("片名最多 200 字符。".into());
    }
    let suffix = if let Some(key) = work_key {
        if key.is_empty()
            || key.len() > 80
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err("影视身份无效。".into());
        }
        format!("/{key}")
    } else {
        String::new()
    };
    request_json(
        client()?
            .get(format!("{}/admin/v1/library{}", c.base_url, suffix))
            .bearer_auth(&c.publish_token)
            .query(&[("q", q)]),
    )
    .await
}

fn collect(path: &Path, depth: usize, paths: &mut Vec<PathBuf>) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "所选路径不可读取，请检查 OneDrive 是否已下载文件。")?;
    if meta.file_type().is_symlink() {
        return Err("所选路径包含链接，请直接选择原文件所在目录。".into());
    }
    if meta.is_dir() {
        if depth >= 16 {
            return Err("文件夹层级超过 16，请选择具体剧集目录。".into());
        }
        for entry in fs::read_dir(path).map_err(|_| "无法读取文件夹。")? {
            collect(
                &entry.map_err(|_| "无法读取文件项。")?.path(),
                depth + 1,
                paths,
            )?;
        }
    } else if meta.is_file()
        && path
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("xml"))
    {
        if paths.len() >= 1000 {
            return Err("一次最多选择 1000 个 XML，请分批更新。".into());
        }
        paths.push(path.to_path_buf());
    }
    Ok(())
}
fn read_selected(paths: Vec<String>) -> Result<Value, String> {
    if paths.is_empty() || paths.len() > 1000 {
        return Err("请选择 XML 文件或文件夹。".into());
    }
    let mut selected = vec![];
    for path in &paths {
        if !Path::new(path).is_absolute() {
            return Err("请选择完整本地路径。".into());
        }
        collect(Path::new(path), 0, &mut selected)?;
    }
    selected.sort();
    selected.dedup();
    if selected.is_empty() {
        return Err("所选位置没有 XML 弹幕文件。".into());
    }
    let mut total = 0;
    let mut files = vec![];
    for path in selected {
        let mut bytes = vec![];
        fs::File::open(&path)
            .map_err(|_| "无法打开 XML。")?
            .take((MAX_OBJECT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "XML 读取失败，请确认 OneDrive 文件可离线使用。")?;
        total += bytes.len();
        if bytes.len() > MAX_OBJECT_BYTES || total > 256 * 1024 * 1024 {
            return Err("单文件最多 64 MiB、单批最多 256 MiB，请分批更新。".into());
        }
        let content =
            String::from_utf8(bytes).map_err(|_| "XML 需要 UTF-8 编码；原文件未修改。")?;
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        compile(&content).map_err(|e| format!("{name}：{e}"))?;
        files.push(json!({"fileName":name,"content":content}));
    }
    Ok(json!({"files":files}))
}
#[tauri::command]
pub async fn read_private_library_files(paths: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_selected(paths))
        .await
        .map_err(|_| "文件读取任务中断。")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_xml_bytes_stay_exact_and_invalid_batches_stop() {
        let dir = std::env::temp_dir().join(format!("library-input-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap();
        let xml = "<i><d p=\"1,1,25,16777215,0,0,user,1\">成品</d></i>";
        fs::write(dir.join("第2季第1集.xml"), xml).unwrap();
        fs::write(dir.join("note.txt"), "ignored").unwrap();
        let result = read_selected(vec![dir.to_string_lossy().into()]).unwrap();
        assert_eq!(result["files"].as_array().unwrap().len(), 1);
        assert_eq!(result["files"][0]["content"], xml);
        assert_eq!(fs::read_to_string(dir.join("第2季第1集.xml")).unwrap(), xml);
        fs::write(dir.join("bad.xml"), "<i>").unwrap();
        assert!(read_selected(vec![dir.to_string_lossy().into()]).is_err());
        assert!(read_selected(vec!["relative.xml".into()]).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
