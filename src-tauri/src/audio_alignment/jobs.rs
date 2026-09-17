//! In-process lifecycle for one audio-alignment job.
//!
//! The module owns the mutable registry, cancellation request semantics, bounded
//! user-facing logs, and progress-to-stage mapping. Callers only create, update,
//! query, cancel, or ask whether work is active; media decoding and alignment
//! algorithms stay outside this seam.

use super::{current_time_ms, AudioAlignmentJobStatus, AudioAlignmentProposal};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

const AUDIO_ALIGNMENT_STAGE_COUNT: u8 = 9;
const MAX_JOB_LOGS: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentJobSnapshot {
    pub(super) job_id: String,
    pub(super) status: AudioAlignmentJobStatus,
    pub(super) progress: f64,
    pub(super) message: String,
    pub(super) stage_key: String,
    pub(super) stage_label: String,
    pub(super) stage_index: u8,
    pub(super) stage_count: u8,
    pub(super) stage_progress: f64,
    pub(super) logs: Vec<String>,
    pub(super) proposal: Option<AudioAlignmentProposal>,
    pub(super) error: Option<String>,
    pub(super) updated_at_ms: u64,
}

pub(super) struct CreatedAudioAlignmentJob {
    pub(super) job_id: String,
    pub(super) cancel_flag: Arc<AtomicBool>,
}

struct AudioAlignmentJobEntry {
    snapshot: AudioAlignmentJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
}

struct AudioAlignmentStageSnapshot {
    key: &'static str,
    label: &'static str,
    index: u8,
    count: u8,
    progress: f64,
}

static JOBS: OnceLock<Mutex<HashMap<String, AudioAlignmentJobEntry>>> = OnceLock::new();
static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(super) fn create_job() -> Result<CreatedAudioAlignmentJob, String> {
    let next = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let job_id = format!("audio-align-{next}");
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let snapshot = AudioAlignmentJobSnapshot {
        job_id: job_id.clone(),
        status: AudioAlignmentJobStatus::Queued,
        progress: 0.0,
        message: "音频对齐任务已加入队列。".to_string(),
        stage_key: "queued".to_string(),
        stage_label: "排队".to_string(),
        stage_index: 0,
        stage_count: AUDIO_ALIGNMENT_STAGE_COUNT,
        stage_progress: 0.0,
        logs: vec!["音频对齐任务已加入队列。".to_string()],
        proposal: None,
        error: None,
        updated_at_ms: current_time_ms(),
    };
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    // Terminal proposals are recoverable in the project; bound the in-process registry.
    while jobs.len() >= 128 {
        let oldest = jobs.iter().filter(|(_, entry)| matches!(entry.snapshot.status,
            AudioAlignmentJobStatus::Completed | AudioAlignmentJobStatus::Failed | AudioAlignmentJobStatus::Cancelled))
            .min_by_key(|(_, entry)| entry.snapshot.updated_at_ms).map(|(id, _)| id.clone());
        if let Some(id) = oldest { jobs.remove(&id); } else {
            return Err("匹配任务过多，请等待正在执行的任务结束。".into());
        }
    }
    jobs.insert(
        job_id.clone(),
        AudioAlignmentJobEntry {
            snapshot,
            cancel_flag: cancel_flag.clone(),
        },
    );
    Ok(CreatedAudioAlignmentJob {
        job_id,
        cancel_flag,
    })
}

pub(super) fn get_job(job_id: &str) -> Result<AudioAlignmentJobSnapshot, String> {
    let jobs = jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    jobs.get(job_id)
        .map(|entry| entry.snapshot.clone())
        .ok_or_else(|| format!("未找到音频对齐任务：{job_id}"))
}

pub(super) fn request_cancellation(job_id: &str) -> Result<AudioAlignmentJobSnapshot, String> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    let entry = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("未找到音频对齐任务：{job_id}"))?;
    entry.cancel_flag.store(true, Ordering::Relaxed);
    if matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        // A cancellation request is deliberately non-terminal until the worker
        // has left FFmpeg and all CPU loops.
        entry.snapshot.message = "正在取消音频对齐任务，等待当前算法安全退出。".to_string();
        append_log(&mut entry.snapshot.logs, "已请求取消；任务仍在退出中。");
        entry.snapshot.updated_at_ms = current_time_ms();
    }
    Ok(entry.snapshot.clone())
}

