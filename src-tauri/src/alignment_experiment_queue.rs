use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};

const STORE_DIRECTORY: &str = "alignment-experiment-queues-v1";
const MAX_QUEUE_BYTES: u64 = 4 * 1024 * 1024;
const SYNTHETIC_LAB_STORE_DIRECTORY: &str = "synthetic-alignment-lab-v1";
const SYNTHETIC_LAB_FILE_NAME: &str = "queue.json";
const SYNTHETIC_LAB_BASELINE_FILE_NAME: &str = "baseline-summary.json";
const SYNTHETIC_REPORT_ARCHIVE_FILE_NAME: &str = "detailed-report-archive.json";
const MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_DIRECTORY: &str = "multimodal-rule-snapshots-v1";
const MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_FILE_NAME: &str = "rule-snapshot-archive.json";
const MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_DIRECTORY: &str = "multimodal-blind-review-drafts-v1";
const MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_FILE_NAME: &str = "draft-archive.json";
const MAX_SYNTHETIC_LAB_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SYNTHETIC_REPORT_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SYNTHETIC_REPORT_ARCHIVE_ENTRIES: usize = 16;
const MAX_MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_ENTRIES: usize = 16;
const MAX_MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_BYTES: u64 = 512 * 1024;
const MAX_MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_ENTRIES: usize = 8;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub fn load_alignment_experiment_queue_file(
    app: AppHandle,
    project_id: String,
) -> Result<Option<String>, String> {
    let root = queue_store_root(&app)?;
    load_queue_at(&root, &project_id)
}

#[tauri::command]
pub fn save_alignment_experiment_queue_file(
    app: AppHandle,
    project_id: String,
    content: String,
) -> Result<(), String> {
    let root = queue_store_root(&app)?;
    save_queue_at(&root, &project_id, &content)
}

#[tauri::command]
pub fn clear_alignment_experiment_queue_file(
    app: AppHandle,
    project_id: String,
) -> Result<(), String> {
    let root = queue_store_root(&app)?;
    clear_queue_at(&root, &project_id)
}

#[tauri::command]
pub fn load_synthetic_alignment_lab_queue_file(app: AppHandle) -> Result<Option<String>, String> {
    let root = synthetic_lab_store_root(&app)?;
    load_synthetic_lab_queue_at(&root)
}

#[tauri::command]
pub fn save_synthetic_alignment_lab_queue_file(
    app: AppHandle,
    content: String,
) -> Result<(), String> {
    let root = synthetic_lab_store_root(&app)?;
    save_synthetic_lab_queue_at(&root, &content)
}

#[tauri::command]
pub fn clear_synthetic_alignment_lab_queue_file(app: AppHandle) -> Result<(), String> {
    let root = synthetic_lab_store_root(&app)?;
    clear_synthetic_lab_queue_at(&root)
}

#[tauri::command]
pub fn load_synthetic_alignment_lab_baseline_file(
    app: AppHandle,
) -> Result<Option<String>, String> {
    let root = synthetic_lab_store_root(&app)?;
    load_synthetic_lab_baseline_at(&root)
}

#[tauri::command]
pub fn save_synthetic_alignment_lab_baseline_file(
    app: AppHandle,
    content: String,
) -> Result<(), String> {
    let root = synthetic_lab_store_root(&app)?;
    save_synthetic_lab_baseline_at(&root, &content)
}

#[tauri::command]
pub fn clear_synthetic_alignment_lab_baseline_file(app: AppHandle) -> Result<(), String> {
    let root = synthetic_lab_store_root(&app)?;
    clear_synthetic_lab_baseline_at(&root)
}

#[tauri::command]
pub fn load_synthetic_alignment_report_archive_file(
    app: AppHandle,
) -> Result<Option<String>, String> {
    let root = synthetic_lab_store_root(&app)?;
    load_synthetic_report_archive_at(&root)
}

#[tauri::command]
pub fn save_synthetic_alignment_report_archive_file(
    app: AppHandle,
    content: String,
) -> Result<(), String> {
    let root = synthetic_lab_store_root(&app)?;
    save_synthetic_report_archive_at(&root, &content)
}

#[tauri::command]
pub fn clear_synthetic_alignment_report_archive_file(app: AppHandle) -> Result<(), String> {
    let root = synthetic_lab_store_root(&app)?;
    clear_synthetic_report_archive_at(&root)
}

#[tauri::command]
pub fn load_multimodal_rule_snapshot_archive_file(
    app: AppHandle,
) -> Result<Option<String>, String> {
    let root = multimodal_rule_snapshot_archive_root(&app)?;
    load_multimodal_rule_snapshot_archive_at(&root)
}

