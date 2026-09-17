pub use crate::audio_alignment::sensitive_manifest_journal::AlignmentSensitiveManifestSummary;
#[cfg(test)]
use crate::audio_alignment::sensitive_manifest_journal::{
    alignment_sensitive_manifest_canonical_payload_digest,
    read_verified_alignment_sensitive_manifest_payload, write_alignment_sensitive_manifest,
    write_alignment_sensitive_manifest_summary, ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION,
    MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILES,
};
use crate::audio_alignment::sensitive_manifest_journal::{
    alignment_sensitive_manifest_root as journal_manifest_root,
    read_alignment_sensitive_manifest_summaries as journal_read_summaries,
    recover_abandoned_sensitive_manifests as journal_recover_abandoned,
};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

const ALIGNMENT_DIAGNOSTIC_DIRECTORY: &str = "alignment-diagnostics";
const ALIGNMENT_DIAGNOSTIC_SCHEMA_VERSION: u8 = 1;
const MAX_ALIGNMENT_DIAGNOSTIC_FILES: usize = 32;
const MAX_ALIGNMENT_DIAGNOSTIC_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ALIGNMENT_DIAGNOSTIC_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) struct AlignmentDiagnosticLogWriter {
    run_id: String,
    written_bytes: u64,
    writer: BufWriter<File>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentDiagnosticHeader<'a> {
    schema_version: u8,
    record_type: &'static str,
    run_id: &'a str,
    created_at_ms: u64,
    app_version: &'static str,
    privacy_mode: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentDiagnosticEventRecord<'a, T> {
    schema_version: u8,
    record_type: &'static str,
    run_id: &'a str,
    event: &'a T,
}

pub(crate) fn alignment_diagnostic_log_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(ALIGNMENT_DIAGNOSTIC_DIRECTORY))
        .map_err(|_| "无法定位桌面对齐诊断日志目录。".to_string())
}

pub(crate) fn alignment_sensitive_manifest_root(app: &AppHandle) -> Result<PathBuf, String> {
    journal_manifest_root(app)
}

fn read_alignment_sensitive_manifest_summaries(
    root: &Path,
) -> Result<Vec<AlignmentSensitiveManifestSummary>, String> {
    journal_read_summaries(root)
}

#[tauri::command]
pub fn list_alignment_sensitive_manifest_summaries(
    app: AppHandle,
) -> Result<Vec<AlignmentSensitiveManifestSummary>, String> {
    let root = alignment_sensitive_manifest_root(&app)?;
    read_alignment_sensitive_manifest_summaries(&root)
}

pub(crate) fn create_alignment_diagnostic_log(
    root: &Path,
    run_id: &str,
    created_at_ms: u64,
) -> Result<AlignmentDiagnosticLogWriter, String> {
    validate_run_id(run_id)?;
    fs::create_dir_all(root).map_err(|_| "无法创建桌面对齐诊断日志目录。".to_string())?;
    rotate_alignment_diagnostic_logs(root)?;
    let path = root.join(format!("{run_id}.jsonl"));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "无法创建本次对齐诊断日志。".to_string())?;
    let mut log = AlignmentDiagnosticLogWriter {
        run_id: run_id.to_string(),
        written_bytes: 0,
        writer: BufWriter::new(file),
    };
    log.write_record(&AlignmentDiagnosticHeader {
        schema_version: ALIGNMENT_DIAGNOSTIC_SCHEMA_VERSION,
        record_type: "runHeader",
        run_id,
        created_at_ms,
        app_version: env!("CARGO_PKG_VERSION"),
        privacy_mode: "path-free-content-free-v1",
    })?;
    Ok(log)
}

impl AlignmentDiagnosticLogWriter {
    pub(crate) fn append_event<T: Serialize>(&mut self, event: &T) -> Result<(), String> {
        let run_id = self.run_id.clone();
        self.write_record(&AlignmentDiagnosticEventRecord {
            schema_version: ALIGNMENT_DIAGNOSTIC_SCHEMA_VERSION,
            record_type: "diagnosticEvent",
            run_id: &run_id,
            event,
        })
    }