pub(super) fn update_job(
    job_id: &str,
    status: AudioAlignmentJobStatus,
    progress: f64,
    message: &str,
    proposal: Option<AudioAlignmentProposal>,
    error: Option<String>,
) -> Result<(), String> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    let entry = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("未找到音频对齐任务：{job_id}"))?;
    if entry.snapshot.status == AudioAlignmentJobStatus::Cancelled
        && status != AudioAlignmentJobStatus::Cancelled
    {
        return Ok(());
    }
    entry.snapshot.status = status;
    entry.snapshot.progress = progress.clamp(0.0, 1.0);
    entry.snapshot.message = message.to_string();
    let stage = create_stage_snapshot(&entry.snapshot.status, entry.snapshot.progress);
    apply_stage_snapshot(&mut entry.snapshot, stage);
    append_log(&mut entry.snapshot.logs, message);
    if let Some(error_message) = &error {
        append_log(&mut entry.snapshot.logs, error_message);
    }
    entry.snapshot.proposal = proposal;
    entry.snapshot.error = error;
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

pub(super) fn has_active_jobs() -> Result<bool, String> {
    let jobs = jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    Ok(jobs.values().any(|entry| {
        matches!(
            entry.snapshot.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        )
    }))
}

fn jobs() -> &'static Mutex<HashMap<String, AudioAlignmentJobEntry>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn create_stage_snapshot(
    status: &AudioAlignmentJobStatus,
    progress: f64,
) -> AudioAlignmentStageSnapshot {
    if *status == AudioAlignmentJobStatus::Cancelled {
        return terminal_stage("cancelled", "已取消");
    }
    if *status == AudioAlignmentJobStatus::Failed {
        return terminal_stage("failed", "失败");
    }
    if *status == AudioAlignmentJobStatus::Completed {
        return terminal_stage("completed", "已完成");
    }
    let clamped = progress.clamp(0.0, 1.0);
    if clamped < 0.10 {
        create_stage_range("validating", "校验输入", 1, clamped, 0.0, 0.10)
    } else if clamped < 0.38 {
        create_stage_range(
            "extracting-complete",
            "提取完整版特征",
            2,
            clamped,
            0.10,
            0.38,
        )
    } else if clamped < 0.66 {
        create_stage_range(
            "extracting-source",
            "提取删减版特征",
            3,
            clamped,
            0.38,
            0.66,
        )
    } else if clamped < 0.76 {
        create_stage_range("extracting-visual", "提取视觉证据", 4, clamped, 0.66, 0.76)
    } else if clamped < 0.81 {
        create_stage_range("fingerprinting", "生成稀疏指纹", 5, clamped, 0.76, 0.81)
    } else if clamped < 0.87 {
        create_stage_range("matching", "建立候选观测", 6, clamped, 0.81, 0.87)
    } else if clamped < 0.92 {
        create_stage_range("fitting", "拟合时间映射", 7, clamped, 0.87, 0.92)
    } else if clamped < 0.97 {
        create_stage_range("refining", "确认持续变点", 8, clamped, 0.92, 0.97)
    } else {
        create_stage_range("reporting", "生成复核数据", 9, clamped, 0.97, 1.0)
    }
}

fn terminal_stage(key: &'static str, label: &'static str) -> AudioAlignmentStageSnapshot {
    AudioAlignmentStageSnapshot {
        key,
        label,
        index: AUDIO_ALIGNMENT_STAGE_COUNT,
        count: AUDIO_ALIGNMENT_STAGE_COUNT,
        progress: 1.0,
    }
}

fn create_stage_range(
    key: &'static str,
    label: &'static str,
    index: u8,
    progress: f64,
    start: f64,
    end: f64,
) -> AudioAlignmentStageSnapshot {
    let stage_progress = if end <= start {
        1.0
    } else {
        ((progress - start) / (end - start)).clamp(0.0, 1.0)
    };
    AudioAlignmentStageSnapshot {
        key,
        label,
        index,
        count: AUDIO_ALIGNMENT_STAGE_COUNT,
        progress: stage_progress,
    }
}

fn apply_stage_snapshot(
    snapshot: &mut AudioAlignmentJobSnapshot,
    stage: AudioAlignmentStageSnapshot,
) {
    snapshot.stage_key = stage.key.to_string();
    snapshot.stage_label = stage.label.to_string();
    snapshot.stage_index = stage.index;
    snapshot.stage_count = stage.count;
    snapshot.stage_progress = stage.progress;
}