#[tauri::command]
pub fn save_multimodal_rule_snapshot_archive_file(
    app: AppHandle,
    content: String,
) -> Result<(), String> {
    let root = multimodal_rule_snapshot_archive_root(&app)?;
    save_multimodal_rule_snapshot_archive_at(&root, &content)
}

#[tauri::command]
pub fn clear_multimodal_rule_snapshot_archive_file(app: AppHandle) -> Result<(), String> {
    let root = multimodal_rule_snapshot_archive_root(&app)?;
    clear_multimodal_rule_snapshot_archive_at(&root)
}

#[tauri::command]
pub fn load_multimodal_blind_review_draft_archive_file(
    app: AppHandle,
) -> Result<Option<String>, String> {
    let root = multimodal_blind_review_draft_archive_root(&app)?;
    load_multimodal_blind_review_draft_archive_at(&root)
}

#[tauri::command]
pub fn save_multimodal_blind_review_draft_archive_file(
    app: AppHandle,
    content: String,
) -> Result<(), String> {
    let root = multimodal_blind_review_draft_archive_root(&app)?;
    save_multimodal_blind_review_draft_archive_at(&root, &content)
}

#[tauri::command]
pub fn clear_multimodal_blind_review_draft_archive_file(app: AppHandle) -> Result<(), String> {
    let root = multimodal_blind_review_draft_archive_root(&app)?;
    clear_multimodal_blind_review_draft_archive_at(&root)
}

fn queue_store_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(STORE_DIRECTORY))
        .map_err(|error| format!("定位匹配任务存储目录失败：{error}"))
}

fn synthetic_lab_store_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SYNTHETIC_LAB_STORE_DIRECTORY))
        .map_err(|error| format!("定位便携实验队列存储目录失败：{error}"))
}

fn multimodal_rule_snapshot_archive_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_DIRECTORY))
        .map_err(|error| format!("定位视觉对照规则档案目录失败：{error}"))
}

fn multimodal_blind_review_draft_archive_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_DIRECTORY))
        .map_err(|error| format!("定位多模态盲复核草稿目录失败：{error}"))
}

fn load_synthetic_lab_queue_at(root: &Path) -> Result<Option<String>, String> {
    let path = root.join(SYNTHETIC_LAB_FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取便携实验队列元数据失败：{error}")),
    };
    if metadata.len() > MAX_SYNTHETIC_LAB_BYTES {
        return Err("便携实验队列文件超过 8 MiB 安全上限。".to_string());
    }
    let mut content = String::new();
    File::open(&path)
        .and_then(|file| {
            file.take(MAX_SYNTHETIC_LAB_BYTES + 1)
                .read_to_string(&mut content)
        })
        .map_err(|error| format!("读取便携实验队列失败：{error}"))?;
    validate_synthetic_lab_content(&content)?;
    Ok(Some(content))
}

fn save_synthetic_lab_queue_at(root: &Path, content: &str) -> Result<(), String> {
    validate_synthetic_lab_content(content)?;
    fs::create_dir_all(root).map_err(|error| format!("创建便携实验队列目录失败：{error}"))?;
    write_atomic_replace(&root.join(SYNTHETIC_LAB_FILE_NAME), content.as_bytes())
}

