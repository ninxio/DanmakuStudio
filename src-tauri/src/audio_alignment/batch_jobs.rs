//! In-process lifecycle for batch audio-alignment jobs.
//!
//! This module is the sole owner of the mutable batch-job registry, job and
//! terminal sequences, cancellation requests, diagnostic persistence, terminal
//! transitions, and bounded retention. The parent module plans and executes
//! alignment work, then submits lifecycle events or reads immutable snapshots.

use super::sensitive_manifest_journal::{
    AudioAlignmentSensitivePreparedMedia, SensitiveManifestJournal, SensitiveManifestWriteReport,
};
use super::*;

const MAX_DIAGNOSTIC_EVENTS: usize = 512;
const MAX_TERMINAL_JOBS: usize = 16;

pub(super) struct CreatedAudioAlignmentBatchJob {
    pub(super) job_id: String,
    pub(super) cancel_flag: Arc<AtomicBool>,
}

pub(super) enum AudioAlignmentBatchJobEvent<'a> {
    Phase {
        progress: f64,
        message: &'a str,
    },
    PairProgress {
        pair_index: usize,
        progress: f64,
        message: &'a str,
    },
    Diagnostic {
        level: AudioAlignmentBatchDiagnosticLevel,
        stage_key: &'a str,
        media_ordinal: Option<usize>,
        pair_ordinal: Option<usize>,
        message: &'a str,
        duration_ms: Option<u64>,
    },
    SensitivePrepared(Vec<AudioAlignmentSensitivePreparedMedia>),
    FineAttemptDetail(AudioAlignmentPersistentFineAttemptDetail),
    Commit {
        staged_results: Vec<StagedAudioAlignmentBatchPairResult>,
        force_cancelled: bool,
        validate: fn(usize, &[StagedAudioAlignmentBatchPairResult]) -> Result<bool, String>,
    },
    WorkerCancelled,
    WorkerLifecycleFailed {
        current_pair_index: usize,
    },
    WorkerInitializationFailed {
        current_pair_index: usize,
        error: &'a str,
    },
    FinalIdentityFailed,
    CommitFailed {
        internal_error: &'a str,
    },
    #[cfg(test)]
    CompletePair {
        pair_index: usize,
        proposal: Option<AudioAlignmentProposal>,
        error: Option<String>,
    },
    #[cfg(test)]
    Finalize,
}

struct AudioAlignmentBatchJobEntry {
    snapshot: AudioAlignmentBatchJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
    terminal_sequence: Option<u64>,
    started_at: Instant,
    next_diagnostic_sequence: u64,
    persistent_diagnostic_log: Option<AlignmentDiagnosticLogWriter>,
    sensitive_manifest: Option<SensitiveManifestJournal>,
}

static JOBS: OnceLock<Mutex<HashMap<String, AudioAlignmentBatchJobEntry>>> = OnceLock::new();
static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(super) fn create_job(
    plan: &PlannedAudioAlignmentBatch,
    diagnostic_root: Option<Result<PathBuf, String>>,
    sensitive_manifest_root: Option<Result<PathBuf, String>>,
) -> Result<CreatedAudioAlignmentBatchJob, String> {
    let job_id = next_job_id();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    insert_job(
        &job_id,
        plan,
        cancel_flag.clone(),
        diagnostic_root,
        sensitive_manifest_root,
    )?;
    Ok(CreatedAudioAlignmentBatchJob {
        job_id,
        cancel_flag,
    })
}

#[cfg(test)]
pub(super) fn insert_test_job(
    job_id: &str,
    plan: &PlannedAudioAlignmentBatch,
    cancel_flag: Arc<AtomicBool>,
    diagnostic_root: Option<Result<PathBuf, String>>,
    sensitive_manifest_root: Option<Result<PathBuf, String>>,
) -> Result<(), String> {
    insert_job(
        job_id,
        plan,
        cancel_flag,
        diagnostic_root,
        sensitive_manifest_root,
    )
}

#[cfg(test)]
pub(super) fn next_test_job_id(prefix: &str) -> String {
    let next = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}-{}-{}-{next}",
        current_time_ms(),
        std::process::id()
    )
}

pub(super) fn get_job(job_id: &str) -> Result<AudioAlignmentBatchJobSnapshot, String> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "批量音频对齐任务状态锁已损坏。".to_string())?;
    let entry = jobs
        .get_mut(job_id)
        .ok_or_else(|| "未找到批量音频对齐任务。".to_string())?;
    retry_sensitive_manifest_to_entry(entry);
    Ok(entry.snapshot.clone())
}

pub(super) fn remove_job(job_id: &str) -> Result<(), String> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "批量音频对齐任务状态锁已损坏。".to_string())?;
    jobs.remove(job_id);
    Ok(())
}

pub(super) fn request_cancellation(job_id: &str) -> Result<AudioAlignmentBatchJobSnapshot, String> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "批量音频对齐任务状态锁已损坏。".to_string())?;
    let entry = jobs
        .get_mut(job_id)
        .ok_or_else(|| "未找到批量音频对齐任务。".to_string())?;
    if matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        entry.cancel_flag.store(true, Ordering::Release);
        entry.snapshot.message =
            "正在取消整批音频对齐，等待当前媒体工具和算法安全退出。".to_string();
        entry.snapshot.updated_at_ms = current_time_ms();
    }
    retry_sensitive_manifest_to_entry(entry);
    Ok(entry.snapshot.clone())
}