fn append_log(logs: &mut Vec<String>, message: &str) {
    let trimmed = message.trim();
    if trimmed.is_empty() || logs.last().is_some_and(|last| last == trimmed) {
        return;
    }
    logs.push(trimmed.to_string());
    if logs.len() > MAX_JOB_LOGS {
        let overflow = logs.len() - MAX_JOB_LOGS;
        logs.drain(0..overflow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_alignment::AUDIO_ALIGNMENT_CANCELLED;

    const QUEUED_JOB_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/infrastructure/alignment/audioAlignmentJobSnapshot.contract.json"
    ));

    #[test]
    fn queued_snapshot_matches_the_cross_layer_json_contract() {
        let snapshot = AudioAlignmentJobSnapshot {
            job_id: "audio-align-contract-1".to_string(),
            status: AudioAlignmentJobStatus::Queued,
            progress: 0.0,
            message: "音频对齐任务已加入队列。".to_string(),
            stage_key: "queued".to_string(),
            stage_label: "排队".to_string(),
            stage_index: 0,
            stage_count: AUDIO_ALIGNMENT_STAGE_COUNT,
            stage_progress: 0.0,
            logs: vec!["音频对齐任务已加入队列。".to_string()],
            proposal: None,
            error: None,
            updated_at_ms: 1_700_000_000_000,
        };

        let actual = serde_json::to_value(snapshot).unwrap();
        let expected: serde_json::Value = serde_json::from_str(QUEUED_JOB_CONTRACT).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn job_updates_snapshot_through_the_module_interface() {
        let created = create_job().unwrap();
        update_job(
            &created.job_id,
            AudioAlignmentJobStatus::Running,
            0.35,
            "正在测试任务状态。",
            None,
            None,
        )
        .unwrap();

        let snapshot = get_job(&created.job_id).unwrap();
        assert_eq!(snapshot.status, AudioAlignmentJobStatus::Running);
        assert_eq!(snapshot.progress, 0.35);
        assert_eq!(snapshot.message, "正在测试任务状态。");
        assert_eq!(snapshot.stage_key, "extracting-complete");
        assert_eq!(snapshot.stage_label, "提取完整版特征");
        assert_eq!(snapshot.stage_index, 2);
        assert_eq!(snapshot.stage_count, AUDIO_ALIGNMENT_STAGE_COUNT);
        assert!(snapshot.stage_progress > 0.0);
        assert!(snapshot.logs.contains(&"正在测试任务状态。".to_string()));
    }

    #[test]
    fn cancellation_request_stays_non_terminal_until_the_worker_exits() {
        let created = create_job().unwrap();
        let cancelled = request_cancellation(&created.job_id).unwrap();
        assert_eq!(cancelled.status, AudioAlignmentJobStatus::Queued);
        assert!(cancelled.message.contains("正在取消"));
        assert!(created.cancel_flag.load(Ordering::Relaxed));

        update_job(
            &created.job_id,
            AudioAlignmentJobStatus::Cancelled,
            1.0,
            AUDIO_ALIGNMENT_CANCELLED,
            None,
            None,
        )
        .unwrap();

        let snapshot = get_job(&created.job_id).unwrap();
        assert_eq!(snapshot.status, AudioAlignmentJobStatus::Cancelled);
        assert_eq!(snapshot.message, AUDIO_ALIGNMENT_CANCELLED);
        assert!(snapshot.logs.iter().any(|line| line.contains("仍在退出中")));
    }

    #[test]
    fn logs_are_deduplicated_and_bounded() {
        let created = create_job().unwrap();
        for index in 0..(MAX_JOB_LOGS + 10) {
            update_job(
                &created.job_id,
                AudioAlignmentJobStatus::Running,
                0.5,
                &format!("日志 {index}"),
                None,
                None,
            )
            .unwrap();
        }
        update_job(
            &created.job_id,
            AudioAlignmentJobStatus::Running,
            0.5,
            "日志 89",
            None,
            None,
        )
        .unwrap();

        let snapshot = get_job(&created.job_id).unwrap();
        assert_eq!(snapshot.logs.len(), MAX_JOB_LOGS);
        assert_eq!(snapshot.logs.last().map(String::as_str), Some("日志 89"));
    }
}