fn clear_synthetic_lab_queue_at(root: &Path) -> Result<(), String> {
    match fs::remove_file(root.join(SYNTHETIC_LAB_FILE_NAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除便携实验队列失败：{error}")),
    }
}

fn validate_synthetic_lab_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_SYNTHETIC_LAB_BYTES {
        return Err("便携实验队列内容超过 8 MiB 安全上限。".to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("便携实验队列不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "便携实验队列必须是 JSON 对象。".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("便携实验队列 schemaVersion 不受支持。".to_string());
    }
    if !object.get("suites").is_some_and(Value::is_array) {
        return Err("便携实验队列缺少 suites 数组。".to_string());
    }
    Ok(())
}

fn load_synthetic_lab_baseline_at(root: &Path) -> Result<Option<String>, String> {
    let path = root.join(SYNTHETIC_LAB_BASELINE_FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取程序化回归基线元数据失败：{error}")),
    };
    if metadata.len() > MAX_SYNTHETIC_LAB_BYTES {
        return Err("程序化回归基线文件超过 8 MiB 安全上限。".to_string());
    }
    let mut content = String::new();
    File::open(&path)
        .and_then(|file| {
            file.take(MAX_SYNTHETIC_LAB_BYTES + 1)
                .read_to_string(&mut content)
        })
        .map_err(|error| format!("读取程序化回归基线失败：{error}"))?;
    validate_synthetic_lab_baseline_content(&content)?;
    Ok(Some(content))
}

fn save_synthetic_lab_baseline_at(root: &Path, content: &str) -> Result<(), String> {
    validate_synthetic_lab_baseline_content(content)?;
    fs::create_dir_all(root).map_err(|error| format!("创建程序化回归基线目录失败：{error}"))?;
    write_atomic_replace(
        &root.join(SYNTHETIC_LAB_BASELINE_FILE_NAME),
        content.as_bytes(),
    )
}

fn clear_synthetic_lab_baseline_at(root: &Path) -> Result<(), String> {
    match fs::remove_file(root.join(SYNTHETIC_LAB_BASELINE_FILE_NAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除程序化回归基线失败：{error}")),
    }
}

fn validate_synthetic_lab_baseline_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_SYNTHETIC_LAB_BYTES {
        return Err("程序化回归基线内容超过 8 MiB 安全上限。".to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("程序化回归基线不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "程序化回归基线必须是 JSON 对象。".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some("alignment-synthetic-lab-summary-v1")
    {
        return Err("程序化回归基线 schemaVersion 不受支持。".to_string());
    }
    if object.get("releaseEligible").and_then(Value::as_bool) != Some(false)
        || object.get("note").and_then(Value::as_str)
            != Some("programmatic-development-evidence-never-real-gold")
    {
        return Err("程序化回归基线的开发证据边界无效。".to_string());
    }
    if !object.get("suites").is_some_and(Value::is_array) {
        return Err("程序化回归基线缺少 suites 数组。".to_string());
    }
    Ok(())
}

fn load_synthetic_report_archive_at(root: &Path) -> Result<Option<String>, String> {
    let path = root.join(SYNTHETIC_REPORT_ARCHIVE_FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取程序化详细报告档案元数据失败：{error}")),
    };
    if metadata.len() > MAX_SYNTHETIC_REPORT_ARCHIVE_BYTES {
        return Err("程序化详细报告档案超过 32 MiB 安全上限。".to_string());
    }
    let mut content = String::new();
    File::open(&path)
        .and_then(|file| {
            file.take(MAX_SYNTHETIC_REPORT_ARCHIVE_BYTES + 1)
                .read_to_string(&mut content)
        })
        .map_err(|error| format!("读取程序化详细报告档案失败：{error}"))?;
    validate_synthetic_report_archive_content(&content)?;
    Ok(Some(content))
}

fn save_synthetic_report_archive_at(root: &Path, content: &str) -> Result<(), String> {
    validate_synthetic_report_archive_content(content)?;
    fs::create_dir_all(root).map_err(|error| format!("创建程序化详细报告档案目录失败：{error}"))?;
    write_atomic_replace(
        &root.join(SYNTHETIC_REPORT_ARCHIVE_FILE_NAME),
        content.as_bytes(),
    )
}

fn clear_synthetic_report_archive_at(root: &Path) -> Result<(), String> {
    match fs::remove_file(root.join(SYNTHETIC_REPORT_ARCHIVE_FILE_NAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除程序化详细报告档案失败：{error}")),
    }
}

fn validate_synthetic_report_archive_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_SYNTHETIC_REPORT_ARCHIVE_BYTES {
        return Err("程序化详细报告档案超过 32 MiB 安全上限。".to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("程序化详细报告档案不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "程序化详细报告档案必须是 JSON 对象。".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some("alignment-synthetic-report-archive-v1")
    {
        return Err("程序化详细报告档案 schemaVersion 不受支持。".to_string());
    }
    if object.get("releaseEligible").and_then(Value::as_bool) != Some(false)
        || object.get("note").and_then(Value::as_str)
            != Some("programmatic-development-evidence-never-real-gold")
    {
        return Err("程序化详细报告档案的开发证据边界无效。".to_string());
    }
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "程序化详细报告档案缺少 entries 数组。".to_string())?;
    if entries.len() > MAX_SYNTHETIC_REPORT_ARCHIVE_ENTRIES {
        return Err("程序化详细报告档案条目数超过 16。".to_string());
    }
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| "程序化详细报告档案条目必须是对象。".to_string())?;
        let report_id = entry
            .get("reportId")
            .and_then(Value::as_str)
            .ok_or_else(|| "程序化详细报告档案条目缺少 reportId。".to_string())?;
        if report_id.len() != 71
            || !report_id.starts_with("sha256:")
            || !report_id[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("程序化详细报告档案 reportId 不是小写 SHA-256。".to_string());
        }
        let report = entry
            .get("report")
            .and_then(Value::as_object)
            .ok_or_else(|| "程序化详细报告档案条目缺少 report。".to_string())?;
        if report.get("schemaVersion").and_then(Value::as_str)
            != Some("alignment-synthetic-run-report-v2")
        {
            return Err("程序化详细报告 schemaVersion 不受支持。".to_string());
        }
        if report.get("releaseEligible").and_then(Value::as_bool) != Some(false)
            || report.get("note").and_then(Value::as_str)
                != Some("programmatic-development-evidence-never-real-gold")
        {
            return Err("程序化详细报告的开发证据边界无效。".to_string());
        }
        if !report.get("predictions").is_some_and(Value::is_array)
            || !report.get("caseReceipts").is_some_and(Value::is_array)
            || !report.get("result").is_some_and(Value::is_object)
        {
            return Err("程序化详细报告缺少预测、回执或评测结果。".to_string());
        }
    }
    Ok(())
}

fn load_multimodal_rule_snapshot_archive_at(root: &Path) -> Result<Option<String>, String> {
    let path = root.join(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取视觉对照规则档案元数据失败：{error}")),
    };
    if metadata.len() > MAX_MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_BYTES {
        return Err("视觉对照规则档案超过 8 MiB 安全上限。".to_string());
    }
    let mut content = String::new();
    File::open(&path)
        .and_then(|file| {
            file.take(MAX_MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_BYTES + 1)
                .read_to_string(&mut content)
        })
        .map_err(|error| format!("读取视觉对照规则档案失败：{error}"))?;
    validate_multimodal_rule_snapshot_archive_content(&content)?;
    Ok(Some(content))
}

fn save_multimodal_rule_snapshot_archive_at(root: &Path, content: &str) -> Result<(), String> {
    validate_multimodal_rule_snapshot_archive_content(content)?;
    fs::create_dir_all(root).map_err(|error| format!("创建视觉对照规则档案目录失败：{error}"))?;
    write_atomic_replace(
        &root.join(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_FILE_NAME),
        content.as_bytes(),
    )
}

fn clear_multimodal_rule_snapshot_archive_at(root: &Path) -> Result<(), String> {
    match fs::remove_file(root.join(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_FILE_NAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除视觉对照规则档案失败：{error}")),
    }
}

fn validate_multimodal_rule_snapshot_archive_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_BYTES {
        return Err("视觉对照规则档案超过 8 MiB 安全上限。".to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("视觉对照规则档案不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "视觉对照规则档案必须是 JSON 对象。".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some("alignment-multimodal-rule-snapshot-archive-v1")
        || object
            .get("containsSensitiveMediaDigests")
            .and_then(Value::as_bool)
            != Some(true)
        || object.get("permission").and_then(Value::as_str)
            != Some("local-multimodal-rule-snapshot-archive-only")
        || object.get("releaseEligible").and_then(Value::as_bool) != Some(false)
        || object.get("updatedAtMs").and_then(Value::as_u64).is_none()
    {
        return Err("视觉对照规则档案的结构或本机权限边界无效。".to_string());
    }
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "视觉对照规则档案缺少 entries 数组。".to_string())?;
    if entries.len() > MAX_MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_ENTRIES {
        return Err("视觉对照规则档案条目数超过 16。".to_string());
    }
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| "视觉对照规则档案条目必须是对象。".to_string())?;
        let snapshot_id = entry
            .get("snapshotId")
            .and_then(Value::as_str)
            .ok_or_else(|| "视觉对照规则档案条目缺少 snapshotId。".to_string())?;
        validate_lower_sha256(snapshot_id, "视觉对照规则 snapshotId")?;
        if entry.get("savedAtMs").and_then(Value::as_u64).is_none() {
            return Err("视觉对照规则档案条目缺少保存时间。".to_string());
        }
        let snapshot = entry
            .get("snapshot")
            .and_then(Value::as_object)
            .ok_or_else(|| "视觉对照规则档案条目缺少 snapshot。".to_string())?;
        if snapshot.get("schemaVersion").and_then(Value::as_str)
            != Some("alignment-multimodal-rule-snapshot-v1")
            || snapshot
                .get("containsSensitiveMediaDigests")
                .and_then(Value::as_bool)
                != Some(true)
            || snapshot.get("permission").and_then(Value::as_str)
                != Some("local-multimodal-shadow-association-only")
            || snapshot.get("releaseEligible").and_then(Value::as_bool) != Some(false)
            || snapshot.get("snapshotId").and_then(Value::as_str) != Some(snapshot_id)
            || snapshot
                .get("timeMaps")
                .and_then(Value::as_array)
                .is_none_or(|time_maps| time_maps.is_empty())
        {
            return Err("视觉对照规则档案内层快照无效。".to_string());
        }
    }
    Ok(())
}

fn load_multimodal_blind_review_draft_archive_at(root: &Path) -> Result<Option<String>, String> {
    let path = root.join(MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取多模态盲复核草稿元数据失败：{error}")),
    };
    if metadata.len() > MAX_MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_BYTES {
        return Err("多模态盲复核草稿超过 512 KiB 安全上限。".to_string());
    }
    let mut content = String::new();
    File::open(&path)
        .and_then(|file| {
            file.take(MAX_MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_BYTES + 1)
                .read_to_string(&mut content)
        })
        .map_err(|error| format!("读取多模态盲复核草稿失败：{error}"))?;
    validate_multimodal_blind_review_draft_archive_content(&content)?;
    Ok(Some(content))
}

fn save_multimodal_blind_review_draft_archive_at(root: &Path, content: &str) -> Result<(), String> {
    validate_multimodal_blind_review_draft_archive_content(content)?;
    fs::create_dir_all(root).map_err(|error| format!("创建多模态盲复核草稿目录失败：{error}"))?;
    write_atomic_replace(
        &root.join(MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_FILE_NAME),
        content.as_bytes(),
    )
}

fn clear_multimodal_blind_review_draft_archive_at(root: &Path) -> Result<(), String> {
    match fs::remove_file(root.join(MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_FILE_NAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除多模态盲复核草稿失败：{error}")),
    }
}

fn validate_multimodal_blind_review_draft_archive_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_BYTES {
        return Err("多模态盲复核草稿超过 512 KiB 安全上限。".to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("多模态盲复核草稿不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "多模态盲复核草稿必须是 JSON 对象。".to_string())?;
    if object.len() != 2
        || object.get("schemaVersion").and_then(Value::as_str)
            != Some("alignment-multimodal-blind-review-draft-archive-v1")
    {
        return Err("多模态盲复核草稿档案结构无效。".to_string());
    }
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "多模态盲复核草稿缺少 entries 数组。".to_string())?;
    if entries.len() > MAX_MULTIMODAL_BLIND_REVIEW_DRAFT_ARCHIVE_ENTRIES {
        return Err("多模态盲复核草稿条目数超过 8。".to_string());
    }
    let mut pack_ids = std::collections::HashSet::new();
    let mut previous_updated_at: Option<&str> = None;
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| "多模态盲复核草稿条目必须是对象。".to_string())?;
        if entry.len() != 4
            || !entry.contains_key("packId")
            || !entry.contains_key("currentTaskId")
            || !entry.contains_key("answers")
            || !entry.contains_key("updatedAt")
        {
            return Err("多模态盲复核草稿包含未知字段。".to_string());
        }
        let pack_id = entry
            .get("packId")
            .and_then(Value::as_str)
            .ok_or_else(|| "多模态盲复核草稿缺少 packId。".to_string())?;
        validate_lower_sha256(pack_id, "多模态盲复核 packId")?;
        if !pack_ids.insert(pack_id) {
            return Err("多模态盲复核草稿包含重复任务包。".to_string());
        }
        validate_lower_sha256(
            entry
                .get("currentTaskId")
                .and_then(Value::as_str)
                .ok_or_else(|| "多模态盲复核草稿缺少 currentTaskId。".to_string())?,
            "多模态盲复核 currentTaskId",
        )?;
        let updated_at = entry
            .get("updatedAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "多模态盲复核草稿缺少更新时间。".to_string())?;
        if previous_updated_at.is_some_and(|previous| previous < updated_at) {
            return Err("多模态盲复核草稿没有按更新时间排序。".to_string());
        }
        previous_updated_at = Some(updated_at);
        let answers = entry
            .get("answers")
            .and_then(Value::as_array)
            .ok_or_else(|| "多模态盲复核草稿缺少 answers 数组。".to_string())?;
        let mut task_ids = std::collections::HashSet::new();
        for answer in answers {
            validate_multimodal_blind_review_draft_answer(answer, &mut task_ids)?;
        }
    }
    Ok(())
}

fn validate_multimodal_blind_review_draft_answer<'a>(
    value: &'a Value,
    task_ids: &mut std::collections::HashSet<&'a str>,
) -> Result<(), String> {
    let answer = value
        .as_object()
        .ok_or_else(|| "多模态盲复核草稿答案必须是对象。".to_string())?;
    let expected = [
        "taskId",
        "decision",
        "targetTimestampMs",
        "boundaryToleranceMs",
        "precision",
    ];
    if answer.len() != expected.len() || expected.iter().any(|key| !answer.contains_key(*key)) {
        return Err("多模态盲复核草稿答案包含未知字段。".to_string());
    }
    let task_id = answer
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| "多模态盲复核草稿答案缺少 taskId。".to_string())?;
    validate_lower_sha256(task_id, "多模态盲复核 taskId")?;
    if !task_ids.insert(task_id) {
        return Err("多模态盲复核草稿包含重复任务答案。".to_string());
    }
    if !matches!(
        answer.get("decision").and_then(Value::as_str),
        Some("unreviewed" | "matched" | "no-match" | "unsure")
    ) {
        return Err("多模态盲复核草稿答案 decision 无效。".to_string());
    }
    match answer.get("precision") {
        Some(Value::Null) => {}
        Some(Value::String(value))
            if matches!(
                value.as_str(),
                "rough" | "playbackChecked" | "frameAccurate"
            ) => {}
        _ => return Err("多模态盲复核草稿答案 precision 无效。".to_string()),
    }
    for key in ["targetTimestampMs", "boundaryToleranceMs"] {
        let field = answer
            .get(key)
            .ok_or_else(|| format!("多模态盲复核草稿答案缺少 {key}。"))?;
        if !field.is_null() && field.as_u64().is_none() {
            return Err(format!("多模态盲复核草稿答案 {key} 无效。"));
        }
    }
    if answer.get("precision").and_then(Value::as_str) == Some("frameAccurate")
        && answer
            .get("boundaryToleranceMs")
            .and_then(Value::as_u64)
            .is_none_or(|tolerance| tolerance > 1_000)
    {
        return Err("逐帧盲复核草稿的边界容差必须不超过 1 秒。".to_string());
    }
    Ok(())
}

fn validate_lower_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{label} 不是小写 SHA-256。"));
    }
    Ok(())
}

fn load_queue_at(root: &Path, project_id: &str) -> Result<Option<String>, String> {
    validate_project_id(project_id)?;
    let path = queue_path(root, project_id);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取匹配任务元数据失败：{error}")),
    };
    if metadata.len() > MAX_QUEUE_BYTES {
        return Err("匹配任务文件超过 4 MiB 安全上限。".to_string());
    }
    let mut content = String::new();
    File::open(&path)
        .and_then(|file| file.take(MAX_QUEUE_BYTES + 1).read_to_string(&mut content))
        .map_err(|error| format!("读取匹配任务文件失败：{error}"))?;
    validate_queue_content(project_id, &content)?;
    Ok(Some(content))
}

fn save_queue_at(root: &Path, project_id: &str, content: &str) -> Result<(), String> {
    validate_project_id(project_id)?;
    validate_queue_content(project_id, content)?;
    fs::create_dir_all(root).map_err(|error| format!("创建匹配任务存储目录失败：{error}"))?;
    write_atomic_replace(&queue_path(root, project_id), content.as_bytes())
}

fn clear_queue_at(root: &Path, project_id: &str) -> Result<(), String> {
    validate_project_id(project_id)?;
    match fs::remove_file(queue_path(root, project_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除匹配任务文件失败：{error}")),
    }
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > 512 || project_id.chars().any(char::is_control) {
        return Err("项目 ID 无效。".to_string());
    }
    Ok(())
}

fn validate_queue_content(project_id: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_QUEUE_BYTES {
        return Err("匹配任务内容超过 4 MiB 安全上限。".to_string());
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|error| format!("匹配任务内容不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "匹配任务内容必须是 JSON 对象。".to_string())?;
    if object.get("projectId").and_then(Value::as_str) != Some(project_id) {
        return Err("匹配任务内容与项目 ID 不一致。".to_string());
    }
    Ok(())
}

fn queue_path(root: &Path, project_id: &str) -> PathBuf {
    let digest = Sha256::digest(project_id.as_bytes());
    root.join(format!("{:x}.json", digest))
}

fn write_atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "匹配任务路径缺少父目录。".to_string())?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("queue"),
        std::process::id(),
        sequence
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("创建匹配任务临时文件失败：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("同步匹配任务临时文件失败：{error}"))?;
        atomic_replace_file(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: Both paths are NUL-terminated UTF-16 buffers kept alive for the call.
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "原子替换匹配任务文件失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| format!("原子替换匹配任务文件失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "danmaku-studio-queue-{name}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn queue_file_round_trips_and_replaces_atomically() {
        let root = test_root("round-trip");
        let first = r#"{"schemaVersion":1,"projectId":"project-a","value":1}"#;
        let second = r#"{"schemaVersion":1,"projectId":"project-a","value":2}"#;
        save_queue_at(&root, "project-a", first).unwrap();
        assert_eq!(
            load_queue_at(&root, "project-a").unwrap().as_deref(),
            Some(first)
        );
        save_queue_at(&root, "project-a", second).unwrap();
        assert_eq!(
            load_queue_at(&root, "project-a").unwrap().as_deref(),
            Some(second)
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        clear_queue_at(&root, "project-a").unwrap();
        assert!(load_queue_at(&root, "project-a").unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn queue_file_rejects_cross_project_invalid_and_oversized_content() {
        let root = test_root("reject");
        assert!(save_queue_at(&root, "project-a", r#"{"projectId":"project-b"}"#).is_err());
        assert!(save_queue_at(&root, "project-a", "[]").is_err());
        let oversized = format!(
            r#"{{"projectId":"project-a","padding":"{}"}}"#,
            "x".repeat(MAX_QUEUE_BYTES as usize)
        );
        assert!(save_queue_at(&root, "project-a", &oversized).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn queue_path_never_contains_the_project_id() {
        let path = queue_path(Path::new("root"), "sensitive-project-name");
        assert!(!path.to_string_lossy().contains("sensitive-project-name"));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("json")
        );
    }

    #[test]
    fn synthetic_lab_queue_round_trips_atomically_and_clears() {
        let root = test_root("synthetic-lab-round-trip");
        let first = r#"{"schemaVersion":1,"suites":[],"value":1}"#;
        let second = r#"{"schemaVersion":1,"suites":[],"value":2}"#;
        save_synthetic_lab_queue_at(&root, first).unwrap();
        assert_eq!(
            load_synthetic_lab_queue_at(&root).unwrap().as_deref(),
            Some(first)
        );
        save_synthetic_lab_queue_at(&root, second).unwrap();
        assert_eq!(
            load_synthetic_lab_queue_at(&root).unwrap().as_deref(),
            Some(second)
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        clear_synthetic_lab_queue_at(&root).unwrap();
        assert!(load_synthetic_lab_queue_at(&root).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn synthetic_lab_queue_rejects_invalid_and_oversized_content() {
        let root = test_root("synthetic-lab-reject");
        assert!(save_synthetic_lab_queue_at(&root, "[]").is_err());
        assert!(save_synthetic_lab_queue_at(&root, r#"{"schemaVersion":2,"suites":[]}"#).is_err());
        assert!(save_synthetic_lab_queue_at(&root, r#"{"schemaVersion":1}"#).is_err());
        let oversized = format!(
            r#"{{"schemaVersion":1,"suites":[],"padding":"{}"}}"#,
            "x".repeat(MAX_SYNTHETIC_LAB_BYTES as usize)
        );
        assert!(save_synthetic_lab_queue_at(&root, &oversized).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn synthetic_lab_baseline_round_trips_and_rejects_release_claims() {
        let root = test_root("synthetic-lab-baseline");
        let valid = r#"{"schemaVersion":"alignment-synthetic-lab-summary-v1","releaseEligible":false,"note":"programmatic-development-evidence-never-real-gold","suites":[]}"#;
        save_synthetic_lab_baseline_at(&root, valid).unwrap();
        assert_eq!(
            load_synthetic_lab_baseline_at(&root).unwrap().as_deref(),
            Some(valid)
        );
        assert!(save_synthetic_lab_baseline_at(
            &root,
            r#"{"schemaVersion":"alignment-synthetic-lab-summary-v1","releaseEligible":true,"note":"programmatic-development-evidence-never-real-gold","suites":[]}"#
        )
        .is_err());
        clear_synthetic_lab_baseline_at(&root).unwrap();
        assert!(load_synthetic_lab_baseline_at(&root).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn synthetic_report_archive_round_trips_atomically_and_clears() {
        let root = test_root("synthetic-report-archive");
        let valid = valid_synthetic_report_archive(false);
        save_synthetic_report_archive_at(&root, &valid).unwrap();
        assert_eq!(
            load_synthetic_report_archive_at(&root).unwrap().as_deref(),
            Some(valid.as_str())
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        clear_synthetic_report_archive_at(&root).unwrap();
        assert!(load_synthetic_report_archive_at(&root).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn synthetic_report_archive_rejects_release_claims_and_invalid_reports() {
        let root = test_root("synthetic-report-archive-reject");
        assert!(
            save_synthetic_report_archive_at(&root, &valid_synthetic_report_archive(true)).is_err()
        );
        let missing_predictions = valid_synthetic_report_archive(false)
            .replace(r#""predictions":[]"#, r#""notPredictions":[]"#);
        assert!(save_synthetic_report_archive_at(&root, &missing_predictions).is_err());
        assert!(save_synthetic_report_archive_at(&root, "[]").is_err());
        assert!(!root.exists());
    }

    #[test]
    fn multimodal_rule_snapshot_archive_round_trips_atomically_and_clears() {
        let root = test_root("multimodal-rule-snapshot-archive");
        let valid = valid_multimodal_rule_snapshot_archive(false, true);
        save_multimodal_rule_snapshot_archive_at(&root, &valid).unwrap();
        assert_eq!(
            load_multimodal_rule_snapshot_archive_at(&root)
                .unwrap()
                .as_deref(),
            Some(valid.as_str())
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        clear_multimodal_rule_snapshot_archive_at(&root).unwrap();
        assert!(load_multimodal_rule_snapshot_archive_at(&root)
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multimodal_rule_snapshot_archive_rejects_release_and_identity_mismatch() {
        let root = test_root("multimodal-rule-snapshot-archive-reject");
        assert!(save_multimodal_rule_snapshot_archive_at(
            &root,
            &valid_multimodal_rule_snapshot_archive(true, true)
        )
        .is_err());
        assert!(save_multimodal_rule_snapshot_archive_at(
            &root,
            &valid_multimodal_rule_snapshot_archive(false, false)
        )
        .is_err());
        assert!(save_multimodal_rule_snapshot_archive_at(&root, "[]").is_err());
        assert!(!root.exists());
    }

    #[test]
    fn multimodal_blind_review_draft_archive_round_trips_atomically_and_clears() {
        let root = test_root("multimodal-blind-review-draft-archive");
        let valid = valid_multimodal_blind_review_draft_archive();
        save_multimodal_blind_review_draft_archive_at(&root, &valid).unwrap();
        assert_eq!(
            load_multimodal_blind_review_draft_archive_at(&root)
                .unwrap()
                .as_deref(),
            Some(valid.as_str())
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        clear_multimodal_blind_review_draft_archive_at(&root).unwrap();
        assert!(load_multimodal_blind_review_draft_archive_at(&root)
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multimodal_blind_review_draft_archive_rejects_identity_and_privacy_fields() {
        let root = test_root("multimodal-blind-review-draft-archive-reject");
        let valid = valid_multimodal_blind_review_draft_archive();
        assert!(save_multimodal_blind_review_draft_archive_at(
            &root,
            &valid.replace(&"a".repeat(64), "not-a-digest")
        )
        .is_err());
        assert!(save_multimodal_blind_review_draft_archive_at(
            &root,
            &valid.replace(
                r#""updatedAt":"2026-07-22T00:00:00.000Z""#,
                r#""updatedAt":"2026-07-22T00:00:00.000Z","mediaPath":"C:/private.mkv""#
            )
        )
        .is_err());
        assert!(save_multimodal_blind_review_draft_archive_at(
            &root,
            &valid.replace(
                r#""boundaryToleranceMs":500"#,
                r#""boundaryToleranceMs":1001"#
            )
        )
        .is_err());
        assert!(!root.exists());
    }

    fn valid_synthetic_report_archive(release_eligible: bool) -> String {
        format!(
            r#"{{"schemaVersion":"alignment-synthetic-report-archive-v1","updatedAtMs":2,"entries":[{{"reportId":"sha256:{}","savedAtMs":2,"report":{{"schemaVersion":"alignment-synthetic-run-report-v2","manifestId":"manifest","datasetVersion":"v1","manifestDigest":"sha256:{}","status":"completed","startedAtMs":1,"completedAtMs":2,"configuration":{{}},"caseReceipts":[],"predictions":[],"result":{{}},"releaseEligible":false,"note":"programmatic-development-evidence-never-real-gold"}}}}],"releaseEligible":{},"note":"programmatic-development-evidence-never-real-gold"}}"#,
            "a".repeat(64),
            "b".repeat(64),
            release_eligible
        )
    }

    fn valid_multimodal_rule_snapshot_archive(
        release_eligible: bool,
        matching_identity: bool,
    ) -> String {
        let entry_digest = format!("sha256:{}", "a".repeat(64));
        let snapshot_digest = if matching_identity {
            entry_digest.clone()
        } else {
            format!("sha256:{}", "b".repeat(64))
        };
        format!(
            r#"{{"schemaVersion":"alignment-multimodal-rule-snapshot-archive-v1","updatedAtMs":2,"entries":[{{"snapshotId":"{entry_digest}","savedAtMs":2,"snapshot":{{"schemaVersion":"alignment-multimodal-rule-snapshot-v1","createdAt":"2026-07-22T00:00:00.000Z","containsSensitiveMediaDigests":true,"permission":"local-multimodal-shadow-association-only","releaseEligible":false,"timeMaps":[{{}}],"snapshotId":"{snapshot_digest}"}}}}],"containsSensitiveMediaDigests":true,"permission":"local-multimodal-rule-snapshot-archive-only","releaseEligible":{release_eligible}}}"#
        )
    }

    fn valid_multimodal_blind_review_draft_archive() -> String {
        format!(
            r#"{{"schemaVersion":"alignment-multimodal-blind-review-draft-archive-v1","entries":[{{"packId":"sha256:{}","currentTaskId":"sha256:{}","answers":[{{"taskId":"sha256:{}","decision":"matched","targetTimestampMs":11500,"boundaryToleranceMs":500,"precision":"frameAccurate"}}],"updatedAt":"2026-07-22T00:00:00.000Z"}}]}}"#,
            "a".repeat(64),
            "b".repeat(64),
            "b".repeat(64)
        )
    }
}
