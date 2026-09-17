//! MDXP exposes metadata and payload as separate tasks, without a parent ID.
//! Join only a unique BT task with the same hash, destination and creation order.
use super::*;

pub(super) fn interoperable_path(value: &str) -> String {
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else if let Some(path) = value.strip_prefix(r"\\?\") {
        path.to_owned()
    } else {
        value.to_owned()
    }
}

fn comparable_path(value: &str) -> String {
    let path = interoperable_path(value).replace('\\', "/");
    #[cfg(windows)]
    let path = path.to_lowercase();
    path.trim_end_matches('/').to_owned()
}

pub(super) fn same_directory(a: &str, b: &str) -> bool {
    comparable_path(a) == comparable_path(b)
}

pub(super) fn safe_magnet(value: &str) -> Result<String, String> {
    let mut url = magnet(value)?;
    // Motrix beta.36 uses dn directly for its staging directory, including on Windows.
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| {
            let value = if key == "dn" {
                let name: String = value
                    .chars()
                    .map(|c| {
                        if c.is_control() || "<>:\"/\\|?*".contains(c) {
                            '-'
                        } else {
                            c
                        }
                    })
                    .take(96)
                    .collect();
                let name = name.trim_matches([' ', '.']);
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                if name.is_empty() {
                    "Studio-download".into()
                } else if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
                {
                    format!("_{name}")
                } else {
                    name.into()
                }
            } else {
                value.into_owned()
            };
            (key.into_owned(), value)
        })
        .collect();
    url.query_pairs_mut().clear().extend_pairs(pairs);
    Ok(url.into())
}

pub(super) fn prepare_directory(value: &str) -> Result<String, String> {
    if value.len() > 4096 || !Path::new(value).is_absolute() {
        return Err("请指定有效的绝对下载目录。".into());
    }
    std::fs::create_dir_all(value).map_err(|_| "无法创建下载目录，请换一个可写的位置。")?;
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| "下载目录不可用。")?;
    // Verify actual write access, without opening or replacing any existing file.
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "无法创建目录检查。")?;
    let probe = path.join(format!(
        ".studio-write-check-{:x}",
        u128::from_le_bytes(nonce)
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| "目录不可写，请检查磁盘和权限或选择其它位置。")?;
    drop(file);
    std::fs::remove_file(&probe).map_err(|_| "无法清理目录检查文件，请检查目录权限。")?;
    Ok(interoperable_path(&path.to_string_lossy()))
}

pub(super) fn payload<'a>(
    row: &Download,
    parent: &Value,
    tasks: &'a [Value],
) -> Result<Option<&'a Value>, String> {
    let hash = parent["infoHash"].as_str().filter(|v| !v.is_empty());
    let Some(hash) = hash else {
        return Ok(None);
    };
    let root = comparable_path(&row.save_dir);
    let created = parent["createdAt"].as_u64();
    let candidates: Vec<_> = tasks
        .iter()
        .filter(|task| {
            let directory = comparable_path(task["saveDir"].as_str().unwrap_or(""));
            task["type"] == "bt"
                && task["infoHash"]
                    .as_str()
                    .is_some_and(|h| h.eq_ignore_ascii_case(hash))
                && (directory == root || directory.starts_with(&format!("{root}/")))
                && created.is_none_or(|at| task["createdAt"].as_u64().is_some_and(|t| t >= at))
        })
        .collect();
    match candidates.as_slice() {
        [] => Ok(None),
        [task] => Ok(Some(*task)),
        _ => Err("发现多个相同磁力的原片任务，无法唯一关联；请在 Motrix 中确认后手动导入。".into()),
    }
}

pub(super) async fn task_list() -> Result<Vec<Value>, String> {
    let mut tasks = Vec::new();
    loop {
        let page = rpc("task/list", json!({"limit":100,"offset":tasks.len()})).await?;
        let entries = page["tasks"].as_array().ok_or("Motrix 缺少任务列表。")?;
        let total = page["total"].as_u64().ok_or("Motrix 缺少任务数量。")?;
        tasks.extend(entries.iter().cloned());
        if tasks.len() as u64 >= total {
            return Ok(tasks);
        }
        if tasks.len() >= 2000 || entries.is_empty() {
            return Err("Motrix 任务过多，无法完整核对磁力后续任务；请在 Motrix 中确认。".into());
        }
    }
}

