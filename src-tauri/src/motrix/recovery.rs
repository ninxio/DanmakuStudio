//! Recover one content identity without removing healthy tasks or any download files.
use super::*;

enum Plan {
    Reuse(Value),
    RemoveFailed(Vec<Value>),
    Empty,
}

fn matches_hash(task: &Value, hash: &str) -> bool {
    matches!(task["type"].as_str(), Some("bt" | "magnet"))
        && task["infoHash"]
            .as_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(hash))
}

fn in_requested_directory(row: &Download, task: &Value, legacy: bool) -> bool {
    let normalize = |s: &str| task_state::interoperable_path(s).replace('\\', "/");
    let root = normalize(&row.save_dir);
    let directory = normalize(task["saveDir"].as_str().unwrap_or(""));
    if directory.split('/').any(|s| s == ".." || s == ".") {
        return false;
    }
    if task_state::same_directory(&root, &directory) {
        return true;
    }
    // Old Motrix metadata children incorrectly used one immediate *.motrix staging folder.
    // Do not accept arbitrary nested directories or similarly prefixed sibling paths.
    let Some((parent, child)) = directory.trim_end_matches('/').rsplit_once('/') else {
        return false;
    };
    legacy && child.ends_with(".motrix") && task_state::same_directory(&root, parent)
}

fn removable(row: &Download, task: &Value, hash: &str) -> bool {
    matches_hash(task, hash)
        && in_requested_directory(row, task, true)
        && (task["status"] == "error"
            || (task["type"] == "magnet" && task["status"] == "completed"))
}

fn plan(row: &Download, tasks: &[Value]) -> Result<Plan, String> {
    let hash = metadata::info_hash(&row.uri)?;
    let candidates: Vec<_> = tasks.iter().filter(|t| matches_hash(t, &hash)).collect();
    let reusable: Vec<_> = candidates
        .iter()
        .filter(|t| {
            t["type"] == "bt"
                && in_requested_directory(row, t, false)
                && matches!(
                    t["status"].as_str(),
                    Some(
                        "queued"
                            | "downloading"
                            | "paused"
                            | "seeding"
                            | "finalizing"
                            | "completed"
                    )
                )
        })
        .collect();
    if reusable.len() == 1 {
        return Ok(Plan::Reuse((**reusable[0]).clone()));
    }
    if reusable.len() > 1 {
        return Err(
            "同一目录存在多个可用任务，无法唯一关联；请在 Motrix 中选择保留的任务。".into(),
        );
    }
    if candidates.is_empty() {
        return Ok(Plan::Empty);
    }
    if candidates.iter().any(|t| !removable(row, t, &hash)) {
        return Err("同一资源仍有其它目录的任务或正在运行的任务。请到 Motrix 查看；仅更换目录不能解除资源占用，未移除任何正常任务。".into());
    }
    let mut failed: Vec<Value> = candidates.into_iter().cloned().collect();
    // Remove completed metadata first, so it cannot spawn another broken child during repair.
    failed.sort_by_key(|t| t["type"] != "magnet");
    Ok(Plan::RemoveFailed(failed))
}

pub(super) async fn reconcile(row: &mut Download) -> Result<(), String> {
    reconcile_with_tasks(row, &task_state::task_list().await?)
}

pub(super) fn needs_reconciliation(row: &Download) -> bool {
    row.task_id.is_none()
        && matches!(
            row.status.as_str(),
            "uncertain" | "duplicate_conflict" | "submitting"
        )
}

pub(super) fn reconcile_with_tasks(row: &mut Download, tasks: &[Value]) -> Result<(), String> {
    match plan(row, tasks) {
        Ok(Plan::Reuse(task)) => {
            update_task(row, &task)?;
            if row.message.is_empty() {
                row.message = "已关联同一目录中的现有任务，保留 Motrix 中的文件选择。".into();
            }
        }
        Ok(Plan::RemoveFailed(tasks)) => {
            row.status = "duplicate_conflict".into();
            row.message = format!("同一资源有 {} 条旧失败或元数据记录仍占用下载。点击“修复重复任务并重试”清理这些记录；下载文件保留。", tasks.len());
        }
        Ok(Plan::Empty) => {}
        Err(message) => {
            row.status = "duplicate_conflict".into();
            row.message = message;
        }
    }
    Ok(())
}

