use super::benchmark_telemetry::{
    AlignmentBenchmarkCancellationTelemetry, AlignmentBenchmarkJobTelemetry,
    AlignmentBenchmarkRunTelemetry, ProcessTreeMemorySample,
};
use super::{AlignmentBenchmarkJobSnapshot, AudioAlignmentJobStatus, AudioAlignmentProposal};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

const MISSING_BENCHMARK_JOB_PREFIX: &str = "基准会话中不存在任务";

#[derive(Default)]
pub(super) struct AlignmentBenchmarkJobRegistry {
    entries: HashMap<String, AlignmentBenchmarkJobEntry>,
    active_job_id: Option<String>,
}

struct AlignmentBenchmarkJobEntry {
    snapshot: AlignmentBenchmarkJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    pending_terminal: Option<AlignmentBenchmarkTerminalOutcome>,
    deferred_terminal_accepted: bool,
    #[cfg(test)]
    force_terminal_telemetry_failure: bool,
}

pub(super) struct AlignmentBenchmarkTerminalOutcome {
    status: AudioAlignmentJobStatus,
    proposal: Option<AudioAlignmentProposal>,
    error_code: Option<String>,
}

impl AlignmentBenchmarkTerminalOutcome {
    pub(super) fn completed(proposal: AudioAlignmentProposal) -> Self {
        Self {
            status: AudioAlignmentJobStatus::Completed,
            proposal: Some(proposal),
            error_code: None,
        }
    }

    pub(super) fn failed(error_code: &'static str) -> Self {
        Self {
            status: AudioAlignmentJobStatus::Failed,
            proposal: None,
            error_code: Some(error_code.to_string()),
        }
    }

    pub(super) fn cancelled() -> Self {
        Self {
            status: AudioAlignmentJobStatus::Cancelled,
            proposal: None,
            error_code: None,
        }
    }
}

pub(super) struct AlignmentBenchmarkJobLifecycleView {
    pub(super) active_job_id: Option<String>,
    pub(super) pending_job_ids: Vec<String>,
    pub(super) has_non_terminal: bool,
}

#[derive(Debug)]
pub(super) struct AlignmentBenchmarkTerminalRecord {
    pub(super) job_id: String,
    pub(super) status: AudioAlignmentJobStatus,
    pub(super) telemetry: AlignmentBenchmarkJobTelemetry,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AlignmentBenchmarkTerminalRecordsError {
    NonTerminal,
    Telemetry(String),
}

impl AlignmentBenchmarkJobRegistry {
    pub(super) fn lifecycle_view(&self) -> AlignmentBenchmarkJobLifecycleView {
        let mut pending_job_ids = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.pending_terminal.is_some())
            .map(|(job_id, _)| job_id.clone())
            .collect::<Vec<_>>();
        pending_job_ids.sort();
        AlignmentBenchmarkJobLifecycleView {
            active_job_id: self.active_job_id.clone(),
            pending_job_ids,
            has_non_terminal: self.entries.values().any(|entry| {
                matches!(
                    entry.snapshot.status,
                    AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
                )
            }),
        }
    }

    pub(super) fn register(
        &mut self,
        job_id: String,
        snapshot: AlignmentBenchmarkJobSnapshot,
        cancel_flag: Arc<AtomicBool>,
        telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    ) -> Result<(), String> {
        if self.active_job_id.is_some() {
            return Err("同一基准会话一次只能运行一个任务。".to_string());
        }
        if self.entries.contains_key(&job_id) {
            return Err(format!("基准会话中已存在任务：{job_id}"));
        }
        self.active_job_id = Some(job_id.clone());
        self.entries.insert(
            job_id,
            AlignmentBenchmarkJobEntry {
                snapshot,
                cancel_flag,
                telemetry,
                pending_terminal: None,
                deferred_terminal_accepted: false,
                #[cfg(test)]
                force_terminal_telemetry_failure: false,
            },
        );
        Ok(())
    }