pub(super) fn apply_event(
    job_id: &str,
    event: AudioAlignmentBatchJobEvent<'_>,
) -> Result<(), String> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "批量音频对齐任务状态锁已损坏。".to_string())?;
    let terminal = {
        let entry = jobs
            .get_mut(job_id)
            .ok_or_else(|| "未找到批量音频对齐任务。".to_string())?;
        match event {
            AudioAlignmentBatchJobEvent::Phase { progress, message } => {
                update_phase(entry, progress, message);
                false
            }
            AudioAlignmentBatchJobEvent::PairProgress {
                pair_index,
                progress,
                message,
            } => {
                update_pair_progress(entry, pair_index, progress, message)?;
                false
            }
            AudioAlignmentBatchJobEvent::Diagnostic {
                level,
                stage_key,
                media_ordinal,
                pair_ordinal,
                message,
                duration_ms,
            } => {
                append_diagnostic_event_to_entry(
                    entry,
                    level,
                    stage_key,
                    media_ordinal,
                    pair_ordinal,
                    message,
                    duration_ms,
                );
                entry.snapshot.updated_at_ms = current_time_ms();
                false
            }
            AudioAlignmentBatchJobEvent::SensitivePrepared(prepared_media) => {
                record_sensitive_manifest_prepared(entry, prepared_media);
                false
            }
            AudioAlignmentBatchJobEvent::FineAttemptDetail(detail) => {
                append_persistent_detail_to_entry(entry, &detail);
                false
            }
            AudioAlignmentBatchJobEvent::Commit {
                staged_results,
                force_cancelled,
                validate,
            } => commit_staged_results(entry, staged_results, force_cancelled, validate)?,
            AudioAlignmentBatchJobEvent::WorkerCancelled => {
                mark_cancelled(entry);
                mark_terminal(entry);
                true
            }
            AudioAlignmentBatchJobEvent::WorkerLifecycleFailed { current_pair_index } => {
                fail_worker(entry, current_pair_index)?;
                mark_terminal(entry);
                true
            }
            AudioAlignmentBatchJobEvent::WorkerInitializationFailed {
                current_pair_index,
                error,
            } => {
                fail_worker_with_error(entry, current_pair_index, error)?;
                mark_terminal(entry);
                true
            }
            AudioAlignmentBatchJobEvent::FinalIdentityFailed => {
                invalidate_after_final_identity_failure(entry)?;
                mark_terminal(entry);
                true
            }
            AudioAlignmentBatchJobEvent::CommitFailed { internal_error } => {
                invalidate_after_commit_failure(entry, internal_error)?;
                mark_terminal(entry);
                true
            }
            #[cfg(test)]
            AudioAlignmentBatchJobEvent::CompletePair {
                pair_index,
                proposal,
                error,
            } => {
                complete_pair(entry, pair_index, proposal, error)?;
                false
            }
            #[cfg(test)]
            AudioAlignmentBatchJobEvent::Finalize => finalize(entry),
        }
    };
    if terminal {
        prune_terminal_jobs(&mut jobs, Some(job_id));
    }
    Ok(())
}

fn jobs() -> &'static Mutex<HashMap<String, AudioAlignmentBatchJobEntry>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_job_id() -> String {
    let next = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "audio-align-batch-{}-{}-{next}",
        current_time_ms(),
        std::process::id()
    )
}