pub(super) async fn repair(
    path: &Path,
    rows: &mut [Download],
    index: usize,
) -> Result<Download, String> {
    let row = &mut rows[index];
    if !matches!(
        row.status.as_str(),
        "error" | "duplicate_conflict" | "uncertain"
    ) {
        return Err("当前记录不需要修复，请刷新查看任务。".into());
    }
    row.save_dir = task_state::prepare_directory(&row.save_dir)?;
    let initial = plan(row, &task_state::task_list().await?)?;
    let cache = path.parent().ok_or("下载记录目录无效。")?.join("metadata");
    // Resolve and validate all metadata before removing even failed task records.
    let torrent = metadata::resolve(row.uri.clone(), cache).await?;
    row.content_files = content_files::manifest(&torrent)?;
    if let Plan::Reuse(task) = initial {
        update_task(row, &task)?;
        save_queue(path, rows)?;
        return Ok(rows[index].clone());
    }
    let hash = metadata::info_hash(&row.uri)?;
    let removals = if let Plan::RemoveFailed(tasks) = initial {
        tasks
    } else {
        vec![]
    };
    row.message = "正在修复同一资源的失败记录；下载文件保留。".into();
    save_queue(path, rows)?;
    for expected in removals {
        // Recheck the whole group and the exact record immediately before each mutation.
        match plan(&rows[index], &task_state::task_list().await?)? {
            Plan::Reuse(task) => {
                update_task(&mut rows[index], &task)?;
                save_queue(path, rows)?;
                return Ok(rows[index].clone());
            }
            Plan::RemoveFailed(_) | Plan::Empty => {}
        }
        let id = expected["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("任务身份无效。")?;
        let latest = rpc("task/get", json!({"taskId":id})).await?;
        if latest.get("task") == Some(&Value::Null) {
            continue;
        }
        if latest["task"]["id"] != expected["id"]
            || !removable(&rows[index], &latest["task"], &hash)
        {
            return Err("任务状态已变化，已停止修复；请刷新后查看。".into());
        }
        rpc("task/remove", json!({"taskId":id,"deleteFiles":false})).await?;
        if rpc("task/get", json!({"taskId":id})).await?.get("task") != Some(&Value::Null) {
            return Err("Motrix 尚未确认旧记录已移除，未创建新的下载。".into());
        }
    }
    match plan(&rows[index], &task_state::task_list().await?)? {
        Plan::Empty => {}
        Plan::Reuse(task) => {
            update_task(&mut rows[index], &task)?;
            save_queue(path, rows)?;
            return Ok(rows[index].clone());
        }
        Plan::RemoveFailed(_) => return Err("修复期间出现新的失败记录，请刷新后重试。".into()),
    }
    let row = &mut rows[index];
    // Only a previously accepted, now removed task requires a new idempotency attempt.
    // Rejected submissions retain the original key across repair and lost responses.
    if row.task_id.is_some() {
        row.attempt = row.attempt.checked_add(1).ok_or("重试次数超出范围。")?;
    }
    row.task_id = None;
    row.metadata_task_id = None;
    row.files.clear();
    row.progress = 0.0;
    row.message.clear();
    dispatch_download(path, rows, index).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "explicit selected live repair; operates on a queue copy and preserves all files"]
    async fn live_selected_repair_and_idempotent_receipt() {
        let path = PathBuf::from(
            std::env::var_os("STUDIO_MOTRIX_RECOVERY_QUEUE").expect("provide a queue copy"),
        );
        let real = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
            .join("studio.danmaku.timeline/acquisition/motrix-v1.json");
        assert_ne!(
            path.canonicalize().unwrap(),
            real.canonicalize().unwrap(),
            "never race the open app's queue writer"
        );
        let key =
            std::env::var("STUDIO_MOTRIX_RECOVERY_KEY").expect("explicitly select one request");
        let mut rows = load_queue(&path).unwrap();
        let index = rows.iter().position(|r| r.key == key).unwrap();
        let hash = metadata::info_hash(&rows[index].uri).unwrap();
        let before = task_state::task_list().await.unwrap();
        let repaired = if rows[index].task_id.is_some()
            && matches!(
                rows[index].status.as_str(),
                "downloading" | "seeding" | "completed" | "paused"
            ) {
            reconcile(&mut rows[index]).await.unwrap();
            rows[index].clone()
        } else {
            repair(&path, &mut rows, index).await.unwrap()
        };
        assert!(
            repaired.task_id.is_some(),
            "repair outcome: {} {}",
            repaired.status,
            repaired.message
        );
        assert_ne!(repaired.status, "error", "{}", repaired.message);
        let retry = dispatch_download(&path, &mut rows, index).await.unwrap();
        assert_eq!(
            retry.task_id, repaired.task_id,
            "the exact request must return one receipt"
        );
        task_state::refresh_row(&mut rows[index]).await.unwrap();
        save_queue(&path, &rows).unwrap();
        let after = task_state::task_list().await.unwrap();
        for task in before.iter().filter(|t| !matches_hash(t, &hash)) {
            assert!(
                after.iter().any(|t| t["id"] == task["id"]),
                "unrelated task disappeared"
            );
        }
        assert_eq!(
            after
                .iter()
                .filter(|t| matches_hash(t, &hash) && t["type"] == "bt")
                .count(),
            1
        );
        println!("Live repair accepted; same-request retry returned one receipt; status={}; other tasks retained", rows[index].status);
    }
    fn row() -> Download {
        serde_json::from_value(json!({"key":"k","projectId":"p","title":"Fixture","uri":format!("magnet:?xt=urn:btih:{}", "a".repeat(40)),"saveDir":"D:/Originals","taskId":null,"status":"uncertain","progress":0,"message":"","files":[]})).unwrap()
    }
    fn task(id: &str, status: &str, directory: &str) -> Value {
        json!({"id":id,"type":"bt","status":status,"saveDir":directory,"infoHash":"A".repeat(40),"progress":0})
    }
    #[test]
    fn repairs_all_legacy_failed_children_and_metadata_by_identity() {
        let mut parent = task("parent", "completed", r"\\?\D:\Originals");
        parent["type"] = json!("magnet");
        let tasks = vec![
            task("child1", "error", r"\\?\D:\Originals\Example.motrix"),
            task("child2", "error", "D:/Originals/Example.motrix"),
            parent,
        ];
        let Plan::RemoveFailed(list) = plan(&row(), &tasks).unwrap() else {
            panic!("expected failed records");
        };
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["id"], "parent");
    }
    #[test]
    fn reuses_healthy_receipt_without_touching_its_file_selection_or_failed_siblings() {
        for state in ["downloading", "paused", "completed", "seeding"] {
            let tasks = vec![
                task("failed", "error", "D:/Originals/Legacy.motrix"),
                task("healthy", state, "D:/Originals"),
            ];
            let Plan::Reuse(found) = plan(&row(), &tasks).unwrap() else {
                panic!("expected receipt");
            };
            assert_eq!(found["id"], "healthy");
            assert_eq!(found["status"], state);
        }
    }
    #[test]
    fn never_removes_foreign_healthy_ambiguous_or_unknown_tasks() {
        for (status, path) in [
            ("downloading", "D:/Elsewhere"),
            ("error", "D:/Originals-other"),
            ("error", "D:/Originals/../Other.motrix"),
            ("error", "D:/Originals/nested/file.motrix"),
            ("unknown", "D:/Originals"),
            ("paused", "D:/Originals/Legacy.motrix"),
        ] {
            assert!(plan(&row(), &[task("foreign", status, path)]).is_err());
        }
        assert!(plan(
            &row(),
            &[
                task("a", "downloading", "D:/Originals"),
                task("b", "paused", "D:/Originals")
            ]
        )
        .is_err());
        let mut other = task("other", "error", "D:/Originals");
        other["infoHash"] = json!("b".repeat(40));
        assert!(matches!(plan(&row(), &[other]).unwrap(), Plan::Empty));
    }
}