    pub(super) fn snapshot(
        &mut self,
        job_id: &str,
    ) -> Result<AlignmentBenchmarkJobSnapshot, String> {
        let entry = self.entry_mut(job_id)?;
        refresh_snapshot(entry)?;
        Ok(entry.snapshot.clone())
    }

    pub(super) fn request_cancellation(
        &mut self,
        job_id: &str,
    ) -> Result<AlignmentBenchmarkJobSnapshot, String> {
        let entry = self.entry_mut(job_id)?;
        if matches!(
            entry.snapshot.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        ) && entry.pending_terminal.is_none()
        {
            let cancel_tick = entry.telemetry.record_cancel_request()?;
            entry.cancel_flag.store(true, Ordering::Release);
            entry.snapshot.telemetry.cancellation = Some(AlignmentBenchmarkCancellationTelemetry {
                request_tick_ns: cancel_tick.to_string(),
                terminal_tick_ns: String::new(),
                latency_ms: 0.0,
                command_accepted: true,
            });
        }
        refresh_snapshot(entry)?;
        Ok(entry.snapshot.clone())
    }

    pub(super) fn mark_running(&mut self, job_id: &str) -> bool {
        let Some(entry) = self.active_non_terminal_entry_mut(job_id) else {
            return false;
        };
        if entry.deferred_terminal_accepted {
            return false;
        }
        let Ok((stage_key, stage_label)) = entry.telemetry.current_stage() else {
            return false;
        };
        let Ok(telemetry) = entry.telemetry.snapshot() else {
            return false;
        };
        entry.snapshot.status = AudioAlignmentJobStatus::Running;
        entry.snapshot.stage_key = stage_key;
        entry.snapshot.stage_label = stage_label;
        entry.snapshot.proposal = None;
        entry.snapshot.error_code = None;
        entry.snapshot.telemetry = telemetry;
        true
    }

    pub(super) fn pending_cleanup(&self, job_id: &str) -> Result<bool, String> {
        self.entries
            .get(job_id)
            .map(|entry| entry.pending_terminal.is_some())
            .ok_or_else(|| missing_job(job_id))
    }

    pub(super) fn record_cleanup_memory_sample(
        &self,
        job_id: &str,
        observed_at: Instant,
        sample: Result<ProcessTreeMemorySample, String>,
        baseline_descendants: &HashSet<u32>,
        residual_count: Option<usize>,
    ) {
        let Some(entry) = self.active_non_terminal_entry(job_id) else {
            return;
        };
        entry
            .telemetry
            .record_memory_sample(observed_at, sample, baseline_descendants);
        if let Some(residual_count) = residual_count {
            let _ = entry.telemetry.set_residual_process_count(residual_count);
        }
    }

    pub(super) fn defer_terminal_for_cleanup(
        &mut self,
        job_id: &str,
        outcome: AlignmentBenchmarkTerminalOutcome,
    ) -> bool {
        let Some(entry) = self.active_non_terminal_entry_mut(job_id) else {
            return false;
        };
        if entry.deferred_terminal_accepted || entry.pending_terminal.is_some() {
            return false;
        }
        entry.deferred_terminal_accepted = true;
        entry.pending_terminal = Some(outcome);
        entry.snapshot.status = AudioAlignmentJobStatus::Running;
        entry.snapshot.error_code = Some("cleanup-blocked".to_string());
        if let Ok(telemetry) = entry.telemetry.snapshot() {
            entry.snapshot.telemetry = telemetry;
        }
        true
    }

    pub(super) fn take_pending_terminal(
        &mut self,
        job_id: &str,
    ) -> Option<AlignmentBenchmarkTerminalOutcome> {
        self.active_non_terminal_entry_mut(job_id)
            .and_then(|entry| entry.pending_terminal.take())
    }