fn insert_job(
    job_id: &str,
    plan: &PlannedAudioAlignmentBatch,
    cancel_flag: Arc<AtomicBool>,
    diagnostic_root: Option<Result<PathBuf, String>>,
    sensitive_manifest_root: Option<Result<PathBuf, String>>,
) -> Result<(), String> {
    let started_at = Instant::now();
    let created_at_ms = current_time_ms();
    let pairs = plan
        .pairs
        .iter()
        .map(|pair| AudioAlignmentBatchPairSnapshot {
            pair_index: pair.pair_index,
            pair_ordinal: pair.pair_ordinal,
            source_media_id: pair.source_media_id.clone(),
            target_media_id: pair.target_media_id.clone(),
            status: AudioAlignmentJobStatus::Queued,
            progress: 0.0,
            message: "等待执行。".to_string(),
            relation_ranking: AudioAlignmentBatchRelationRankingSnapshot::pending(),
            global_selection: AudioAlignmentBatchGlobalSelectionSnapshot::pending(),
            fine_frontier: None,
            fine_execution_evidence: None,
            proposal: None,
            error: None,
        })
        .collect::<Vec<_>>();
    let total_pair_count = pairs.len();
    let queued_event = AudioAlignmentBatchDiagnosticEvent {
        sequence: 1,
        at_ms: created_at_ms,
        elapsed_ms: 0,
        level: AudioAlignmentBatchDiagnosticLevel::Info,
        stage_key: "batch.queued".to_string(),
        media_ordinal: None,
        pair_ordinal: None,
        message: "批量匹配已进入原生任务队列。".to_string(),
        duration_ms: None,
    };
    let mut diagnostic_events = vec![queued_event.clone()];
    let mut next_diagnostic_sequence = 2;
    let mut persistent_diagnostic_log = None;
    if let Some(root) = diagnostic_root {
        let writer = root.and_then(|root| {
            create_alignment_diagnostic_log(&root, job_id, created_at_ms).and_then(|mut writer| {
                writer.append_event(&queued_event)?;
                Ok(writer)
            })
        });
        match writer {
            Ok(mut writer) => {
                let enabled_event = AudioAlignmentBatchDiagnosticEvent {
                    sequence: next_diagnostic_sequence,
                    at_ms: current_time_ms(),
                    elapsed_ms: 0,
                    level: AudioAlignmentBatchDiagnosticLevel::Info,
                    stage_key: "logging.persistence-enabled".to_string(),
                    media_ordinal: None,
                    pair_ordinal: None,
                    message: "脱敏诊断日志已启用；可在批次诊断中查看运行编号并打开日志目录。"
                        .to_string(),
                    duration_ms: None,
                };
                if writer.append_event(&enabled_event).is_ok() {
                    diagnostic_events.push(enabled_event);
                    next_diagnostic_sequence = next_diagnostic_sequence.saturating_add(1);
                    persistent_diagnostic_log = Some(writer);
                } else {
                    diagnostic_events.push(audio_alignment_diagnostic_persistence_warning(
                        next_diagnostic_sequence,
                        created_at_ms,
                        0,
                    ));
                    next_diagnostic_sequence = next_diagnostic_sequence.saturating_add(1);
                }
            }
            Err(_) => {
                diagnostic_events.push(audio_alignment_diagnostic_persistence_warning(
                    next_diagnostic_sequence,
                    created_at_ms,
                    0,
                ));
                next_diagnostic_sequence = next_diagnostic_sequence.saturating_add(1);
            }
        }
    }
    let mut snapshot = AudioAlignmentBatchJobSnapshot {
        schema_version: AUDIO_ALIGNMENT_BATCH_SCHEMA_VERSION,
        evidence_version: AUDIO_ALIGNMENT_BATCH_EVIDENCE_VERSION,
        job_id: job_id.to_string(),
        pairing_mode: plan.pairing_mode.clone(),
        source_media_ids: plan.source_media_ids.clone(),
        target_media_ids: plan.target_media_ids.clone(),
        version_reuse_groups: plan
            .version_reuse_groups
            .iter()
            .map(|group| group.snapshot.clone())
            .collect(),
        status: AudioAlignmentJobStatus::Queued,
        progress: 0.0,
        message: "批量音频对齐任务已加入队列。".to_string(),
        total_pair_count,
        processed_pair_count: 0,
        failed_pair_count: 0,
        current_pair_ordinal: None,
        diagnostic_events,
        pairs,
        error: None,
        updated_at_ms: created_at_ms,
    };
    let mut sensitive_manifest = None;
    if let Some(root) = sensitive_manifest_root {
        let sensitive_event_sequence = next_diagnostic_sequence;
        next_diagnostic_sequence = next_diagnostic_sequence.saturating_add(1);
        let sensitive_enabled_event = AudioAlignmentBatchDiagnosticEvent {
            sequence: sensitive_event_sequence,
            at_ms: current_time_ms(),
            elapsed_ms: 0,
            level: AudioAlignmentBatchDiagnosticLevel::Info,
            stage_key: "logging.sensitive-manifest-enabled".to_string(),
            media_ordinal: None,
            pair_ordinal: None,
            message: "本机敏感执行清单已启用：保存完整媒体路径、内容身份、音轨和算法结果；该文件不可分享。"
                .to_string(),
            duration_ms: None,
        };
        snapshot
            .diagnostic_events
            .push(sensitive_enabled_event.clone());
        let state = root.and_then(|root| {
            let created =
                SensitiveManifestJournal::create(root, job_id, created_at_ms, plan, &snapshot)?;
            Ok((created.journal, created.report))
        });
        match state {
            Ok((state, report)) => {
                sensitive_manifest = Some(state);
                if report.summary_unavailable {
                    snapshot
                        .diagnostic_events
                        .push(AudioAlignmentBatchDiagnosticEvent {
                            sequence: next_diagnostic_sequence,
                            at_ms: current_time_ms(),
                            elapsed_ms: 0,
                            level: AudioAlignmentBatchDiagnosticLevel::Warning,
                            stage_key: "logging.sensitive-summary-unavailable".to_string(),
                            media_ordinal: None,
                            pair_ordinal: None,
                            message: "完整运行清单已保存，但本机训练证据索引暂时无法更新；可继续匹配并从证据目录恢复。"
                                .to_string(),
                            duration_ms: None,
                        });
                    next_diagnostic_sequence = next_diagnostic_sequence.saturating_add(1);
                }
            }
            Err(_) => {
                snapshot.diagnostic_events.pop();
                snapshot
                    .diagnostic_events
                    .push(audio_alignment_sensitive_manifest_warning(
                        sensitive_event_sequence,
                        created_at_ms,
                        0,
                    ));
            }
        }
    }
    let mut jobs = jobs()
        .lock()
        .map_err(|_| "批量音频对齐任务状态锁已损坏。".to_string())?;
    if jobs.contains_key(job_id) {
        return Err("批量音频对齐任务 ID 冲突。".to_string());
    }
    jobs.insert(
        job_id.to_string(),
        AudioAlignmentBatchJobEntry {
            snapshot,
            cancel_flag,
            terminal_sequence: None,
            started_at,
            next_diagnostic_sequence,
            persistent_diagnostic_log,
            sensitive_manifest,
        },
    );
    prune_terminal_jobs(&mut jobs, None);
    Ok(())
}

fn update_phase(entry: &mut AudioAlignmentBatchJobEntry, progress: f64, message: &str) {
    if !matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        return;
    }
    let message_changed = entry.snapshot.message != message;
    entry.snapshot.status = AudioAlignmentJobStatus::Running;
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.progress = entry.snapshot.progress.max(progress.clamp(0.0, 1.0));
    entry.snapshot.message = message.to_string();
    for pair in &mut entry.snapshot.pairs {
        if pair.status == AudioAlignmentJobStatus::Queued {
            pair.message = message.to_string();
        }
    }
    if message_changed {
        append_diagnostic_event_to_entry(
            entry,
            AudioAlignmentBatchDiagnosticLevel::Info,
            "batch.phase",
            None,
            None,
            message,
            None,
        );
    }
    entry.snapshot.updated_at_ms = current_time_ms();
}