    fn write_record<T: Serialize>(&mut self, record: &T) -> Result<(), String> {
        let mut encoded =
            serde_json::to_vec(record).map_err(|_| "无法序列化对齐诊断事件。".to_string())?;
        encoded.push(b'\n');
        let encoded_bytes =
            u64::try_from(encoded.len()).map_err(|_| "对齐诊断事件长度无效。".to_string())?;
        let next_bytes = self
            .written_bytes
            .checked_add(encoded_bytes)
            .ok_or_else(|| "对齐诊断日志大小溢出。".to_string())?;
        if next_bytes > MAX_ALIGNMENT_DIAGNOSTIC_FILE_BYTES {
            return Err("本次对齐诊断日志已达到大小上限。".to_string());
        }
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.flush())
            .map_err(|_| "写入对齐诊断日志失败。".to_string())?;
        self.written_bytes = next_bytes;
        Ok(())
    }
}

#[tauri::command]
pub fn open_alignment_diagnostic_log_directory(app: AppHandle) -> Result<(), String> {
    let root = alignment_diagnostic_log_root(&app)?;
    fs::create_dir_all(&root).map_err(|_| "无法创建桌面对齐诊断日志目录。".to_string())?;
    open_directory(&root)
}

#[tauri::command]
pub fn open_alignment_sensitive_manifest_directory(app: AppHandle) -> Result<(), String> {
    let root = alignment_sensitive_manifest_root(&app)?;
    journal_recover_abandoned(&root)?;
    fs::create_dir_all(&root).map_err(|_| "无法创建本机敏感对齐执行清单目录。".to_string())?;
    open_directory(&root)
}

pub(crate) fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > 96
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("对齐诊断运行编号无效。".to_string());
    }
    Ok(())
}