    pub(super) fn finalize_terminal(
        &mut self,
        job_id: &str,
        outcome: AlignmentBenchmarkTerminalOutcome,
    ) -> bool {
        {
            let Some(entry) = self.active_non_terminal_entry_mut(job_id) else {
                return false;
            };
            if entry.pending_terminal.is_some() {
                return false;
            }
            let _ = entry.telemetry.set_residual_process_count(0);
            let _ = entry.telemetry.finish(outcome.status);
            let (stage_key, stage_label) = match outcome.status {
                AudioAlignmentJobStatus::Completed => ("completed", "已完成"),
                AudioAlignmentJobStatus::Failed => ("failed", "失败"),
                AudioAlignmentJobStatus::Cancelled => ("cancelled", "已取消"),
                _ => ("reporting", "生成复核数据"),
            };
            entry.snapshot.status = outcome.status;
            entry.snapshot.stage_key = stage_key.to_string();
            entry.snapshot.stage_label = stage_label.to_string();
            entry.snapshot.proposal = outcome.proposal;
            entry.snapshot.error_code = outcome.error_code;
            if let Ok(telemetry) = entry.telemetry.snapshot() {
                entry.snapshot.telemetry = telemetry;
            }
        }
        self.active_job_id = None;
        true
    }

    pub(super) fn terminal_records(
        &self,
    ) -> Result<Vec<AlignmentBenchmarkTerminalRecord>, AlignmentBenchmarkTerminalRecordsError> {
        let mut records = self
            .entries
            .iter()
            .map(|(job_id, entry)| {
                if !is_terminal(entry.snapshot.status) {
                    return Err(AlignmentBenchmarkTerminalRecordsError::NonTerminal);
                }
                #[cfg(test)]
                if entry.force_terminal_telemetry_failure {
                    return Err(AlignmentBenchmarkTerminalRecordsError::Telemetry(
                        "test telemetry snapshot failure".to_string(),
                    ));
                }
                let telemetry = entry
                    .telemetry
                    .snapshot()
                    .map_err(AlignmentBenchmarkTerminalRecordsError::Telemetry)?;
                Ok(AlignmentBenchmarkTerminalRecord {
                    job_id: job_id.clone(),
                    status: entry.snapshot.status,
                    telemetry,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        records.sort_by(|left, right| left.job_id.cmp(&right.job_id));
        Ok(records)
    }

    pub(super) fn clear_for_session_release(&mut self) {
        self.entries.clear();
        self.active_job_id = None;
    }

    fn entry_mut(&mut self, job_id: &str) -> Result<&mut AlignmentBenchmarkJobEntry, String> {
        self.entries
            .get_mut(job_id)
            .ok_or_else(|| missing_job(job_id))
    }

    fn active_non_terminal_entry(&self, job_id: &str) -> Option<&AlignmentBenchmarkJobEntry> {
        if self.active_job_id.as_deref() != Some(job_id) {
            return None;
        }
        self.entries
            .get(job_id)
            .filter(|entry| is_non_terminal(entry.snapshot.status))
    }

    fn active_non_terminal_entry_mut(
        &mut self,
        job_id: &str,
    ) -> Option<&mut AlignmentBenchmarkJobEntry> {
        if self.active_job_id.as_deref() != Some(job_id) {
            return None;
        }
        self.entries
            .get_mut(job_id)
            .filter(|entry| is_non_terminal(entry.snapshot.status))
    }

    #[cfg(test)]
    fn force_terminal_telemetry_failure(&mut self, job_id: &str) {
        self.entries
            .get_mut(job_id)
            .expect("registered test benchmark job")
            .force_terminal_telemetry_failure = true;
    }
}

fn refresh_snapshot(entry: &mut AlignmentBenchmarkJobEntry) -> Result<(), String> {
    if matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        let (stage_key, stage_label) = entry.telemetry.current_stage()?;
        entry.snapshot.stage_key = stage_key;
        entry.snapshot.stage_label = stage_label;
    }
    entry.snapshot.telemetry = entry.telemetry.snapshot()?;
    Ok(())
}

fn missing_job(job_id: &str) -> String {
    format!("{MISSING_BENCHMARK_JOB_PREFIX}：{job_id}")
}

fn is_terminal(status: AudioAlignmentJobStatus) -> bool {
    matches!(
        status,
        AudioAlignmentJobStatus::Completed
            | AudioAlignmentJobStatus::Failed
            | AudioAlignmentJobStatus::Cancelled
    )
}

fn is_non_terminal(status: AudioAlignmentJobStatus) -> bool {
    matches!(
        status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    )
}

#[cfg(test)]
mod tests {
    use super::{
        AlignmentBenchmarkJobRegistry, AlignmentBenchmarkTerminalOutcome,
        AlignmentBenchmarkTerminalRecordsError,
    };
    use crate::audio_alignment::{
        benchmark_telemetry::{
            AlignmentBenchmarkCacheCounts, AlignmentBenchmarkRunTelemetry, ProcessTreeMemorySample,
        },
        AlignmentBenchmarkJobSnapshot, AudioAlignmentJobStatus, ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
    };
    use std::{
        collections::HashSet,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Instant,
    };

    fn test_job(
        job_id: &str,
    ) -> (
        AlignmentBenchmarkJobSnapshot,
        Arc<AtomicBool>,
        Arc<AlignmentBenchmarkRunTelemetry>,
    ) {
        let telemetry = Arc::new(AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            100,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        ));
        let snapshot = AlignmentBenchmarkJobSnapshot {
            schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
            session_id: "session-test".to_string(),
            job_id: job_id.to_string(),
            status: AudioAlignmentJobStatus::Queued,
            stage_key: "queued".to_string(),
            stage_label: "排队".to_string(),
            proposal: None,
            error_code: None,
            telemetry: telemetry.snapshot().unwrap(),
        };
        (snapshot, Arc::new(AtomicBool::new(false)), telemetry)
    }

    fn register_test_job(
        registry: &mut AlignmentBenchmarkJobRegistry,
        job_id: &str,
    ) -> (Arc<AtomicBool>, Arc<AlignmentBenchmarkRunTelemetry>) {
        let (snapshot, cancel_flag, telemetry) = test_job(job_id);
        registry
            .register(
                job_id.to_string(),
                snapshot,
                cancel_flag.clone(),
                telemetry.clone(),
            )
            .unwrap();
        (cancel_flag, telemetry)
    }

    #[test]
    fn register_enforces_single_active_until_terminal_finalize() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        register_test_job(&mut registry, "job-b");
        let (snapshot, cancel_flag, telemetry) = test_job("job-a");
        assert!(registry
            .register("job-a".to_string(), snapshot, cancel_flag, telemetry)
            .unwrap_err()
            .contains("一次只能运行一个任务"));

        assert!(registry.finalize_terminal(
            "job-b",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        assert!(registry.lifecycle_view().active_job_id.is_none());

        let (snapshot, cancel_flag, telemetry) = test_job("job-a");
        registry
            .register("job-a".to_string(), snapshot, cancel_flag, telemetry)
            .unwrap();
        assert_eq!(
            registry.lifecycle_view().active_job_id.as_deref(),
            Some("job-a")
        );
    }

    #[test]
    fn stale_terminal_mutations_cannot_release_or_revive_the_current_active_job() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        let (_, stale_telemetry) = register_test_job(&mut registry, "job-a");
        assert!(registry.finalize_terminal(
            "job-a",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        register_test_job(&mut registry, "job-b");

        assert!(!registry.finalize_terminal(
            "job-a",
            AlignmentBenchmarkTerminalOutcome::failed("memory-sampler-start-failed"),
        ));
        assert!(!registry.mark_running("job-a"));
        assert!(!registry
            .defer_terminal_for_cleanup("job-a", AlignmentBenchmarkTerminalOutcome::cancelled(),));
        assert!(registry.take_pending_terminal("job-a").is_none());

        let stale_sample_count = stale_telemetry.snapshot().unwrap().memory.sample_count;
        registry.record_cleanup_memory_sample(
            "job-a",
            Instant::now(),
            Ok(ProcessTreeMemorySample {
                working_set_bytes: 1,
                descendants: HashSet::new(),
            }),
            &HashSet::new(),
            Some(7),
        );
        let stale_memory = stale_telemetry.snapshot().unwrap().memory;
        assert_eq!(stale_memory.sample_count, stale_sample_count);
        assert_eq!(stale_memory.residual_process_count, 0);

        assert_eq!(
            registry.lifecycle_view().active_job_id.as_deref(),
            Some("job-b")
        );
        assert_eq!(
            registry.snapshot("job-a").unwrap().error_code.as_deref(),
            Some("alignment-failed")
        );
        assert_eq!(
            registry.snapshot("job-b").unwrap().status,
            AudioAlignmentJobStatus::Queued
        );
        let (snapshot, cancel_flag, telemetry) = test_job("job-c");
        assert!(registry
            .register("job-c".to_string(), snapshot, cancel_flag, telemetry)
            .unwrap_err()
            .contains("一次只能运行一个任务"));
    }

    #[test]
    fn running_refresh_does_not_overwrite_terminal_stage() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        let (_, telemetry) = register_test_job(&mut registry, "job-running");
        telemetry.mark_started().unwrap();
        telemetry
            .transition_stage("matching", "建立候选观测")
            .unwrap();
        assert!(registry.mark_running("job-running"));
        let running = registry.snapshot("job-running").unwrap();
        assert_eq!(running.status, AudioAlignmentJobStatus::Running);
        assert_eq!(running.stage_key, "matching");

        assert!(registry.finalize_terminal(
            "job-running",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        let terminal = registry.snapshot("job-running").unwrap();
        assert_eq!(terminal.status, AudioAlignmentJobStatus::Failed);
        assert_eq!(terminal.stage_key, "failed");
        assert_eq!(terminal.stage_label, "失败");
        assert_eq!(terminal.error_code.as_deref(), Some("alignment-failed"));
    }

    #[test]
    fn cancellation_records_first_tick_is_idempotent_and_ignores_terminal() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        let (cancel_flag, telemetry) = register_test_job(&mut registry, "job-cancel");
        telemetry.mark_started().unwrap();
        let first = registry.request_cancellation("job-cancel").unwrap();
        let repeated = registry.request_cancellation("job-cancel").unwrap();
        assert!(cancel_flag.load(Ordering::Acquire));
        assert_eq!(
            first.telemetry.cancellation.unwrap().request_tick_ns,
            repeated.telemetry.cancellation.unwrap().request_tick_ns
        );

        assert!(registry
            .finalize_terminal("job-cancel", AlignmentBenchmarkTerminalOutcome::cancelled(),));
        let terminal = registry.request_cancellation("job-cancel").unwrap();
        assert_eq!(terminal.status, AudioAlignmentJobStatus::Cancelled);

        let (snapshot, terminal_flag, terminal_telemetry) = test_job("job-terminal");
        registry.clear_for_session_release();
        registry
            .register(
                "job-terminal".to_string(),
                snapshot,
                terminal_flag.clone(),
                terminal_telemetry,
            )
            .unwrap();
        assert!(registry.finalize_terminal(
            "job-terminal",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        let before = registry.snapshot("job-terminal").unwrap();
        let after = registry.request_cancellation("job-terminal").unwrap();
        assert!(!terminal_flag.load(Ordering::Acquire));
        assert!(before.telemetry.cancellation.is_none());
        assert!(after.telemetry.cancellation.is_none());
    }

    #[test]
    fn pending_terminal_is_one_shot_and_preserves_original_outcome() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        register_test_job(&mut registry, "job-cleanup");
        assert!(registry.defer_terminal_for_cleanup(
            "job-cleanup",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        assert!(!registry.defer_terminal_for_cleanup(
            "job-cleanup",
            AlignmentBenchmarkTerminalOutcome::failed("memory-sampler-start-failed"),
        ));
        assert!(!registry.finalize_terminal(
            "job-cleanup",
            AlignmentBenchmarkTerminalOutcome::failed("memory-sampler-start-failed"),
        ));
        assert_eq!(
            registry.lifecycle_view().pending_job_ids,
            vec!["job-cleanup".to_string()]
        );

        registry.record_cleanup_memory_sample(
            "job-cleanup",
            Instant::now(),
            Ok(ProcessTreeMemorySample {
                working_set_bytes: 1,
                descendants: HashSet::new(),
            }),
            &HashSet::new(),
            Some(0),
        );
        let outcome = registry
            .take_pending_terminal("job-cleanup")
            .expect("pending cleanup outcome");
        assert!(registry.take_pending_terminal("job-cleanup").is_none());
        assert!(registry.finalize_terminal("job-cleanup", outcome));
        let terminal = registry.snapshot("job-cleanup").unwrap();
        assert_eq!(terminal.status, AudioAlignmentJobStatus::Failed);
        assert_eq!(terminal.error_code.as_deref(), Some("alignment-failed"));
        assert!(registry.lifecycle_view().pending_job_ids.is_empty());
    }

    #[test]
    fn deferred_terminal_history_survives_take_until_original_outcome_is_finalized() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        register_test_job(&mut registry, "job-in-flight");
        assert!(registry.defer_terminal_for_cleanup(
            "job-in-flight",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));

        let original = registry
            .take_pending_terminal("job-in-flight")
            .expect("first deferred terminal outcome");
        assert!(!registry.defer_terminal_for_cleanup(
            "job-in-flight",
            AlignmentBenchmarkTerminalOutcome::failed("memory-sampler-start-failed"),
        ));
        assert!(registry.take_pending_terminal("job-in-flight").is_none());
        assert!(registry.finalize_terminal("job-in-flight", original));

        let terminal = registry.snapshot("job-in-flight").unwrap();
        assert_eq!(terminal.status, AudioAlignmentJobStatus::Failed);
        assert_eq!(terminal.error_code.as_deref(), Some("alignment-failed"));
        assert!(registry.lifecycle_view().active_job_id.is_none());
    }

    #[test]
    fn terminal_records_are_sorted_terminal_only_and_fail_closed() {
        let mut registry = AlignmentBenchmarkJobRegistry::default();
        register_test_job(&mut registry, "job-b");
        assert!(registry.finalize_terminal(
            "job-b",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        register_test_job(&mut registry, "job-a");
        assert!(
            registry.finalize_terminal("job-a", AlignmentBenchmarkTerminalOutcome::cancelled(),)
        );
        let records = registry.terminal_records().unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.job_id.as_str())
                .collect::<Vec<_>>(),
            vec!["job-a", "job-b"]
        );
        assert_eq!(records[0].status, AudioAlignmentJobStatus::Cancelled);
        assert_eq!(records[1].status, AudioAlignmentJobStatus::Failed);

        register_test_job(&mut registry, "job-active");
        assert_eq!(
            registry.terminal_records().unwrap_err(),
            AlignmentBenchmarkTerminalRecordsError::NonTerminal
        );
        assert!(registry.finalize_terminal(
            "job-active",
            AlignmentBenchmarkTerminalOutcome::failed("alignment-failed"),
        ));
        registry.force_terminal_telemetry_failure("job-active");
        assert!(matches!(
            registry.terminal_records(),
            Err(AlignmentBenchmarkTerminalRecordsError::Telemetry(_))
        ));
    }
}