fn update_pair_progress(
    entry: &mut AudioAlignmentBatchJobEntry,
    pair_index: usize,
    pair_progress: f64,
    message: &str,
) -> Result<(), String> {
    if !matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        return Ok(());
    }
    let clamped = pair_progress.clamp(0.0, 1.0);
    let (pair_ordinal, message_changed) = {
        let pair = entry
            .snapshot
            .pairs
            .get_mut(pair_index)
            .ok_or_else(|| "批量音频对齐 pair 索引越界。".to_string())?;
        let message_changed = pair.message != message;
        pair.status = AudioAlignmentJobStatus::Running;
        pair.progress = clamped;
        pair.message = message.to_string();
        (pair.pair_ordinal, message_changed)
    };
    entry.snapshot.status = AudioAlignmentJobStatus::Running;
    entry.snapshot.current_pair_ordinal = Some(pair_ordinal);
    let execution_progress =
        (pair_index as f64 + clamped) / entry.snapshot.total_pair_count.max(1) as f64;
    let weighted_progress = AUDIO_ALIGNMENT_BATCH_PREPARATION_END_PROGRESS
        + (1.0 - AUDIO_ALIGNMENT_BATCH_PREPARATION_END_PROGRESS) * execution_progress;
    entry.snapshot.progress = entry.snapshot.progress.max(weighted_progress);
    entry.snapshot.message = format!(
        "正在执行第 {pair_ordinal}/{} 个 pair：{message}",
        entry.snapshot.total_pair_count
    );
    if message_changed {
        append_diagnostic_event_to_entry(
            entry,
            AudioAlignmentBatchDiagnosticLevel::Info,
            "pair.progress",
            None,
            Some(pair_ordinal),
            message,
            None,
        );
    }
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

fn commit_staged_results(
    entry: &mut AudioAlignmentBatchJobEntry,
    staged_results: Vec<StagedAudioAlignmentBatchPairResult>,
    force_cancelled: bool,
    validate: fn(usize, &[StagedAudioAlignmentBatchPairResult]) -> Result<bool, String>,
) -> Result<bool, String> {
    if !matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        return Err("批量音频对齐任务已终止，不能提交 staged 结果。".to_string());
    }
    // Keep the parent-owned evidence rules inside the original lock interval:
    // validation precedes the cancellation decision, while completeness is
    // enforced only after cancellation has had its legacy chance to win.
    let complete = validate(entry.snapshot.total_pair_count, &staged_results)?;
    let cancelled = force_cancelled || entry.cancel_flag.load(Ordering::Acquire);
    if cancelled {
        mark_cancelled(entry);
        mark_terminal(entry);
        return Ok(true);
    }
    if !complete {
        return Err("批量音频对齐正常完成时缺少 staged pair 结果。".to_string());
    }
    for staged in staged_results {
        let pair = entry
            .snapshot
            .pairs
            .get_mut(staged.pair_index)
            .ok_or_else(|| "批量音频对齐 pair 索引越界。".to_string())?;
        pair.progress = 1.0;
        pair.relation_ranking = staged.relation_ranking;
        pair.global_selection = staged.global_selection;
        pair.fine_frontier = staged.fine_frontier;
        pair.fine_execution_evidence = staged.fine_execution_evidence;
        match staged.outcome {
            StagedAudioAlignmentBatchPairOutcome::Proposal(proposal) => {
                pair.status = AudioAlignmentJobStatus::Completed;
                pair.message = "当前 pair 已完成并通过批次最终身份复核。".to_string();
                pair.proposal = Some(*proposal);
                pair.error = None;
            }
            StagedAudioAlignmentBatchPairOutcome::Failed(error) => {
                pair.status = AudioAlignmentJobStatus::Failed;
                pair.message = "当前 pair 执行失败。".to_string();
                pair.proposal = None;
                pair.error = Some(error);
            }
        }
    }
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.progress = 1.0;
    entry.snapshot.processed_pair_count = entry.snapshot.total_pair_count;
    entry.snapshot.failed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Failed)
        .count();
    entry.snapshot.status = AudioAlignmentJobStatus::Completed;
    entry.snapshot.message = if entry.snapshot.failed_pair_count == 0 {
        format!(
            "批量音频对齐完成：{} 个 pair 均已真实执行。",
            entry.snapshot.total_pair_count
        )
    } else {
        format!(
            "批量音频对齐完成：{} 个成功，{} 个失败；成功结果已保留。",
            entry
                .snapshot
                .total_pair_count
                .saturating_sub(entry.snapshot.failed_pair_count),
            entry.snapshot.failed_pair_count
        )
    };
    entry.snapshot.error = None;
    entry.snapshot.updated_at_ms = current_time_ms();
    let persistent_pair_details = entry
        .snapshot
        .pairs
        .iter()
        .map(persistent_pair_result_detail)
        .collect::<Vec<_>>();
    for detail in &persistent_pair_details {
        append_persistent_detail_to_entry(entry, detail);
    }
    mark_terminal(entry);
    Ok(true)
}