pub(super) async fn refresh_row(row: &mut Download) -> Result<(), String> {
    let id = row.task_id.as_ref().ok_or("Motrix 尚未确认此任务。")?;
    let result = rpc("task/get", json!({"taskId":id})).await?;
    let task = &result["task"];
    if task.is_null() {
        row.status = "missing".into();
        row.files.clear();
        row.message = "任务已从 Motrix 移除，可重新创建下载；已有文件保留。".into();
        return Ok(());
    }
    if task["type"] == "magnet" {
        update_task(row, task)?;
        let tasks = task_list().await?;
        if let Some(child) = payload(row, task, &tasks)? {
            update_task(row, child)?;
        }
    } else {
        update_task(row, task)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "explicit actual MDXP metadata-to-BT transfer with local generated fixture"]
    async fn live_local_bt_transfer() {
        let path =
            std::env::var("STUDIO_BT_FIXTURE").expect("start scripts/motrix-bt-fixture.mjs first");
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let directory = prepare_directory(fixture["directory"].as_str().unwrap()).unwrap();
        assert!(!directory.starts_with(r"\\?\"));
        let uri = safe_magnet(fixture["uri"].as_str().unwrap()).unwrap();
        let torrent = super::super::metadata::resolve(
            uri.clone(),
            Path::new(&directory).parent().unwrap().join("metadata"),
        )
        .await
        .unwrap();
        let manifest = super::super::content_files::manifest(&torrent).unwrap();
        let metadata = rpc("download/add", json!({"kind":"torrent","base64":base64::engine::general_purpose::STANDARD.encode(torrent),"saveDir":directory,"idempotencyKey":format!("fixture-{}", fixture["infoHash"].as_str().unwrap())})).await.unwrap();
        assert_eq!(metadata["type"], "bt");
        let parent_id = metadata["id"].as_str().unwrap().to_owned();
        let mut record = row();
        record.save_dir = directory;
        record.uri = uri;
        record.content_files = manifest;
        update_task(&mut record, &metadata).unwrap();
        let mut verified = false;
        for _ in 0..90 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            refresh_row(&mut record).await.unwrap();
            if record.status == "error" {
                break;
            }
            if matches!(record.status.as_str(), "completed" | "seeding") && !record.files.is_empty()
            {
                let bytes = std::fs::read(&record.files[0]).unwrap();
                assert_eq!(
                    format!("{:x}", Sha256::digest(&bytes)),
                    fixture["expectedSha256"].as_str().unwrap()
                );
                verified = true;
                break;
            }
        }
        // Remove only this test's registered tasks, preserving generated files as diagnostics.
        if !verified {
            let actual = rpc("task/get", json!({"taskId":record.task_id}))
                .await
                .unwrap();
            println!(
                "Fixture failed: type={} status={} code={} error={}",
                actual["task"]["type"],
                actual["task"]["status"],
                actual["task"]["errorCode"],
                actual["task"]["error"]
            );
        }
        for id in [Some(parent_id.clone()), record.task_id.clone()]
            .into_iter()
            .flatten()
        {
            let _ = rpc("task/remove", json!({"taskId":id,"deleteFiles":false})).await;
        }
        assert_eq!(
            record.task_id.as_deref(),
            Some(parent_id.as_str()),
            "torrent submission must retain the actual payload task"
        );
        assert!(
            verified,
            "actual BT payload did not complete: {} {}",
            record.status, record.message
        );
    }

    #[tokio::test]
    #[ignore = "read-only audit of current Studio registered tasks"]
    async fn live_registered_downloads() {
        let path = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
            .join("studio.danmaku.timeline/acquisition/motrix-v1.json");
        let mut records = load_queue(&path).unwrap();
        for record in &mut records {
            refresh_row(record).await.unwrap();
            assert!(record.status != "completed" || !record.files.is_empty());
        }
        println!(
            "Verified {} Studio task chains without altering queue or downloads",
            records.len()
        );
    }
    fn row() -> Download {
        serde_json::from_value(json!({
            "key":"k", "projectId":"p", "title":"Example", "uri":"", "saveDir":"D:/Originals",
            "taskId":"metadata", "status":"completed", "progress":1, "message":"", "files":[]
        }))
        .unwrap()
    }

    #[test]
    fn payload_selection_does_not_confuse_metadata_or_foreign_duplicate() {
        let parent = json!({"id":"metadata","type":"magnet","infoHash":"abc","createdAt":10});
        let child = json!({"id":"payload","type":"bt","infoHash":"ABC","createdAt":11,"saveDir":"D:/Originals/Example.motrix","status":"error","progress":0});
        let foreign = json!({"id":"foreign","type":"bt","infoHash":"abc","createdAt":11,"saveDir":"D:/Originals-other"});
        let older = json!({"id":"older","type":"bt","infoHash":"abc","createdAt":1,"saveDir":"D:/Originals"});
        let tasks = vec![parent.clone(), foreign, older, child.clone()];
        let mut record = row();
        let selected = payload(&record, &parent, &tasks).unwrap().unwrap();
        update_task(&mut record, selected).unwrap();
        assert_eq!(record.task_id.as_deref(), Some("payload"));
        assert_eq!(record.status, "error");
        assert_eq!(record.progress, 0.0);
        assert!(payload(&record, &parent, &[child.clone(), child]).is_err());
    }

    #[test]
    fn windows_paths_and_magnet_display_names_are_interoperable() {
        assert_eq!(
            interoperable_path(r"\\?\D:\DanmakuStudio\原片"),
            r"D:\DanmakuStudio\原片"
        );
        assert_eq!(
            interoperable_path(r"\\?\UNC\server\media"),
            r"\\server\media"
        );
        let input = format!("magnet:?xt=urn:btih:{}&dn=Example%20:%20Season%2002&tr=https://tracker.example/announce", "a".repeat(40));
        let safe = Url::parse(&safe_magnet(&input).unwrap()).unwrap();
        assert_eq!(
            safe.query_pairs().find(|(k, _)| k == "dn").unwrap().1,
            "Example - Season 02"
        );
        assert!(safe
            .query_pairs()
            .any(|(k, v)| k == "tr" && v == "https://tracker.example/announce"));
        assert_eq!(safe_magnet(safe.as_str()).unwrap(), safe.as_str());
    }
}