fn rotate_alignment_diagnostic_logs(root: &Path) -> Result<(), String> {
    let mut files = fs::read_dir(root)
        .map_err(|_| "无法读取桌面对齐诊断日志目录。".to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file()
                || !entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                entry.path(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let mut total_bytes = files
        .iter()
        .fold(0_u64, |total, (_, _, bytes)| total.saturating_add(*bytes));
    while files.len() >= MAX_ALIGNMENT_DIAGNOSTIC_FILES
        || total_bytes.saturating_add(MAX_ALIGNMENT_DIAGNOSTIC_FILE_BYTES)
            > MAX_ALIGNMENT_DIAGNOSTIC_TOTAL_BYTES
    {
        let (path, _, bytes) = files.remove(0);
        fs::remove_file(path).map_err(|_| "无法轮转旧的桌面对齐诊断日志。".to_string())?;
        total_bytes = total_bytes.saturating_sub(bytes);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "打开桌面对齐诊断日志目录失败。".to_string())
}

#[cfg(target_os = "macos")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "打开桌面对齐诊断日志目录失败。".to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "打开桌面对齐诊断日志目录失败。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn test_directory(label: &str) -> PathBuf {
        let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "danmaku-timeline-diagnostic-{label}-{}-{sequence}",
            std::process::id()
        ))
    }

    fn ready_sensitive_summary(
        run_id: &str,
        manifest_payload_digest: String,
    ) -> AlignmentSensitiveManifestSummary {
        AlignmentSensitiveManifestSummary {
            run_id: run_id.to_string(),
            manifest_payload_digest,
            manifest_canonical_payload_digest: None,
            lifecycle_stage: "terminal".to_string(),
            created_at_ms: 100,
            updated_at_ms: 200,
            app_version: "0.1.0".to_string(),
            engine_version: "engine-test".to_string(),
            feature_version: "feature-test".to_string(),
            status: "completed".to_string(),
            source_media_count: 1,
            target_media_count: 1,
            pair_count: 1,
            processed_pair_count: 1,
            completed_pair_count: 1,
            failed_pair_count: 0,
            cancelled_pair_count: 0,
            prepared_media_count: 2,
            identified_media_count: 2,
            audio_candidate_count: 2,
            landmark_artifact_count: 2,
            landmark_cache_hit_count: 1,
            evidence_span_count: 3,
            uncertain_span_count: 1,
            visual_evidence_pair_count: 1,
            visual_evidence_requested: true,
            evidence_group_key: Some(format!("sha256:{}", "a".repeat(64))),
            intake_state: "ready".to_string(),
            ready_for_training_intake: true,
            review_candidate_pairs: Vec::new(),
            notes: vec!["可进入真实证据整理。".to_string()],
        }
    }

    #[test]
    fn writes_path_free_jsonl_header_and_events() {
        let root = test_directory("write");
        let run_id = "audio-align-batch-123-456-1";
        let mut writer = create_alignment_diagnostic_log(&root, run_id, 123).expect("create log");
        writer
            .append_event(&json!({
                "sequence": 1,
                "stageKey": "batch.queued",
                "message": "批量匹配已进入原生任务队列。"
            }))
            .expect("append event");
        drop(writer);

        let content = fs::read_to_string(root.join(format!("{run_id}.jsonl"))).expect("read log");
        let lines = content.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains(r#""privacyMode":"path-free-content-free-v1""#));
        assert!(lines[1].contains(r#""recordType":"diagnosticEvent""#));
        assert!(!content.contains(std::env::temp_dir().to_string_lossy().as_ref()));

        fs::remove_dir_all(root).expect("cleanup log root");
    }

    #[test]
    fn rejects_run_ids_that_could_escape_the_log_directory() {
        let root = test_directory("invalid");
        assert!(create_alignment_diagnostic_log(&root, "../private", 0).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn rotates_old_jsonl_files_before_starting_a_new_run() {
        let root = test_directory("rotate");
        fs::create_dir_all(&root).expect("create root");
        for index in 0..MAX_ALIGNMENT_DIAGNOSTIC_FILES {
            fs::write(root.join(format!("old-{index:02}.jsonl")), b"{}\n").expect("write old log");
        }
        fs::write(root.join("keep.txt"), b"not a diagnostic log").expect("write unrelated");

        let writer =
            create_alignment_diagnostic_log(&root, "audio-align-batch-new", 0).expect("new log");
        drop(writer);
        let jsonl_count = fs::read_dir(&root)
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "jsonl")
            })
            .count();
        assert!(jsonl_count <= MAX_ALIGNMENT_DIAGNOSTIC_FILES);
        assert!(root.join("keep.txt").exists());

        fs::remove_dir_all(root).expect("cleanup log root");
    }

    #[test]
    fn sensitive_manifest_is_digest_bound_and_atomically_replaced() {
        let root = test_directory("sensitive-replace");
        let run_id = "audio-align-batch-sensitive-1";
        let first = json!({
            "runId": run_id,
            "lifecycleStage": "queued",
            "media": [{"path": "F:\\private\\source.mkv"}]
        });
        let first_digest =
            write_alignment_sensitive_manifest(&root, run_id, &first).expect("write first");
        let first_envelope: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join(format!("{run_id}.json"))).expect("read first"),
        )
        .expect("parse first");
        assert_eq!(first_envelope["payloadDigest"], first_digest);
        assert_eq!(
            first_envelope["privacyClass"],
            "local-sensitive-full-media-v1"
        );
        assert_eq!(
            first_envelope["payload"]["media"][0]["path"],
            "F:\\private\\source.mkv"
        );

        let second = json!({
            "runId": run_id,
            "lifecycleStage": "terminal",
            "media": [{"path": "F:\\private\\source.mkv"}]
        });
        let second_digest =
            write_alignment_sensitive_manifest(&root, run_id, &second).expect("replace");
        assert_ne!(first_digest, second_digest);
        let second_content =
            fs::read_to_string(root.join(format!("{run_id}.json"))).expect("read second");
        assert!(second_content.contains(r#""lifecycleStage": "terminal""#));
        assert!(!fs::read_dir(&root)
            .expect("read root")
            .filter_map(Result::ok)
            .any(|entry| entry.path().extension().is_some_and(|value| value == "tmp")));

        fs::remove_dir_all(root).expect("cleanup sensitive root");
    }

    #[test]
    fn sensitive_manifest_summary_is_digest_bound_and_requires_its_manifest() {
        let root = test_directory("sensitive-summary");
        let run_id = "audio-align-batch-sensitive-summary-1";
        let payload_digest = write_alignment_sensitive_manifest(
            &root,
            run_id,
            &json!({"runId": run_id, "lifecycleStage": "terminal"}),
        )
        .expect("write manifest");
        let summary = ready_sensitive_summary(run_id, payload_digest);
        write_alignment_sensitive_manifest_summary(&root, &summary).expect("write summary");

        let listed = read_alignment_sensitive_manifest_summaries(&root).expect("read summaries");
        assert_eq!(listed, vec![summary.clone()]);

        let summary_path = root.join(format!(
            "{run_id}.{}",
            ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION
        ));
        let mut tampered: serde_json::Value =
            serde_json::from_slice(&fs::read(&summary_path).expect("read summary"))
                .expect("parse summary");
        tampered["summary"]["uncertainSpanCount"] = json!(2);
        fs::write(
            &summary_path,
            serde_json::to_vec_pretty(&tampered).expect("encode tampered"),
        )
        .expect("write tampered");
        assert!(read_alignment_sensitive_manifest_summaries(&root)
            .expect_err("tampered summary must fail")
            .contains("摘要校验失败"));

        write_alignment_sensitive_manifest_summary(&root, &summary).expect("restore summary");
        fs::remove_file(root.join(format!("{run_id}.json"))).expect("remove manifest");
        assert!(read_alignment_sensitive_manifest_summaries(&root)
            .expect_err("orphan summary must fail")
            .contains("完整运行清单不存在"));

        fs::remove_dir_all(root).expect("cleanup sensitive root");
    }

    #[test]
    fn listing_cleans_an_abandoned_nonterminal_sensitive_manifest() {
        let root = test_directory("sensitive-abandoned");
        let run_id = "audio-align-batch-sensitive-abandoned-1";
        let payload = json!({
            "runId": run_id,
            "lifecycleStage": "prepared",
            "snapshot": {"status": "running"}
        });
        let payload_digest =
            write_alignment_sensitive_manifest(&root, run_id, &payload).expect("write prepared");
        let mut summary = ready_sensitive_summary(run_id, payload_digest);
        summary.lifecycle_stage = "prepared".to_string();
        summary.status = "running".to_string();
        summary.processed_pair_count = 0;
        summary.completed_pair_count = 0;
        summary.intake_state = "collecting".to_string();
        summary.ready_for_training_intake = false;
        summary.review_candidate_pairs.clear();
        write_alignment_sensitive_manifest_summary(&root, &summary)
            .expect("write prepared summary");
        let abandoned_temp = root.join(format!(".{run_id}.json.999.1.tmp"));
        fs::write(&abandoned_temp, b"partial-sensitive-bytes").expect("write abandoned temp");

        let listed = read_alignment_sensitive_manifest_summaries(&root)
            .expect("abandoned prepared run should be cleaned");
        assert!(listed.is_empty());
        assert!(!root.join(format!("{run_id}.json")).exists());
        assert!(!root.join(format!("{run_id}.summary")).exists());
        assert!(!abandoned_temp.exists());

        fs::remove_dir_all(root).expect("cleanup abandoned root");
    }

    #[test]
    fn listing_discards_a_prepared_summary_left_behind_a_terminal_manifest() {
        let root = test_directory("sensitive-terminal-summary-crash");
        let run_id = "audio-align-batch-sensitive-terminal-summary-crash-1";
        let prepared_digest = write_alignment_sensitive_manifest(
            &root,
            run_id,
            &json!({
                "runId": run_id,
                "lifecycleStage": "prepared",
                "snapshot": {"status": "running"}
            }),
        )
        .expect("write prepared manifest");
        let mut prepared_summary = ready_sensitive_summary(run_id, prepared_digest);
        prepared_summary.lifecycle_stage = "prepared".to_string();
        prepared_summary.status = "running".to_string();
        prepared_summary.processed_pair_count = 0;
        prepared_summary.completed_pair_count = 0;
        prepared_summary.intake_state = "collecting".to_string();
        prepared_summary.ready_for_training_intake = false;
        write_alignment_sensitive_manifest_summary(&root, &prepared_summary)
            .expect("write prepared summary");

        write_alignment_sensitive_manifest(
            &root,
            run_id,
            &json!({
                "runId": run_id,
                "lifecycleStage": "terminal",
                "snapshot": {"status": "completed"}
            }),
        )
        .expect("replace terminal manifest before simulated crash");

        let listed = read_alignment_sensitive_manifest_summaries(&root)
            .expect("stale prepared summary should be cleaned fail-closed");
        assert!(listed.is_empty());
        assert!(root.join(format!("{run_id}.json")).exists());
        assert!(!root.join(format!("{run_id}.summary")).exists());

        fs::remove_dir_all(root).expect("cleanup terminal crash root");
    }

    #[test]
    fn verified_sensitive_manifest_rejects_payload_tampering_and_legacy_summaries() {
        let root = test_directory("sensitive-canonical-binding");
        let run_id = "audio-align-batch-sensitive-canonical-1";
        let payload = json!({
            "runId": run_id,
            "lifecycleStage": "terminal",
            "snapshot": {"status": "completed"}
        });
        let payload_digest =
            write_alignment_sensitive_manifest(&root, run_id, &payload).expect("write manifest");
        let mut legacy_summary = ready_sensitive_summary(run_id, payload_digest);
        write_alignment_sensitive_manifest_summary(&root, &legacy_summary)
            .expect("write legacy summary");
        assert!(
            read_verified_alignment_sensitive_manifest_payload(&root, run_id)
                .expect_err("legacy summary must require rerun")
                .contains("旧运行缺少完整内容防篡改绑定")
        );

        legacy_summary.manifest_canonical_payload_digest = Some(
            alignment_sensitive_manifest_canonical_payload_digest(&payload)
                .expect("canonical digest"),
        );
        write_alignment_sensitive_manifest_summary(&root, &legacy_summary)
            .expect("write canonical summary");
        let (_, verified) = read_verified_alignment_sensitive_manifest_payload(&root, run_id)
            .expect("verified manifest");
        assert_eq!(verified, payload);

        let manifest_path = root.join(format!("{run_id}.json"));
        let mut tampered: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read manifest"))
                .expect("parse manifest");
        tampered["payload"]["snapshot"]["status"] = json!("failed");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&tampered).expect("encode tampered manifest"),
        )
        .expect("write tampered manifest");
        assert!(
            read_verified_alignment_sensitive_manifest_payload(&root, run_id)
                .expect_err("tampered payload must fail")
                .contains("完整内容摘要校验失败")
        );

        fs::remove_dir_all(root).expect("cleanup sensitive root");
    }

    #[test]
    fn sensitive_manifest_rotation_accounts_for_the_incoming_replacement() {
        let root = test_directory("sensitive-rotate");
        fs::create_dir_all(&root).expect("create root");
        for index in 0..MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILES {
            fs::write(root.join(format!("old-{index:02}.json")), b"{}")
                .expect("write old manifest");
            fs::write(
                root.join(format!(
                    "old-{index:02}.{}",
                    ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION
                )),
                b"{}",
            )
            .expect("write old summary");
        }
        fs::write(root.join("keep.txt"), b"unrelated").expect("write unrelated");

        write_alignment_sensitive_manifest(
            &root,
            "audio-align-batch-new-sensitive",
            &json!({"stage": "queued"}),
        )
        .expect("write incoming manifest");

        let json_files = fs::read_dir(&root)
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "json")
            })
            .collect::<Vec<_>>();
        assert_eq!(json_files.len(), MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILES);
        let summary_files = fs::read_dir(&root)
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION)
            })
            .count();
        assert_eq!(summary_files, MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILES - 1);
        assert!(root.join("audio-align-batch-new-sensitive.json").exists());
        assert!(root.join("keep.txt").exists());

        fs::remove_dir_all(root).expect("cleanup sensitive root");
    }
}