fn append_diagnostic_event_to_entry(
    entry: &mut AudioAlignmentBatchJobEntry,
    level: AudioAlignmentBatchDiagnosticLevel,
    stage_key: &str,
    media_ordinal: Option<usize>,
    pair_ordinal: Option<usize>,
    message: &str,
    duration_ms: Option<u64>,
) {
    let stage_key = stage_key.trim();
    let message = message.trim();
    if stage_key.is_empty() || message.is_empty() {
        return;
    }
    let sequence = entry.next_diagnostic_sequence;
    entry.next_diagnostic_sequence = entry.next_diagnostic_sequence.saturating_add(1);
    let at_ms = current_time_ms();
    let elapsed_ms = u64::try_from(entry.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    let event = AudioAlignmentBatchDiagnosticEvent {
        sequence,
        at_ms,
        elapsed_ms,
        level,
        stage_key: stage_key.to_string(),
        media_ordinal,
        pair_ordinal,
        message: message.to_string(),
        duration_ms,
    };
    let persistence_failed = entry
        .persistent_diagnostic_log
        .as_mut()
        .is_some_and(|log| log.append_event(&event).is_err());
    entry.snapshot.diagnostic_events.push(event);
    if persistence_failed {
        entry.persistent_diagnostic_log = None;
        let warning_sequence = entry.next_diagnostic_sequence;
        entry.next_diagnostic_sequence = entry.next_diagnostic_sequence.saturating_add(1);
        entry
            .snapshot
            .diagnostic_events
            .push(audio_alignment_diagnostic_persistence_warning(
                warning_sequence,
                at_ms,
                elapsed_ms,
            ));
    }
    if entry.snapshot.diagnostic_events.len() > MAX_DIAGNOSTIC_EVENTS {
        let overflow = entry
            .snapshot
            .diagnostic_events
            .len()
            .saturating_sub(MAX_DIAGNOSTIC_EVENTS);
        entry.snapshot.diagnostic_events.drain(0..overflow);
    }
}

fn append_persistent_detail_to_entry<T: Serialize>(
    entry: &mut AudioAlignmentBatchJobEntry,
    detail: &T,
) {
    let persistence_failed = entry
        .persistent_diagnostic_log
        .as_mut()
        .is_some_and(|log| log.append_event(detail).is_err());
    if persistence_failed {
        entry.persistent_diagnostic_log = None;
        let warning_sequence = entry.next_diagnostic_sequence;
        entry.next_diagnostic_sequence = entry.next_diagnostic_sequence.saturating_add(1);
        entry
            .snapshot
            .diagnostic_events
            .push(audio_alignment_diagnostic_persistence_warning(
                warning_sequence,
                current_time_ms(),
                u64::try_from(entry.started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            ));
    }
}

fn mark_cancelled(entry: &mut AudioAlignmentBatchJobEntry) {
    for pair in &mut entry.snapshot.pairs {
        if matches!(
            pair.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        ) {
            pair.status = AudioAlignmentJobStatus::Cancelled;
            pair.progress = 1.0;
            pair.message = "批次已取消；当前或未开始的 pair 未产生结果。".to_string();
            pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::cancelled();
            pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::cancelled();
            pair.proposal = None;
            pair.error = None;
        }
    }
    entry.snapshot.status = AudioAlignmentJobStatus::Cancelled;
    entry.snapshot.progress = 1.0;
    entry.snapshot.message = "批量音频对齐已取消；此前已完成的 pair 结果已保留。".to_string();
    entry.snapshot.processed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| {
            matches!(
                pair.status,
                AudioAlignmentJobStatus::Completed | AudioAlignmentJobStatus::Failed
            )
        })
        .count();
    entry.snapshot.failed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Failed)
        .count();
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.error = None;
    entry.snapshot.updated_at_ms = current_time_ms();
}

fn record_sensitive_manifest_prepared(
    entry: &mut AudioAlignmentBatchJobEntry,
    prepared_media: Vec<AudioAlignmentSensitivePreparedMedia>,
) {
    let report = entry
        .sensitive_manifest
        .as_mut()
        .map(|journal| journal.record_prepared(prepared_media, &entry.snapshot));
    if let Some(report) = report {
        apply_sensitive_manifest_report(entry, report);
    }
}

fn retry_sensitive_manifest_to_entry(entry: &mut AudioAlignmentBatchJobEntry) {
    let report = entry
        .sensitive_manifest
        .as_mut()
        .and_then(SensitiveManifestJournal::retry_pending);
    if let Some(report) = report {
        apply_sensitive_manifest_report(entry, report);
    }
}

fn apply_sensitive_manifest_report(
    entry: &mut AudioAlignmentBatchJobEntry,
    report: SensitiveManifestWriteReport,
) {
    if report.summary_unavailable {
        append_diagnostic_event_to_entry(
            entry,
            AudioAlignmentBatchDiagnosticLevel::Warning,
            "logging.sensitive-summary-unavailable",
            None,
            None,
            "完整运行清单已保存，但本机训练证据索引暂时无法更新；可继续匹配并从证据目录恢复。",
            None,
        );
    }
    if report.manifest_became_unavailable {
        append_diagnostic_event_to_entry(
            entry,
            AudioAlignmentBatchDiagnosticLevel::Warning,
            "logging.sensitive-manifest-unavailable",
            None,
            None,
            "本机敏感执行清单更新失败；共享诊断与匹配结果继续保留，应用会在下次读取任务时重试。",
            None,
        );
    }
}

fn mark_terminal(entry: &mut AudioAlignmentBatchJobEntry) {
    if entry.terminal_sequence.is_none() {
        let (level, stage_key) = match entry.snapshot.status {
            AudioAlignmentJobStatus::Completed => {
                (AudioAlignmentBatchDiagnosticLevel::Info, "batch.completed")
            }
            AudioAlignmentJobStatus::Cancelled => (
                AudioAlignmentBatchDiagnosticLevel::Warning,
                "batch.cancelled",
            ),
            AudioAlignmentJobStatus::Failed => {
                (AudioAlignmentBatchDiagnosticLevel::Error, "batch.failed")
            }
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running => (
                AudioAlignmentBatchDiagnosticLevel::Warning,
                "batch.terminal-with-nonterminal-status",
            ),
        };
        let message = entry.snapshot.message.clone();
        let elapsed_ms = u64::try_from(entry.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        append_diagnostic_event_to_entry(
            entry,
            level,
            stage_key,
            None,
            None,
            &message,
            Some(elapsed_ms),
        );
        entry.terminal_sequence = Some(TERMINAL_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    }
    let report = entry
        .sensitive_manifest
        .as_mut()
        .map(|journal| journal.finish_terminal(&entry.snapshot));
    if let Some(report) = report {
        apply_sensitive_manifest_report(entry, report);
    }
}

fn prune_terminal_jobs(
    jobs: &mut HashMap<String, AudioAlignmentBatchJobEntry>,
    protected_job_id: Option<&str>,
) {
    let mut terminal_jobs = jobs
        .iter()
        .filter(|(_, entry)| {
            matches!(
                entry.snapshot.status,
                AudioAlignmentJobStatus::Completed
                    | AudioAlignmentJobStatus::Failed
                    | AudioAlignmentJobStatus::Cancelled
            )
        })
        .map(|(job_id, entry)| (entry.terminal_sequence.unwrap_or(u64::MAX), job_id.clone()))
        .collect::<Vec<_>>();
    let mut remove_count = terminal_jobs.len().saturating_sub(MAX_TERMINAL_JOBS);
    if remove_count == 0 {
        return;
    }
    terminal_jobs.sort_unstable();
    for (_, job_id) in terminal_jobs {
        if remove_count == 0 {
            break;
        }
        if protected_job_id == Some(job_id.as_str()) {
            continue;
        }
        jobs.remove(&job_id);
        remove_count -= 1;
    }
}

fn fail_worker(
    entry: &mut AudioAlignmentBatchJobEntry,
    current_pair_index: usize,
) -> Result<(), String> {
    let failed_pair_ordinal = entry
        .snapshot
        .pairs
        .get(current_pair_index)
        .map(|pair| pair.pair_ordinal)
        .ok_or_else(|| "批量音频对齐失败 pair 索引越界。".to_string())?;
    let failed_receipt = create_empty_audio_alignment_batch_fine_frontier_receipt(
        1,
        vec![failed_pair_ordinal],
        AudioAlignmentBatchFineFrontierStateSnapshot::Failed,
    )?;
    for (index, pair) in entry.snapshot.pairs.iter_mut().enumerate() {
        if index == current_pair_index
            && matches!(
                pair.status,
                AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
            )
        {
            pair.status = AudioAlignmentJobStatus::Failed;
            pair.progress = 1.0;
            pair.message = "底层媒体进程未能可信收尾；当前 pair 已失败。".to_string();
            pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::failed();
            pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::failed();
            pair.fine_frontier = Some(failed_receipt.clone());
            pair.fine_execution_evidence = None;
            pair.proposal = None;
            pair.error = Some("受监督媒体进程清理状态不可信。".to_string());
        } else if matches!(
            pair.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        ) {
            pair.status = AudioAlignmentJobStatus::Cancelled;
            pair.progress = 1.0;
            pair.message = "批次生命周期失败；该 pair 未执行。".to_string();
            pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::cancelled();
            pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::cancelled();
            pair.proposal = None;
            pair.error = None;
        }
    }
    entry.snapshot.status = AudioAlignmentJobStatus::Failed;
    entry.snapshot.progress = 1.0;
    entry.snapshot.message = "批量音频对齐因底层进程清理状态不可信而终止。".to_string();
    entry.snapshot.processed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| {
            matches!(
                pair.status,
                AudioAlignmentJobStatus::Completed | AudioAlignmentJobStatus::Failed
            )
        })
        .count();
    entry.snapshot.failed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Failed)
        .count();
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.error =
        Some("批量任务生命周期失败；后续普通对齐将保持 fail-closed。".to_string());
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

fn fail_worker_with_error(
    entry: &mut AudioAlignmentBatchJobEntry,
    current_pair_index: usize,
    error: &str,
) -> Result<(), String> {
    let safe_message = if error.starts_with("blocked:media-toolchain")
        || error.starts_with("unsupported:media-toolchain")
    {
        "FFmpeg/FFprobe 工具链无法固定或已变化；请检查工具安装后重试。"
    } else if error.starts_with("blocked:cuda") || error.starts_with("blocked:spectral-backend") {
        "CUDA/cuFFT 后端不可用或配置无效；请检查 NVIDIA 驱动与 CUDA 环境。"
    } else if error.starts_with("blocked:resource-limit") {
        "批量匹配超过当前内存或计算资源上限；请缩小批次后重试。"
    } else if error.starts_with("blocked:tool-stalled") {
        "媒体解码持续 2 分钟没有产生新音频数据，已自动终止；请检查对应文件和音轨后重试。"
    } else if error.starts_with("blocked:tool-timeout") {
        "媒体工具超过最长执行时限，已自动终止；请检查对应文件和媒体工具后重试。"
    } else if error.starts_with("blocked:physical-file")
        || error.starts_with("unsupported:physical-file")
    {
        "媒体文件无法取得稳定只读 lease；请确认文件位于受支持的本地磁盘且未被修改。"
    } else {
        "批量匹配初始化失败；本地路径与工具输出已隐藏，请检查素材和媒体工具配置。"
    }
    .to_string();
    let failed_pair_ordinal = entry
        .snapshot
        .pairs
        .get(current_pair_index)
        .map(|pair| pair.pair_ordinal)
        .ok_or_else(|| "批量音频对齐失败 pair 索引越界。".to_string())?;
    let failed_receipt = create_empty_audio_alignment_batch_fine_frontier_receipt(
        1,
        vec![failed_pair_ordinal],
        AudioAlignmentBatchFineFrontierStateSnapshot::Failed,
    )?;
    for (index, pair) in entry.snapshot.pairs.iter_mut().enumerate() {
        if index == current_pair_index
            && matches!(
                pair.status,
                AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
            )
        {
            pair.status = AudioAlignmentJobStatus::Failed;
            pair.progress = 1.0;
            pair.message = safe_message.clone();
            pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::failed();
            pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::failed();
            pair.fine_frontier = Some(failed_receipt.clone());
            pair.fine_execution_evidence = None;
            pair.proposal = None;
            pair.error = Some(safe_message.clone());
        } else if matches!(
            pair.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        ) {
            pair.status = AudioAlignmentJobStatus::Cancelled;
            pair.progress = 1.0;
            pair.message = "批次初始化失败；该 pair 未执行。".to_string();
            pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::cancelled();
            pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::cancelled();
            pair.proposal = None;
            pair.error = None;
        }
    }
    entry.snapshot.status = AudioAlignmentJobStatus::Failed;
    entry.snapshot.progress = 1.0;
    entry.snapshot.processed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Failed)
        .count();
    entry.snapshot.failed_pair_count = entry.snapshot.processed_pair_count;
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.message = safe_message.clone();
    entry.snapshot.error = Some(safe_message);
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

fn invalidate_after_final_identity_failure(
    entry: &mut AudioAlignmentBatchJobEntry,
) -> Result<(), String> {
    let failed_receipts = entry
        .snapshot
        .pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| {
            create_empty_audio_alignment_batch_fine_frontier_receipt(
                index + 1,
                vec![pair.pair_ordinal],
                AudioAlignmentBatchFineFrontierStateSnapshot::Failed,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (pair, failed_receipt) in entry.snapshot.pairs.iter_mut().zip(failed_receipts) {
        pair.status = AudioAlignmentJobStatus::Failed;
        pair.progress = 1.0;
        pair.message = "批次结束前媒体身份复核失败；该 pair 的结果已作废。".to_string();
        pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::failed();
        pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::failed();
        pair.fine_frontier = Some(failed_receipt);
        pair.fine_execution_evidence = None;
        pair.proposal = None;
        pair.error = Some("批次级 distinct-media 身份绑定失效。".to_string());
    }
    entry.snapshot.status = AudioAlignmentJobStatus::Failed;
    entry.snapshot.progress = 1.0;
    entry.snapshot.processed_pair_count = entry.snapshot.total_pair_count;
    entry.snapshot.failed_pair_count = entry.snapshot.total_pair_count;
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.message = "批次结束前媒体身份复核失败；所有 proposal 已清除。".to_string();
    entry.snapshot.error = Some("批次级 distinct-media 身份绑定失效。".to_string());
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

fn invalidate_after_commit_failure(
    entry: &mut AudioAlignmentBatchJobEntry,
    internal_error: &str,
) -> Result<(), String> {
    let failed_receipts = entry
        .snapshot
        .pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| {
            create_empty_audio_alignment_batch_fine_frontier_receipt(
                index + 1,
                vec![pair.pair_ordinal],
                AudioAlignmentBatchFineFrontierStateSnapshot::Failed,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let diagnostic_message = format!(
        "最终媒体身份复核已通过，但 staged 结果未通过证据合同校验；所有结果已作废。拒绝原因：{internal_error}"
    );
    append_diagnostic_event_to_entry(
        entry,
        AudioAlignmentBatchDiagnosticLevel::Error,
        "batch.evidence-contract-failed",
        None,
        None,
        &diagnostic_message,
        None,
    );
    for (pair, failed_receipt) in entry.snapshot.pairs.iter_mut().zip(failed_receipts) {
        pair.status = AudioAlignmentJobStatus::Failed;
        pair.progress = 1.0;
        pair.message = "批次最终证据合同校验失败；该 pair 的结果已作废。".to_string();
        pair.relation_ranking = AudioAlignmentBatchRelationRankingSnapshot::failed();
        pair.global_selection = AudioAlignmentBatchGlobalSelectionSnapshot::failed();
        pair.fine_frontier = Some(failed_receipt);
        pair.fine_execution_evidence = None;
        pair.proposal = None;
        pair.error = Some(
            "应用内部结果校验失败；素材未被判定为损坏，请保留任务日志并使用修复版本重试。"
                .to_string(),
        );
    }
    entry.snapshot.status = AudioAlignmentJobStatus::Failed;
    entry.snapshot.progress = 1.0;
    entry.snapshot.processed_pair_count = entry.snapshot.total_pair_count;
    entry.snapshot.failed_pair_count = entry.snapshot.total_pair_count;
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.message = "批次最终证据合同校验失败；所有 proposal 已清除。".to_string();
    entry.snapshot.error = Some(
        "应用内部结果校验失败；素材未被判定为损坏，请保留任务日志并使用修复版本重试。".to_string(),
    );
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

#[cfg(test)]
fn complete_pair(
    entry: &mut AudioAlignmentBatchJobEntry,
    pair_index: usize,
    proposal: Option<AudioAlignmentProposal>,
    error: Option<String>,
) -> Result<(), String> {
    let failed = error.is_some();
    let pair = entry
        .snapshot
        .pairs
        .get_mut(pair_index)
        .ok_or_else(|| "批量音频对齐 pair 索引越界。".to_string())?;
    pair.status = if failed {
        AudioAlignmentJobStatus::Failed
    } else {
        AudioAlignmentJobStatus::Completed
    };
    pair.progress = 1.0;
    pair.message = if failed {
        "当前 pair 执行失败。".to_string()
    } else {
        "当前 pair 已完成。".to_string()
    };
    pair.relation_ranking = if failed {
        AudioAlignmentBatchRelationRankingSnapshot::failed()
    } else {
        let (digest, identity) = test_audio_alignment_batch_execution_identity();
        AudioAlignmentBatchRelationRankingSnapshot::no_eligible_candidate(0, digest, identity)
    };
    pair.global_selection = if failed {
        AudioAlignmentBatchGlobalSelectionSnapshot::failed()
    } else {
        AudioAlignmentBatchGlobalSelectionSnapshot {
            state: AudioAlignmentBatchGlobalSelectionState::Blocked,
            ..AudioAlignmentBatchGlobalSelectionSnapshot::pending()
        }
    };
    pair.proposal = proposal;
    pair.error = error;
    entry.snapshot.processed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| {
            matches!(
                pair.status,
                AudioAlignmentJobStatus::Completed | AudioAlignmentJobStatus::Failed
            )
        })
        .count();
    entry.snapshot.failed_pair_count = entry
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Failed)
        .count();
    entry.snapshot.progress =
        entry.snapshot.processed_pair_count as f64 / entry.snapshot.total_pair_count.max(1) as f64;
    entry.snapshot.current_pair_ordinal = None;
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

#[cfg(test)]
fn finalize(entry: &mut AudioAlignmentBatchJobEntry) -> bool {
    if entry.cancel_flag.load(Ordering::Acquire) {
        mark_cancelled(entry);
    } else if !matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        return false;
    } else {
        entry.snapshot.current_pair_ordinal = None;
        entry.snapshot.progress = 1.0;
        entry.snapshot.processed_pair_count = entry.snapshot.total_pair_count;
        entry.snapshot.status = AudioAlignmentJobStatus::Completed;
        entry.snapshot.message = if entry.snapshot.failed_pair_count == 0 {
            format!(
                "批量音频对齐完成：{} 个 pair 均已真实执行。",
                entry.snapshot.total_pair_count
            )
        } else {
            format!(
                "批量音频对齐完成：{} 个成功，{} 个失败；成功结果已保留。",
                entry
                    .snapshot
                    .total_pair_count
                    .saturating_sub(entry.snapshot.failed_pair_count),
                entry.snapshot.failed_pair_count
            )
        };
        entry.snapshot.error = None;
        entry.snapshot.updated_at_ms = current_time_ms();
    }
    mark_terminal(entry);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_entry(
        job_id: &str,
        status: AudioAlignmentJobStatus,
        terminal_sequence: Option<u64>,
    ) -> AudioAlignmentBatchJobEntry {
        AudioAlignmentBatchJobEntry {
            snapshot: AudioAlignmentBatchJobSnapshot {
                schema_version: AUDIO_ALIGNMENT_BATCH_SCHEMA_VERSION,
                evidence_version: AUDIO_ALIGNMENT_BATCH_EVIDENCE_VERSION,
                job_id: job_id.to_string(),
                pairing_mode: AudioAlignmentBatchPairingMode::FullCartesian,
                source_media_ids: Vec::new(),
                target_media_ids: Vec::new(),
                version_reuse_groups: Vec::new(),
                status,
                progress: 0.0,
                message: String::new(),
                total_pair_count: 0,
                processed_pair_count: 0,
                failed_pair_count: 0,
                current_pair_ordinal: None,
                diagnostic_events: Vec::new(),
                pairs: Vec::new(),
                error: None,
                updated_at_ms: 0,
            },
            cancel_flag: Arc::new(AtomicBool::new(false)),
            terminal_sequence,
            started_at: Instant::now(),
            next_diagnostic_sequence: 1,
            persistent_diagnostic_log: None,
            sensitive_manifest: None,
        }
    }

    #[test]
    fn terminal_retention_is_bounded_without_evicting_active_jobs() {
        let mut jobs = HashMap::new();
        for index in 0..(MAX_TERMINAL_JOBS + 3) {
            let job_id = format!("terminal-{index:03}");
            jobs.insert(
                job_id.clone(),
                test_entry(
                    &job_id,
                    AudioAlignmentJobStatus::Completed,
                    Some(index as u64 + 1),
                ),
            );
        }
        jobs.insert(
            "queued-active".to_string(),
            test_entry("queued-active", AudioAlignmentJobStatus::Queued, None),
        );
        jobs.insert(
            "running-active".to_string(),
            test_entry("running-active", AudioAlignmentJobStatus::Running, None),
        );
        let protected = format!("terminal-{:03}", MAX_TERMINAL_JOBS + 2);

        prune_terminal_jobs(&mut jobs, Some(&protected));

        let retained_terminal_count = jobs
            .values()
            .filter(|entry| {
                matches!(
                    entry.snapshot.status,
                    AudioAlignmentJobStatus::Completed
                        | AudioAlignmentJobStatus::Failed
                        | AudioAlignmentJobStatus::Cancelled
                )
            })
            .count();
        assert_eq!(retained_terminal_count, MAX_TERMINAL_JOBS);
        assert!(jobs.contains_key("queued-active"));
        assert!(jobs.contains_key("running-active"));
        assert!(jobs.contains_key(&protected));
        assert!(!jobs.contains_key("terminal-000"));
        assert!(!jobs.contains_key("terminal-001"));
        assert!(!jobs.contains_key("terminal-002"));
    }
}
